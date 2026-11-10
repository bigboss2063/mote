import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { obsidianStub } from "./obsidian-stub.mjs";
import { readFileSync } from "node:fs";

const bundle = await build({
  entryPoints: ["src/view.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});

/**
 * 把样式表里展开态的 --memoria-input-min 抽出来，确保 view.ts 不会退回去
 * 读当前计算值（收起态只有 40px，那样两行草稿会被锁在 46px）。
 */
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("the input height budget comes from the expanded-state variable", () => {
  assert.match(
    css,
    /--memoria-input-min:\s*96px/,
    "desktop declares the expanded minimum"
  );
  assert.match(
    css,
    /--memoria-input-min:\s*56px/,
    "phone overrides it in the 680 breakpoint"
  );
  assert.match(
    css,
    /min-height:\s*var\(--memoria-input-min\)/,
    "the input itself consumes the variable"
  );
});

test("autoResizeInput reads the variable, not the collapsed computed value", () => {
  const source = readFileSync(new URL("../src/view.ts", import.meta.url), "utf8");
  const body = source.slice(
    source.indexOf("private autoResizeInput"),
    source.indexOf("private syncInputCardContentState")
  );
  assert.ok(
    body.includes('getPropertyValue("--memoria-input-min")'),
    "reads the expanded-state custom property"
  );
  assert.ok(
    !/getComputedStyle\(el\)\.minHeight/.test(body),
    "must not reuse the collapsed 40px value"
  );
});

function resizer({ minHeight, scrollHeight, value }) {
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: () => obsidianStub({ ItemView: class {}, Platform: { isMobile: true } }),
    window: { requestAnimationFrame: (fn) => fn() },
    getComputedStyle: () => ({
      minHeight,
      getPropertyValue: (name) => (name === "--memoria-input-min" ? minHeight : ""),
    }),
  });
  const styles = {};
  const el = {
    value,
    scrollHeight,
    classList: { add() {}, remove() {} },
    setCssStyles: (next) => Object.assign(styles, next),
  };
  const view = Object.create(module.exports.MemoriaView.prototype);
  Object.assign(view, {
    contentEl: { hasClass: () => false },
    inputEl: el,
  });
  view.autoResizeInput();
  return styles;
}

test("a two-line draft keeps the expanded minimum instead of the collapsed one", () => {
  // 收起态计算值是 40，展开态预算 56：46 的内容不该被当成"已够高"。
  const collapsedRead = resizer({ minHeight: "40px", scrollHeight: 44, value: "两行\n草稿" });
  const expandedRead = resizer({ minHeight: "56px", scrollHeight: 44, value: "两行\n草稿" });
  assert.equal(collapsedRead.height, "46px", "46 > 40 so it takes over");
  assert.equal(expandedRead.height, "", "46 <= 56 so CSS minimum wins");
});

test("tall content sets an explicit height, short content leaves it to CSS", () => {
  assert.equal(resizer({ minHeight: "96px", scrollHeight: 400, value: "x".repeat(400) }).height, "402px");
  assert.equal(resizer({ minHeight: "96px", scrollHeight: 40, value: "短" }).height, "");
});

test("an empty draft clears the inline height so the card can collapse", () => {
  assert.equal(resizer({ minHeight: "96px", scrollHeight: 120, value: "" }).height, "");
});
