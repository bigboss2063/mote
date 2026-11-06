import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, makeMemo } from "./ai-fixtures.mjs";

const {
  tokenize,
  cleanMemoText,
  selectRelatedNotes,
  selectScopeNotes,
} = await loadTs("src/ai/retrieve.ts");

test("tokenize keeps Chinese bigrams and Latin words", () => {
  const tokens = tokenize("今天天气很好 AI tools");
  assert.ok(tokens.includes("今天"));
  assert.ok(tokens.includes("天气"));
  assert.ok(tokens.includes("ai"));
  assert.ok(tokens.includes("tools"));
});

test("cleanMemoText drops tags, images and URLs before truncating", () => {
  const cleaned = cleanMemoText(
    "一个想法 #灵感 ![[image.png]] https://example.com/very/long/url 继续写",
    20
  );
  assert.ok(!cleaned.includes("#灵感"));
  assert.ok(!cleaned.includes("image.png"));
  assert.ok(!cleaned.includes("https://"));
  assert.ok(cleaned.startsWith("一个想法"));
  assert.ok(cleaned.length <= 20);
});

test("single-memo retrieval prefers tag and text overlap over unrelated notes", () => {
  const seed = makeMemo({
    date: "2026-11-04",
    content: "最近在思考时间管理 #工作",
    tags: ["工作"],
  });
  const related = makeMemo({
    date: "2025-06-01",
    content: "时间管理的核心是留出思考的时间",
    tags: ["工作"],
  });
  const unrelated = makeMemo({
    date: "2025-07-01",
    content: "晚饭吃了牛肉面",
    tags: ["生活"],
  });
  const notes = selectRelatedNotes(seed, [seed, related, unrelated]);
  assert.equal(notes[0].memo, seed);
  assert.equal(notes[1].memo, related);
  assert.ok(!notes.some((note) => note.memo === unrelated));
});

test("cross-tag lexical overlap can retrieve a related note", () => {
  const seed = makeMemo({
    date: "2026-11-04",
    content: "最近总在反思自己的焦虑",
  });
  const related = makeMemo({
    date: "2024-03-02",
    content: "通过自我反思处理焦虑",
    tags: ["阅读"],
  });
  const unrelated = makeMemo({
    date: "2024-04-02",
    content: "今天晚饭很好吃",
    tags: ["生活"],
  });
  const notes = selectRelatedNotes(seed, [seed, related, unrelated]);
  assert.ok(notes.some((note) => note.memo === related));
  assert.ok(!notes.some((note) => note.memo === unrelated));
});

test("related retrieval respects the note cap and keeps the seed", () => {
  const seed = makeMemo({ date: "2026-11-04", content: "共同主题 时间管理", tags: ["工作"] });
  const pool = [seed];
  for (let i = 0; i < 30; i++) {
    pool.push(
      makeMemo({
        date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
        content: `时间管理记录 ${i}`,
        tags: ["工作"],
      })
    );
  }
  const notes = selectRelatedNotes(seed, pool, { maxRelated: 5 });
  assert.equal(notes.length, 6);
  assert.equal(notes[0].memo, seed);
});

test("context budget is never exceeded", () => {
  const seed = makeMemo({ date: "2026-11-04", content: "x".repeat(500), tags: ["工作"] });
  const pool = [seed];
  for (let i = 0; i < 5; i++) {
    pool.push(
      makeMemo({
        date: `2025-0${i + 1}-01`,
        content: "y".repeat(500),
        tags: ["工作"],
      })
    );
  }
  const notes = selectRelatedNotes(seed, pool, {
    maxCharsPerNote: 500,
    maxTotalChars: 1200,
  });
  const total = notes.reduce((sum, note) => sum + note.text.length, 0);
  assert.ok(total <= 1200);
  assert.ok(notes.length >= 1);
});

test("scope sampling spreads across months instead of taking the newest notes", () => {
  const memos = [];
  for (let month = 1; month <= 12; month++) {
    for (let i = 0; i < 2; i++) {
      memos.push(
        makeMemo({
          date: `2025-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`,
          content: `记录 ${month}-${i}`,
          tags: ["工作"],
        })
      );
    }
  }
  const notes = selectScopeNotes(memos, { maxScopeNotes: 6 });
  assert.equal(notes.length, 6);
  assert.equal(new Set(notes.map((note) => note.memo.date.slice(0, 7))).size, 6);
});

test("small scopes are kept whole and chronological", () => {
  const memos = [
    makeMemo({ date: "2025-03-01", content: "第三条" }),
    makeMemo({ date: "2025-01-01", content: "第一条" }),
    makeMemo({ date: "2025-02-01", content: "第二条" }),
  ];
  const notes = selectScopeNotes(memos, { maxScopeNotes: 6 });
  assert.deepEqual([...notes.map((note) => note.text)], ["第一条", "第二条", "第三条"]);
});
