import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { obsidianStub } from "./obsidian-stub.mjs";

const bundle = await build({
  entryPoints: ["src/view.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});

function cardFixture(mobile) {
  const module = {exports: {}};
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: () => obsidianStub({ItemView: class {}, Platform: {isMobile: mobile}}),
  });
  const listeners = new Map();
  let edits = 0;
  const memo = { file: "Mote/2026/2026-01-01 10.00.md" };
  const stop = new Error("The rest of the card rendering is outside this gesture test");
  const card = {
    dataset: {},
    addEventListener(name, callback) { listeners.set(name, callback); },
    createDiv() { throw stop; },
  };
  const view = {
    settings: {},
    enterEditMode(value) { assert.equal(value, memo); edits++; },
  };
  assert.throws(() => module.exports.MemoriaView.prototype.renderMemoCard.call(
    view, {createDiv: () => card}, memo
  ), error => error === stop);
  return {listeners, get edits() {return edits;}};
}

test("desktop double-click still edits ordinary card text", () => {
  const f = cardFixture(false);
  f.listeners.get("dblclick")({target: {closest: () => null}});
  assert.equal(f.edits, 1);
  assert.equal(f.listeners.has("pointerdown"), false);
  assert.equal(f.listeners.has("mousedown"), false);
});

test("interactive card descendants do not trigger double-click editing", () => {
  for (const selector of ["a", "button", "input", "textarea", "select", "img", ".memoria-img-cell", ".memoria-tag-pill"]) {
    const f = cardFixture(false);
    f.listeners.get("dblclick")({target: {closest: selectors => {
      assert.ok(selectors.split(", ").includes(selector));
      return {};
    }}});
    assert.equal(f.edits, 0, selector);
  }
});

test("mobile leaves long-press and double-tap selection to the system", () => {
  const f = cardFixture(true);
  f.listeners.get("dblclick")({target: {closest: () => null}});
  assert.equal(f.edits, 0);
  for (const name of ["pointerdown", "touchstart", "contextmenu", "selectstart"]) {
    assert.equal(f.listeners.has(name), false, name);
  }
});

for (const [density, limit, height, threshold] of [
  ["compact", 8, 180, 96], // Clipped in compact mode, below the cozy threshold.
  ["compact", 0, 180, 96], // Compact previews still need a way to expand.
  ["compact", 4, 360, 96],
  ["compact", 8, 72, null],
  ["cozy", 8, 180, null],
  ["cozy", 8, 360, 192],
  ["cozy", 0, 360, null],
]) {
  test(`${density} memo folding: limit=${limit}, height=${height}`, () => {
    const module = {exports: {}};
    const classes = new Set(), properties = new Map(), spans = [];
    let click, button, scrolled = false, icon;
    vm.runInNewContext(bundle.outputFiles[0].text, {
      module, exports: module.exports,
      require: () => obsidianStub({ItemView: class {}, setIcon: (_, value) => {icon = value;}}),
      window: {
        requestAnimationFrame: callback => callback(),
        getComputedStyle: () => ({lineHeight: "24px", fontSize: "16px"}),
      },
      createEl: (_, options) => {
        button = {
          ...options,
          createSpan(options) {
            const span = {...options, setText(text) {this.text = text;}};
            spans.push(span);
            return span;
          },
          addEventListener(event, callback) {assert.equal(event, "click"); click = callback;},
        };
        return button;
      },
    });
    const body = {
      scrollHeight: height,
      addClass: cls => classes.add(cls),
      removeClass: cls => classes.delete(cls),
      style: {setProperty: (key, value) => properties.set(key, value)},
    };
    const card = {
      querySelector: () => null,
      appendChild: child => assert.equal(child, button),
      scrollIntoView() {scrolled = true;},
    };
    module.exports.MemoriaView.prototype.applyCollapseIfNeeded.call(
      {settings: {density, collapseLineLimit: limit}}, body, card
    );
    if (threshold === null) {
      assert.equal(button, undefined, "Unclipped text needs no expand button");
      assert.equal(classes.has("is-collapsed"), false);
      return;
    }
    assert.equal(properties.get("--memoria-collapse-max"), `${threshold}px`);
    assert.equal(classes.has("is-collapsed"), true);
    const expandLabel = spans[0].text;
    assert.equal(icon, "chevron-down");
    let stopped = 0;
    const event = {stopPropagation() {stopped++;}};
    click(event);
    assert.equal(classes.has("is-collapsed"), false);
    assert.notEqual(spans[0].text, expandLabel);
    assert.equal(icon, "chevron-up");
    assert.equal(scrolled, false);
    click(event);
    assert.equal(classes.has("is-collapsed"), true);
    assert.equal(spans[0].text, expandLabel);
    assert.equal(icon, "chevron-down");
    assert.equal(scrolled, true);
    assert.equal(stopped, 2);
  });
}

test("active tag is appended when its only occurrence is a URL fragment", () => {
  const module = {exports: {}};
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: () => obsidianStub({ItemView: class {}}),
  });
  const append = text => module.exports.MemoriaView.prototype.appendActiveTagIfMissing.call(
    {filter: {tag: "rd"}}, text
  );
  const link = "[fish](https://mp.weixin.qq.com/s/example#rd)";
  assert.equal(append(link), link + "\n#rd");
  assert.equal(append(link + " #rd"), link + " #rd");
  assert.equal(append(link + " #rd/child"), link + " #rd/child");
});

test("card rendering keeps URL fragments out of its tag pills", () => {
  const module = {exports: {}};
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: () => obsidianStub({ItemView: class {}}),
  });
  const strip = text => module.exports.MemoriaView.prototype.stripTags.call({}, text);
  const link = "[fish](https://mp.weixin.qq.com/s/example#rd)";
  assert.equal(strip(link).text, link);
  assert.equal(strip(link).tags.length, 0);
  assert.equal(strip(link + " #rd").text, link);
  assert.deepEqual([...strip(link + " #rd").tags], ["rd"]);
});

test("quoting memo or insight inserts a compact full-path link and preserves the draft", () => {
  const module = {exports: {}};
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, Event,
    require: () => obsidianStub({ItemView: class {}}),
  });
  for (const file of ["Mote/2026/2026-11-06 10.00.md", "Mote/_insights/Pattern.md"]) {
    const input = {
      value: "Draft text  ", focus() {}, setSelectionRange() {}, dispatchEvent() {},
    };
    let revealed = false;
    module.exports.MemoriaView.prototype.quoteSource.call({
      inputEl: input,
      app: {workspace: {revealLeaf() { revealed = true; }}},
      autoResizeInput() {}, syncInputCardContentState() {},
    }, file);
    assert.equal(input.value, `Draft text\n\n[[${file.slice(0, -3)}|↗]]\n\n`);
    assert.equal(revealed, true);
  }
});
