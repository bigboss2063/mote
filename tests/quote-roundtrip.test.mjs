import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

// 正文就是文件内容：写入什么，读回来就是什么（只允许首尾空行被裁掉）。
const bundle = await build({
  entryPoints: ["src/parser.ts"], bundle: true, write: false,
  platform: "node", format: "cjs",
});
const module = {exports: {}};
vm.runInNewContext(bundle.outputFiles[0].text, {module, exports: module.exports});
const {normalizeMemoBody, parseMemoFile, memoFileInfo, memoFilePath, memoLinkName} = module.exports;

const quote = "> [!quote] 2026-10-21 09:00\n> Original text";
const cases = [
  ["ordinary quote", quote + "\n\nFollow-up text"],
  ["multiple blank lines", quote + "\n\n\n\nFollow-up text"],
  ["long quote", quote + "\n" + Array(24).fill("> Original line").join("\n") + "\n\nFollow-up text"],
  ["list and code", quote + "\n\n- Follow-up item\n- [ ] Task\n\n```text\nCode\n```\n\nFollow-up text"],
  ["nested quote", "> [!quote] Second quote\n> > Earlier text\n> More context\n\nFollow-up text"],
  ["thematic break", "Before\n\n---\n\nAfter"],
];

const path = "Mote/2026/2026-10-21 10.00.md";

for (const [name, content] of cases) {
  test(`body survives a file round-trip: ${name}`, () => {
    const body = normalizeMemoBody(content);
    const memo = parseMemoFile(path, `${body}\n`);
    assert.equal(memo.content, body);
    assert.equal(memo.file, path);
    assert.equal(memo.date, "2026-10-21");
    assert.equal(memo.time, "10:00");
  });
}

test("leading and trailing blank lines are trimmed, internal ones stay", () => {
  const body = normalizeMemoBody("\n\nA\n\nB\n\n\n");
  assert.equal(body, "A\n\nB");
  assert.equal(normalizeMemoBody("   \n\n"), "");
});

test("tags and link fragments are read from plain markdown", () => {
  const memo = parseMemoFile(path, "#work/sub [fish](https://example.com/#rd)\n");
  assert.deepEqual([...memo.tags], ["work/sub"]);
});

test("memo file names carry the identity", () => {
  assert.equal(memoFileInfo(path).date, "2026-10-21");
  assert.equal(memoFileInfo(path).time, "10:00");
  assert.equal(memoFileInfo("Mote/2026/2026-10-21 10.00.03.md").time, "10:00");
  assert.equal(memoFileInfo("Mote/2026/2026.md"), null);
  assert.equal(memoFileInfo("Mote/_insights/2026-10-21 10.00 Note.md"), null);
  assert.equal(memoFilePath("Mote", "2026-10-21", "10:00"), path);
  assert.equal(memoFilePath("Mote", "2026-10-21", "10:00", 1), "Mote/2026/2026-10-21 10.00.01.md");
  assert.equal(memoLinkName(path), "2026-10-21 10.00");
});
