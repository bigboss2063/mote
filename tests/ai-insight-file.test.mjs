import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./ai-fixtures.mjs";

class TFile {
  constructor(path, content = "") {
    this.path = path;
    this.name = path.split("/").at(-1);
    this.basename = this.name.replace(/\.md$/, "");
    this.extension = "md";
    this.content = content;
    this.stat = {mtime: 0};
  }
}

function fixture(seed = []) {
  const files = new Map();
  const created = [];
  const trashed = [];
  const folders = new Set();
  for (const [path, content] of seed) files.set(path, new TFile(path, content));
  const vault = {
    getMarkdownFiles: () => [...files.values()],
    getAbstractFileByPath: path => files.get(path),
    cachedRead: async file => file.content,
    create: async (path, content) => {
      const file = new TFile(path, content);
      files.set(path, file);
      created.push(file);
      return file;
    },
    createFolder: async path => { folders.add(path); },
    trash: async (file, system) => {
      trashed.push([file.path, system]);
      files.delete(file.path);
    },
  };
  const fileManager = {trashFile: async file => { trashed.push([file.path, "trashFile"]); files.delete(file.path); }};
  return {vault, fileManager, files, created, trashed, folders};
}

const settings = {folder: "Mote"};
const draft = (overrides = {}) => ({
  createdAt: new Date(2026, 10, 6, 0, 12).getTime(),
  title: "关于引用",
  perspectiveLabel: "下一步",
  scopeDescription: "全部笔记",
  noteCount: 3,
  markdown: "# 关于引用\n\n第一条 [1]\n第二条 [2]",
  sources: ["2026-11-02 17.17", "2026-11-03 12.59"],
  ...overrides,
});

test("insight is saved as one markdown file with frontmatter", async () => {
  const f = fixture();
  const {saveInsightRecord} = await loadTs(
    "src/ai/insight-file.ts",
    () => ({TFile, normalizePath: p => p}),
    {console}
  );
  const record = await saveInsightRecord({vault: f.vault}, settings, draft());
  const path = "Mote/_insights/2026-11-06 00.12 关于引用.md";
  assert.equal(record.file, path);
  const raw = f.files.get(path).content;
  assert.match(raw, /^---\nmote: insight\ncreated: 2026-11-06T00:12\n/);
  assert.match(raw, /title: "关于引用"/);
  assert.match(raw, /kind: "下一步"/);
  assert.match(raw, /scope: "全部笔记"\nnotes: 3\nsources:\n {2}- "\[\[2026-11-02 17\.17\]\]"/);
  assert.match(raw, /^# 关于引用$/m);
  assert.equal(record.markdown, "# 关于引用\n\n第一条 [1]\n第二条 [2]");
});

test("titles are made file-safe and duplicates get a suffix", async () => {
  const f = fixture();
  const {saveInsightRecord} = await loadTs("src/ai/insight-file.ts", () => ({TFile, normalizePath: p => p}));
  const first = await saveInsightRecord({vault: f.vault}, settings,
    draft({title: "a/b: c? #d"}));
  const second = await saveInsightRecord({vault: f.vault}, settings,
    draft({title: "a/b: c? #d"}));
  assert.match(first.file, /2026-11-06 00\.12 a b c d\.md$/);
  assert.match(second.file, /2026-11-06 00\.12 a b c d 2\.md$/);
});

test("loading reads frontmatter and sorts newest first", async () => {
  const f = fixture([
    ["Mote/_insights/2026-11-01 10.00 旧.md", "---\ncreated: 2026-11-01T10:00\ntitle: \"旧\"\nnotes: 2\n---\n\n# 旧\n\n正文"],
    ["Mote/_insights/2026-11-05 10.00 新.md", "---\ncreated: 2026-11-05T10:00\ntitle: \"新\"\nkind: \"行动\"\n---\n\n# 新\n\n正文"],
    ["Mote/2026/2026-11-05 10.00.md", "普通 memo"],
  ]);
  const {loadInsightRecords} = await loadTs("src/ai/insight-file.ts", () => ({TFile, normalizePath: p => p}));
  const records = await loadInsightRecords({vault: f.vault}, settings);
  assert.equal(records.length, 2);
  assert.equal(records[0].title, "新");
  assert.equal(records[0].perspectiveLabel, "行动");
  assert.equal(records[1].noteCount, 2);
  assert.equal(records[1].markdown, "# 旧\n\n正文");
});

test("deleting an insight goes through Obsidian's trash", async () => {
  const f = fixture([
    ["Mote/_insights/2026-11-01 10.00 旧.md", "---\ntitle: \"旧\"\n---\n\n# 旧\n"],
  ]);
  const {loadInsightRecords, deleteInsightRecord} = await loadTs(
    "src/ai/insight-file.ts", () => ({TFile, normalizePath: p => p}));
  const [record] = await loadInsightRecords({vault: f.vault}, settings);
  await deleteInsightRecord({vault: f.vault, fileManager: f.fileManager}, record);
  assert.deepEqual(f.trashed, [["Mote/_insights/2026-11-01 10.00 旧.md", "trashFile"]]);
  assert.equal(f.vault.getAbstractFileByPath(record.file), undefined);
});
