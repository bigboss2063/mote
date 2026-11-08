import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { obsidianStub } from "./obsidian-stub.mjs";

const bundle = await build({
  entryPoints: ["src/quote-suggest.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["obsidian"],
});
const module = {exports: {}};
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, require: () => obsidianStub(),
});
const {findQuoteTrigger, matchQuoteCandidates, matchSnippet, quoteLink, quoteSnippet} = module.exports;

// vm 里造出来的对象/数组原型不同，deepStrictEqual 会判不等，统一转成普通结构
const trigger = (text, pos) => {
  const hit = findQuoteTrigger(text, pos);
  return hit && {start: hit.start, query: hit.query};
};
const times = (all, query) => [...matchQuoteCandidates(all, query).map(c => c.time)];

test("trigger fires on @ at a word boundary, skips emails", () => {
  assert.deepEqual(trigger("@abc", 4), {start: 0, query: "abc"});
  assert.deepEqual(trigger("hi @ab", 6), {start: 3, query: "ab"});
  assert.deepEqual(trigger("今天@小明", 5), {start: 2, query: "小明"});
  assert.deepEqual(trigger("x @a @b", 7), {start: 5, query: "b"});
  assert.equal(findQuoteTrigger("user@example.com", 5), null, "email");
  assert.equal(findQuoteTrigger("a@b", 2), null, "identifier");
  assert.equal(findQuoteTrigger("@a\nb", 4), null, "newline ends the query");
  assert.equal(findQuoteTrigger("no at here", 11), null);
  assert.equal(findQuoteTrigger("[[@memo", 7), null, "unclosed wikilink owns @");
  assert.deepEqual(trigger("[[done]] @x", 11), {start: 9, query: "x"});
});

test("candidates need every token; title hits outrank body hits; newest first", () => {
  const all = [
    {file: "Mote/2026/2026-11-06 10.00.md", title: "2026-11-06 10:00", snippet: "about AI ideas", kind: "memo", time: 5},
    {file: "Mote/2026/2026-11-04 09.00.md", title: "2026-11-04 09:00", snippet: "关于写作和 AI 的关系", kind: "memo", time: 4},
    {file: "Mote/_insights/Pattern.md", title: "Pattern", snippet: "recurring structure", kind: "insight", time: 3},
    {file: "Mote/2026/2026-11-01 08.00.md", title: "2026-11-01 08:00", snippet: "写作方法", kind: "memo", time: 2},
  ];
  // 空查询：最近更新的在前
  assert.equal(matchQuoteCandidates(all, "")[0].time, 5);
  // 多词 AND：只留同时命中的那条
  assert.deepEqual(times(all, "ai 写作"), [4]);
  // 标题命中（日期）排前，即使更旧
  assert.deepEqual(times(all, "11-04"), [4]);
  assert.deepEqual(times(all, "Pattern"), [3]);
  assert.deepEqual(times(all, "nothing"), []);
});

test("search reaches the tail of a long memo (not just the first 80 chars)", () => {
  const long = `${"铺垫".repeat(60)} 关键时刻`;
  const all = [{file: "Mote/2026/a.md", title: "2026-11-06 10:00", snippet: long, kind: "memo", time: 1}];
  assert.equal(matchQuoteCandidates(all, "关键时刻").length, 1);
});

test("displayed snippet centers on the match; long text gets ellipsis", () => {
  const long = `${"x".repeat(120)} KEYWORD ${"y".repeat(120)}`;
  const shown = matchSnippet(long, "keyword");
  assert.ok(shown.includes("KEYWORD"));
  assert.ok(shown.startsWith("…") && shown.endsWith("…"));
  assert.equal(matchSnippet("short text", "text"), "short text");
  assert.equal(matchSnippet("abc".repeat(100), ""), quoteSnippet("abc".repeat(100)));
});

test("inserted link keeps the full path alias format and a one-line snippet", () => {
  assert.equal(quoteLink("Mote/2026/2026-11-06 10.00.md"), "[[Mote/2026/2026-11-06 10.00|↗]]");
  assert.equal(quoteLink("Mote/_insights/Pattern.md"), "[[Mote/_insights/Pattern|↗]]");
  assert.equal(quoteSnippet("a\n\n b   c "), "a b c");
  assert.equal(quoteSnippet("x".repeat(90)).length, 81);
});
