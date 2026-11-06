import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { obsidianStub } from "./obsidian-stub.mjs";

class Element {
  constructor(doc, tag = "div") {
    this.ownerDocument = doc;
    this.tag = tag;
    this.attrs = {};
    this.listeners = {};
    this.children = [];
    this.isConnected = true;
  }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  removeEventListener() {}
  closest() { return null; }
  replaceWith(value) { this.replacement = value; }
  matches() { return true; }
  createDiv(options) { return this.createChild(options); }
  createSpan(options) { return this.createChild(options); }
  createChild(options) {
    const child = new Element(this.ownerDocument);
    child.textContent = options.text;
    child.className = options.cls;
    this.children.push(child);
    return child;
  }
  appendChild(child) { this.children.push(child); }
  getBoundingClientRect() { return {left: 80, top: 200, bottom: 212, width: 12}; }
  get offsetWidth() { return 340; }
  get offsetHeight() { return 150; }
  get style() { return this._style ??= {}; }
  remove() { this.isConnected = false; }
}
class TFile {
  constructor(path, content = "Source body") {
    this.path = path;
    this.content = content;
    this.extension = path.split(".").at(-1);
    this.basename = path.split("/").at(-1).replace(/\.md$/, "");
    this.stat = {mtime: 0};
  }
}
const bundle = await build({
  entryPoints: ["src/ai/citation-ui.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});
function fixture() {
  const notices = [];
  const module = {exports: {}};
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: () => obsidianStub({TFile, Notice: class {constructor(text) { notices.push(text); }}}),
  });
  const win = {innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {}, clearTimeout() {}};
  const doc = {defaultView: win, addEventListener() {}, removeEventListener() {}};
  doc.createElement = tag => new Element(doc, tag);
  doc.body = new Element(doc);
  const files = new Map();
  const links = [];
  const root = {ownerDocument: doc, querySelectorAll: () => links};
  const app = {
    metadataCache: {getFirstLinkpathDest: href => files.get(href)},
    vault: {
      getAbstractFileByPath: path => [...files.values()].find(file => file.path === path),
      cachedRead: async file => file.content,
    },
  };
  const opened = [];
  const add = (href, path, content) => {
    if (path) files.set(href, new TFile(path, content));
    const link = new Element(doc, "a");
    link.attrs["data-href"] = href;
    links.push(link);
    return link;
  };
  const decorate = () => module.exports.decorateSourceLinks(root, app, "Mote/2026/current.md", "Mote", file => opened.push(file));
  const click = button => button.listeners.click({preventDefault() {}, stopPropagation() {}});
  return {doc, add, decorate, click, files, opened, notices, dismiss: module.exports.dismissCitationPreview};
}

test("memo and insight links become interactive arrows; ordinary, subpath and outside links stay intact", () => {
  const f = fixture();
  const memo = f.add("memo", "Mote/2026/2026-11-06 10.00.md");
  const insight = f.add("insight", "Mote/_insights/Pattern.md");
  const ordinary = f.add("ordinary", "Mote/ordinary.md");
  const outside = f.add("outside", "Other/2026-11-06 10.00.md");
  const heading = f.add("memo#heading", "Mote/2026/2026-11-06 10.00.md");
  f.decorate();
  for (const link of [memo, insight]) {
    assert.equal(link.replacement.className, "memoria-insight-cite");
    f.click(link.replacement);
  }
  assert.deepEqual(f.opened, ["Mote/2026/2026-11-06 10.00.md", "Mote/_insights/Pattern.md"]);
  for (const link of [ordinary, outside, heading]) assert.equal(link.replacement, undefined);
});

test("fresh rendering and cached clones each receive working arrow listeners", () => {
  const f = fixture();
  const first = f.add("memo", "Mote/2026/2026-11-06 10.00.md");
  f.decorate();
  const cachedClone = f.add("memo", "Mote/2026/2026-11-06 10.00.md");
  f.decorate();
  f.click(first.replacement);
  f.click(cachedClone.replacement);
  assert.equal(f.opened.length, 2);
});

test("missing explicit citations and deleted sources show a notice without navigation", () => {
  const f = fixture();
  const missing = f.add("missing");
  missing.textContent = "↗";
  const removed = f.add("memo", "Mote/2026/2026-11-06 10.00.md");
  f.decorate();
  f.files.clear();
  f.click(missing.replacement);
  f.click(removed.replacement);
  assert.equal(f.notices.length, 2);
  assert.equal(f.opened.length, 0);
});

for (const [kind, path, content, title, body] of [
  ["memo", "Mote/2026/2026-11-06 10.00.md", "Source body", "2026-11-06 10:00", "Source body"],
  ["insight", "Mote/_insights/Pattern.md", '---\nmote: insight\ntitle: "Pattern"\n---\n\n# Pattern\n\nInsight body', "Pattern", "Insight body"],
]) {
  test(`${kind} arrow previews its source body on hover`, async () => {
    const f = fixture();
    const link = f.add(kind, path, content);
    f.decorate();
    link.replacement.listeners.mouseenter();
    await new Promise(resolve => setImmediate(resolve));
    const card = f.doc.body.children[0];
    assert.equal(card.children[0].textContent, title);
    assert.equal(card.children[1].textContent, body);
    f.dismiss();
    assert.equal(card.isConnected, false);
  });
}
