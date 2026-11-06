import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, makeMemo } from "./ai-fixtures.mjs";

const {
  DEFAULT_SCOPE_FILTER,
  filterScopeMemos,
  scopeStats,
  describeScopeFilter,
  hasScopeFilter,
  scopeFilterKey,
} = await loadTs("src/ai/scope.ts");

const now = new Date("2026-11-04T12:00:00");

const memos = [
  makeMemo({
    date: "2026-11-04",
    content: "今天完成报告 #工作",
    tags: ["工作"],
    isStarred: true,
    hasOpenTask: true,
  }),
  makeMemo({
    date: "2026-11-03",
    content: "本周整理会议记录",
    tags: ["工作/会议"],
  }),
  makeMemo({
    date: "2026-10-30",
    content: "上周的旅行计划",
    tags: ["生活/旅行"],
    hasImage: true,
  }),
  makeMemo({
    date: "2025-05-05",
    content: "旧笔记：年度复盘",
    tags: ["复盘"],
    hasLink: true,
  }),
  makeMemo({
    date: "2026-11-04",
    content: "随手记一句",
    tags: [],
  }),
];

function filter(overrides = {}) {
  return filterScopeMemos(memos, { ...DEFAULT_SCOPE_FILTER, ...overrides }, now);
}

test("scope type presets match the main list semantics", () => {
  assert.equal(
    filter({ type: "today" })
      .map((memo) => memo.content)
      .join("|"),
    "今天完成报告 #工作|随手记一句"
  );
  assert.equal(filter({ type: "week" }).length, 3);
  assert.equal(filter({ type: "starred" }).length, 1);
  assert.equal(filter({ type: "todo" }).length, 1);
  assert.equal(filter({ type: "with-image" }).length, 1);
  assert.equal(filter({ type: "with-link" }).length, 1);
  assert.equal(filter({ type: "no-tag" }).length, 1);
});

test("year, date, tag prefix and advanced keyword filters compose", () => {
  assert.equal(filter({ year: "2025" }).length, 1);
  assert.equal(filter({ date: "2026-11-03" }).length, 1);
  assert.equal(filter({ tag: "生活" }).length, 1);
  assert.equal(filter({ tag: "工作" }).length, 2);
  assert.equal(filter({ keyword: "#工作" }).length, 2);
  assert.equal(filter({ keyword: "报告 -旅行" }).length, 1);
  assert.equal(filter({ keyword: "date:2025" }).length, 1);
  assert.equal(
    filter({ year: "2026", tag: "工作", keyword: "报告" }).length,
    1
  );
});

test("scope stats count notes, distinct tags and distinct days", () => {
  const stats = scopeStats(memos);
  assert.equal(stats.notes, 5);
  assert.equal(stats.tags, 4);
  assert.equal(stats.days, 4);
});

test("scope description and dirty checks stay in sync", () => {
  assert.equal(describeScopeFilter(DEFAULT_SCOPE_FILTER), "全部笔记");
  assert.match(
    describeScopeFilter({
      type: "starred",
      year: "2026",
      date: null,
      tag: "工作",
      keyword: "报告",
    }),
    /收藏.*2026.*#工作.*报告/
  );
  assert.equal(hasScopeFilter(DEFAULT_SCOPE_FILTER), false);
  assert.equal(hasScopeFilter({ ...DEFAULT_SCOPE_FILTER, year: "2026" }), true);
  assert.notEqual(
    scopeFilterKey(DEFAULT_SCOPE_FILTER),
    scopeFilterKey({ ...DEFAULT_SCOPE_FILTER, keyword: "x" })
  );
});
