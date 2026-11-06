// ================= 相关笔记召回 =================
// 两路信号 + 引用图，用 RRF 融合，不依赖任何外部服务：
//   1. BM25（中英混合分词沿用 retrieve.ts）
//   2. 标签重合度（含层级展开）
//   3. 双向 `[[引用]]`（由调用方用 metadataCache 解析后传入）
//   4. 可选向量余弦（有 embedding 索引时由调用方传入）
// 纯函数，方便单测；调用方负责缓存索引和向量。

import type { Memo } from "../types";
import { cleanMemoText, expandedTags, tagsOf, tokenize } from "./retrieve";
import { cosine } from "./embedding";

const RRF_K = 60;
const MAX_QUERY_TERMS = 80;
/** 余弦低于这个值就不算"语义相关"，避免把弱相关硬塞进来。 */
export const SEMANTIC_MIN_COSINE = 0.35;
const DEFAULT_LIMIT = 6;

export type LinkDirection = "out" | "in" | "both";

export interface RelatedReasons {
  /** 共享的标签（展开层级后的交集） */
  tags: string[];
  /** 共享的检索词（按 IDF 从高到低） */
  terms: string[];
  /** 谁引用了谁：out = 种子引用了对方，in = 对方引用了种子 */
  link: LinkDirection | null;
  /** 仅靠向量余弦入选 */
  semantic: boolean;
}

export interface RelatedItem {
  memo: Memo;
  score: number;
  reasons: RelatedReasons;
}

interface Entry {
  memo: Memo;
  /** token -> 词频 */
  tf: Map<string, number>;
  len: number;
  /** 展开层级后的标签集合，用于打分 */
  tags: Set<string>;
}

export interface LexicalIndex {
  entries: Entry[];
  byFile: Map<string, Entry>;
  idf: Map<string, number>;
  avgLen: number;
}

export interface FindRelatedOptions {
  limit?: number;
  vectors?: Map<string, Float32Array>;
  /** file -> 它引用的 memo 文件集合 */
  links?: Map<string, Set<string>>;
}

function buildEntry(memo: Memo): Entry {
  const text = cleanMemoText(memo.content, 0);
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const tags = tagsOf(memo);
  return { memo, tf, len: tokens.length, tags: expandedTags(tags) };
}

export function buildLexicalIndex(memos: Memo[]): LexicalIndex {
  const entries = memos.map(buildEntry);
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const entry of entries) {
    totalLen += entry.len;
    for (const token of entry.tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const total = Math.max(1, entries.length);
  const idf = new Map<string, number>();
  for (const [token, count] of df) {
    idf.set(token, Math.log(1 + (total - count + 0.5) / (count + 0.5)));
  }
  return {
    entries,
    byFile: new Map(entries.map((entry) => [entry.memo.file, entry])),
    idf,
    avgLen: Math.max(1, totalLen / total),
  };
}

function bm25(entry: Entry, terms: string[], index: LexicalIndex): number {
  const k1 = 1.2;
  const b = 0.75;
  const norm = k1 * (1 - b + (b * entry.len) / index.avgLen);
  let score = 0;
  for (const term of terms) {
    const tf = entry.tf.get(term);
    if (!tf) continue;
    const weight = index.idf.get(term) ?? 0;
    if (weight <= 0) continue;
    score += (weight * (tf * (k1 + 1))) / (tf + norm);
  }
  return score;
}

function tagScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const tag of a) if (b.has(tag)) shared++;
  return shared / (a.size + b.size - shared);
}

function sharedTags(seed: Entry, other: Entry): string[] {
  const shared: string[] = [];
  for (const tag of seed.tags) if (other.tags.has(tag)) shared.push(tag);
  // 越具体的标签越有信息量（"产品/灵感"优于"产品"）
  shared.sort((a, b) => b.length - a.length);
  return shared.slice(0, 2);
}

function topLevelTag(tag: string): string {
  return tag.split("/")[0];
}

function pickDiverse(items: RelatedItem[], limit: number): RelatedItem[] {
  const picked: RelatedItem[] = [];
  const dates = new Map<string, number>();
  const tags = new Map<string, number>();
  const tryAdd = (item: RelatedItem, enforce: boolean): void => {
    if (picked.length >= limit || picked.includes(item)) return;
    const date = item.memo.date;
    if (enforce && (dates.get(date) ?? 0) >= 2) return;
    const itemTags = [...new Set(tagsOf(item.memo).map(topLevelTag))];
    if (enforce) {
      for (const tag of itemTags) if ((tags.get(tag) ?? 0) >= 2) return;
    }
    picked.push(item);
    dates.set(date, (dates.get(date) ?? 0) + 1);
    for (const tag of itemTags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  };
  for (const item of items) tryAdd(item, true);
  for (const item of items) tryAdd(item, false);
  return picked;
}

interface Candidate {
  entry: Entry;
  lexical: number;
  tag: number;
  link: LinkDirection | null;
  cosine: number;
}

function linkDirection(links: Map<string, Set<string>> | undefined, seed: string, other: string): LinkDirection | null {
  if (!links) return null;
  const out = links.get(seed)?.has(other) ?? false;
  const incoming = links.get(other)?.has(seed) ?? false;
  if (out && incoming) return "both";
  if (out) return "out";
  if (incoming) return "in";
  return null;
}

export function findRelated(
  seed: Memo,
  index: LexicalIndex,
  options: FindRelatedOptions = {}
): RelatedItem[] {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const seedEntry = index.byFile.get(seed.file) ?? buildEntry(seed);
  const seedVec = options.vectors?.get(seed.file);
  const seedTerms = new Set(tokenize(cleanMemoText(seed.content, 0)));
  const queryTerms = [...seedTerms]
    .filter((term) => (index.idf.get(term) ?? 0) > 0)
    .sort((a, b) => (index.idf.get(b) ?? 0) - (index.idf.get(a) ?? 0))
    .slice(0, MAX_QUERY_TERMS);

  const candidates: Candidate[] = [];
  for (const entry of index.entries) {
    if (entry.memo.file === seed.file) continue;
    const lexical = bm25(entry, queryTerms, index);
    const tag = tagScore(seedEntry.tags, entry.tags);
    const link = linkDirection(options.links, seed.file, entry.memo.file);
    let cos = 0;
    if (seedVec) {
      const otherVec = options.vectors?.get(entry.memo.file);
      if (otherVec) cos = cosine(seedVec, otherVec);
    }
    if (lexical <= 0 && tag <= 0 && !link && cos < SEMANTIC_MIN_COSINE) continue;
    candidates.push({ entry, lexical, tag, link, cosine: cos });
  }
  if (candidates.length === 0) return [];

  const fused = new Map<string, number>();
  const add = (file: string, weight: number): void => {
    fused.set(file, (fused.get(file) ?? 0) + weight);
  };
  const byScore = (pick: (c: Candidate) => number) =>
    [...candidates].filter((c) => pick(c) > 0).sort((a, b) => pick(b) - pick(a));

  byScore((c) => c.lexical).forEach((c, i) => add(c.entry.memo.file, 1 / (RRF_K + i + 1)));
  byScore((c) => c.tag).forEach((c, i) => add(c.entry.memo.file, 0.8 / (RRF_K + i + 1)));
  byScore((c) => (c.link ? 1 : 0)).forEach((c, i) => add(c.entry.memo.file, 1.6 / (RRF_K + i + 1)));
  byScore((c) => (c.cosine >= SEMANTIC_MIN_COSINE ? c.cosine : 0)).forEach((c, i) =>
    add(c.entry.memo.file, 1.2 / (RRF_K + i + 1))
  );

  const scored = candidates
    .map((candidate) => {
      const { entry } = candidate;
      const terms: string[] = [];
      for (const term of queryTerms) {
        if (term.length < 2 || !entry.tf.has(term)) continue;
        terms.push(term);
      }
      terms.sort((a, b) => (index.idf.get(b) ?? 0) - (index.idf.get(a) ?? 0));
      const item: RelatedItem = {
        memo: entry.memo,
        score: fused.get(entry.memo.file) ?? 0,
        reasons: {
          tags: sharedTags(seedEntry, entry),
          terms: terms.slice(0, 2),
          link: candidate.link,
          semantic: candidate.cosine >= SEMANTIC_MIN_COSINE,
        },
      };
      return item;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const delta = b.memo.datetime.getTime() - a.memo.datetime.getTime();
      return delta !== 0 ? delta : a.memo.file.localeCompare(b.memo.file);
    });

  return pickDiverse(scored, limit);
}
