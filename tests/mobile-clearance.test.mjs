import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const bundle = await build({
  entryPoints: ["src/mobile-navbar.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["obsidian"],
});

class HTMLElementFixture {}
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  require: () => ({ Platform: { isMobile: true } }),
  // 被测代码用 instanceof HTMLElement 做运行期类型守卫；
  // 沙箱里给出同名类，夹具对象继承它即可。
  HTMLElement: HTMLElementFixture,
});
const { bindMobileNavbarClearance } = module.exports;

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/**
 * 最小 DOM：一个视图根 + 可选的导航栏 + 可选的 visualViewport。
 * 只实现 bindMobileNavbarClearance 真正会碰的东西。
 */
function fixture({ rootBottom = 844, navbar = null, innerHeight = 844, viewport = null }) {
  const props = {};
  const navEl = navbar
    ? Object.assign(new HTMLElementFixture(), {
        getBoundingClientRect: () => ({
          top: navbar.top, bottom: navbar.top + navbar.height,
          width: navbar.width ?? 390, height: navbar.height,
        }),
        addEventListener() {},
        removeEventListener() {},
      })
    : null;

  const doc = {
    querySelector: (sel) => (sel === ".mobile-navbar" ? navEl : null),
    defaultView: {
      innerHeight,
      visualViewport: viewport,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      addEventListener() {},
      removeEventListener() {},
      clearTimeout() {},
      setTimeout: () => 0,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    },
    body: { addEventListener() {}, removeEventListener() {} },
    documentElement: { setCssProps: (next) => Object.assign(props, next) },
  };

  const root = {
    ownerDocument: doc,
    getBoundingClientRect: () => ({ top: 0, bottom: rootBottom, width: 390, height: rootBottom }),
    setCssProps: (next) => Object.assign(props, next),
  };

  return { root, props };
}

/** 触发一次测量 —— bind 内部会立刻 publish 一次。 */
function measure(options) {
  const { root, props } = fixture(options);
  const stop = bindMobileNavbarClearance(root);
  stop();
  return props;
}

test("a detached navbar resolves to zero instead of waiting forever", () => {
  // 键盘弹起时 Obsidian 把 .mobile-navbar 整个 detach 掉（MobileNavbar.hide()
  // 里的 containerEl.detach()）。原来这里返回 ready:false，publish 直接 return，
  // 样式表里那份保守高度就再也不会被撤销 —— 真机上量到输入卡离键盘 129px。
  const props = measure({ navbar: null, rootBottom: 680 });
  assert.equal(
    props["--mote-mobile-navbar-clearance"],
    "0px",
    "no navbar in the page must settle at zero, not stay on the table's guess"
  );
});

test("a navbar that overlaps the view still gets the 24px breathing gap", () => {
  const props = measure({ navbar: { top: 758, height: 52 }, rootBottom: 844 });
  assert.equal(props["--mote-mobile-navbar-clearance"], "110px");
});

test("the keyboard wins over the navbar and adds no extra gap", () => {
  // 键盘顶在 680，导航还被键盘盖在下面（top 758）。
  // 内容盒已经止于键盘顶边，再来 24px 就是键盘上方那条空白。
  const props = measure({
    navbar: { top: 758, height: 52 },
    rootBottom: 680,
    viewport: {
      offsetTop: 0,
      height: 680,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  assert.equal(
    props["--mote-mobile-navbar-clearance"],
    "0px",
    "keyboard already defines the bottom edge; don't stack a nav gap on top of it"
  );
});

test("the stylesheet fallback is zero, not a guessed navbar height", () => {
  // 测量完成前，页面上不能自带一份"导航大概这么高"的猜测：
  // 导航被摘掉时它就永远留着。真机上那 129px 的空白正是这么来的。
  const block = css.match(/body\.is-phone\s*\{([^}]*)\}/);
  assert.ok(block, "body.is-phone fallback block should exist");
  assert.match(block[1], /--mote-mobile-navbar-clearance:\s*0px/);
  assert.match(block[1], /--mote-mobile-navbar-fixed-clearance:\s*0px/);
  assert.ok(
    !/--navbar-height/.test(block[1]),
    "Obsidian never defines --navbar-height, so the calc could only ever add its own constant"
  );
});
