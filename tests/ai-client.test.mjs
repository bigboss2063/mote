import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { loadTs } from "./ai-fixtures.mjs";

async function loadClient(
  responseFactory,
  { desktop = false, nodeClient, globals = {} } = {}
) {
  return loadTs(
    "src/ai/client.ts",
    (id) => {
      if (id === "obsidian") {
        return {
          requestUrl: async (options) => responseFactory(options),
          Platform: { isDesktopApp: desktop },
        };
      }
      if (id === "http" || id === "https") {
        if (!nodeClient) throw new Error(`unexpected node require: ${id}`);
        return nodeClient;
      }
      return {};
    },
    globals
  );
}

const CHAT_OPTIONS = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "secret",
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
};

/** Minimal fake of Node's http/https module that replays an SSE (or raw)
 *  response through EventEmitter, the same surface client.ts relies on. */
function fakeNodeClient({
  status = 200,
  headers = { "content-type": "text/event-stream; charset=utf-8" },
  chunks = [],
  holdOpen = false,
} = {}) {
  const state = {
    url: null,
    options: null,
    body: "",
    destroyed: 0,
  };
  const client = {
    request(url, options, callback) {
      state.url = url;
      state.options = options;
      const request = new EventEmitter();
      request.write = (chunk) => {
        state.body += chunk;
      };
      request.destroy = () => {
        state.destroyed += 1;
      };
      request.end = () => {
        setTimeout(() => {
          const response = new EventEmitter();
          response.statusCode = status;
          response.headers = { ...headers };
          response.setEncoding = () => {};
          response.resume = () => {};
          response.destroy = () => {
            state.destroyed += 1;
          };
          callback(response);
          let index = 0;
          const next = () => {
            if (index < chunks.length) {
              response.emit("data", chunks[index]);
              index += 1;
              setTimeout(next, 0);
            } else if (!holdOpen) {
              response.emit("end");
            }
          };
          next();
        }, 0);
      };
      return request;
    },
  };
  return { client, state };
}

test("endpoint normalization keeps a full chat completions URL", async () => {
  const { resolveChatEndpoint } = await loadClient(() => ({ status: 200, json: {} }));
  assert.equal(
    resolveChatEndpoint("https://api.openai.com/v1/"),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    resolveChatEndpoint("https://example.com/v1/chat/completions"),
    "https://example.com/v1/chat/completions"
  );
  assert.throws(() => resolveChatEndpoint("  "), (error) => error.code === "config");
});

test("content extraction accepts strings and content-part arrays", async () => {
  const { extractChatContent } = await loadClient(() => ({ status: 200, json: {} }));
  assert.equal(extractChatContent({ choices: [{ message: { content: "hi" } }] }), "hi");
  assert.equal(
    extractChatContent({
      choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }],
    }),
    "ab"
  );
  assert.equal(extractChatContent({ choices: [] }), "");
});

test("stream deltas understand content and common reasoning fields", async () => {
  const { extractStreamDelta } = await loadClient(() => ({ status: 200, json: {} }));
  const first = extractStreamDelta({
    choices: [{ delta: { content: "你" } }],
  });
  assert.equal(first.content, "你");
  assert.equal(first.reasoning, "");
  const reasoningContent = extractStreamDelta({
    choices: [{ delta: { reasoning_content: "先看笔记", content: "" } }],
  });
  assert.equal(reasoningContent.content, "");
  assert.equal(reasoningContent.reasoning, "先看笔记");
  const reasoning = extractStreamDelta({
    choices: [{ delta: { reasoning: "thinking" } }],
  });
  assert.equal(reasoning.content, "");
  assert.equal(reasoning.reasoning, "thinking");
  const parts = extractStreamDelta({
    choices: [{ delta: { content: [{ text: "a" }, { text: "b" }] } }],
  });
  assert.equal(parts.content, "ab");
  assert.equal(parts.reasoning, "");
  const details = extractStreamDelta({
    choices: [
      { delta: { reasoning_details: [{ text: "先看" }, { content: "记录" }] } },
    ],
  });
  assert.equal(details.reasoning, "先看记录");
  const choiceLevel = extractStreamDelta({
    choices: [{ reasoning_content: "choices 级别" }],
  });
  assert.equal(choiceLevel.reasoning, "choices 级别");
  const camelCase = extractStreamDelta({
    choices: [{ delta: { reasoningContent: "camelCase" } }],
  });
  assert.equal(camelCase.reasoning, "camelCase");
  assert.equal(extractStreamDelta({ choices: [{ delta: {} }] }), null);
  assert.equal(extractStreamDelta({ choices: [] }), null);
});

test("request sends a minimal OpenAI-compatible body and returns content", async () => {
  let captured;
  const { requestChatCompletion } = await loadClient((options) => {
    captured = options;
    return {
      status: 200,
      json: { choices: [{ message: { content: "  insight  " } }] },
    };
  });
  const content = await requestChatCompletion({
    baseUrl: "https://api.example.com/v1",
    apiKey: "secret",
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(content, "insight");
  assert.equal(captured.url, "https://api.example.com/v1/chat/completions");
  assert.equal(captured.headers.Authorization, "Bearer secret");
  const body = JSON.parse(captured.body);
  assert.deepEqual(body, {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
});

test("local endpoints can omit the API key", async () => {
  let captured;
  const { requestChatCompletion } = await loadClient((options) => {
    captured = options;
    return { status: 200, json: { choices: [{ message: { content: "ok" } }] } };
  });
  await requestChatCompletion({
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
    model: "llama3",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(captured.headers.Authorization, undefined);
});

test("HTTP errors are classified for actionable UI messages", async () => {
  const unauthorized = await loadClient(() => ({
    status: 401,
    json: { error: { message: "bad key" } },
  }));
  await assert.rejects(
    unauthorized.requestChatCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "bad",
      model: "m",
      messages: [],
    }),
    (error) => error.code === "unauthorized"
  );

  const context = await loadClient(() => ({
    status: 400,
    json: { error: { message: "maximum context length exceeded" } },
  }));
  await assert.rejects(
    context.requestChatCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [],
    }),
    (error) => error.code === "context"
  );

  const empty = await loadClient(() => ({
    status: 200,
    json: { choices: [{ message: { content: "" } }] },
  }));
  await assert.rejects(
    empty.requestChatCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      messages: [],
    }),
    (error) => error.code === "empty"
  );
});

test("desktop streams reasoning and content incrementally via node http", async () => {
  const { client, state } = fakeNodeClient({
    chunks: [
      'data: {"choices":[{"delta":{"reasoning_content":"先看笔记"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"第一"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"段"}}]}\n\n',
      "data: [DONE]\n\n",
    ],
  });
  const { requestChatCompletionRich } = await loadClient(() => ({}), {
    desktop: true,
    nodeClient: client,
  });
  const updates = [];
  const result = await requestChatCompletionRich(CHAT_OPTIONS, {
    onUpdate: (update) => updates.push({ ...update }),
  });

  assert.equal(result.streamed, true);
  assert.equal(result.content, "第一段");
  assert.equal(result.reasoning, "先看笔记");
  assert.ok(updates.length >= 3, "updates should arrive incrementally");
  assert.deepEqual(updates[0], { content: "", reasoning: "先看笔记" });
  assert.deepEqual(updates.at(-1), { content: "第一段", reasoning: "先看笔记" });

  assert.equal(state.url, "https://api.example.com/v1/chat/completions");
  assert.equal(state.options.method, "POST");
  assert.equal(state.options.headers.Accept, "text/event-stream");
  assert.equal(state.options.headers.Authorization, "Bearer secret");
  assert.equal(JSON.parse(state.body).stream, true);
});

test("node transport finishes without a trailing [DONE] marker", async () => {
  const { client } = fakeNodeClient({
    chunks: ['data: {"choices":[{"delta":{"content":"结论"}}]}\n\n'],
  });
  const { requestChatCompletionRich } = await loadClient(() => ({}), {
    desktop: true,
    nodeClient: client,
  });
  const result = await requestChatCompletionRich(CHAT_OPTIONS);
  assert.equal(result.streamed, true);
  assert.equal(result.content, "结论");
});

test("node transport degrades to requestUrl when streaming is unavailable", async () => {
  let requestUrlCalls = 0;
  const { requestChatCompletionRich } = await loadClient(() => {
    requestUrlCalls += 1;
    return {
      status: 200,
      json: { choices: [{ message: { content: "buffered insight" } }] },
    };
  }, { desktop: true, nodeClient: null });

  const result = await requestChatCompletionRich(CHAT_OPTIONS);
  assert.equal(result.streamed, false);
  assert.equal(result.content, "buffered insight");
  assert.equal(requestUrlCalls, 1);
});

test("node HTTP errors surface directly without a fallback retry", async () => {
  const { client } = fakeNodeClient({
    status: 401,
    headers: { "content-type": "application/json" },
    chunks: [JSON.stringify({ error: { message: "bad key" } })],
  });
  const { requestChatCompletionRich } = await loadClient(() => {
    throw new Error("requestUrl must not be called after an HTTP response");
  }, { desktop: true, nodeClient: client });

  await assert.rejects(
    requestChatCompletionRich(CHAT_OPTIONS),
    (error) => error.code === "unauthorized"
  );
});

test("node transport accepts a provider that ignores stream and buffers JSON", async () => {
  const { client } = fakeNodeClient({
    headers: { "content-type": "application/json" },
    chunks: [
      JSON.stringify({ choices: [{ message: { content: "whole answer" } }] }),
    ],
  });
  const { requestChatCompletionRich } = await loadClient(() => ({}), {
    desktop: true,
    nodeClient: client,
  });
  const updates = [];
  const result = await requestChatCompletionRich(CHAT_OPTIONS, {
    onUpdate: (update) => updates.push(update),
  });
  assert.equal(result.streamed, false);
  assert.equal(result.content, "whole answer");
  assert.equal(updates.length, 0);
});

test("aborting the node transport destroys the request and reports aborted", async () => {
  const { client, state } = fakeNodeClient({
    holdOpen: true,
    chunks: ['data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'],
  });
  const { requestChatCompletionRich } = await loadClient(() => ({}), {
    desktop: true,
    nodeClient: client,
  });
  const controller = new AbortController();
  const updates = [];
  const pending = requestChatCompletionRich(CHAT_OPTIONS, {
    signal: controller.signal,
    onUpdate: (update) => {
      updates.push(update);
      controller.abort();
    },
  });
  await assert.rejects(pending, (error) => error.code === "aborted");
  assert.ok(state.destroyed >= 1, "request should be destroyed on abort");
  assert.equal(updates.length, 1);
});

test("fetch transport streams SSE when fetch is available", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning":"思考"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  let readIndex = 0;
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name === "content-type" ? "text/event-stream" : null),
      },
      body: {
        getReader: () => ({
          read: async () => {
            if (readIndex < chunks.length) {
              return { done: false, value: encoder.encode(chunks[readIndex++]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
      text: async () => chunks.join(""),
    };
  };
  const { requestChatCompletionRich } = await loadClient(() => ({}), {
    globals: { fetch: fetchImpl, AbortController, TextDecoder },
  });

  const updates = [];
  const result = await requestChatCompletionRich(CHAT_OPTIONS, {
    onUpdate: (update) => updates.push({ ...update }),
  });
  assert.equal(result.streamed, true);
  assert.equal(result.content, "答案");
  assert.equal(result.reasoning, "思考");
  assert.equal(updates.length, 2);
  assert.equal(
    fetchCalls[0].init.body,
    JSON.stringify({
      model: "test-model",
      messages: CHAT_OPTIONS.messages,
      stream: true,
    })
  );
});

test("mid-stream SSE error payload is classified as a server error", async () => {
  const { client } = fakeNodeClient({
    chunks: [
      'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n',
      'data: {"error":{"message":"upstream exploded"}}\n\n',
    ],
  });
  const { requestChatCompletionRich } = await loadClient(() => ({}), {
    desktop: true,
    nodeClient: client,
  });
  await assert.rejects(
    requestChatCompletionRich(CHAT_OPTIONS),
    (error) => error.code === "server" && error.message === "upstream exploded"
  );
});

test("empty SSE stream reports empty instead of resolving", async () => {
  const { client } = fakeNodeClient({ chunks: [": keep-alive\n\n"] });
  const { requestChatCompletionRich } = await loadClient(() => {
    throw new Error("requestUrl must not be called for an empty stream");
  }, { desktop: true, nodeClient: client });
  await assert.rejects(
    requestChatCompletionRich(CHAT_OPTIONS),
    (error) => error.code === "empty"
  );
});

test("eventsource-parser handles multiline data chunks correctly", async () => {
  const payload = JSON.stringify({
    choices: [{ delta: { content: "跨行文本" } }],
  });
  // SSE spec: multiple data: lines within one message are joined with newline
  const mid = Math.floor(payload.length / 2);
  const chunk1 = payload.slice(0, mid);
  const chunk2 = payload.slice(mid);
  const { client } = fakeNodeClient({
    chunks: [`data: ${chunk1}\r\ndata: ${chunk2}\r\n\r\n`, "data: [DONE]\r\n\r\n"],
  });
  const { requestChatCompletionRich } = await loadClient(() => ({}), {
    desktop: true,
    nodeClient: client,
  });
  const result = await requestChatCompletionRich(CHAT_OPTIONS);
  assert.equal(result.streamed, true);
  assert.equal(result.content, "跨行文本");
});
