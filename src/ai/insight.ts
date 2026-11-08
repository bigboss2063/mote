import type { Memo } from "../types";
import type { Locale } from "./prompt";
import { buildInsightMessages } from "./prompt";
import { validateCitations } from "./citations";
import { InsightError } from "./errors";
import { attachNoteReferences, type ReferenceLookup } from "./references";
import { selectRelatedNotes, selectScopeNotes } from "./retrieve";
import type {
  InsightPlan,
  InsightResult,
  InsightSource,
  PerspectiveId,
  PromptNote,
} from "./types";

export interface InsightInput {
  seed?: Memo;
  scopeMemos: Memo[];
  allMemos: Memo[];
  perspective: PerspectiveId;
  scopeDescription: string;
  locale: Locale;
}

export function buildInsightPlan(input: InsightInput): InsightPlan {
  const notes = input.seed
    ? selectRelatedNotes(input.seed, input.allMemos)
    : selectScopeNotes(input.scopeMemos);
  if (notes.length === 0) throw new InsightError("empty_scope");

  const focusNoteId = input.seed ? 1 : null;
  const scopeTotal = input.seed ? input.allMemos.length : input.scopeMemos.length;
  return {
    notes,
    focusNoteId,
    messages: buildInsightMessages({
      notes,
      focusNoteId,
      perspective: input.perspective,
      scopeDescription: input.scopeDescription,
      scopeTotal,
      locale: input.locale,
    }),
  };
}

/** Re-read one hop of wikilinks on the selected notes and rebuild the prompt. */
export async function withNoteReferences(
  plan: InsightPlan,
  input: InsightInput,
  lookup: ReferenceLookup
): Promise<InsightPlan> {
  const notes = await attachNoteReferences(plan.notes, lookup, {
    focusNoteId: plan.focusNoteId,
  });
  if (!notes.some((note) => note.references?.length)) return plan;
  const scopeTotal = input.seed ? input.allMemos.length : input.scopeMemos.length;
  return {
    notes,
    focusNoteId: plan.focusNoteId,
    messages: buildInsightMessages({
      notes,
      focusNoteId: plan.focusNoteId,
      perspective: input.perspective,
      scopeDescription: input.scopeDescription,
      scopeTotal,
      locale: input.locale,
    }),
  };
}

function excerptOf(note: PromptNote): string {
  const text = note.text.replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

export function renumberCitations(
  markdown: string,
  idsInOrder: number[]
): { markdown: string; idMap: Map<number, number> } {
  const idMap = new Map(idsInOrder.map((id, index) => [id, index + 1]));
  const remapped = markdown.replace(/\[(\d+)\]/g, (match, rawId: string) => {
    const next = idMap.get(Number(rawId));
    return next === undefined ? match : `[${next}]`;
  });
  return { markdown: remapped, idMap };
}

export function extractInsightSources(
  markdown: string,
  notes: PromptNote[]
): InsightSource[] {
  const validIds = new Set(notes.map((note) => note.id));
  const checked = validateCitations(markdown, validIds);
  const byId = new Map(notes.map((note) => [note.id, note]));
  return checked.citedIds
    .map((id, index) => {
      const note = byId.get(id);
      return note
        ? { id: index + 1, memo: note.memo, excerpt: excerptOf(note) }
        : null;
    })
    .filter((source): source is InsightSource => source !== null);
}

export function finalizeInsight(markdown: string, notes: PromptNote[]): InsightResult {
  const validIds = new Set(notes.map((note) => note.id));
  const checked = validateCitations(markdown, validIds);
  const renumbered = renumberCitations(checked.markdown, checked.citedIds);
  const sources = extractInsightSources(checked.markdown, notes);
  return {
    markdown: renumbered.markdown,
    citedIds: checked.citedIds.map((_, index) => index + 1),
    sources,
  };
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/^[-+>\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer the model's `# title`; fall back to the first concrete line, then
 *  to the perspective label so history entries are always readable. */
export function extractInsightTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/m);
  if (heading) {
    const title = cleanTitle(heading[1]);
    if (title) return title;
  }
  const firstLine = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  if (firstLine) {
    const title = cleanTitle(firstLine.replace(/\[\d+\]/g, ""));
    if (title) {
      return title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title;
    }
  }
  return fallback;
}
