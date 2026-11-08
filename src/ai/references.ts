// 把入选 memo 里的一层双链展开成摘录，挂回该条笔记。
// 不递归、不把库内笔记变成可引用的 [n]，篇幅单独封顶，避免挤掉 memo 本身。

import type { NoteReference, PromptNote } from "./types";
import { cleanMemoText } from "./retrieve";

const DEFAULT_MAX_REF_CHARS = 500;
const DEFAULT_MAX_REFS_PER_NOTE = 3;
const DEFAULT_MAX_REFS_TOTAL = 8;
const DEFAULT_MAX_REF_CHARS_TOTAL = 4000;
const MIN_REF_CHARS = 80;

const NON_MARKDOWN =
  /\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf|mp4|webm|mp3|wav|canvas|base|excalidraw)$/i;

export interface ReferenceLookup {
  /** Vault path of a markdown file, or null when the link is not a note. */
  resolve(linkpath: string, sourcePath: string): string | null;
  read(file: string): Promise<string | null>;
}

export interface AttachReferenceOptions {
  /** 单条洞察时优先给焦点笔记留额度。 */
  focusNoteId?: number | null;
  maxRefChars?: number;
  maxRefsPerNote?: number;
  maxRefsTotal?: number;
  maxRefCharsTotal?: number;
}

interface ParsedLink {
  /** `path` or `path#heading` / `path#^block`, without alias. */
  link: string;
  linkpath: string;
  heading: string | null;
  block: string | null;
}

/** Wikilinks and markdown embeds outside code. Image embeds are dropped. */
export function parseWikilinks(content: string): ParsedLink[] {
  const masked = maskCode(content);
  const re = /!?\[\[([^\]\n]+)\]\]/g;
  const links: ParsedLink[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const parsed = parseWikilink(match[1]);
    if (parsed) links.push(parsed);
  }
  return links;
}

export async function attachNoteReferences(
  notes: PromptNote[],
  lookup: ReferenceLookup,
  options: AttachReferenceOptions = {}
): Promise<PromptNote[]> {
  const maxRefChars = options.maxRefChars ?? DEFAULT_MAX_REF_CHARS;
  const maxRefsPerNote = options.maxRefsPerNote ?? DEFAULT_MAX_REFS_PER_NOTE;
  const maxRefsTotal = options.maxRefsTotal ?? DEFAULT_MAX_REFS_TOTAL;
  const maxRefCharsTotal = options.maxRefCharsTotal ?? DEFAULT_MAX_REF_CHARS_TOTAL;
  const selected = new Set(notes.map((note) => note.memo.file));
  const seen = new Set<string>();
  const attached = new Map<number, NoteReference[]>();
  let totalRefs = 0;
  let totalChars = 0;

  for (const note of priorityOrder(notes, options.focusNoteId)) {
    if (totalRefs >= maxRefsTotal || totalChars >= maxRefCharsTotal) break;
    const refs: NoteReference[] = [];
    for (const link of parseWikilinks(note.memo.content)) {
      if (refs.length >= maxRefsPerNote || totalRefs >= maxRefsTotal) break;
      const remaining = maxRefCharsTotal - totalChars;
      if (remaining < MIN_REF_CHARS) break;
      const file = lookup.resolve(link.linkpath, note.memo.file);
      if (!file || selected.has(file)) continue;
      const key = `${file}#${link.heading ?? ""}#${link.block ?? ""}`;
      if (seen.has(key)) continue;
      let raw: string | null = null;
      try {
        raw = await lookup.read(file);
      } catch {
        raw = null;
      }
      if (!raw) continue;
      const text = excerptForLink(raw, link, Math.min(maxRefChars, remaining));
      if (!text) continue;
      seen.add(key);
      const reference: NoteReference = { link: link.link, text };
      if (isInsightFile(file)) reference.kind = "insight";
      refs.push(reference);
      totalRefs++;
      totalChars += text.length;
    }
    if (refs.length) attached.set(note.id, refs);
  }

  if (attached.size === 0) return notes;
  return notes.map((note) => {
    const references = attached.get(note.id);
    return references ? { ...note, references } : note;
  });
}

function isInsightFile(file: string): boolean {
  return file.includes("/_insights/") || file.startsWith("_insights/");
}

function priorityOrder(notes: PromptNote[], focusNoteId?: number | null): PromptNote[] {
  return [...notes].sort((a, b) => {
    if (focusNoteId != null) {
      if (a.id === focusNoteId) return -1;
      if (b.id === focusNoteId) return 1;
    }
    return b.memo.datetime.getTime() - a.memo.datetime.getTime();
  });
}

function parseWikilink(inner: string): ParsedLink | null {
  const pipe = inner.indexOf("|");
  const rawTarget = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  if (!rawTarget) return null;
  const hash = rawTarget.indexOf("#");
  const linkpath = normalizeLinkpath(hash >= 0 ? rawTarget.slice(0, hash) : rawTarget);
  const sub = hash >= 0 ? decodeLink(rawTarget.slice(hash + 1).trim()) : "";
  if (!linkpath || isNonMarkdown(linkpath)) return null;
  let heading: string | null = null;
  let block: string | null = null;
  if (sub.startsWith("^")) {
    block = sub.slice(1).trim() || null;
    if (!block) return null;
  } else if (sub) {
    heading = sub;
  }
  const suffix = block ? `#^${block}` : heading ? `#${heading}` : "";
  return { link: `${linkpath}${suffix}`, linkpath, heading, block };
}

function normalizeLinkpath(value: string): string {
  return decodeLink(value).replace(/\.md$/i, "").trim();
}

function decodeLink(value: string): string {
  const unescaped = value.replace(/\\ /g, " ").trim();
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped;
  }
}

function isNonMarkdown(value: string): boolean {
  return NON_MARKDOWN.test(value.trim());
}

function maskCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length))
    .replace(/~~~[\s\S]*?~~~/g, (block) => " ".repeat(block.length))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

function excerptForLink(raw: string, link: ParsedLink, maxChars: number): string {
  const body = stripFrontmatter(raw);
  let slice = body;
  if (link.block) slice = extractBlock(body, link.block) ?? body;
  else if (link.heading) slice = extractHeading(body, link.heading) ?? body;
  const cleaned = cleanMemoText(slice, maxChars);
  if (cleaned) return cleaned;
  if (slice !== body) return cleanMemoText(body, maxChars);
  return "";
}

function stripFrontmatter(text: string): string {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") return normalized;
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return normalized;
  return normalized.slice(end + 4).replace(/^\n/, "");
}

function normalizeHeading(value: string): string {
  return value
    .replace(/\[\[([^\]|#]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[*_`]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function extractHeading(markdown: string, heading: string): string | null {
  const full = normalizeHeading(heading);
  const exact = findSection(markdown, full);
  if (exact) return exact;
  const last = normalizeHeading(heading.split("#").pop() ?? "");
  if (!last || last === full) return null;
  return findSection(markdown, last);
}

function findSection(markdown: string, wanted: string): string | null {
  const lines = markdown.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[i]);
    if (!match) continue;
    if (start < 0) {
      if (normalizeHeading(match[2]) === wanted) {
        start = i + 1;
        level = match[1].length;
      }
      continue;
    }
    if (match[1].length <= level) {
      const section = lines.slice(start, i).join("\n").trim();
      return section || null;
    }
  }
  if (start < 0) return null;
  const section = lines.slice(start).join("\n").trim();
  return section || null;
}

function extractBlock(markdown: string, blockId: string): string | null {
  const lines = markdown.split("\n");
  const marker = new RegExp(`\\^${escapeRegExp(blockId)}\\s*$`);
  const index = lines.findIndex((line) => marker.test(line));
  if (index < 0) return null;
  let start = index;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  let end = index + 1;
  while (end < lines.length && lines[end].trim() !== "") end++;
  const text = lines
    .slice(start, end)
    .join("\n")
    .replace(marker, "")
    .trim();
  return text || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
