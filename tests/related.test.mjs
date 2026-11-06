import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { obsidianStub } from "./obsidian-stub.mjs";

// vm 上下文里没有 Node 的 btoa/atob，用 Buffer 版本塞进去
const btoa = (binary) => Buffer.from(binary, "binary").toString("base64");
const atob = (text) => Buffer.from(text, "base64").toString("binary");

async function load(entry) {
  const bundle = await build({
    entryPoints: [entry], bundle: true, write: false,
    platform: "node", format: "cjs", external: ["obsidian"],
  });
  const module = {exports: {}};
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: () => obsidianStub(), btoa, atob, console,
  });
  return module.exports;
}

const related = await load("src/ai/related.ts");
const embedding = await load("src/ai/embedding.ts");

const memo = (file, content, {tags = [], date = "2026-11-06"} = {}) => ({
  file,
  date,
  datetime: new Date(`${date}T10:00:00`),
  content,
  tags,
});

test("BM25 sees the whole memo, not just its first 900 chars", () => {
  const seed = memo("Mote/seed.md", "最近在读量子计算的书");
  const tail = memo("Mote/tail.md", `${"铺垫".repeat(600)} 量子计算`);
  const index = related.buildLexicalIndex([seed, tail]);
  const items = related.findRelated(seed, index);
  assert.equal(items[0].memo.file, "Mote/tail.md");
});

test("a `[[link]]` alone is enough to surface the target", () => {
  const seed = memo("Mote/seed.md", "这条引用了 [[Mote/target.md]]");
  const target = memo("Mote/target.md", "完全不同的内容");
  const index = related.buildLexicalIndex([seed, target]);
  const links = new Map([["Mote/seed.md", new Set(["Mote/target.md"])]]);
  const items = related.findRelated(seed, index, {links});
  assert.equal(items.length, 1);
  assert.equal(items[0].reasons.link, "out");
  assert.ok(items[0].score > 0);
});

test("shared nested tags become a reason", () => {
  const seed = memo("Mote/seed.md", "写了一篇关于灵感的记录", {tags: ["产品/灵感"]});
  const other = memo("Mote/other.md", "另一个角度", {tags: ["产品/灵感"]});
  const index = related.buildLexicalIndex([seed, other]);
  const items = related.findRelated(seed, index);
  assert.equal(items[0].memo.file, "Mote/other.md");
  assert.equal(items[0].reasons.tags[0], "产品/灵感");
});

test("vectors work as a fallback when no words or tags overlap", () => {
  const seed = memo("Mote/s.md", "alpha beta");
  const near = memo("Mote/n.md", "gamma delta");
  const far = memo("Mote/f.md", "epsilon zeta");
  const index = related.buildLexicalIndex([seed, near, far]);
  const vectors = new Map([
    ["Mote/s.md", Float32Array.from([1, 0])],
    ["Mote/n.md", Float32Array.from([1, 0])],
    ["Mote/f.md", Float32Array.from([0, 1])],
  ]);
  const items = related.findRelated(seed, index, {vectors});
  assert.deepEqual([...items.map((item) => item.memo.file)], ["Mote/n.md"]);
  assert.equal(items[0].reasons.semantic, true);
});

test("limit is respected and the seed never recommends itself", () => {
  const seed = memo("Mote/seed.md", "共同 主题");
  const others = Array.from({length: 8}, (_, i) =>
    memo(`Mote/o${i}.md`, "共同 主题", {date: "2026-11-06"})
  );
  const index = related.buildLexicalIndex([seed, ...others]);
  const items = related.findRelated(seed, index, {limit: 3});
  assert.equal(items.length, 3);
  assert.ok(items.every((item) => item.memo.file !== seed.file));
  assert.equal(new Set(items.map((item) => item.memo.file)).size, 3);
});

test("embedding endpoints are derived from the chat base URL", () => {
  assert.equal(
    embedding.resolveEmbeddingEndpoint("https://api.example.com/v1"),
    "https://api.example.com/v1/embeddings"
  );
  assert.equal(
    embedding.resolveEmbeddingEndpoint("https://api.example.com/v1/"),
    "https://api.example.com/v1/embeddings"
  );
  assert.equal(
    embedding.resolveEmbeddingEndpoint("https://api.example.com/v1/embeddings"),
    "https://api.example.com/v1/embeddings"
  );
  assert.equal(
    embedding.resolveEmbeddingEndpoint("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1/embeddings"
  );
  assert.equal(embedding.resolveEmbeddingEndpoint("  "), null);
});

test("embedding settings are separate from the chat endpoint", () => {
  const base = {
    aiEnabled: true, aiConsent: true,
    aiBaseUrl: "https://api.deepseek.com/v1", aiApiKey: "sk-chat",
    aiEmbeddingBaseUrl: "", aiEmbeddingApiKey: "", aiEmbeddingModel: "text-embedding-3-small",
  };
  // 对话地址存在但没有 embedding 地址：不启用，避免把请求打到没有 /embeddings 的服务
  assert.equal(embedding.embeddingConfig(base), null);
  const filled = embedding.embeddingConfig({
    ...base,
    aiEmbeddingBaseUrl: "https://api.openai.com/v1",
    aiEmbeddingApiKey: "sk-emb",
  });
  assert.equal(filled.baseUrl, "https://api.openai.com/v1");
  assert.equal(filled.apiKey, "sk-emb");
  assert.equal(filled.model, "text-embedding-3-small");
  // 没勾隐私同意仍然关闭
  assert.equal(
    embedding.embeddingConfig({
      ...base,
      aiEmbeddingBaseUrl: "https://api.openai.com/v1",
      aiConsent: false,
    }),
    null
  );
});

test("vectors round-trip through the cache file", () => {
  const entries = new Map([["Mote/a.md", {hash: "abc", vec: Float32Array.from([0.25, -0.5, 1])}]]);
  const raw = embedding.encodeCache("text-embedding-3-small", entries);
  const decoded = embedding.decodeCache(raw);
  assert.equal(decoded.model, "text-embedding-3-small");
  assert.equal(decoded.dims, 3);
  assert.deepEqual([...decoded.entries.get("Mote/a.md").vec], [0.25, -0.5, 1]);
  assert.equal(decoded.entries.get("Mote/a.md").hash, "abc");
});

test("cache rejects stale versions and corrupt JSON", () => {
  const raw = JSON.parse(embedding.encodeCache("m", new Map([["a", {hash: "h", vec: Float32Array.from([1])}]])));
  raw.version = 0;
  assert.equal(embedding.decodeCache(JSON.stringify(raw)), null);
  assert.equal(embedding.decodeCache("not json"), null);
  assert.equal(embedding.decodeCache(JSON.stringify({version: 1, model: "m", items: {}})).entries.size, 0);
});

test("content hash is stable, hex, and changes with the text", () => {
  const a = embedding.memoHash("同样的内容");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, embedding.memoHash("同样的内容"));
  assert.notEqual(a, embedding.memoHash("同样的内容改一个字"));
});

test("cosine is 1 for identical vectors and 0 for orthogonal ones", () => {
  assert.equal(embedding.cosine(Float32Array.from([1, 2]), Float32Array.from([1, 2])), 1);
  assert.equal(embedding.cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  assert.equal(embedding.cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])), 0);
});
