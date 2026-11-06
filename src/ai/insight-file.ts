// ================= 洞察文件 =================
// 一条洞察一个 md 文件：frontmatter 记元信息与来源 memo（`[[...]]`），正文里
// 的引用保持纯文本 `[n]`，靠渲染时按 sources 顺序映射成可点的引用按钮。

import { App, TFile, normalizePath } from "obsidian";
import type { MemoriaSettings } from "../types";
import { fmtDate, fmtTime } from "../parser";
import type { InsightRecord } from "./types";

/** 洞察保存的目录：`<folder>/_insights/`（下划线开头，不会被当成 memo）。 */
export function insightFolder(settings: MemoriaSettings): string {
  return `${normalizePath(settings.folder)}/_insights`;
}

/** 去掉正文开头的一级标题（标题已经显示在文档头部）。 */
export function stripLeadingTitle(markdown: string): string {
  return markdown.replace(/^\s{0,3}#{1,6}[ \t]+[^\n]*\n+/, "");
}

/** 文件名里不能出现的字符，换成空格。 */
const INVALID_TITLE_CHARS = /[\\/:*?"<>|#^[\]]/g;

function fileSafeTitle(title: string): string {
  const cleaned = title
    .replace(INVALID_TITLE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  return cleaned.slice(0, 60).trim() || "洞察";
}

/** JSON 字符串就是合法的 YAML 双引号字符串。 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** 本地时间 `2026-11-06T00:12`（带时区反而会让 Obsidian 属性显示成 UTC）。 */
function localIso(createdAt: number): string {
  const d = new Date(createdAt);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stampName(createdAt: number): string {
  const d = new Date(createdAt);
  return `${fmtDate(d)} ${fmtTime(d).replace(":", ".")}`;
}

export interface InsightDraft {
  createdAt: number;
  title: string;
  /** 视角名，如「下一步」。 */
  perspectiveLabel: string;
  scopeDescription: string;
  noteCount: number;
  /** 含 `# 标题` 的正文，引用保持纯文本 `[n]`。 */
  markdown: string;
  /** 被引用的 memo 文件名（不含目录与 .md），写进 frontmatter 的 sources。 */
  sources: string[];
}

/** 把洞察写成 `<folder>/_insights/<日期 时间> <标题>.md`。 */
export async function saveInsightRecord(
  app: App,
  settings: MemoriaSettings,
  draft: InsightDraft
): Promise<InsightRecord> {
  const folder = insightFolder(settings);
  await ensureFolder(app, folder);

  const stamp = stampName(draft.createdAt);
  const base = fileSafeTitle(draft.title);
  let path = `${folder}/${stamp} ${base}.md`;
  for (let i = 2; app.vault.getAbstractFileByPath(path); i++) {
    path = `${folder}/${stamp} ${base} ${i}.md`;
  }

  const body = stripLeadingTitle(draft.markdown).trim();
  const lines = [
    "---",
    "mote: insight",
    `created: ${localIso(draft.createdAt)}`,
    `title: ${yamlString(draft.title)}`,
  ];
  if (draft.perspectiveLabel) {
    lines.push(`kind: ${yamlString(draft.perspectiveLabel)}`);
  }
  if (draft.scopeDescription) {
    lines.push(`scope: ${yamlString(draft.scopeDescription)}`);
  }
  if (draft.noteCount > 0) {
    lines.push(`notes: ${draft.noteCount}`);
  }
  if (draft.sources.length) {
    lines.push("sources:");
    for (const source of draft.sources) {
      lines.push(`  - "[[${source}]]"`);
    }
  }
  lines.push("---", "", `# ${draft.title}`, "");
  if (body) lines.push(body, "");

  await app.vault.create(path, lines.join("\n"));
  return {
    file: path,
    createdAt: draft.createdAt,
    title: draft.title,
    perspectiveLabel: draft.perspectiveLabel,
    scopeDescription: draft.scopeDescription,
    noteCount: draft.noteCount,
    markdown: `# ${draft.title}\n\n${body}`.trim(),
    sources: draft.sources,
  };
}

/** 读取 `_insights/` 下所有洞察，按时间倒序。 */
export async function loadInsightRecords(
  app: App,
  settings: MemoriaSettings
): Promise<InsightRecord[]> {
  const prefix = `${insightFolder(settings)}/`;
  const files = app.vault
    .getMarkdownFiles()
    .filter((file) => file.path.startsWith(prefix));
  const records = await Promise.all(
    files.map(async (file) => {
      try {
        return await readInsightRecord(app, file);
      } catch (error) {
        console.error("[Mote] Failed to read insight:", file.path, error);
        return null;
      }
    })
  );
  return records
    .filter((record): record is InsightRecord => record !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function readInsightRecord(
  app: App,
  file: TFile
): Promise<InsightRecord> {
  const { meta, body } = splitFrontmatter(await app.vault.cachedRead(file));
  const created = typeof meta.created === "string" ? Date.parse(meta.created) : NaN;
  const title =
    (typeof meta.title === "string" && meta.title) ||
    body.match(/^\s{0,3}#{1,6}\s+([^\n]+)/)?.[1]?.trim() ||
    file.basename;
  const notes = typeof meta.notes === "string" ? parseInt(meta.notes, 10) : 0;
  const rawSources = Array.isArray(meta.sources) ? meta.sources : [];
  return {
    file: file.path,
    createdAt: Number.isNaN(created) ? file.stat.mtime : created,
    title,
    perspectiveLabel: typeof meta.kind === "string" ? meta.kind : "",
    scopeDescription: typeof meta.scope === "string" ? meta.scope : "",
    noteCount: Number.isFinite(notes) ? notes : 0,
    markdown: body.trim(),
    sources: rawSources
      .map((value) => value.trim().replace(/^\[\[|\]\]$/g, ""))
      .filter(Boolean),
  };
}

/** 删除一条洞察：交给 Obsidian 的 trashFile（遵循用户的删除设置）。 */
export async function deleteInsightRecord(
  app: App,
  record: InsightRecord
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(record.file);
  if (file instanceof TFile) await app.fileManager.trashFile(file);
}

type FrontmatterValue = string | string[];
type Frontmatter = Record<string, FrontmatterValue>;

/** 极简 frontmatter 解析：只认 `key: value` 与 `key:` + `- item` 列表。 */
function splitFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const text = raw.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { meta: {}, body: text };

  const meta: Frontmatter = {};
  let listKey: string | null = null;
  for (const line of text.slice(4, end).split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      const list = (meta[listKey] as string[]) ?? [];
      list.push(unquote(item[1]));
      meta[listKey] = list;
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!pair) continue;
    const [, key, value] = pair;
    if (value === "") {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = unquote(value);
      listKey = null;
    }
  }
  return { meta, body: text.slice(end + 5) };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}

/** 递归建目录，`_insights` 的父目录可能还不存在（全新 vault）。 */
async function ensureFolder(app: App, folder: string): Promise<void> {
  if (app.vault.getAbstractFileByPath(folder)) return;
  const slash = folder.lastIndexOf("/");
  if (slash > 0) await ensureFolder(app, folder.slice(0, slash));
  if (!app.vault.getAbstractFileByPath(folder)) {
    try {
      await app.vault.createFolder(folder);
    } catch {
      // 并发创建时可能已存在
    }
  }
}
