/**
 * Official-client request fingerprints, one per gateway region.
 *
 * The two gateways are different products with different official clients, and
 * they verify different things:
 *
 * - **CN** (`copilot.tencent.com`): the official CodeBuddy IDE client, captured
 *   during the 2026-09-21 mitm session documented by
 *   `Zhengyuuuui/workbuddy2api` (`doc/incident-postmortem-and-hardening-checklist.md`,
 *   `doc/mitm-capture-playbook.md`): `CodeBuddyIDE/4.12.0`, the `x-ide-*` and
 *   `x-product-*` family, a per-request trace pair, and the CN-only
 *   `accept-language` / `sec-fetch-mode` / `monitor_httpsendtime`.
 * - **International** (`www.workbuddy.ai`, alias `www.codebuddy.ai`): the
 *   WorkBuddy desktop client. Measured against the live gateway, a plain
 *   authenticated request is answered `400 / 11128 "request illegal"`; the same
 *   request passes once it carries the captured intl fingerprint —
 *   `workbuddy-ai/5.7.6 … CLI/2.156.0`, `x-ide-*` = WorkBuddy, the
 *   `x-stainless-*` block — and **no** CN-only header. So the two profiles are
 *   deliberately disjoint, exactly as `ZHENGYUUUUI/workbuddy2api` keeps them.
 *
 * Both profiles also send the trace chain the official clients send every turn:
 * a conversation id that is stable for the whole conversation, a message id and
 * request id per call, and the b3/traceparent pair. The reference proxy's
 * postmortem calls an isolated (unchained) request one of the behaviours that
 * earns risk-control escalations, so the chain is part of the simulation rather
 * than decoration.
 *
 * Every value here was verified against the live gateway on 2026-10-21 (CN and
 * intl both answered 200 with the profile and the trace chain attached).
 *
 * @module dsh-workbuddy-pool/fingerprint
 */

import { createHash, randomBytes } from "node:crypto";

/** Official CodeBuddy IDE version the CN capture belongs to. */
export const CN_IDE_VERSION = "4.12.0";
/** Official WorkBuddy desktop version the intl capture belongs to. */
export const INTL_IDE_VERSION = "5.7.6";
/** CLI half of the intl UA; the gateway parses it for the copilot version. */
export const INTL_CLI_VERSION = "2.156.0";

/** CN User-Agent: the official IDE. */
export const CN_USER_AGENT = `CodeBuddyIDE/${CN_IDE_VERSION} CodeBuddy/${CN_IDE_VERSION}`;
/** International User-Agent: the WorkBuddy desktop app. */
export const INTL_USER_AGENT = `workbuddy-ai/${INTL_IDE_VERSION} workbuddy-ai/${INTL_IDE_VERSION} CLI/${INTL_CLI_VERSION}`;

/** The intl endpoint the shipped client resolves from `/v3/config`. */
export const INTL_ENDPOINT = "https://www.codebuddy.ai";
/** The alias the same endpoint answers under. */
export const INTL_ENDPOINT_ALIAS = "https://www.workbuddy.ai";

/** How many conversations keep a trace id before the oldest is dropped. */
const TRACE_LIMIT = 512;

/**
 * Per-conversation trace state: one trace id for the whole conversation and the
 * span id of the previous request (the next request's parent).
 */
const traces = new Map();

function hexId(bytes) {
  return randomBytes(bytes).toString("hex");
}

/** A uuid-v4 shaped id (the CN capture uses `uuid.uuid4()` here). */
function uuidV4() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 32-hex conversation id derived from the prompt opening. */
export function conversationIdOf(messages) {
  if (!Array.isArray(messages)) return undefined;
  let system = "";
  let firstUser = "";
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const content = typeof message.content === "string" ? message.content : textOfParts(message.content);
    if (system === "" && message.role === "system") system = content;
    else if (firstUser === "" && message.role === "user") firstUser = content;
  }
  // The system prompt changes as tool sections are added mid-session, so only
  // its opening is part of the seed; the first user message pins the rest.
  const seed = `${system.slice(0, 160)}\u0000${firstUser}`;
  if (seed === "\u0000") return undefined;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/** Concatenated text of an OpenAI content-part array. */
function textOfParts(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * Trace state for one conversation.
 *
 * Returns fresh per-request ids plus the conversation's stable trace id, and
 * rotates the stored span so the next request can name this one as its parent.
 */
function traceState(region, conversationId) {
  const key = `${region}\u0000${conversationId}`;
  let entry = traces.get(key);
  if (entry === undefined) {
    entry = { traceId: hexId(16), lastSpanId: undefined };
    traces.set(key, entry);
    if (traces.size > TRACE_LIMIT) {
      const oldest = traces.keys().next();
      if (!oldest.done) traces.delete(oldest.value);
    }
  }
  const spanId = hexId(8);
  const parentSpanId = entry.lastSpanId ?? "0".repeat(16);
  entry.lastSpanId = spanId;
  return {
    conversationId,
    traceId: entry.traceId,
    spanId,
    parentSpanId,
    messageId: hexId(16),
    requestId: hexId(16),
  };
}

/** Headers both official clients send on every chat request. */
function traceHeaders(region, conversationId) {
  const id = conversationId === undefined ? undefined : traceState(region, conversationId);
  const conversation = conversationId ?? hexId(16);
  const traceId = id?.traceId ?? hexId(16);
  const spanId = id?.spanId ?? hexId(8);
  const parentSpanId = id?.parentSpanId ?? "0".repeat(16);
  const messageId = id?.messageId ?? hexId(16);
  const requestId = id?.requestId ?? hexId(16);
  return {
    "x-conversation-id": conversation,
    "x-conversation-message-id": messageId,
    "x-conversation-request-id": requestId,
    // Official intl ties x-request-id to the message id; the CN client ties it
    // to the request id.
    "x-request-id": region === "global" ? messageId : requestId,
    "x-root-request-id": requestId,
    "x-b3-traceid": traceId,
    "x-b3-spanid": spanId,
    "x-b3-parentspanid": parentSpanId,
    "x-b3-sampled": "1",
    b3: `${traceId}-${spanId}-1`,
    "x-trace-id": traceId,
    traceparent: `00-${traceId}-${spanId}-01`,
    "x-requested-with": "XMLHttpRequest",
  };
}

/** Fingerprint header block for one region (no identity, no authorization). */
export function fingerprintHeaders({ region, model, conversationId }) {
  const common = traceHeaders(region, conversationId);
  if (region === "global") {
    return {
      "user-agent": INTL_USER_AGENT,
      accept: "application/json",
      "x-ide-name": "WorkBuddy",
      "x-ide-type": "WorkBuddy",
      "x-ide-version": INTL_IDE_VERSION,
      "x-agent-intent": "craft",
      "x-agent-purpose": "conversation",
      "x-agent-type": "main",
      "x-private-data": "true",
      "x-codebuddy-request": "1",
      "x-product": "SaaS",
      // The desktop client ships the OpenAI JS SDK, whose x-stainless-* block is
      // part of the captured header set.
      "x-stainless-arch": "arm64",
      "x-stainless-lang": "js",
      "x-stainless-os": "MacOS",
      "x-stainless-package-version": "6.25.0",
      "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": "v22.21.1",
      ...common,
    };
  }
  return {
    "user-agent": CN_USER_AGENT,
    accept: "*/*",
    "accept-language": "*",
    "sec-fetch-mode": "cors",
    "x-ide-name": "CodeBuddyIDE",
    "x-ide-type": "CodeBuddyIDE",
    "x-ide-version": CN_IDE_VERSION,
    "x-product": "SaaS",
    "x-product-code": "codebuddy",
    "x-product-version": CN_IDE_VERSION,
    "x-env-id": "production",
    "x-agent-intent": "craft",
    ...(typeof model === "string" && model !== "" ? { "x-model-id": model } : {}),
    "monitor_httpsendtime": String(Date.now()),
    "x-request-trace-id": uuidV4(),
    ...common,
  };
}

/** Drop every conversation's trace state (tests, and a manual pool reset). */
export function resetFingerprintState() {
  traces.clear();
}
