import type { Memo } from "../types";

export type PerspectiveId =
  | "insight"
  | "affirmation"
  | "meaning"
  | "action"
  | "question"
  | "reverse"
  | "second-order"
  | "cbt";

/** Excerpt from a vault note a memo explicitly linked or embedded. */
export interface NoteReference {
  /** Wikilink target without the alias, so it lines up with `[[...]]` in the note. */
  link: string;
  text: string;
  /** A previously saved insight. The prompt treats it as background only. */
  kind?: "insight";
}

/** A memo prepared for the model, with its 1-based citation id. */
export interface PromptNote {
  id: number;
  memo: Memo;
  text: string;
  /** One-hop excerpts for links in this memo. Omitted when there are none. */
  references?: NoteReference[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InsightSource {
  id: number;
  memo: Memo;
  excerpt: string;
}

export interface InsightResult {
  markdown: string;
  citedIds: number[];
  sources: InsightSource[];
}

export interface InsightPlan {
  notes: PromptNote[];
  focusNoteId: number | null;
  messages: ChatMessage[];
}

export interface StreamUpdate {
  content: string;
  reasoning: string;
}

export interface ChatCompletionResult {
  content: string;
  reasoning: string;
  streamed: boolean;
}

/** 一条已落盘的洞察文件；`file` 即它的唯一身份。 */
export interface InsightRecord {
  file: string;
  createdAt: number;
  title: string;
  perspectiveLabel: string;
  scopeDescription: string;
  noteCount: number;
  /** 正文（含 `# 标题`，引用是纯文本 `[n]`） */
  markdown: string;
  /** frontmatter 里 sources 顺序，索引 + 1 即 `[n]` 的 n。 */
  sources: string[];
}
