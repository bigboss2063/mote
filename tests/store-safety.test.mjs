import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/store.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});
class TFile {
  constructor(path, content = "") {
    this.path = path;
    this.name = path.split("/").at(-1);
    this.extension = "md";
    this.content = content;
  }
}
const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi);

async function fixture() {
  const files = new Map();
  const writes = [];
  const renames = [];
  const deleted = [];
  const vault = {
    getMarkdownFiles: () => [...files.values()],
    getAbstractFileByPath: path => files.get(path),
    read: async file => file.content,
    createFolder: async () => {},
    create: async (path, content) => {
      assert.ok(!files.has(path), `create twice: ${path}`);
      const file = new TFile(path, content);
      files.set(path, file);
      writes.push(path);
      return file;
    },
    modify: async (file, content) => {
      file.content = content;
      writes.push(file.path);
    },
    delete: async file => {
      deleted.push(file.path);
      files.delete(file.path);
    },
  };
  const fileManager = {
    renameFile: async (file, path) => {
      assert.ok(!files.has(path), `rename onto existing: ${path}`);
      files.delete(file.path);
      renames.push([file.path, path]);
      file.path = path;
      file.name = path.split("/").at(-1);
      files.set(path, file);
    },
    trashFile: async file => {
      deleted.push(file.path);
      files.delete(file.path);
    },
  };
  const module = {exports: {}};
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require: () => ({TFile, normalizePath: p => p}),
  });
  const store = new module.exports.MemoStore(
    {vault, fileManager}, {folder: "Mote", useTrash: false});
  return {store, files, writes, renames, deleted, vault};
}

async function seeded() {
  const f = await fixture();
  await f.store.addMemo("first", at(2026, 10, 21, 10, 0));
  await f.store.addMemo("second", at(2026, 10, 21, 10, 0));
  const second = f.store.getAll().find(m => m.content === "second");
  return {...f, second};
}

test("addMemo writes one file per memo, body verbatim", async () => {
  const f = await fixture();
  await f.store.addMemo("hello\n\n- [ ] task #work", at(2026, 10, 21, 10, 0));
  const path = "Mote/2026/2026-10-21 10.00.md";
  assert.equal(f.files.get(path).content, "hello\n\n- [ ] task #work\n");
  const memo = f.store.getAll()[0];
  assert.equal(memo.file, path);
  assert.equal(memo.content, "hello\n\n- [ ] task #work");
  assert.equal(memo.hasOpenTask, true);
  assert.deepEqual([...memo.tags], ["work"]);
});

test("same-minute memos get .01 / .02 suffixes", async () => {
  const f = await seeded();
  await f.store.addMemo("third", at(2026, 10, 21, 10, 0));
  assert.deepEqual([...f.files.keys()].sort(), [
    "Mote/2026/2026-10-21 10.00.01.md",
    "Mote/2026/2026-10-21 10.00.02.md",
    "Mote/2026/2026-10-21 10.00.md",
  ]);
  assert.equal(f.store.getAll()[0].file, "Mote/2026/2026-10-21 10.00.02.md");
});

test("editMemo changes only its own file", async () => {
  const f = await seeded();
  const first = f.store.getAll().find(m => m.content === "first");
  await f.store.editMemo(first, "edited\n\nwith a quote\n\n> [!quote] x\n> y");
  assert.equal(f.files.get("Mote/2026/2026-10-21 10.00.md").content,
    "edited\n\nwith a quote\n\n> [!quote] x\n> y\n");
  assert.equal(f.files.get("Mote/2026/2026-10-21 10.00.01.md").content, "second\n");
  assert.equal(f.store.getAll().filter(m => m.content === "second").length, 1);
});

test("editMemoDateTime renames the file and keeps the identity", async () => {
  const f = await seeded();
  await f.store.editMemoDateTime(f.second, at(2025, 1, 2, 9, 30), "moved");
  assert.deepEqual(f.renames, [
    ["Mote/2026/2026-10-21 10.00.01.md", "Mote/2025/2025-01-02 09.30.md"],
  ]);
  const moved = f.store.getAll().find(m => m.content === "moved");
  assert.equal(moved.file, "Mote/2025/2025-01-02 09.30.md");
  assert.equal(moved.date, "2025-01-02");
  assert.equal(moved.time, "09:30");
  assert.equal(f.store.getAll().filter(m => m.content === "second").length, 0);
});

test("editMemoDateTime onto an occupied minute picks the next suffix", async () => {
  const f = await seeded();
  await f.store.addMemo("occupant", at(2025, 1, 2, 9, 30));
  await f.store.editMemoDateTime(f.second, at(2025, 1, 2, 9, 30));
  assert.ok(f.files.has("Mote/2025/2025-01-02 09.30.01.md"));
  assert.equal(f.store.getAll().filter(m => m.content === "second").length, 1);
});

test("deleteMemo moves the file to _trash/ when trash is on", async () => {
  const f = await seeded();
  f.store.settings.useTrash = true;
  await f.store.deleteMemo(f.second);
  assert.ok(f.files.has("Mote/_trash/2026-10-21 10.00.01.md"));
  assert.equal(f.store.getAll().some(m => m.content === "second"), false);
  assert.equal(f.store.getAll().some(m => m.content === "first"), true);
});

test("deleteMemo hard-deletes when trash is off", async () => {
  const f = await seeded();
  await f.store.deleteMemo(f.second);
  assert.deepEqual(f.deleted, ["Mote/2026/2026-10-21 10.00.01.md"]);
  assert.equal(f.store.getAll().length, 1);
});

test("memos outside the folder or not matching the name pattern are ignored", async () => {
  const f = await fixture();
  const outside = new TFile("Elsewhere/2026-10-21 10.00.md", "x");
  const container = new TFile("Mote/2026/2026.md", "y");
  f.files.set(outside.path, outside);
  f.files.set(container.path, container);
  await f.store.reloadAll();
  assert.equal(f.store.getAll().length, 0);
  assert.equal(f.store.isInFolder(outside), false);
  assert.equal(f.store.isInFolder(container), false);
});
