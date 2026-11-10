import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/mobile-navbar.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});

function load(observers) {
  const module = { exports: {} };
  class ResizeObserverFixture {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.observing = true; }
    disconnect() { this.observing = false; }
  }
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: () => ({ Platform: { isMobile: false } }),
    ResizeObserver: ResizeObserverFixture,
  });
  return module.exports;
}

/** Obsidian 的 contentEl 既是 .view-content 又是视图根，class 也挂在它上面。 */
function fixture({ paneWidth, windowWidth }, observers = []) {
  const classes = new Set();
  const root = {
    clientWidth: paneWidth,
    ownerDocument: {
      defaultView: {
        innerWidth: windowWidth,
        ResizeObserver: class {
          constructor(callback) { this.callback = callback; observers.push(this); }
          observe() { this.observing = true; }
          disconnect() { this.observing = false; }
        },
      },
      querySelector: () => null,
    },
    classList: classes,
    toggleClass(cls, on) { on ? classes.add(cls) : classes.delete(cls); },
  };
  return { root, classes };
}

test("narrow pane means the panel is cramped while the window is not", () => {
  const { isNarrowPane } = load([]);
  const at = (paneWidth, windowWidth) =>
    isNarrowPane(fixture({ paneWidth, windowWidth }).root);

  assert.equal(at(360, 1400), true, "desktop side pane");
  assert.equal(at(500, 1100), true, "iPad split view");
  assert.equal(at(390, 390), false, "phone: window is narrow too, CSS already handles it");
  assert.equal(at(1200, 1400), false, "wide desktop panel");
  assert.equal(at(0, 1400), false, "hidden tab measures 0 and must not switch layout");
});

test("the binding toggles the class and follows later resizes", () => {
  const observers = [];
  const { bindNarrowPane } = load(observers);
  const { root, classes } = fixture({ paneWidth: 360, windowWidth: 1400 }, observers);

  const stop = bindNarrowPane(root);
  assert.equal(classes.has("is-narrow-pane"), true);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].observing, true);

  // Dragging the pane wider should drop the class on the next resize.
  root.clientWidth = 900;
  observers[0].callback();
  assert.equal(classes.has("is-narrow-pane"), false);

  // ...and dragging it back should restore it.
  root.clientWidth = 420;
  observers[0].callback();
  assert.equal(classes.has("is-narrow-pane"), true);

  stop();
  assert.equal(observers[0].observing, false, "observer released on view close");
});
