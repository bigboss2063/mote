import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** 同一个 selector 在样式表里会出现多次（transition 块 + 布局块），全部取出。 */
function blocks(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  assert.ok(all.length, `rule not found: ${selector}`);
  return all.map((m) => m[1]);
}

/** 只要任意一处声明就满足：样式表按块分段，布局不必和 transition 同块。 */
function declares(selector, pattern) {
  return blocks(selector).some((rule) => pattern.test(rule));
}

test("the input toolbar aligns to the top, not the centre", () => {
  // 右侧 submit-wrap 在窄屏因时间框换行变成两行；居中会把左边图标整体压低。
  assert.ok(declares(".memoria-input-toolbar", /align-items:\s*flex-start/));
  assert.ok(
    !declares(".memoria-input-toolbar", /align-items:\s*center/),
    "centre alignment pushes the icon row below the date field's top edge"
  );
});

test("cancel and send share one size", () => {
  assert.ok(declares(".memoria-cancel-btn", /min-width:\s*48px/), "cancel reserves the send width");
  assert.ok(declares(".memoria-cancel-btn", /height:\s*32px/));
  assert.ok(declares(".memoria-root button.memoria-submit-btn", /width:\s*48px/));
  assert.ok(declares(".memoria-root button.memoria-submit-btn", /height:\s*32px/));
  // 宽度不能写死：长文案（如 Abbrechen）应该把按钮撑宽，而不是被裁掉。
  assert.ok(
    !declares(".memoria-cancel-btn", /(?:^|[\s;])width:\s*\d/),
    "cancel must grow instead of clipping its label"
  );
  assert.ok(declares(".memoria-cancel-btn", /white-space:\s*nowrap/));
});

test("the date field matches the action button height", () => {
  assert.ok(declares(".memoria-edit-datetime", /min-height:\s*32px/));
});

test("both insight doc feet sit the same distance from the bottom", () => {
  // 结果页有 .memoria-insight-doc 包裹，历史页没有；留白放在共用的 foot 上。
  assert.ok(
    declares(".memoria-insight-doc-foot", /padding-bottom:\s*18px/),
    "footer owns the bottom gap"
  );
  assert.ok(
    !declares(".memoria-insight-doc", /padding-bottom:\s*\d/),
    "the doc wrapper must not double the gap on the result page"
  );
});
