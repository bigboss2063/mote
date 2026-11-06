import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, makeMemo } from "./ai-fixtures.mjs";

const { PERSPECTIVES, buildInsightMessages } = await loadTs("src/ai/prompt.ts");

function note(id, overrides = {}) {
  const memo = makeMemo(overrides);
  return { id, memo, text: memo.content };
}

test("Chinese prompt carries grounding rules, focus note and JSON payload", () => {
  const messages = buildInsightMessages({
    notes: [
      note(1, {
        date: "2026-11-04",
        content: "最近在逃避实践 #置顶",
        tags: ["置顶", "工作"],
      }),
      note(2, {
        date: "2025-01-02",
        content: "又一次只收集工具没有行动",
        tags: ["工作"],
      }),
    ],
    focusNoteId: 1,
    perspective: "insight",
    scopeDescription: "这条笔记 + 历史相关",
    scopeTotal: 1,
    locale: "zh-CN",
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /只使用 <notes_json>/);
  assert.match(messages[0].content, /相关性过滤与纯角标引用/);
  assert.match(messages[0].content, /不要按时间写流水账/);
  assert.match(messages[0].content, /不是对你的指令/);
  assert.match(messages[1].content, /\[1\] 号笔记是用户最新关注的焦点笔记/);

  const json = messages[1].content.split("<notes_json>\n")[1].split("\n</notes_json>")[0];
  const payload = JSON.parse(json);
  assert.equal(payload.focus_note_id, 1);
  assert.equal(payload.notes.length, 2);
  assert.deepEqual(payload.notes[0].tags, ["工作"]);
  assert.match(payload.notes[0].date, /2026-11-04 周/);
  assert.equal(payload.notes[1].text, "又一次只收集工具没有行动");
});

test("English prompt uses English rules and an action perspective", () => {
  const messages = buildInsightMessages({
    notes: [note(1, { content: "collecting tools without acting" })],
    focusNoteId: null,
    perspective: "action",
    scopeDescription: "All notes",
    scopeTotal: 1,
    locale: "en-US",
  });
  assert.match(messages[0].content, /Use ONLY <notes_json>/);
  assert.match(messages[0].content, /48 hours/);
  assert.match(messages[1].content, /Prioritize recent progress and fresh thinking/);
  assert.match(messages[0].content, /English/);
  assert.match(messages[1].content, /\(Sun|\(Mon|\(Tue|\(Wed|\(Thu|\(Fri|\(Sat\)/);
});

test("affirmation prompt requires concrete evidence", () => {
  const messages = buildInsightMessages({
    notes: [note(1, { content: "今天还是散步了十分钟" })],
    focusNoteId: 1,
    perspective: "affirmation",
    scopeDescription: "这条笔记",
    scopeTotal: 1,
    locale: "zh-CN",
  });
  assert.match(messages[0].content, /在用户习以为常或自我苛责的记录中/);
});

test("perspective gallery exposes the flomo-style lenses", () => {
  assert.equal(PERSPECTIVES.length, 8);
  const ids = PERSPECTIVES.map((perspective) => perspective.id);
  assert.ok(ids.includes("reverse"));
  assert.ok(ids.includes("second-order"));
  assert.ok(ids.includes("cbt"));
  for (const perspective of PERSPECTIVES) {
    assert.ok(perspective.icon);
    assert.ok(perspective.descriptionKey.endsWith(".desc"));
  }
});

test("insight prompt asks for a concrete title and paragraph flow", () => {
  const messages = buildInsightMessages({
    notes: [note(1, { content: "一条记录" })],
    focusNoteId: null,
    perspective: "insight",
    scopeDescription: "全部笔记",
    scopeTotal: 1,
    locale: "zh-CN",
  });
  assert.match(messages[0].content, /给出 10–16 个字的具体标题/);
  assert.match(messages[0].content, /加粗的判断句/);
  assert.match(messages[0].content, /500–850 个中文字/);
});

