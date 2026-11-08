import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { obsidianStub } from "./obsidian-stub.mjs";

const bundle = await build({
  entryPoints: ["src/wiki-suggest.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});
const module = {exports: {}};
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require: () => obsidianStub(),
});
const {findWikiTrigger, isInMemoFolder, matchWikiCandidates, wikiLink} = module.exports;

const trigger = (text, pos) => {
  const hit = findWikiTrigger(text, pos);
  return hit && {start: hit.start, query: hit.query};
};
const files = (all, query) => [...matchWikiCandidates(all, query).map((item) => item.file)];

const notes = [
  {file: "Projects/Plan.md", title: "Plan", folder: "Projects", aliases: ["路线图"], mtime: 3},
  {file: "Archive/plan-old.md", title: "plan-old", folder: "Archive", aliases: [], mtime: 1},
  {file: "Daily.md", title: "Daily", folder: "", aliases: ["日记"], mtime: 5},
  {file: "Projects/Notes/Alpha.md", title: "Alpha", folder: "Projects/Notes", aliases: [], mtime: 4},
];

test("[[ opens an unclosed link and ignores closed links, aliases, and headings", () => {
  assert.deepEqual(trigger("[[", 2), {start: 0, query: ""});
  assert.deepEqual(trigger("see [[计划", 8), {start: 4, query: "计划"});
  assert.deepEqual(trigger("[[done]] [[ab", 13), {start: 9, query: "ab"});
  assert.deepEqual(trigger("![[图", 4), {start: 1, query: "图"});
  assert.equal(findWikiTrigger("[[done]]", 8), null);
  assert.equal(findWikiTrigger("[[hello]]", 7), null, "cursor still inside a closed link");
  assert.equal(findWikiTrigger("[[foo\nbar", 9), null);
  assert.equal(findWikiTrigger("[[a|b", 5), null);
  assert.equal(findWikiTrigger("[[a#b", 5), null);
  assert.equal(findWikiTrigger("no brackets", 11), null);
});

test("memo folder is excluded, neighbouring folders are not", () => {
  assert.equal(isInMemoFolder("Mote/2026/a.md", "Mote"), true);
  assert.equal(isInMemoFolder("Mote/_insights/Pattern.md", "Mote/"), true);
  assert.equal(isInMemoFolder("Mote.md", "Mote"), false);
  assert.equal(isInMemoFolder("Notes/Mote/a.md", "Mote"), false);
  assert.equal(isInMemoFolder("Other/a.md", "Mote"), false);
  assert.equal(isInMemoFolder("a.md", ""), false);
});

test("empty query is newest first; title outranks alias and path", () => {
  assert.deepEqual(files(notes, ""), ["Daily.md", "Projects/Notes/Alpha.md", "Projects/Plan.md", "Archive/plan-old.md"]);
  assert.deepEqual(files(notes, "plan"), ["Projects/Plan.md", "Archive/plan-old.md"]);
  assert.deepEqual(files(notes, "路线"), ["Projects/Plan.md"]);
  assert.deepEqual(files(notes, "日记"), ["Daily.md"]);
  assert.deepEqual(files(notes, "projects alpha"), ["Projects/Notes/Alpha.md"]);
  assert.deepEqual(files(notes, "notes"), ["Projects/Notes/Alpha.md"]);
  assert.deepEqual(files(notes, "nothing"), []);
});

test("inserted link is a wikilink without the .md extension", () => {
  assert.equal(wikiLink("Plan"), "[[Plan]]");
  assert.equal(wikiLink("Projects/Plan.md"), "[[Projects/Plan]]");
  assert.equal(wikiLink("  Daily.md  "), "[[Daily]]");
});
