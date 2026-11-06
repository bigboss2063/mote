// ================= Memo 解析器 =================
// 一条 memo 一个文件：文件名即日期时间，文件内容即正文。
// 没有容器语法，没有 frontmatter —— 停用插件后这些文件仍然是普通 md。

import { Memo, PIN_TAG, STAR_TAG } from "./types";

const WEEKDAY_NAMES = {
  "zh-CN": ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
  "en-US": ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
} as const;

/** 按 locale 取星期名（0 = 周日）。 */
export function weekdayName(locale: "zh-CN" | "en-US", day: number): string {
  return WEEKDAY_NAMES[locale][day];
}

/** `2026-04-25 12.43.md`；同一分钟的第二条是 `... 12.43.01.md`。 */
const MEMO_FILE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})(?:\.(\d{2}))?\.md$/;

export interface MemoFileInfo {
  /** yyyy-MM-dd */
  date: string;
  /** HH:mm */
  time: string;
}

/** 从文件路径解析日期时间；不是 memo 文件则返回 null。 */
export function memoFileInfo(filePath: string): MemoFileInfo | null {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const m = name.match(MEMO_FILE_RE);
  if (!m) return null;
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: `${m[4]}:${m[5]}`,
  };
}

/** 文件路径 → `[[wikilink]]` 目标名（不含目录与扩展名）。 */
export function memoLinkName(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  return name.replace(/\.md$/, "");
}

/** 生成 memo 文件路径。index > 0 表示同一分钟的冲突序号（.01 / .02）。 */
export function memoFilePath(
  folder: string,
  date: string,
  time: string,
  index = 0
): string {
  const [hour, minute] = time.split(":");
  const suffix = index > 0 ? `.${index.toString().padStart(2, "0")}` : "";
  return `${folder}/${date.slice(0, 4)}/${date} ${hour}.${minute}${suffix}.md`;
}

/** 去掉首尾空行，并把换行统一成 \n。 */
export function normalizeMemoBody(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

/** 解析一个 memo 文件；文件名不符合 `YYYY-MM-DD HH.mm.md` 时返回 null。 */
export function parseMemoFile(filePath: string, raw: string): Memo | null {
  const info = memoFileInfo(filePath);
  if (!info) return null;
  const content = normalizeMemoBody(raw);
  const tags = extractTags(content);
  const tasks = detectTasks(content);
  return {
    file: filePath,
    date: info.date,
    time: info.time,
    datetime: parseLocalDateTime(info.date, info.time),
    content,
    tags,
    hasImage: detectImage(content),
    hasLink: detectLink(content),
    isPinned: tags.includes(PIN_TAG),
    isStarred: tags.includes(STAR_TAG),
    hasOpenTask: tasks.open,
    hasClosedTask: tasks.closed,
  };
}

/** 把 "2026-04-25" + "12:43" 解析成本地 Date */
export function parseLocalDateTime(date: string, time: string): Date {
  const [y, mo, d] = date.split("-").map((s) => parseInt(s, 10));
  const [h, mi] = time.split(":").map((s) => parseInt(s, 10));
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

/** 抽取 #tag（支持中文、嵌套如 #父/子） */
function findTags(text: string): Array<{ tag: string; start: number; end: number }> {
  // Link fragments belong to their destination, not the memo's tags. Keep link
  // labels and surrounding prose; never change the stored Markdown itself.
  const tagText = text.replace(
    /!?\[\[[^\]\n]+\]\]|\]\((?:\\.|[^\\()]|\([^()]*\))*\)|^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*|\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]+/gim,
    (link) => " ".repeat(link.length)
  );
  const re = /#([A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff/]*)/g;
  const matches: Array<{ tag: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagText)) !== null) {
    matches.push({ tag: m[1], start: m.index, end: re.lastIndex });
  }
  return matches;
}

export function extractTags(text: string): string[] {
  return [...new Set(findTags(text).map((match) => match.tag))];
}

/** Remove only real tag occurrences, preserving identical fragments in links. */
export function stripMemoTags(content: string, selected?: ReadonlySet<string>): { text: string; tags: string[] } {
  const matches = findTags(content);
  let text = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    if (selected && !selected.has(match.tag)) continue;
    let start = match.start;
    while (start > 0 && /[ \t]/.test(content[start - 1])) start--;
    text = text.slice(0, start) + text.slice(match.end);
  }
  return { text, tags: [...new Set(matches.map((match) => match.tag))] };
}

/** 是否包含图片：Markdown ![](url) 或 Obsidian 风格 ![[xxx.png]] */
export function detectImage(text: string): boolean {
  if (/!\[[^\]]*\]\([^)]+\)/.test(text)) return true;
  if (/!\[\[[^\]]+\.(png|jpe?g|gif|webp|svg|bmp|avif)(\|[^\]]*)?\]\]/i.test(text))
    return true;
  return false;
}

/** v1.5.0: 扫描正文里的任务列表项。
 *   Markdown 规范允许多种缩进和列表符号（- / * / +），需要都支持。
 *   `- [ ]` = 未完成，`- [x]` / `- [X]` = 已完成（有些 md 变体还支持
 *   `- [-]` 表示取消但我们不识别，保持最小集合）。
 *   返回 { open, closed } 分别表示"至少有一个未完成/已完成"的布尔。
 *   一次扫描同时算出两个，比 parser 里再单独跑一遍正则省一次遍历。 */
export function detectTasks(text: string): { open: boolean; closed: boolean } {
  // (?:^|\n) 锚定行首，允许前置空白 \s*，支持 - / * / + 三种列表符号
  const openRe = /(?:^|\n)\s*[-*+]\s+\[ \]\s/;
  const closedRe = /(?:^|\n)\s*[-*+]\s+\[[xX]\]\s/;
  return {
    open: openRe.test(text),
    closed: closedRe.test(text),
  };
}

/** 是否包含链接：http(s) 链接、Markdown 链接、Obsidian wikilink
 *
 * Bug fix (v1.1.3): 之前 `https?://` 裸链正则会匹配 `![](https://x.png)` 括号里的 URL，
 *   导致"只有一张外链图片"的笔记被同时算进"有图片"和"有链接"，两边重复出现。
 *   修复方式：先把所有图片语法（含其 URL 部分）整块剔除，再判断剩余文本里是否还有链接。
 *
 * Bug fix (v1.1.4): 代码块里的 URL 也会被当作链接（如 `http://192.168.1.1:10086`
 *   这种配置示例，本意是字面文本不是可点链接）。现在进一步剔除三段代码内容：
 *     1) ``` ... ``` 代码围栏
 *     2) ~~~ ... ~~~ 代码围栏
 *     3) `...` 行内代码
 *   这样"笔记里只有一张图片 + 一个代码块 URL"就不会再被误判为有链接。
 */
export function detectLink(text: string): boolean {
  const stripped = text
    // 代码块（多行围栏）
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    // 行内代码
    .replace(/`[^`\n]*`/g, "")
    // 图片语法（连 URL 一起剥掉）
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/!\[\[[^\]]+\]\]/g, "");
  if (/\[[^\]]+\]\([^)]+\)/.test(stripped)) return true;
  if (/\[\[[^\]]+\]\]/.test(stripped)) return true;
  if (/https?:\/\/[^\s)]+/.test(stripped)) return true;
  return false;
}

/** 根据 Date 生成本地 yyyy-MM-dd */
export function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 根据 Date 生成本地 HH:mm */
export function fmtTime(d: Date): string {
  const h = d.getHours().toString().padStart(2, "0");
  const mi = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${mi}`;
}

/** 根据 Date 生成中文星期 */
export function fmtWeekday(d: Date): string {
  return weekdayName("zh-CN", d.getDay());
}
