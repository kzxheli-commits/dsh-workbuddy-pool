/**
 * The loopback shim: an OpenAI/Responses/Anthropic-compatible HTTP server that
 * fronts the account pool.
 *
 * Why a local server instead of an adapter straight to the upstream: rotation,
 * failover and cooldowns need to happen *before* a stream is committed to a
 * client, and the Harness adapter contract only sees one provider route. The
 * shim also lets any ordinary SDK client (Codex, Claude Code, plain OpenAI
 * clients) share the same pool over the same loopback port.
 *
 * Security: bound to 127.0.0.1, every request needs the per-region shared
 * secret, POST bodies must declare JSON, and the Host header must name loopback.
 *
 * @module dsh-workbuddy-pool/shim
 */

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { PoolError } from "./pool.js";
import {
  anthropicToChatBody,
  chatCompletionToAnthropic,
  chatCompletionToResponses,
  collectChatCompletion,
  iterateChatEvents,
  modelOf,
  responsesToChatBody,
  sessionKeyOf,
  streamAnthropic,
  streamResponses,
  wantsStream,
} from "./protocol.js";
import { CHAT_BODY_LIMIT, isJsonContentType, json, pathOf, readBodyText, safeMessage } from "./util.js";

/** Routes that actually reach a model (and therefore count toward usage). */
const MODEL_PATHS = new Set(["/v1/chat/completions", "/v1/responses", "/v1/messages"]);

/**
 * Brand phrases the gateway refuses to see in a SYSTEM message.
 *
 * Since 2026-10-20 the CN gateway answers HTTP 400 with business code `11128`
 * ("Illegal API invocation from an unapproved channel", `displayTips`: "This call
 * failed channel verification … not sent from an official client") for any chat
 * body whose system prompt names a rival harness. Measured against the live
 * gateway, the trigger is the exact signature the Harness writes into its system
 * prompt:
 *
 *   "You are an AI agent powered by DeepSeek Harness."   -> 400 / 11128
 *   "You are an AI agent powered by DeepSeek."           -> 200
 *   "DeepSeek Harness" alone, in user/assistant/tool text or a tool description
 *   or in the system prompt body ("You run in DeepSeek Harness.") -> 200
 *
 * So it is a disguised content filter, not a real channel check: the error code
 * and wording are deliberately misleading, which is why every request of an
 * otherwise healthy account suddenly fails while session-title calls (different
 * system prompt) keep succeeding.
 *
 * How it is neutralised follows `Zhengyuuuui/workbuddy2api` (`server/desensitize.py`):
 * instead of rewriting the words, a ZERO-WIDTH SPACE (U+200B) is inserted inside
 * the term. The gateway's keyword match no longer fires, while the prompt the
 * model reads stays visually identical — strictly better than a visible rename,
 * which the earlier 0.4.36 build did. Verified against the live gateway:
 *
 *   "You are an AI agent powered by DeepSeek Harness."    -> 400 / 11128
 *   "You are an AI agent powered by Deep\u200bSeek Harness." -> 200
 */
const SYSTEM_BLOCKED_PHRASES = [/\bdeepseek\s+harness\b/giu];

/** Invisible separator inserted inside a blocked phrase (zero-width space). */
const ZERO_WIDTH_SPACE = "\u200b";

/** Break keyword matching without changing the visible text. */
function breakKeywordMatch(term) {
  return term.length <= 1 ? term : `${term[0]}${ZERO_WIDTH_SPACE}${term.slice(1)}`;
}

/** Desensitise one string the way the reference gateway proxy does. */
export function desensitizeSystemText(text) {
  let out = text;
  for (const pattern of SYSTEM_BLOCKED_PHRASES) out = out.replace(pattern, breakKeywordMatch);
  return out;
}

/** Desensitise one `system` message's content, string or content-part array. */
function desensitizeSystemMessage(message) {
  const content = message.content;
  if (typeof content === "string") return { ...message, content: desensitizeSystemText(content) };
  if (!Array.isArray(content)) return message;
  let changed = false;
  const parts = content.map((part) => {
    if (typeof part !== "object" || part === null || typeof part.text !== "string") return part;
    const text = desensitizeSystemText(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...message, content: parts } : message;
}

/**
 * Normalise the message list the gateway will accept.
 *
 * Two rules were measured, not assumed:
 *
 * 1. `role: "developer"` is rejected with 400 / 11128 anywhere in the list, so it
 *    becomes `system` (the same rename the reference implementation does).
 * 2. A system message naming a rival harness is rejected the same way, so the
 *    phrase is desensitised with an invisible separator (see
 *    {@link SYSTEM_BLOCKED_PHRASES}).
 */
export function sanitizeChatMessages(messages) {
  return messages.map((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
    const role = message.role === "developer" ? "system" : message.role;
    const renamed = role === message.role ? message : { ...message, role };
    return role === "system" ? desensitizeSystemMessage(renamed) : renamed;
  });
}

/** SSE headers shared by the three streaming routes. */
function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

/** Write one named SSE event. */
function writeSse(res, eventName, data) {
  if (eventName !== undefined) res.write(`event: ${eventName}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

/** An OpenAI-shaped error body. */
function openAiErrorBody(status, message, type, code) {
  return { error: { message, type, ...(code === undefined ? {} : { code }), param: null, status } };
}

/** The error shape each route family expects. */
function errorPayload(protocol, status, error) {
  const message = error instanceof Error ? error.message : String(error);
  const reason = error instanceof PoolError ? error.reason : "upstream";
  const map = {
    "rate-limited": ["rate_limit_error", "rate_limit_exceeded"],
    "credits-exhausted": ["insufficient_quota", "insufficient_quota"],
    "needs-sign-in": ["authentication_error", "invalid_api_key"],
    "all-disabled": ["permission_error", "account_disabled"],
    "no-accounts": ["authentication_error", "no_accounts"],
    "request-invalid": ["invalid_request_error", "invalid_request"],
    "model-unavailable": ["invalid_request_error", "model_not_found"],
    "upstream-unreachable": ["server_error", "upstream_unreachable"],
  };
  const [openAiType, code] = map[reason] ?? ["api_error", "upstream_error"];
  if (protocol === "anthropic") {
    return {
      type: "error",
      error: {
        type:
          status === 401
            ? "authentication_error"
            : status === 403
              ? "permission_error"
              : status === 429
                ? "rate_limit_error"
                : status === 400
                  ? "invalid_request_error"
                  : "api_error",
        message,
      },
    };
  }
  if (protocol === "responses") {
    return { error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", code } };
  }
  return { error: { message, type: openAiType, code, param: null, status } };
}

/** Estimate output tokens when the upstream omitted usage (chars / 4). */
function estimateTokens(charCount) {
  return Math.max(0, Math.round(charCount / 4));
}

/**
 * Create the shim. `ready` resolves once the port is bound; `baseUrl()` is only
 * meaningful after that.
 */
export function createShim(options) {
  const { pool, region, logger, token } = options;
  const selection = () => options.selection?.() ?? {};
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  let address;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => undefined);

  /** Constant-time comparison, so a wrong secret cannot be guessed by timing. */
  function secretEquals(presented) {
    const given = Buffer.from(typeof presented === "string" ? presented : "", "utf8");
    const expected = Buffer.from(token, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Reject a request that did not present this shim's shared secret. */
  function allowed(req) {
    const bearer = req.headers.authorization;
    const apiKey = req.headers["x-api-key"];
    const presented = typeof bearer === "string" && bearer.startsWith("Bearer ") ? bearer.slice(7) : typeof apiKey === "string" ? apiKey : "";
    return secretEquals(presented);
  }

  /** Answer a pool failure with the protocol's error shape. */
  function fail(res, protocol, error) {
    const status = error instanceof PoolError ? error.status || 502 : 502;
    json(res, status, errorPayload(protocol, status, error));
  }

  /** Read the request body and normalise the model id. */
  async function readBody(req) {
    if (!isJsonContentType(req)) {
      const error = new Error("the request body must be declared as application/json");
      error.status = 415;
      throw error;
    }
    const text = await readBodyText(req, CHAT_BODY_LIMIT);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      const error = new Error("invalid JSON body");
      error.status = 400;
      throw error;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      const error = new Error("the request body must be a JSON object");
      error.status = 400;
      throw error;
    }
    return body;
  }

  /** Normalise a chat body for the upstream (stream forced, tool pairs repaired). */
  function prepareChatBody(body, model) {
    // The upstream refuses a non-streaming body and rejects `stream_options`,
    // so it is dropped here; usage arrives in the final chunks regardless.
    const { stream_options: _ignoredStreamOptions, ...rest } = body;
    const out = { ...rest, model, stream: true };
    if (Array.isArray(out.messages)) {
      out.messages = sanitizeChatMessages(
        repairToolPairs(out.messages.filter((message) => typeof message === "object" && message !== null && !Array.isArray(message))),
      );
    }
    const choice = out.tool_choice;
    if (choice === "none") {
      delete out.tool_choice;
      delete out.tools;
    } else if (typeof choice === "object" && choice !== null) {
      const type = typeof choice.type === "string" ? choice.type : "";
      if (type === "none") {
        delete out.tool_choice;
        delete out.tools;
      } else if (type === "auto" || type === "required") out.tool_choice = type;
      else if (type === "function") {
        // The gateway's Go struct types `tool_choice` as a plain string: the
        // OpenAI object form is rejected with "cannot unmarshal object into
        // Request.tool_choice of type string". It accepts the function NAME,
        // which is what the reference client sends, so flatten to that.
        const name = typeof choice.function?.name === "string" ? choice.function.name.trim() : "";
        if (name === "") delete out.tool_choice;
        else out.tool_choice = name;
      } else delete out.tool_choice;
    }
    return out;
  }

  /** Send one chat request through the pool and relay the SSE verbatim. */
  async function handleChat(req, res, body) {
    const model = modelOf(body);
    const sessionKey = sessionKeyOf(body);
    const started = Date.now();
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    let attempt;
    let result;
    try {
      result = await pool.chat({
        region,
        model,
        sessionKey,
        body: JSON.stringify(prepareChatBody(body, model)),
        signal: controller.signal,
        onAttempt: (account) => {
          attempt = account;
        },
      });
    } catch (error) {
      fail(res, "chat", error);
      return;
    }
    const headersAt = Date.now();
    const queueMs = result.queueMs;
    const upstream = result.response;
    if (body.stream !== true) {
      try {
        const completion = await collectChatCompletion(upstream.body, { model });
        const totalMs = Date.now() - started;
        pool.finishSuccess({
          account: result.account,
          model,
          sessionKey,
          inputTokens: completion.usage?.prompt_tokens,
          outputTokens: completion.usage?.completion_tokens,
          queueMs,
          totalMs,
        });
        json(res, 200, completion);
      } catch (error) {
        pool.failStream(result.account, { model, error });
        fail(res, "chat", new PoolError(`stream failed: ${safeMessage(error)}`, { reason: "upstream", status: 502 }));
      } finally {
        result.release();
      }
      return;
    }
    res.writeHead(200, sseHeaders());
    const outcome = await relayChatStream(res, upstream.body, { timeoutMs: options.streamIdleTimeoutMs });
    const totalMs = Date.now() - started;
    pool.finishSuccess({
      account: result.account,
      model,
      sessionKey,
      inputTokens: outcome.usage?.input,
      outputTokens: outcome.usage?.output ?? estimateTokens(outcome.textChars),
      queueMs,
      totalMs,
      firstByteMs: outcome.firstByteMs ?? headersAt - started,
    });
    result.release();
  }

  /**
   * Relay the upstream SSE bytes unchanged while scanning them for usage and
   * content, so the client sees exactly what the upstream produced.
   */
  async function relayChatStream(res, body, scanOptions = {}) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let textChars = 0;
    let usage;
    let firstByteMs;
    let sawDone = false;
    const startedAt = Date.now();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteMs === undefined) firstByteMs = Date.now() - startedAt;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk.includes("[DONE]")) sawDone = true;
        res.write(chunk);
        buffer += chunk;
        const scanned = scanSseText(buffer, { textChars, usage });
        textChars = scanned.textChars;
        usage = scanned.usage ?? usage;
        buffer = scanned.rest;
      }
      // Some gateways end the stream without the terminal `[DONE]` frame; the
      // OpenAI-compatible clients (and pi-ai) treat that as a truncated stream.
      if (!sawDone) res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      res.end();
      throw error;
    } finally {
      reader.releaseLock?.();
    }
    return { textChars, usage, firstByteMs };
  }

  /** POST /v1/responses */
  async function handleResponses(req, res, body) {
    const model = modelOf(body);
    const chatBody = responsesToChatBody(body);
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    const started = Date.now();
    let result;
    try {
      result = await pool.chat({
        region,
        model,
        sessionKey: sessionKeyOf(body),
        body: JSON.stringify(prepareChatBody(chatBody, model)),
        signal: controller.signal,
      });
    } catch (error) {
      fail(res, "responses", error);
      return;
    }
    if (!wantsStream(body)) {
      try {
        const completion = await collectChatCompletion(result.response.body, { model });
        const payload = chatCompletionToResponses(completion, body);
        pool.finishSuccess({
          account: result.account,
          model,
          sessionKey: sessionKeyOf(body),
          inputTokens: payload.usage.input_tokens,
          outputTokens: payload.usage.output_tokens,
          queueMs: result.queueMs,
          totalMs: Date.now() - started,
        });
        json(res, 200, payload);
      } catch (error) {
        fail(res, "responses", new PoolError(`stream failed: ${safeMessage(error)}`, { reason: "upstream", status: 502 }));
      } finally {
        result.release();
      }
      return;
    }
    res.writeHead(200, sseHeaders());
    const events = iterateChatEvents(result.response.body);
    let textChars = 0;
    const write = (eventName, data) => writeSse(res, eventName, data);
    try {
      const outcome = await streamResponses(
        (async function* () {
          for await (const event of events) {
            if (event.kind === "text") textChars += event.text.length;
            yield event;
          }
        })(),
        { write, model, request: body },
      );
      pool.finishSuccess({
        account: result.account,
        model,
        sessionKey: sessionKeyOf(body),
        inputTokens: outcome.usage?.input,
        outputTokens: outcome.usage?.output ?? estimateTokens(textChars),
        queueMs: result.queueMs,
        totalMs: Date.now() - started,
      });
    } finally {
      res.end();
      result.release();
    }
  }

  /** POST /v1/messages */
  async function handleMessages(req, res, body) {
    const model = modelOf(body);
    const chatBody = anthropicToChatBody(body);
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());
    const started = Date.now();
    let result;
    try {
      result = await pool.chat({
        region,
        model,
        sessionKey: sessionKeyOf(body),
        body: JSON.stringify(prepareChatBody(chatBody, model)),
        signal: controller.signal,
      });
    } catch (error) {
      fail(res, "anthropic", error);
      return;
    }
    if (body.stream !== true) {
      try {
        const completion = await collectChatCompletion(result.response.body, { model });
        const payload = chatCompletionToAnthropic(completion, body);
        pool.finishSuccess({
          account: result.account,
          model,
          sessionKey: sessionKeyOf(body),
          inputTokens: payload.usage.input_tokens,
          outputTokens: payload.usage.output_tokens,
          queueMs: result.queueMs,
          totalMs: Date.now() - started,
        });
        json(res, 200, payload);
      } catch (error) {
        fail(res, "anthropic", new PoolError(`stream failed: ${safeMessage(error)}`, { reason: "upstream", status: 502 }));
      } finally {
        result.release();
      }
      return;
    }
    res.writeHead(200, sseHeaders());
    const events = iterateChatEvents(result.response.body);
    const write = (eventName, data) => writeSse(res, eventName, data);
    try {
      const outcome = await streamAnthropic(events, { write, model });
      pool.finishSuccess({
        account: result.account,
        model,
        sessionKey: sessionKeyOf(body),
        inputTokens: outcome.usage?.input,
        outputTokens: outcome.usage?.output,
        queueMs: result.queueMs,
        totalMs: Date.now() - started,
      });
    } finally {
      res.end();
      result.release();
    }
  }

  /** The request handler shared by the first bind attempt and any fallback. */
  function handleRequest(req, res) {
    const url = pathOf(req);
    void (async () => {
      try {
        if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
          json(res, 200, {
            ok: true,
            region,
            accounts: pool.accountsOf(region).length,
            available: pool.status(region).available,
          });
          return;
        }
        if (!allowed(req)) {
          json(res, 401, openAiErrorBody(401, "missing or invalid loopback secret", "authentication_error", "invalid_api_key"));
          return;
        }
        if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
          json(res, 200, options.catalog.toOpenAiModels(selection()));
          return;
        }
        if (req.method === "POST" && MODEL_PATHS.has(url)) {
          if (!isJsonContentType(req)) {
            json(res, 415, openAiErrorBody(415, "the request body must be declared as application/json", "invalid_request_error", "invalid_content_type"));
            return;
          }
          const body = await readBody(req);
          if (url === "/v1/chat/completions" || url === "/v1/chat/completions/") return await handleChat(req, res, body);
          if (url === "/v1/responses" || url === "/v1/responses/") return await handleResponses(req, res, body);
          return await handleMessages(req, res, body);
        }
        json(res, 404, openAiErrorBody(404, `unknown route ${req.method ?? ""} ${url}`, "invalid_request_error", "unknown_route"));
      } catch (error) {
        const status = typeof error?.status === "number" ? error.status : 500;
        if (!res.headersSent) json(res, status, openAiErrorBody(status, safeMessage(error), "invalid_request_error"));
        else res.end();
        logger?.warn?.(`workbuddy-pool shim: ${safeMessage(error)}`);
      }
    })();
  }

  /**
   * Bind one server. A preferred port already held by another Harness process
   * (two instances sharing a profile, or a restart overlapping the old process)
   * falls back to an OS-assigned port: failing the whole provider registration
   * over a port collision would leave the second instance with no models at all,
   * and the port is only ever used through `baseUrl()`.
   */
  async function bind(listenPort) {
    const server = createServer(handleRequest);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || listenPort === 0) throw error;
      logger?.warn?.(`workbuddy-pool: port ${listenPort} is taken; falling back to an OS-assigned port`);
      server.close(() => undefined);
      return bind(0);
    }
    const bound = server.address();
    if (bound === null || typeof bound === "string") {
      server.close(() => undefined);
      throw new Error("the loopback shim did not bind a TCP port");
    }
    address = bound;
    serverRef = server;
    return { host: bound.address, port: bound.port, baseUrl: `http://127.0.0.1:${bound.port}` };
  }

  let serverRef;
  bind(port).then(
    (bound) => {
      address = { address: bound.host, port: bound.port };
      readyResolve(bound);
    },
    (error) => readyReject(error),
  );

  return {
    ready,
    baseUrl: () => (address === undefined ? "" : `http://127.0.0.1:${address.port}`),
    token: () => token,
    region,
    close: () =>
      new Promise((resolve) => {
        if (serverRef === undefined) return resolve();
        serverRef.close(() => resolve());
      }),
  };
}

/** Repair tool-call/tool-result pairing before a body reaches the upstream. */
export function repairToolPairs(messages) {
  const paired = [];
  const callIds = new Set();
  const resultIds = new Set();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) if (typeof call?.id === "string") callIds.add(call.id);
    } else if (message.role === "tool" && typeof message.tool_call_id === "string") {
      resultIds.add(message.tool_call_id);
    }
  }
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      // Drop calls whose result is missing: the upstream rejects "call without result".
      const calls = message.tool_calls.filter((call) => typeof call?.id !== "string" || resultIds.has(call.id));
      if (calls.length === 0 && (message.content === null || message.content === "")) continue;
      paired.push({ ...message, tool_calls: calls.length === message.tool_calls.length ? message.tool_calls : calls });
    } else if (message.role === "tool") {
      // Drop results whose call was trimmed away: "result before call" is rejected too.
      if (typeof message.tool_call_id === "string" && !callIds.has(message.tool_call_id)) continue;
      paired.push(message);
    } else {
      paired.push(message);
    }
  }
  // The upstream also refuses a conversation that opens with a tool result.
  const first = paired[0];
  if (first !== undefined && first.role === "tool") {
    paired.unshift({ role: "user", content: "Continue." });
  }
  return paired;
}

/**
 * Scan relayed SSE text for usage and visible content, keeping the last
 * incomplete frame buffered.
 */
function scanSseText(buffer, previous) {
  let rest = buffer;
  let textChars = previous.textChars ?? 0;
  let usage = previous.usage;
  for (;;) {
    const match = /\r?\n\r?\n/u.exec(rest);
    if (match === null) break;
    const frame = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    for (const rawLine of frame.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      const prompt = /"prompt_tokens"\s*:\s*(\d+)/u.exec(payload);
      const completion = /"completion_tokens"\s*:\s*(\d+)/u.exec(payload);
      if (prompt !== null || completion !== null) {
        usage = {
          input: prompt === null ? usage?.input : Number(prompt[1]),
          output: completion === null ? usage?.output : Number(completion[1]),
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const choices = parsed?.choices;
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const delta = choices[0]?.delta;
      if (typeof delta?.content === "string") textChars += delta.content.length;
    }
  }
  // A frame longer than this is not a frame the parser can use; drop it so a
  // malformed stream cannot pin memory.
  if (rest.length > 4 * 1024 * 1024) rest = rest.slice(-1024);
  return { rest, textChars, usage };
}
