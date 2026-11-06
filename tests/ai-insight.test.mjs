import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, makeMemo } from "./ai-fixtures.mjs";

const { validateCitations } = await loadTs("src/ai/citations.ts");
const {
  buildInsightPlan,
  finalizeInsight,
  extractInsightTitle,
  extractInsightSources,
} = await loadTs("src/ai/insight.ts");

test("invalid citation ids are removed and valid ids are deduplicated", () => {
  const result = validateCitations("A [1] B [9] C [1] [2]", new Set([1, 2]));
  assert.equal(result.citedIds.join(","), "1,2");
  assert.ok(!result.markdown.includes("[9]"));
  assert.ok(result.markdown.includes("[1]"));
});

test("finalizeInsight maps cited ids to real note excerpts", () => {
  const notes = [
    { id: 1, memo: makeMemo({ date: "2026-11-04", content: "seed" }), text: "seed text" },
    {
      id: 2,
      memo: makeMemo({ date: "2025-01-01", content: "old" }),
      text: "A much longer historical excerpt that should be shortened for the source card.",
    },
  ];
  const result = finalizeInsight("模式 [2]，没有引用 [7]", notes);
  assert.equal(result.citedIds.join(","), "1");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, 1);
  assert.ok(result.sources[0].excerpt.startsWith("A much longer"));
  assert.ok(result.markdown.includes("[1]"));
  assert.ok(!result.markdown.includes("[7]"));
});

test("buildInsightPlan uses the seed as focus and produces two messages", () => {
  const seed = makeMemo({
    date: "2026-11-04",
    content: "最近在思考时间管理",
    tags: ["工作"],
  });
  const related = makeMemo({
    date: "2025-01-01",
    content: "时间管理需要留白",
    tags: ["工作"],
  });
  const plan = buildInsightPlan({
    seed,
    scopeMemos: [seed],
    allMemos: [seed, related],
    perspective: "insight",
    scopeDescription: "这条笔记",
    locale: "zh-CN",
  });
  assert.equal(plan.focusNoteId, 1);
  assert.equal(plan.notes[0].memo, seed);
  assert.equal(plan.messages.length, 2);
});

test("empty scope raises a typed error", () => {
  const empty = makeMemo({ content: "" });
  assert.throws(
    () =>
      buildInsightPlan({
        seed: empty,
        scopeMemos: [empty],
        allMemos: [empty],
        perspective: "insight",
        scopeDescription: "这条笔记",
        locale: "zh-CN",
      }),
    (error) => error.code === "empty_scope"
  );
});

test("insight titles prefer the model heading and fall back safely", () => {
  assert.equal(
    extractInsightTitle("# **把记录留给自己**\n\n正文", "默认"),
    "把记录留给自己"
  );
  assert.equal(
    extractInsightTitle("第一句判断。第二句。", "默认"),
    "第一句判断。第二句。"
  );
  assert.equal(extractInsightTitle("", "默认观点"), "默认观点");
});

test("sources can be rebuilt from cited markdown", () => {
  const notes = [
    { id: 1, memo: makeMemo({ content: "seed" }), text: "seed" },
    { id: 2, memo: makeMemo({ content: "second" }), text: "second" },
  ];
  const sources = extractInsightSources("看到 [2]，也看到 [7]", notes);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 1);
  assert.equal(sources[0].excerpt, "second");
});

test("citations are renumbered from one in first-citation order", () => {
  const notes = [
    { id: 2, memo: makeMemo({ content: "second" }), text: "second" },
    { id: 7, memo: makeMemo({ content: "seventh" }), text: "seventh" },
  ];
  const result = finalizeInsight("先看 [7]，再看 [2] 和 [7]", notes);
  assert.equal(result.citedIds.join(","), "1,2");
  assert.equal(result.sources[0].id, 1);
  assert.equal(result.sources[1].id, 2);
  assert.match(result.markdown, /先看 \[1\]，再看 \[2\] 和 \[1\]/);
});
