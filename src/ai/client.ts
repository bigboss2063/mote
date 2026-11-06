import { Platform, requestUrl } from "obsidian";
import { createParser } from "eventsource-parser";
import type { RequestUrlResponse } from "obsidian";
import type {
  ChatCompletionResult,
  ChatMessage,
  StreamUpdate,
} from "./types";
import { InsightError } from "./errors";

export interface ChatCompletionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
}

export interface ChatCompletionBody {
  model: string;
  messages: ChatMessage[];
  stream: false;
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  onUpdate?: (update: StreamUpdate) => void;
}

export function resolveChatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new InsightError("config");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

export function buildChatBody(model: string, messages: ChatMessage[]): ChatCompletionBody {
  const trimmed = model.trim();
  if (!trimmed) throw new InsightError("config");
  return { model: trimmed, messages, stream: false };
}

function buildStreamChatBody(model: string, messages: ChatMessage[]) {
  const trimmed = model.trim();
  if (!trimmed) throw new InsightError("config");
  return { model: trimmed, messages, stream: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractContentValue(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

/** OpenAI-compatible endpoints usually return message.content as a string,
 *  but a few return an array of content parts. Accept both. */
export function extractChatContent(data: unknown): string {
  if (!isRecord(data)) return "";
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first: unknown = choices[0];
  if (!isRecord(first)) return "";
  if (isRecord(first.message)) return extractContentValue(first.message.content);
  return "";
}

function extractReasoningValue(source: Record<string, unknown> | null): string {
  if (!source) return "";
  const direct = extractContentValue(
    source.reasoning_content ??
      source.reasoningContent ??
      source.reasoning ??
      source.thinking
  );
  if (direct) return direct;
  const details = source.reasoning_details ?? source.reasoningDetails;
  if (!Array.isArray(details)) return "";
  return details
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      return extractContentValue(part.text ?? part.content);
    })
    .join("");
}

/** Streaming chunks can carry visible content and/or a reasoning trace.
 *  Different providers use different field names for the latter. */
export function extractStreamDelta(
  data: unknown
): { content: string; reasoning: string } | null {
  if (!isRecord(data)) return null;
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (!isRecord(first)) return null;

  const delta = isRecord(first.delta) ? first.delta : null;
  const message = isRecord(first.message) ? first.message : null;
  const source = delta ?? message;
  const content =
    extractContentValue(source?.content) ||
    (typeof first.text === "string" ? first.text : "");
  const reasoning =
    extractReasoningValue(source) || extractReasoningValue(first);
  if (!content && !reasoning) return null;
  return { content, reasoning };
}

function errorDetail(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.error)) return "";
  return typeof data.error.message === "string" ? data.error.message : "";
}

function classifyHttpError(status: number, detail: string): InsightError {
  if (status === 401 || status === 403) {
    return new InsightError("unauthorized", detail || undefined, status);
  }
  if (status === 404) {
    return new InsightError("not_found", detail || undefined, status);
  }
  if (status === 429) {
    return new InsightError("rate_limited", detail || undefined, status);
  }
  if (/context length|context window|maximum context|too many tokens|token limit|上下文|超长/i.test(detail)) {
    return new InsightError("context", detail, status);
  }
  if (status >= 500) {
    return new InsightError("server", detail || undefined, status);
  }
  return new InsightError("unknown", detail || `HTTP ${status}`, status);
}

export async function requestChatCompletion(options: ChatCompletionOptions): Promise<string> {
  const endpoint = resolveChatEndpoint(options.baseUrl);
  const body = buildChatBody(options.model, options.messages);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const apiKey = options.apiKey.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: RequestUrlResponse;
  try {
    response = await requestUrl({
      url: endpoint,
      method: "POST",
      contentType: "application/json",
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (error) {
    throw new InsightError(
      "network",
      error instanceof Error ? error.message : undefined
    );
  }

  let data: unknown;
  try {
    data = response.json as unknown;
  } catch {
    data = undefined;
  }

  if (response.status >= 400) {
    throw classifyHttpError(response.status, errorDetail(data));
  }

  const content = extractChatContent(data).trim();
  if (!content) throw new InsightError("empty");
  return content;
}

function requestHeaders(options: ChatCompletionOptions, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: accept,
  };
  const apiKey = options.apiKey.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

function abortError(): InsightError {
  return new InsightError("aborted");
}

async function fallbackCompletion(
  options: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const content = await requestChatCompletion(options);
  return { content, reasoning: "", streamed: false };
}

async function parseErrorResponse(response: Response): Promise<InsightError> {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const data: unknown = JSON.parse(text);
      detail = errorDetail(data);
    } catch {
      detail = text.slice(0, 500);
    }
  } catch {
    detail = "";
  }
  return classifyHttpError(response.status, detail);
}

/** Streaming is only observable through transports that can read the
 *  response incrementally. Obsidian's requestUrl buffers the whole body,
 *  so transports are tried in order and each one may degrade to the next:
 *  1. Node http/https (desktop) — not bound by renderer CORS, true SSE.
 *  2. fetch — streams when the endpoint sends CORS headers (mobile).
 *  3. requestUrl — non-streaming, but the insight still completes.
 */
export async function requestChatCompletionRich(
  options: ChatCompletionOptions,
  handlers: ChatStreamOptions = {}
): Promise<ChatCompletionResult> {
  const endpoint = resolveChatEndpoint(options.baseUrl);
  const body = buildStreamChatBody(options.model, options.messages);
  const bodyJson = JSON.stringify(body);
  const headers = requestHeaders(options, "text/event-stream");

  if (handlers.signal?.aborted) throw abortError();

  // Desktop app: the renderer enforces CORS on fetch, which most
  // OpenAI-compatible endpoints do not allow, so stream via Node instead.
  if (Platform.isDesktopApp) {
    try {
      return await streamViaNodeClient({
        endpoint,
        headers,
        body: bodyJson,
        handlers,
      });
    } catch (error) {
      // A completed HTTP exchange already carries a classified error;
      // only transport-level failures degrade to the next transport.
      if (error instanceof InsightError) throw error;
      console.debug(
        "[Mote] insight node streaming unavailable, trying fetch:",
        error
      );
    }
  }

  return await streamViaFetch(options, endpoint, headers, bodyJson, handlers);
}

async function streamViaFetch(
  options: ChatCompletionOptions,
  endpoint: string,
  headers: Record<string, string>,
  bodyJson: string,
  handlers: ChatStreamOptions
): Promise<ChatCompletionResult> {
  // eslint-disable-next-line no-restricted-globals
  const fetchImpl = typeof fetch === "function" ? fetch : null;
  if (!fetchImpl) return fallbackCompletion(options);
  if (handlers.signal?.aborted) throw abortError();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  handlers.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: bodyJson,
        signal: controller.signal,
      });
    } catch (error) {
      if (handlers.signal?.aborted || isAbortError(error)) throw abortError();
      // Browsers block cross-origin reads without CORS headers; requestUrl
      // bypasses that, so degrade to the non-streaming path.
      console.debug(
        "[Mote] insight fetch streaming blocked, falling back to requestUrl"
      );
      return await fallbackCompletion(options);
    }

    if (!response.ok) throw await parseErrorResponse(response);

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || contentType.includes("application/json")) {
      const text = await response.text();
      const content = extractChatContent(parseJsonText(text)).trim();
      if (!content) throw new InsightError("empty");
      return { content, reasoning: "", streamed: false };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const accumulator = createSseAccumulator(handlers);
    while (!accumulator.isFinished()) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (handlers.signal?.aborted || isAbortError(error)) throw abortError();
        throw new InsightError(
          "network",
          error instanceof Error ? error.message : undefined
        );
      }
      if (chunk.done) break;
      accumulator.push(decoder.decode(chunk.value, { stream: true }));
    }
    accumulator.push(decoder.decode());
    accumulator.finish();
    if (handlers.signal?.aborted) throw abortError();
    return accumulator.result();
  } finally {
    handlers.signal?.removeEventListener("abort", onAbort);
  }
}

type NodeRequire = (id: string) => unknown;

interface NodeHttpRequest {
  write(chunk: string): void;
  end(): void;
  destroy(error?: Error): void;
  on(event: string, listener: (error?: Error) => void): unknown;
}

interface NodeHttpResponse {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  setEncoding(encoding: string): void;
  on(event: string, listener: (arg?: unknown) => void): unknown;
  resume(): void;
  destroy(): void;
}

interface NodeHttpClient {
  request(
    url: string,
    options: { method: string; headers: Record<string, string> },
    callback: (response: NodeHttpResponse) => void
  ): NodeHttpRequest;
}

/** Transport-level failure (module missing, connection never established,
 *  redirect we cannot follow); callers degrade to the next transport. */
class TransportError extends Error {}

function loadNodeClient(protocol: string): NodeHttpClient | null {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  const req = (typeof window !== "undefined" && (window as unknown as { require?: NodeRequire }).require) || (new Function("return typeof require === 'function' ? require : undefined;")() as NodeRequire | undefined);
  if (typeof req !== "function") return null;
  const id = protocol === "http:" ? "http" : "https";
  let mod: unknown;
  try {
    mod = req(id);
  } catch {
    return null;
  }
  if (typeof mod !== "object" || mod === null) return null;
  return typeof (mod as { request?: unknown }).request === "function"
    ? (mod as NodeHttpClient)
    : null;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface SseAccumulator {
  push(text: string): void;
  finish(): void;
  isFinished(): boolean;
  result(): ChatCompletionResult;
}

/** Shared SSE state machine: both the Node and fetch transports feed it
 *  decoded text and get the same incremental onUpdate and final result. */
function createSseAccumulator(handlers: ChatStreamOptions): SseAccumulator {
  let content = "";
  let reasoning = "";
  let finished = false;

  const emit = () => {
    if (!handlers.onUpdate) return;
    handlers.onUpdate({ content, reasoning });
  };

  const parser = createParser({
    onEvent(event) {
      if (finished) return;
      const payload = event.data.trim();
      if (!payload) return;
      if (payload === "[DONE]") {
        finished = true;
        return;
      }
      const data = parseJsonText(payload);
      if (isRecord(data) && isRecord(data.error)) {
        throw new InsightError("server", errorDetail(data) || undefined);
      }
      const delta = extractStreamDelta(data);
      if (!delta) return;
      if (delta.content) content += delta.content;
      if (delta.reasoning) reasoning += delta.reasoning;
      if (delta.content || delta.reasoning) emit();
    },
  });

  return {
    push(text: string): void {
      parser.feed(text);
    },
    finish(): void {
      parser.reset();
    },
    isFinished(): boolean {
      return finished;
    },
    result(): ChatCompletionResult {
      const trimmedContent = content.trim();
      if (!trimmedContent) throw new InsightError("empty");
      return {
        content: trimmedContent,
        reasoning: reasoning.trim(),
        streamed: true,
      };
    },
  };
}

/** Desktop streaming transport built on Node's http/https module, which is
 *  reachable from the plugin process and ignores renderer CORS entirely.
 *  The response is decoded as UTF-8 incrementally, so multi-byte characters
 *  split across TCP chunks stay intact. */
function streamViaNodeClient(params: {
  endpoint: string;
  headers: Record<string, string>;
  body: string;
  handlers: ChatStreamOptions;
}): Promise<ChatCompletionResult> {
  const { endpoint, headers, body, handlers } = params;
  const signal = handlers.signal;

  return new Promise<ChatCompletionResult>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      reject(new InsightError("config"));
      return;
    }
    const client = loadNodeClient(url.protocol);
    if (!client) {
      reject(new TransportError("node http client unavailable"));
      return;
    }

    let settled = false;
    let request: NodeHttpRequest | null = null;
    let responseStarted = false;

    const finish = (error: unknown, result?: ChatCompletionResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        reject(error instanceof Error ? error : new Error(typeof error === "string" ? error : "stream error"));
      } else if (result) {
        resolve(result);
      } else {
        reject(new InsightError("empty"));
      }
    };

    const onAbort = (): void => {
      request?.destroy();
      finish(abortError());
    };

    if (signal?.aborted) {
      finish(abortError());
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const readRawBody = (
      response: NodeHttpResponse,
      onDone: (raw: string) => void
    ): void => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (typeof chunk === "string") raw += chunk;
      });
      response.on("end", () => onDone(raw));
      response.on("error", () => onDone(raw));
    };

    try {
      request = client.request(
        endpoint,
        { method: "POST", headers },
        (response) => {
          responseStarted = true;
          const status = response.statusCode ?? 0;

          if (status >= 300 && status < 400) {
            // Node does not follow redirects; let fetch (which does) take over.
            response.resume();
            finish(new TransportError(`redirect ${status}`));
            return;
          }

          if (status >= 400) {
            readRawBody(response, (raw) =>
              finish(classifyHttpError(status, errorDetail(parseJsonText(raw))))
            );
            return;
          }

          const contentType = headerValue(response.headers, "content-type");
          if (contentType.includes("application/json")) {
            // Endpoint ignored stream:true; accept the buffered completion.
            readRawBody(response, (raw) => {
              const content = extractChatContent(parseJsonText(raw)).trim();
              if (!content) {
                finish(new InsightError("empty"));
                return;
              }
              finish(null, { content, reasoning: "", streamed: false });
            });
            return;
          }

          response.setEncoding("utf8");
          const accumulator = createSseAccumulator(handlers);
          response.on("data", (chunk) => {
            if (settled) return;
            try {
              accumulator.push(typeof chunk === "string" ? chunk : "");
              if (accumulator.isFinished()) {
                response.destroy();
                finish(null, accumulator.result());
              }
            } catch (error) {
              request?.destroy();
              finish(error);
            }
          });
          response.on("end", () => {
            if (settled) return;
            try {
              accumulator.finish();
              finish(null, accumulator.result());
            } catch (error) {
              finish(error);
            }
          });
          response.on("error", () => {
            if (settled) return;
            finish(new InsightError("network"));
          });
        }
      );
      request.on("error", (error) => {
        if (settled) return;
        const message =
          error instanceof Error ? error.message : "request failed";
        // After the response started this is a mid-stream network failure;
        // before it, the endpoint may simply be unreachable from Node
        // (e.g. a proxy only Chromium knows about) — try fetch next.
        finish(
          responseStarted
            ? new InsightError("network", message)
            : new TransportError(message)
        );
      });
      request.write(body);
      request.end();
    } catch (error) {
      finish(
        new TransportError(
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  });
}
