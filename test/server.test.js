import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

process.env.DICTATION_API_KEY = "test-adapter-key";
process.env.OPENCODE_SERVER_PASSWORD = "test-opencode-password";

const calls = [];
let availableModels = ["opencode/test-model", "openai/test-model"];
const opencode = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  calls.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
  response.setHeader("content-type", "application/json");
  if (request.method === "POST" && request.url === "/session") return response.end(JSON.stringify({ id: "session-1" }));
  if (request.method === "POST" && request.url === "/session/session-1/message") {
    return response.end(JSON.stringify({ parts: [{ type: "text", text: "Cleaned dictation." }] }));
  }
  if (request.method === "DELETE" && request.url === "/session/session-1") return response.end(JSON.stringify(true));
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

let app;
let providerUrl;

before(async () => {
  await new Promise((resolve) => opencode.listen(0, "127.0.0.1", resolve));
  const opencodePort = opencode.address().port;
  process.env.OPENCODE_URL = `http://127.0.0.1:${opencodePort}`;
  const { createApp } = await import("../src/server.js");
  app = createApp({ listModels: async () => availableModels });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  providerUrl = `http://127.0.0.1:${app.address().port}`;
});

test("logs dictation text only when debug logging is enabled", async () => {
  const { cleanupLogRecord } = await import("../src/server.js");
  const redacted = cleanupLogRecord("completion-1", "opencode/deepseek-v4-flash-free", "raw text", "clean text", false);
  const debug = cleanupLogRecord("completion-1", "opencode/deepseek-v4-flash-free", "raw text", "clean text", true);
  assert.equal("input_dictation" in redacted, false);
  assert.equal("cleaned_dictation" in redacted, false);
  assert.equal(debug.input_dictation, "raw text");
  assert.equal(debug.cleaned_dictation, "clean text");
});

after(async () => {
  await Promise.all([new Promise((resolve) => app.close(resolve)), new Promise((resolve) => opencode.close(resolve))]);
});

test("health endpoint is public", async () => {
  const response = await fetch(`${providerUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("lists models discovered from OpenCode", async () => {
  const response = await fetch(`${providerUrl}/v1/models`, {
    headers: { authorization: "Bearer test-adapter-key" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "list");
  assert.deepEqual(body.data.map((model) => model.id), availableModels);
});

test("cleans a dictation through a fresh OpenCode session", async () => {
  const response = await fetch(`${providerUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-adapter-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "opencode/test-model", messages: [{ role: "user", content: "um hello there" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "Cleaned dictation.");
  assert.equal(calls[1].body.agent, "dictation-cleaner");
  assert.deepEqual(calls[1].body.model, { providerID: "opencode", modelID: "test-model" });
});

test("uses the model selected by the client", async () => {
  const logs = [];
  const originalInfo = console.info;
  console.info = (entry) => logs.push(entry);
  let body;
  try {
    const response = await fetch(`${providerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer test-adapter-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/test-model", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, 200);
    body = await response.json();
  } finally {
    console.info = originalInfo;
  }
  assert.equal(body.model, "openai/test-model");
  assert.deepEqual(calls.at(-2).body.model, { providerID: "openai", modelID: "test-model" });
  assert.deepEqual(Object.keys(JSON.parse(logs.at(-1))).sort(), ["completion_id", "event", "model", "timestamp"]);
  assert.equal(JSON.parse(logs.at(-1)).model, "openai/test-model");
});

test("rejects models not currently returned by OpenCode", async () => {
  const response = await fetch(`${providerUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-adapter-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "opencode/not-allowed", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 400);
});

test("requires a client-selected model", async () => {
  const response = await fetch(`${providerUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-adapter-key", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 400);
});

test("rejects invalid credentials", async () => {
  const response = await fetch(`${providerUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 401);
});
