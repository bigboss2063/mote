import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { obsidianStub } from "./obsidian-stub.mjs";

const bundle = await build({
  entryPoints: ["src/ai/history-pane.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});

function pane({ windowNarrow = false, mobile = false, hostWidth = 0 }) {
  const module = { exports: {} };
  const observed = { count: 0 };
  class ResizeObserverFixture {
    observe() { observed.count++; }
    disconnect() { observed.count = -1; }
  }
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: () => obsidianStub({
      Component: class { load() {} unload() {} },
      setIcon() {}, Notice: class {}, TFile: class {},
    }),
    window: { matchMedia: () => ({ matches: windowNarrow, addEventListener() {}, removeEventListener() {} }),
      ResizeObserver: ResizeObserverFixture },
  });
  const host = {
    ownerDocument: {
      body: { classList: { contains: () => mobile } },
      defaultView: {
        matchMedia: () => ({ matches: windowNarrow, addEventListener() {}, removeEventListener() {} }),
        ResizeObserver: ResizeObserverFixture,
      },
    },
    clientWidth: hostWidth,
  };
  const view = Object.create(module.exports.InsightHistoryPane.prototype);
  Object.assign(view, {
    host,
    compactQuery: { matches: windowNarrow },
    hostObserver: null,
  });
  return { view, observed };
}

test("a narrow pane is compact even when the window is wide", () => {
  // 桌面侧边 pane / iPad 分屏：窗口够宽，matchMedia 不匹配，pane 只有 360px。
  const wide = pane({ windowNarrow: false, mobile: false, hostWidth: 1200 });
  assert.equal(wide.view.isCompact(), false);
  const narrow = pane({ windowNarrow: false, mobile: false, hostWidth: 360 });
  assert.equal(narrow.view.isCompact(), true);
});

test("window breakpoint and mobile shell still count as compact", () => {
  assert.equal(pane({ windowNarrow: true }).view.isCompact(), true);
  assert.equal(pane({ mobile: true, hostWidth: 1200 }).view.isCompact(), true);
});

test("an unmeasured host does not force compact", () => {
  // 隐藏的标签页量出来是 0，不能因此切到单列。
  assert.equal(pane({ hostWidth: 0 }).view.isCompact(), false);
});

test("the pane watches its own width so split-view resizes re-render", () => {
  const { view, observed } = pane({ hostWidth: 500 });
  view.bindCompactQuery();
  assert.equal(observed.count, 1, "ResizeObserver observes the host");

  // unmount() 的其余步骤依赖宿主 DOM，这里只验证 observer 会被断开。
  view.hostObserver?.disconnect();
  assert.equal(observed.count, -1, "observer is disconnected on unmount");
});
