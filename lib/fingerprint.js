/**
 * Official-client request fingerprints, one per gateway region.
 *
 * Everything here was **read out of the installed official client**, not guessed.
 * The WorkBuddy desktop 5.9.2 bundle (`resources/app.asar`) builds its gateway
 * headers in two functions that are quoted below; the version strings come from the
 * files the client itself reads:
 *
 *   - `resources/install-manifest.json` → `appVersion: "5.9.2"`
 *   - `resources/app.asar.unpacked/cli/package.json` → `"version": "2.165.0"`
 *   - the bundled `product.json` → `"applicationName": "WorkBuddy"`
 *
 * `buildVlmGatewayHeaders` (in `/main/server.js`) assembles the identity:
 *
 *     User-Agent: `WorkBuddy/${appVersion} WorkBuddy/${appVersion} CLI/${cliVersion}`
 *     X-Product: SaaS, X-IDE-Type: WorkBuddy, X-IDE-Name: WorkBuddy,
 *     X-IDE-Version: appVersion, X-Private-Data: true
 *
 * and `applyGatewayHeaders` adds the per-request block:
 *
 *     Accept: application/json, Content-Type: application/json,
 *     x-requested-with: XMLHttpRequest, X-Conversation-ID,
 *     X-Conversation-Request-ID, acp-connection-id, X-Conversation-Message-ID,
 *     X-Request-ID, X-Agent-Intent: craft, X-Agent-Purpose: conversation,
 *     x-codebuddy-request: 1
 *
 * with a trace chain of `traceparent`, a **four-field** `b3`
 * (`trace-span-1-parent`), `X-B3-TraceId`, `X-B3-ParentSpanId`, `X-B3-SpanId`,
 * `X-B3-Sampled` and `X-Trace-ID`.
 *
 * The same binary serves both regions, so both gateways get the same identity. The
 * earlier revision of this module used two *different* clients — a September capture
 * of `CodeBuddyIDE/4.12.0` for CN and `workbuddy-ai/5.7.6 … CLI/2.156.0` for intl —
 * because that is what the gateway accepted at the time. Measured on 2026-10-27, the
 * current official identity is answered 200 by both gateways, so the split is gone;
 * the CN-only extras (`x-product-code`, `x-env-id`, `monitor_httpsendtime`,
 * `x-request-trace-id`, `accept-language`, `sec-fetch-mode`) are still sent, because
 * the CN gateway accepted them and they cost nothing.
 *
 * Two behaviours are deliberately NOT copied from the official client:
 *
 *   - it sends **no** `x-stainless-*` block (the shipped OpenAI JS SDK headers the
 *     older capture showed), and inventing them was a liability, so they are gone;
 *   - its `b3` has four fields, which the older code got wrong (three); that is fixed.
 *
 * @module dsh-workbuddy-pool/fingerprint
 */

import { createHash, randomBytes } from "node:crypto";

import { defaultProfile, normalizeProfile, profileHeaders } from "./fingerprint-profile.js";

/** The official desktop version this fingerprint describes (5.9.2, 2026-10-24). */
export const CLIENT_VERSION = "5.9.2";
/** The CLI bundled inside that desktop build. */
export const CLIENT_CLI_VERSION = "2.165.0";
/** Product name the official client reports in its UA and `X-IDE-*` headers. */
export const CLIENT_PRODUCT_NAME = "WorkBuddy";

/** The UA the official client sends: `WorkBuddy/<v> WorkBuddy/<v> CLI/<cli>`. */
export const CLIENT_USER_AGENT = `${CLIENT_PRODUCT_NAME}/${CLIENT_VERSION} ${CLIENT_PRODUCT_NAME}/${CLIENT_VERSION} CLI/${CLIENT_CLI_VERSION}`;

/** Kept for the CN profile name in older callers; both regions share one identity. */
export const CN_IDE_VERSION = CLIENT_VERSION;
/** Kept for compatibility with the intl profile name in older callers. */
export const INTL_IDE_VERSION = CLIENT_VERSION;
/** Kept for compatibility: the CLI half of the UA. */
export const INTL_CLI_VERSION = CLIENT_CLI_VERSION;
/** CN User-Agent (identical to the intl one now). */
export const CN_USER_AGENT = CLIENT_USER_AGENT;
/** International User-Agent (identical to the CN one now). */
export const INTL_USER_AGENT = CLIENT_USER_AGENT;

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

/** A uuid-v4 shaped id (the official client uses `randomUUID()` here). */
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
    messageId: uuidV4(),
    requestId: uuidV4(),
    conversationRequestId: uuidV4(),
    connectionId: uuidV4(),
  };
}

/**
 * The per-request header block the official client sends on every chat call.
 *
 * Shape copied from `applyGatewayHeaders`: uuid-shaped ids for the conversation,
 * message, request and ACP connection, `craft`/`conversation` for the agent
 * headers, and the four-field b3 value.
 */
function traceHeaders(region, conversationId) {
  const id = conversationId === undefined ? undefined : traceState(region, conversationId);
  const conversation = conversationId ?? hexId(16);
  const traceId = id?.traceId ?? hexId(16);
  const spanId = id?.spanId ?? hexId(8);
  const parentSpanId = id?.parentSpanId ?? "0".repeat(16);
  const messageId = id?.messageId ?? uuidV4();
  const requestId = id?.requestId ?? uuidV4();
  const conversationRequestId = id?.conversationRequestId ?? uuidV4();
  return {
    "x-conversation-id": conversation,
    "x-conversation-message-id": messageId,
    "x-conversation-request-id": conversationRequestId,
    "x-request-id": requestId,
    "x-requested-with": "XMLHttpRequest",
    "acp-connection-id": id?.connectionId ?? uuidV4(),
    "x-b3-traceid": traceId,
    "x-b3-spanid": spanId,
    "x-b3-parentspanid": parentSpanId,
    "x-b3-sampled": "1",
    // Four fields, exactly as the official client writes it.
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "x-trace-id": traceId,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

/**
 * The live fingerprint profile.
 *
 * Held at module scope so every caller (chat, refresh, catalog) sees the same
 * rotation without threading it through the call chain. It starts as the shipped,
 * measured-working profile: a caller that never sets one — a unit test, a script —
 * gets exactly the captured header set.
 */
let activeProfile = defaultProfile();

/** Install a profile (the plugin does this at boot and on every rotation). */
export function setFingerprintProfile(profile) {
  activeProfile = normalizeProfile(profile);
  return activeProfile;
}

/** The profile currently in force. */
export function getFingerprintProfile() {
  return activeProfile;
}

/** Header block for one region from the active profile. */
export function activeProfileHeaders(region) {
  return profileHeaders(region, activeProfile);
}

/**
 * Fingerprint header block for one region (no identity, no authorization).
 *
 * Both regions send the same official-client identity; only the CN extras differ,
 * and they are additive.
 */
export function fingerprintHeaders({ region, model, conversationId }) {
  const common = traceHeaders(region, conversationId);
  const overrides = profileHeaders(region, activeProfile);
  const identity = {
    "user-agent": CLIENT_USER_AGENT,
    accept: "application/json",
    "content-type": "application/json",
    "x-ide-type": CLIENT_PRODUCT_NAME,
    "x-ide-name": CLIENT_PRODUCT_NAME,
    "x-ide-version": CLIENT_VERSION,
    "x-private-data": "true",
    "x-product": "SaaS",
    "x-agent-intent": "craft",
    "x-agent-purpose": "conversation",
    "x-codebuddy-request": "1",
  };
  if (region === "global") {
    return { ...identity, ...overrides, ...common };
  }
  // CN keeps the extras the CN gateway accepted alongside the modern identity.
  return {
    ...identity,
    "accept-language": "*",
    "sec-fetch-mode": "cors",
    "x-product-code": "codebuddy",
    "x-env-id": "production",
    ...(typeof model === "string" && model !== "" ? { "x-model-id": model } : {}),
    monitor_httpsendtime: String(Date.now()),
    "x-request-trace-id": uuidV4(),
    ...overrides,
    ...common,
  };
}

/** Drop every conversation's trace state (tests, and a manual pool reset). */
export function resetFingerprintState() {
  traces.clear();
}
