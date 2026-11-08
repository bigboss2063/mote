import assert from "node:assert/strict";
import test from "node:test";
import { loadTs, makeMemo } from "./ai-fixtures.mjs";

const { attachNoteReferences } = await loadTs("src/ai/references.ts");
const { buildInsightMessages } = await loadTs("src/ai/prompt.ts");
const { buildInsightPlan, withNoteReferences } = await loadTs("src/ai/insight.ts");

function note(id, overrides = {}) {
  const memo = makeMemo(overrides);
  return { id, memo, text: overrides.text ?? memo.content };
}

function library(entries) {
  const byLink = new Map(entries.map((entry) => [entry.link, entry]));
  return {
    resolve(linkpath) {
      return byLink.get(linkpath)?.file ?? null;
    },
    async read(file) {
      const entry = entries.find((item) => item.file === file);
      if (!entry) return null;
      if (entry.error) throw new Error(entry.error);
      return entry.content;
    },
  };
}

test("linked vault notes are attached and image or code links are skipped", async () => {
  const notes = [
    note(1, {
      content:
        "对照 [[Projects/计划|↗]] 再看。\n![[shot.png]]\n```\n[[Projects/不要]]\n```\n`[[Projects/也不要]]`",
    }),
  ];
  const enriched = await attachNoteReferences(
    notes,
    library([
      {
        link: "Projects/计划",
        file: "Projects/计划.md",
        content: "---\ntags: [draft]\n---\n下周只推进一件事 #项目\n![[shot.png]]",
      },
      {
        link: "Projects/不要",
        file: "Projects/不要.md",
        content: "代码块里的链接不该被读进来",
      },
      {
        link: "Projects/也不要",
        file: "Projects/也不要.md",
        content: "行内代码也不该被读进来",
      },
    ])
  );

  assert.equal(enriched[0].references.length, 1);
  assert.equal(enriched[0].references[0].link, "Projects/计划");
  assert.match(enriched[0].references[0].text, /下周只推进一件事/);
  assert.ok(!enriched[0].references[0].text.includes("#项目"));
  assert.ok(!enriched[0].references[0].text.includes("shot.png"));
  assert.ok(!enriched[0].references[0].text.includes("tags:"));
});

test("a target already selected as a memo is not copied again", async () => {
  const cited = makeMemo({
    date: "2026-04-25",
    time: "12:43",
    content: "被引用的原文",
  });
  const notes = [
    note(1, { content: `接着 [[${cited.file.replace(/\.md$/, "")}]] 写` }),
    { id: 2, memo: cited, text: cited.content },
  ];
  const enriched = await attachNoteReferences(
    notes,
    library([
      {
        link: cited.file.replace(/\.md$/, ""),
        file: cited.file,
        content: cited.content,
      },
    ])
  );
  assert.equal(enriched, notes);
});

test("heading and block links use that slice of the note", async () => {
  const notes = [
    note(1, {
      content: "看 [[计划#预算]]，还有 [[计划#^abc]]。",
    }),
  ];
  const enriched = await attachNoteReferences(
    notes,
    library([
      {
        link: "计划",
        file: "计划.md",
        content: "# 范围\n整篇开头\n\n## 预算\n只留一块钱\n\n## 其他\n别的\n\n就这一句 ^abc\n\n后面",
      },
    ]),
    { maxRefsPerNote: 2 }
  );
  assert.equal(enriched[0].references[0].link, "计划#预算");
  assert.equal(enriched[0].references[0].text, "只留一块钱");
  assert.equal(enriched[0].references[1].link, "计划#^abc");
  assert.equal(enriched[0].references[1].text, "就这一句");
});

test("markdown embeds are included and a failed read is skipped", async () => {
  const notes = [
    note(1, { content: "嵌入 ![[记录]]，坏链 [[缺失]]。" }),
  ];
  const enriched = await attachNoteReferences(
    notes,
    library([
      { link: "记录", file: "记录.md", content: "嵌入的正文" },
      { link: "缺失", file: "缺失.md", content: "", error: "unreadable" },
    ])
  );
  assert.equal(enriched[0].references.length, 1);
  assert.equal(enriched[0].references[0].text, "嵌入的正文");
});

test("the same excerpt is attached once, with focus notes first", async () => {
  const older = note(1, {
    date: "2026-01-01",
    time: "09:00",
    content: "旧的 [[计划]]",
  });
  const newer = note(2, {
    date: "2026-11-01",
    time: "09:00",
    content: "新的 [[另一篇]]",
  });
  const files = library([
    { link: "计划", file: "计划.md", content: "旧计划正文" },
    { link: "另一篇", file: "另一篇.md", content: "新计划正文" },
  ]);
  const recentFirst = await attachNoteReferences([older, newer], files, {
    maxRefsTotal: 1,
  });
  assert.equal(recentFirst[1].references[0].text, "新计划正文");
  assert.equal(recentFirst[0].references, undefined);

  const focusFirst = await attachNoteReferences([older, newer], files, {
    maxRefsTotal: 1,
    focusNoteId: 1,
  });
  assert.equal(focusFirst[0].references[0].text, "旧计划正文");
  assert.equal(focusFirst[1].references, undefined);
});

test("a repeated link keeps one copy and insights are marked", async () => {
  const notes = [
    note(1, { date: "2026-11-02", content: "再看 [[洞察/旧结论]]" }),
    note(2, { date: "2026-01-01", content: "当时 [[洞察/旧结论|↗]]" }),
  ];
  const enriched = await attachNoteReferences(
    notes,
    library([
      {
        link: "洞察/旧结论",
        file: "Mote/_insights/旧结论.md",
        content: "---\nkind: insight\n---\n# 旧结论\n\n以前这么判断过",
      },
    ])
  );
  assert.equal(enriched[0].references.length, 1);
  assert.equal(enriched[0].references[0].kind, "insight");
  assert.match(enriched[0].references[0].text, /以前这么判断过/);
  assert.equal(enriched[1].references, undefined);
});

test("insight messages include reference excerpts without new citation ids", async () => {
  const seed = makeMemo({
    date: "2026-11-04",
    content: "对照 [[Projects/计划]] 之后，决定只留一件事",
  });
  const input = {
    seed,
    scopeMemos: [seed],
    allMemos: [seed],
    perspective: "insight",
    scopeDescription: "这条笔记",
    locale: "zh-CN",
  };
  const plan = await withNoteReferences(buildInsightPlan(input), input, library([
    { link: "Projects/计划", file: "Projects/计划.md", content: "计划正文：先写完一页" },
  ]));
  const payload = JSON.parse(
    plan.messages[1].content.split("<notes_json>\n")[1].split("\n</notes_json>")[0]
  );
  assert.equal(payload.notes[0].references[0].link, "Projects/计划");
  assert.match(payload.notes[0].references[0].text, /先写完一页/);
  assert.match(plan.messages[0].content, /references 是该条笔记用双链或嵌入点名的库内原文摘录/);
  assert.match(plan.messages[1].content, /角标仍只标笔记 id/);
  assert.equal(plan.notes[0].id, 1);

  const english = buildInsightMessages({
    notes: [
      {
        ...note(1, { content: "see [[Plan]]" }),
        references: [{ link: "Plan", text: "ship one page", kind: "insight" }],
      },
    ],
    focusNoteId: 1,
    perspective: "insight",
    scopeDescription: "this note",
    scopeTotal: 1,
    locale: "en-US",
  });
  const englishPayload = JSON.parse(
    english[1].content.split("<notes_json>\n")[1].split("\n</notes_json>")[0]
  );
  assert.equal(englishPayload.notes[0].references[0].kind, "insight");
  assert.match(english[0].content, /kind "insight"/);
});
