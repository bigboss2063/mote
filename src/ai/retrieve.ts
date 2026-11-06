import type { Memo } from "../types";
import { RESERVED_TAGS } from "../types";
import { stripMemoTags } from "../parser";
import type { PromptNote } from "./types";

const DEFAULT_MAX_RELATED = 20;
const DEFAULT_MAX_SCOPE_NOTES = 24;
const DEFAULT_MAX_CHARS_PER_NOTE = 900;
const DEFAULT_MAX_TOTAL_CHARS = 20000;

export interface RetrieveOptions {
  maxRelated?: number;
  maxScopeNotes?: number;
  maxCharsPerNote?: number;
  maxTotalChars?: number;
}

interface MemoText {
  memo: Memo;
  text: string;
}

interface ScoredMemo extends MemoText {
  score: number;
}

export function memoKey(memo: Memo): string {
  // 一 memo 一文件：文件路径就是稳定 id。
  return memo.file;
}

/** Keep the payload close to what the user wrote: drop images, URLs and tag
 *  suffixes (tags are passed separately), then cap each note. */
export function cleanMemoText(content: string, maxChars = DEFAULT_MAX_CHARS_PER_NOTE): string {
  let text = stripMemoTags(content).text;
  text = text
    .replace(/!\[\[[^\]\n]+\]\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/https?:\/\/[^\s)>\]]+/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (maxChars > 0 && text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }
  return text;
}

/** Chinese is tokenized as overlapping bigrams, Latin as words. This is
 *  deliberately dependency-free; IDF below removes the noise from common
 *  bigrams such as 今天/觉得. */
export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];
  const latin = normalized.match(/[a-z0-9][a-z0-9_'-]*/g) ?? [];
  for (const word of latin) {
    if (word.length >= 2) tokens.push(word);
  }
  const cjkRuns = normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

function buildIdf(tokenSets: Set<string>[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const set of tokenSets) {
    for (const token of set) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const total = Math.max(1, tokenSets.length);
  const idf = new Map<string, number>();
  for (const [token, count] of df) {
    idf.set(token, Math.log((total + 1) / (count + 1)) + 1);
  }
  return idf;
}

function weightedJaccard(a: Set<string>, b: Set<string>, idf: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  let union = 0;
  for (const token of a) {
    const weight = idf.get(token) ?? 1;
    union += weight;
    if (b.has(token)) intersection += weight;
  }
  for (const token of b) {
    if (!a.has(token)) union += idf.get(token) ?? 1;
  }
  return union > 0 ? intersection / union : 0;
}

export function tagsOf(memo: Memo): string[] {
  return memo.tags.filter((tag) => !RESERVED_TAGS.has(tag)).map((tag) => tag.toLowerCase());
}

export function expandedTags(tags: string[]): Set<string> {
  const result = new Set<string>();
  for (const tag of tags) {
    const parts = tag.split("/");
    for (let i = 1; i <= parts.length; i++) result.add(parts.slice(0, i).join("/"));
  }
  return result;
}

function topLevelTags(tags: string[]): string[] {
  return tags.map((tag) => tag.split("/")[0]);
}

function tagJaccard(aTags: string[], bTags: string[]): number {
  const a = expandedTags(aTags);
  const b = expandedTags(bTags);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const tag of a) if (b.has(tag)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function sortChronological(a: MemoText, b: MemoText): number {
  const delta = a.memo.datetime.getTime() - b.memo.datetime.getTime();
  return delta !== 0 ? delta : memoKey(a.memo).localeCompare(memoKey(b.memo));
}

function sortScoreDesc(a: ScoredMemo, b: ScoredMemo): number {
  if (b.score !== a.score) return b.score - a.score;
  const delta = b.memo.datetime.getTime() - a.memo.datetime.getTime();
  return delta !== 0 ? delta : memoKey(a.memo).localeCompare(memoKey(b.memo));
}

function assemble(
  records: MemoText[],
  maxCount: number,
  maxTotalChars: number
): PromptNote[] {
  const notes: PromptNote[] = [];
  let usedChars = 0;
  for (const record of records) {
    if (notes.length >= maxCount) break;
    if (!record.text) continue;
    if (notes.length > 0 && usedChars + record.text.length > maxTotalChars) continue;
    notes.push({ id: notes.length + 1, memo: record.memo, text: record.text });
    usedChars += record.text.length;
  }
  return notes;
}

function pickDiverse(scored: ScoredMemo[], limit: number): ScoredMemo[] {
  const selected: ScoredMemo[] = [];
  const selectedKeys = new Set<string>();
  const dates = new Set<string>();
  const tagCounts = new Map<string, number>();
  const maxTagShare = Math.max(2, Math.floor(limit * 0.5));

  const add = (item: ScoredMemo, enforce: boolean): void => {
    if (selected.length >= limit || selectedKeys.has(memoKey(item.memo))) return;
    if (enforce) {
      if (dates.has(item.memo.date)) return;
      for (const tag of topLevelTags(tagsOf(item.memo))) {
        if ((tagCounts.get(tag) ?? 0) >= maxTagShare) return;
      }
    }
    selected.push(item);
    selectedKeys.add(memoKey(item.memo));
    dates.add(item.memo.date);
    for (const tag of topLevelTags(tagsOf(item.memo))) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  };

  for (const item of scored) add(item, true);
  for (const item of scored) add(item, false);
  return selected;
}

/**
 * Single-memo insight: use the memo as the query, retrieve related notes across
 * the whole history, then let the model trace patterns. No embedding index in
 * v1; tags + IDF-weighted bigram overlap are enough for short memos.
 */
export function selectRelatedNotes(
  seed: Memo,
  allMemos: Memo[],
  options: RetrieveOptions = {}
): PromptNote[] {
  const maxRelated = options.maxRelated ?? DEFAULT_MAX_RELATED;
  const maxCharsPerNote = options.maxCharsPerNote ?? DEFAULT_MAX_CHARS_PER_NOTE;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const seedText = cleanMemoText(seed.content, maxCharsPerNote);
  if (!seedText) return [];

  const seedKey = memoKey(seed);
  const records: MemoText[] = [];
  for (const memo of allMemos) {
    if (memoKey(memo) === seedKey) continue;
    const text = cleanMemoText(memo.content, maxCharsPerNote);
    if (text) records.push({ memo, text });
  }
  if (records.length === 0) {
    return assemble([{ memo: seed, text: seedText }], 1, maxTotalChars);
  }

  const seedTokens = new Set(tokenize(seedText));
  const recordTokens = records.map((record) => new Set(tokenize(record.text)));
  const idf = buildIdf([seedTokens, ...recordTokens]);
  const seedTags = tagsOf(seed);

  const scored: ScoredMemo[] = records.map((record, index) => {
    const tagScore = tagJaccard(seedTags, tagsOf(record.memo));
    const textScore = weightedJaccard(seedTokens, recordTokens[index], idf);
    const starredBonus = record.memo.isStarred ? 0.05 : 0;
    return { ...record, score: tagScore * 0.55 + textScore * 0.4 + starredBonus };
  });
  scored.sort(sortScoreDesc);

  const related = pickDiverse(scored.filter((item) => item.score > 0), maxRelated)
    .sort(sortChronological);
  return assemble(
    [{ memo: seed, text: seedText }, ...related],
    maxRelated + 1,
    maxTotalChars
  );
}

function sampleAcrossMonths(records: MemoText[], limit: number): MemoText[] {
  const byMonth = new Map<string, MemoText[]>();
  for (const record of records) {
    const key = record.memo.date.slice(0, 7);
    const list = byMonth.get(key) ?? [];
    list.push(record);
    byMonth.set(key, list);
  }
  for (const list of byMonth.values()) {
    list.sort((a, b) => {
      const starred = Number(b.memo.isStarred) - Number(a.memo.isStarred);
      if (starred !== 0) return starred;
      const tags = b.memo.tags.length - a.memo.tags.length;
      if (tags !== 0) return tags;
      const length = b.text.length - a.text.length;
      if (length !== 0) return length;
      return sortChronological(b, a);
    });
  }

  const monthKeys = [...byMonth.keys()].sort();
  const picked: MemoText[] = [];
  const usedKeys = new Set<string>();
  const addMonth = (key: string): void => {
    if (picked.length >= limit || usedKeys.has(key)) return;
    const first = byMonth.get(key)?.[0];
    if (!first) return;
    usedKeys.add(key);
    picked.push(first);
  };

  if (monthKeys.length >= limit) {
    for (let i = 0; i < limit; i++) {
      const index = limit === 1 ? 0 : Math.round((i * (monthKeys.length - 1)) / (limit - 1));
      addMonth(monthKeys[index]);
    }
    for (const key of monthKeys) {
      if (picked.length >= limit) break;
      addMonth(key);
    }
  } else {
    let round = 0;
    while (picked.length < limit) {
      let added = false;
      for (const key of monthKeys) {
        const item = byMonth.get(key)?.[round];
        if (!item) continue;
        picked.push(item);
        added = true;
        if (picked.length >= limit) break;
      }
      if (!added) break;
      round++;
    }
  }

  if (picked.length < limit) {
    const used = new Set(picked.map((item) => memoKey(item.memo)));
    for (const record of records) {
      if (picked.length >= limit) break;
      if (!used.has(memoKey(record.memo))) {
        picked.push(record);
        used.add(memoKey(record.memo));
      }
    }
  }
  return picked.sort(sortChronological);
}

/** Group insight: respect the user's current filter, but cap the context and
 *  keep coverage across months instead of sending the latest N notes. */
export function selectScopeNotes(
  scopeMemos: Memo[],
  options: RetrieveOptions = {}
): PromptNote[] {
  const maxScopeNotes = options.maxScopeNotes ?? DEFAULT_MAX_SCOPE_NOTES;
  const maxCharsPerNote = options.maxCharsPerNote ?? DEFAULT_MAX_CHARS_PER_NOTE;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const records: MemoText[] = [];
  for (const memo of scopeMemos) {
    const text = cleanMemoText(memo.content, maxCharsPerNote);
    if (text) records.push({ memo, text });
  }
  if (records.length === 0) return [];
  records.sort(sortChronological);
  const selected =
    records.length <= maxScopeNotes ? records : sampleAcrossMonths(records, maxScopeNotes);
  return assemble(selected, maxScopeNotes, maxTotalChars);
}
