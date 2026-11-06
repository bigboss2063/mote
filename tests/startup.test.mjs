import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

// Keep the real plugin lifecycle, store and parser; only replace UI constructors.
const bundle = await build({
  entryPoints: ["src/main.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
  plugins: [{ name: "headless-views", setup(build) {
    build.onResolve({filter: /^\.\/(view|settings|stats|year-panorama)$/}, args =>
      ({path: args.path, namespace: "ui-stub"}));
    build.onLoad({filter: /.*/, namespace: "ui-stub"}, () => ({contents:
      "export class MemoriaView {} export class MemoriaSettingTab {} export class StatsView {} export class YearPanoramaView {}"}));
  }}],
});

class TFile {
  constructor(path, content = "") {
    this.path = path;
    this.name = path.split("/").at(-1);
    this.extension = this.name.split(".").at(-1);
    this.content = content;
  }
}
const memoFile = (name, text) => new TFile(`Mote/2026/${name}.md`, `${text}\n`);
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(files = [], ready = false) {
  const events = new Map();
  const layoutCallbacks = [];
  const byPath = new Map(files.map(f => [f.path, f]));
  const reads = [], errors = [];
  let scans = 0;
  class Plugin {
    constructor(app) { this.app = app; }
    async loadData() { return {language: "en-US"}; }
    registerView() {}
    addRibbonIcon() {}
    addCommand() {}
    registerObsidianProtocolHandler() {}
    registerEvent() {}
    addSettingTab() {}
  }
  const app = {
    vault: {
      on(name, callback) { events.set(name, callback); },
      getMarkdownFiles() { scans++; return [...byPath.values()].filter(f => f.extension.toLowerCase() === "md"); },
      getAbstractFileByPath(path) { return byPath.get(path); },
      async read(file) { reads.push(file.path); return file.content; },
    },
    workspace: {
      layoutReady: ready,
      onLayoutReady(callback) { ready ? callback() : layoutCallbacks.push(callback); },
    },
  };
  const module = {exports: {}};
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    console: {error: (...args) => errors.push(args)},
    require: () => ({Plugin, TFile, normalizePath: p => p.replace(/\/+$/, ""), Platform: {isMobile: false}}),
  });
  const plugin = new module.exports.default(app);
  await plugin.onload();
  let notifications = 0;
  plugin.store.onChange(() => notifications++);
  return {
    plugin, app, reads, errors, byPath,
    get scans() { return scans; },
    get notifications() { return notifications; },
    emit(name, ...args) { events.get(name)?.(...args); },
    async finishStartup() {
      app.workspace.layoutReady = true;
      layoutCallbacks.splice(0).forEach(callback => callback());
      await flush();
    },
  };
}

test("3000 startup attachment events cause no text reads or refreshes", async () => {
  const images = Array.from({length: 3000}, (_, i) => new TFile(`Mote/attachments/${i}.jpg`));
  const f = await fixture(images);
  for (const image of images) f.emit("create", image);
  await flush();
  assert.equal(f.reads.length, 0);
  assert.equal(f.notifications, 0);
  await f.finishStartup();
  assert.equal(f.scans, 1);
  assert.equal(f.reads.length, 0);
  assert.equal(f.notifications, 1);
  for (const image of images) {
    f.emit("create", image);
    f.emit("modify", image);
    await f.plugin.store.reloadFile(image);
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.notifications, 1);
});

test("startup scans only memo files under the folder", async () => {
  const files = [
    memoFile("2026-10-21 10.00", "first"),
    new TFile("Mote/2026/2026-10-20 09.30.md", "second\n"),
    new TFile("Mote/_trash/2026-10-19 10.00.md", "trash\n"),
    new TFile("Mote/_insights/2026-10-18 10.00 Note.md", "# Note\n"),
    new TFile("Mote-copy/2026/2026-10-21 10.00.md", "outside\n"),
    new TFile("Mote/2026/2026.md", "old container\n"),
    new TFile("Mote/attachments/file.pdf"),
    new TFile("Mote/attachments/photo.webp"),
  ];
  const f = await fixture(files);
  files.forEach(file => f.emit("create", file));
  await flush();
  assert.equal(f.reads.length, 0);
  await f.finishStartup();
  assert.deepEqual(f.reads.sort(), [
    "Mote/2026/2026-10-20 09.30.md",
    "Mote/2026/2026-10-21 10.00.md",
  ]);
  assert.equal(f.plugin.store.getAll().length, 2);
  assert.equal(f.notifications, 1);
});

test("post-startup create, modify, rename and delete still update notes", async () => {
  const f = await fixture();
  await f.finishStartup();
  const file = memoFile("2026-10-21 10.00", "created");
  f.byPath.set(file.path, file);
  f.emit("create", file);
  await flush();
  assert.equal(f.plugin.store.getAll()[0].content, "created");
  file.content = "modified\n";
  f.emit("modify", file);
  await flush();
  assert.equal(f.plugin.store.getAll()[0].content, "modified");
  const renamed = new TFile("Mote/2026/2026-10-21 11.00.md", file.content);
  f.byPath.delete(file.path);
  f.byPath.set(renamed.path, renamed);
  f.emit("rename", renamed, file.path);
  await flush();
  assert.equal(f.plugin.store.getAll().length, 1);
  assert.equal(f.plugin.store.getAll()[0].file, renamed.path);
  f.byPath.delete(renamed.path);
  f.emit("delete", renamed);
  assert.equal(f.plugin.store.getAll().length, 0);
});

test("moving a note outside the folder or renaming to non-Markdown removes it", async () => {
  for (const path of ["Elsewhere/2026/2026-10-21 10.00.md", "Mote/2026/2026-10-21 10.00.txt"]) {
    const file = memoFile("2026-10-21 10.00", "old");
    const f = await fixture([file]);
    await f.finishStartup();
    f.byPath.delete(file.path);
    const renamed = new TFile(path, file.content);
    f.byPath.set(path, renamed);
    f.emit("rename", renamed, file.path);
    await flush();
    assert.equal(f.plugin.store.getAll().length, 0);
    assert.equal(f.reads.length, 1);
  }
});

test("enabling after layout is ready still loads existing notes", async () => {
  const f = await fixture([memoFile("2026-10-21 10.00", "existing")], true);
  await flush();
  assert.equal(f.plugin.store.getAll().length, 1);
  assert.equal(f.scans, 1);
});

test("unloading before layout is ready cancels deferred initialization", async () => {
  const f = await fixture([memoFile("2026-10-21 10.00", "existing")]);
  f.plugin.onunload();
  await f.finishStartup();
  assert.equal(f.scans, 0);
  assert.equal(f.reads.length, 0);
});

test("failed event reads are handled and later updates can recover", async () => {
  const f = await fixture();
  await f.finishStartup();
  const file = memoFile("2026-10-21 10.00", "recovered");
  f.byPath.set(file.path, file);
  const read = f.app.vault.read;
  f.app.vault.read = async () => { throw new Error("read failure"); };
  f.emit("create", file);
  await flush();
  assert.equal(f.errors.length, 1);
  f.app.vault.read = read;
  f.emit("modify", file);
  await flush();
  assert.equal(f.plugin.store.getAll()[0].content, "recovered");
});

test("saving an image still writes binary data without triggering memo parsing", async () => {
  const f = await fixture();
  await f.finishStartup();
  f.app.vault.createFolder = async () => {};
  const writes = [];
  f.app.vault.createBinary = async (path, bytes) => {
    writes.push({path, bytes});
    const file = new TFile(path);
    f.byPath.set(path, file);
    f.emit("create", file);
    return file;
  };
  const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
  const path = await f.plugin.store.saveImageAttachment(bytes, "png");
  await flush();
  assert.match(path, /^Mote\/attachments\/mote-.*\.png$/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].bytes, bytes);
  assert.equal(f.reads.length, 0);
  assert.equal(f.notifications, 1);
});
