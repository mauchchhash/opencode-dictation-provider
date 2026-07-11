import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const configuredPort = Number(process.env.PORT ?? 11435);
const host = process.env.HOST ?? "127.0.0.1";
const apiKey = process.env.DICTATION_API_KEY;
const opencodeUrl = (process.env.OPENCODE_URL ?? "http://127.0.0.1:4096").replace(/\/$/, "");
const opencodeUsername = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const opencodePassword = process.env.OPENCODE_SERVER_PASSWORD;
const agent = process.env.OPENCODE_AGENT ?? "dictation-cleaner";
const allowedModels = (process.env.DICTATION_MODELS ?? [
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "openai/gpt-5.3-codex-spark",
  "opencode/hy3-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/north-mini-code-free",
].join(",")).split(",").map((value) => value.trim()).filter(Boolean);
const defaultModel = process.env.DICTATION_DEFAULT_MODEL ?? "opencode/deepseek-v4-flash-free";
const debugLogging = process.env.DICTATION_DEBUG === "true";
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 30000);
const maxInputChars = Number(process.env.MAX_INPUT_CHARS ?? 20000);

if (!apiKey || !opencodePassword) {
  throw new Error("DICTATION_API_KEY and OPENCODE_SERVER_PASSWORD must be set");
}
if (!allowedModels.includes(defaultModel)) {
  throw new Error("DICTATION_DEFAULT_MODEL must be included in DICTATION_MODELS");
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function error(response, status, message, type = "invalid_request_error") {
  json(response, status, { error: { message, type } });
}

async function parseJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxInputChars * 2) throw new Error("Request body is too large");
  }
  return JSON.parse(body);
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim();
  }
  return null;
}

async function opencodeFetch(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${opencodeUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        authorization: `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`,
        "content-type": "application/json",
        ...options.headers,
      },
    });
    if (!response.ok) throw new Error(`OpenCode returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function responseText(result) {
  const parts = result?.parts;
  if (!Array.isArray(parts)) return null;
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim() || null;
}

export function cleanupLogRecord(completionID, model, input, cleaned, debug = debugLogging) {
  const record = {
    event: "dictation.cleaned",
    completion_id: completionID,
    model,
    timestamp: new Date().toISOString(),
  };
  if (debug) {
    record.input_dictation = input;
    record.cleaned_dictation = cleaned;
  }
  return record;
}

async function cleanDictation(text, model) {
  const session = await opencodeFetch("/session", {
    method: "POST",
    body: JSON.stringify({ title: "Dictation cleanup" }),
  });
  const sessionID = session?.id;
  if (!sessionID) throw new Error("OpenCode did not return a session ID");

  try {
    const [providerID, modelID] = model.split("/", 2);
    const result = await opencodeFetch(`/session/${encodeURIComponent(sessionID)}/message`, {
      method: "POST",
      body: JSON.stringify({
        agent,
        model: { providerID, modelID },
        parts: [{ type: "text", text }],
      }),
    });
    const cleaned = responseText(result);
    if (!cleaned) throw new Error("OpenCode returned no text response");
    return cleaned;
  } finally {
    await opencodeFetch(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" }).catch(() => {});
  }
}

export function createApp() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { status: "ok" });
    }
    const isModelsRequest = request.method === "GET" && request.url === "/v1/models";
    const isCompletionRequest = request.method === "POST" && request.url === "/v1/chat/completions";
    if (!isModelsRequest && !isCompletionRequest) {
      return error(response, 404, "Not found");
    }
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      return error(response, 401, "Invalid API key", "authentication_error");
    }
    if (isModelsRequest) {
      return json(response, 200, {
        object: "list",
        data: allowedModels.map((id) => ({ id, object: "model", created: 0, owned_by: "opencode" })),
      });
    }

    try {
      const body = await parseJson(request);
      if (body.stream) return error(response, 400, "Streaming is not supported");
      const text = latestUserText(body.messages);
      if (!text) return error(response, 400, "messages must include a non-empty user text message");
      if (text.length > maxInputChars) return error(response, 400, `Input exceeds ${maxInputChars} characters`);
      const requestedModel = typeof body.model === "string" && body.model ? body.model : defaultModel;
      if (!allowedModels.includes(requestedModel)) {
        return error(response, 400, `Unsupported model: ${requestedModel}`);
      }

      const completionID = `chatcmpl-${randomUUID()}`;
      const cleaned = await cleanDictation(text, requestedModel);
      console.info(JSON.stringify(cleanupLogRecord(completionID, requestedModel, text, cleaned)));
      return json(response, 200, {
        id: completionID,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, message: { role: "assistant", content: cleaned }, finish_reason: "stop" }],
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unknown failure";
      return error(response, 502, `Dictation cleaning failed: ${message}`, "api_error");
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  createApp().listen(configuredPort, host, () => {
    console.log(`OpenCode dictation provider listening on http://${host}:${configuredPort}`);
  });
}
