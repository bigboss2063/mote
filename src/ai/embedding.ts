// ================= 语义向量索引 =================
// 可选的第二路召回：把每条 memo 发到 OpenAI 兼容的 /embeddings 接口，
// 把向量缓存到插件目录的 embeddings.json（base64 Float32，按内容 hash 增量更新）。
// 没有配置 embedding 模型、接口不通或请求失败时全部降级为纯关键词匹配。

import { requestUrl } from "obsidian";
import type { Memo, MemoriaSettings } from "../types";
import { cleanMemoText } from "./retrieve";

const CACHE_VERSION = 1;
/** 单次请求的文本条数：太大容易被网关拒绝，太小请求数过多。 */
const BATCH_SIZE = 24;
/** 送进 embedding 模型前截断，避免超出上下文。 */
const MAX_EMBED_CHARS = 2000;
/** 请求失败后 5 分钟内不再重试，避免每次打开都打一遍失败接口。 */
const RETRY_AFTER_MS = 5 * 60 * 1000;

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VectorEntry {
  hash: string;
  vec: Float32Array;
}

export type SemanticState = "off" | "idle" | "syncing" | "ready" | "error";

export interface SemanticStatus {
  state: SemanticState;
  count: number;
  done: number;
  total: number;
  error?: string;
}

export function embeddingConfig(settings: MemoriaSettings): EmbeddingConfig | null {
  if (!settings.aiEnabled || !settings.aiConsent) return null;
  const baseUrl = settings.aiEmbeddingBaseUrl.trim();
  const model = settings.aiEmbeddingModel.trim();
  if (!baseUrl || !model) return null;
  return { baseUrl, apiKey: settings.aiEmbeddingApiKey.trim(), model };
}

/** 从对话 Base URL 推导 /embeddings 地址（兼容填了完整 chat/completions 的情况）。 */
export function resolveEmbeddingEndpoint(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (/\/embeddings$/.test(trimmed)) return trimmed;
  if (/\/chat\/completions$/.test(trimmed)) {
    return trimmed.replace(/\/chat\/completions$/, "/embeddings");
  }
  return `${trimmed}/embeddings`;
}

/** 64 位内容指纹：文件路径不变、正文一变就要重新算向量。 */
export function memoHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ (code + i), 0x85ebca6b);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

function toBase64(vec: Float32Array): string {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Float32Array | null {
  try {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
    return new Float32Array(bytes.buffer);
  } catch {
    return null;
  }
}

interface CacheFile {
  version: number;
  model: string;
  dims: number;
  items: Record<string, { h?: string; v?: string }>;
}

export function encodeCache(model: string, entries: Map<string, VectorEntry>): string {
  const items: Record<string, { h: string; v: string }> = {};
  let dims = 0;
  for (const [file, entry] of entries) {
    dims = entry.vec.length;
    items[file] = { h: entry.hash, v: toBase64(entry.vec) };
  }
  const payload: CacheFile = { version: CACHE_VERSION, model, dims, items };
  return JSON.stringify(payload);
}

export function decodeCache(
  raw: string
): { model: string; dims: number; entries: Map<string, VectorEntry> } | null {
  try {
    const json = JSON.parse(raw) as Partial<CacheFile>;
    if (
      json.version !== CACHE_VERSION ||
      typeof json.model !== "string" ||
      !json.items ||
      typeof json.items !== "object"
    ) {
      return null;
    }
    const dims = typeof json.dims === "number" ? json.dims : 0;
    const entries = new Map<string, VectorEntry>();
    for (const [file, item] of Object.entries(json.items)) {
      if (!item || typeof item.h !== "string" || typeof item.v !== "string") continue;
      const vec = fromBase64(item.v);
      if (!vec) continue;
      if (dims && vec.length !== dims) continue;
      entries.set(file, { hash: item.h, vec });
    }
    return { model: json.model, dims, entries };
  } catch {
    return null;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

interface EmbeddingPayload {
  data?: Array<{ index?: number; embedding?: number[] }>;
  error?: { message?: string };
}

/** 调用 OpenAI 兼容的 /embeddings，返回与 texts 一一对应的向量。 */
export async function fetchEmbeddings(
  config: EmbeddingConfig,
  texts: string[]
): Promise<Float32Array[]> {
  const endpoint = resolveEmbeddingEndpoint(config.baseUrl);
  if (!endpoint) throw new Error("embedding endpoint is empty");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await requestUrl({
    url: endpoint,
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.model, input: texts }),
    throw: false,
  });

  let payload: EmbeddingPayload;
  try {
    payload = JSON.parse(response.text) as EmbeddingPayload;
  } catch {
    throw new Error(`embedding 接口返回了非 JSON（HTTP ${response.status}）`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(payload.error?.message || `embedding 请求失败（HTTP ${response.status}）`);
  }
  const data = payload.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error("embedding 接口返回的向量数量不匹配");
  }
  return data.map((item, index) => {
    const embedding = item.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error(`embedding #${index} 为空`);
    }
    return Float32Array.from(embedding);
  });
}

export interface SemanticDeps {
  config: () => EmbeddingConfig | null;
  load: () => Promise<string | null>;
  save: (data: string) => Promise<void>;
}

/**
 * 向量缓存 + 增量同步。只负责数据；调用方（相关笔记弹窗）决定什么时候 sync。
 * 所有失败都吞掉并记为 error，关键词召回不受影响。
 */
export class SemanticIndex {
  private entries = new Map<string, VectorEntry>();
  private model = "";
  private loaded = false;
  private loading: Promise<void> | null = null;
  private syncing = false;
  private progress = { done: 0, total: 0 };
  private error: string | null = null;
  private retryAt = 0;
  private lastSave = 0;
  private vectorCache: Map<string, Float32Array> | null = null;
  private listeners = new Set<() => void>();

  constructor(private deps: SemanticDeps) {}

  onUpdate(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const raw = await this.deps.load().catch(() => null);
        const cache = raw ? decodeCache(raw) : null;
        if (cache) {
          this.entries = cache.entries;
          this.model = cache.model;
          this.vectorCache = null;
        }
      } finally {
        this.loaded = true;
        this.loading = null;
        this.emit();
      }
    })();
    return this.loading;
  }

  /** 读给相关度计算用；没配置或还没有向量时返回 undefined（调用方自动降级）。 */
  vectors(): Map<string, Float32Array> | undefined {
    if (!this.deps.config() || this.entries.size === 0) return undefined;
    if (!this.vectorCache) {
      this.vectorCache = new Map();
      for (const [file, entry] of this.entries) this.vectorCache.set(file, entry.vec);
    }
    return this.vectorCache;
  }

  status(): SemanticStatus {
    if (!this.deps.config()) {
      return { state: "off", count: this.entries.size, done: 0, total: 0 };
    }
    if (this.syncing) {
      return {
        state: "syncing",
        count: this.entries.size,
        done: this.progress.done,
        total: this.progress.total,
      };
    }
    if (this.error) {
      const error = this.error;
      return { state: "error", count: this.entries.size, done: 0, total: 0, error };
    }
    if (this.entries.size > 0) {
      return { state: "ready", count: this.entries.size, done: 0, total: 0 };
    }
    return { state: "idle", count: 0, done: 0, total: 0 };
  }

  /** 增量补齐缺失/变更的向量；并发调用只跑一次。 */
  async sync(memos: Memo[]): Promise<void> {
    if (this.syncing) return;
    const config = this.deps.config();
    if (!config) return;
    await this.ensureLoaded();
    if (Date.now() < this.retryAt) return;

    if (this.model !== config.model) {
      this.entries.clear();
      this.model = config.model;
      this.vectorCache = null;
    }
    const current = new Set(memos.map((memo) => memo.file));
    for (const file of [...this.entries.keys()]) {
      if (!current.has(file)) this.entries.delete(file);
    }

    const missing: Array<{ file: string; text: string; hash: string }> = [];
    for (const memo of memos) {
      const text = cleanMemoText(memo.content, 0);
      if (!text) continue;
      const hash = memoHash(text);
      const existing = this.entries.get(memo.file);
      if (existing && existing.hash === hash) continue;
      missing.push({ file: memo.file, text: text.slice(0, MAX_EMBED_CHARS), hash });
    }
    if (missing.length === 0) return;

    this.syncing = true;
    this.error = null;
    this.progress = { done: 0, total: missing.length };
    this.emit();
    try {
      for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        const vectors = await fetchEmbeddings(
          config,
          batch.map((item) => item.text)
        );
        vectors.forEach((vec, index) => {
          this.entries.set(batch[index].file, { hash: batch[index].hash, vec });
        });
        this.progress.done += batch.length;
        this.vectorCache = null;
        this.emit();
        if (Date.now() - this.lastSave > 5000) await this.persist();
      }
      await this.persist();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.retryAt = Date.now() + RETRY_AFTER_MS;
      // 已成功的批次照样存盘，下次只补剩下的。
      await this.persist();
    } finally {
      this.syncing = false;
      this.progress = { done: 0, total: 0 };
      this.emit();
    }
  }

  private async persist(): Promise<void> {
    if (this.entries.size === 0) return;
    this.lastSave = Date.now();
    try {
      await this.deps.save(encodeCache(this.model, this.entries));
    } catch (err) {
      console.warn("[Mote] 语义索引缓存写入失败:", err);
    }
  }
}
