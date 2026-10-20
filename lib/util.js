/**
 * Small, dependency-free helpers shared by every Host module.
 *
 * The HTTP helpers here are the security boundary of the loopback shim and of
 * the settings routes, so they are deliberately explicit about what they accept
 * (see `writeAllowed` for why the JSON content-type carries the weight).
 *
 * @module dsh-workbuddy-pool/util
 */

import { createHash } from "node:crypto";

/** Upper bound for every JSON body the plugin accepts from the browser. */
export const JSON_BODY_LIMIT = 64 * 1024;
/** Upper bound for the loopback shim request body (chat payloads are large). */
export const CHAT_BODY_LIMIT = 64 * 1024 * 1024;

/** A human-readable message for any thrown value. */
export function safeMessage(error) {
  if (error instanceof Error) return error.message;
  if (error === undefined) return "unknown error";
  return typeof error === "string" ? error : String(error);
}

/** True for a plain JSON object (not null, not an array). */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First non-empty string across candidate sources, key order first. */
export function pickText(sources, keys) {
  for (const key of keys) {
    for (const source of sources) {
      const value = source?.[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return undefined;
}

/** First positive finite number across candidate sources, key order first. */
export function pickNumber(sources, keys) {
  for (const key of keys) {
    for (const source of sources) {
      const value = source?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

/** Sleep for `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Local calendar day (`YYYY-MM-DD`) used by every daily ledger. */
export function dayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Round to two decimals. */
export function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Stable short identifier for a secret string (never reversible). */
export function hashId(text, length = 12) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, length);
}

/** One ISO timestamp. */
export function nowIso() {
  return new Date().toISOString();
}

/** Percentile (0..1) of a numeric sample; `undefined` for an empty sample. */
export function percentile(values, ratio) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

/** Append into a fixed-size ring buffer, dropping the oldest entries. */
export function ringPush(buffer, entry, limit) {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  return buffer;
}

/**
 * Serialize async work: tasks queue behind each other in call order.
 * Used for credential writes and cooldown persistence so two concurrent
 * requests cannot interleave a read-modify-write.
 */
export function createMutex() {
  let tail = Promise.resolve();
  return function run(task) {
    const next = tail.then(task, task);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

/** Coerce to an integer inside `[min, max]`, or return `fallback`. */
export function clampInt(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** `content-type` is JSON (parameters such as charset are ignored). */
export function isJsonContentType(req) {
  const header = req.headers["content-type"];
  if (typeof header !== "string") return false;
  const media = header.split(";")[0]?.trim().toLowerCase();
  return media === "application/json";
}

/** `host` names the loopback interface (DNS-rebinding guard). */
export function hostIsLoopback(host) {
  if (typeof host !== "string" || host === "") return false;
  const value = host.trim().toLowerCase();
  const bare = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.split(":")[0];
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "[::1]";
}

/**
 * Only loopback browser origins may talk to the plugin routes.
 *
 * `Origin: null` and a missing Origin are accepted because the Harness client
 * half can be loaded from `file://` and a sandboxed frame sends `null` too.
 * This predicate is the readability check, NOT the write boundary;
 * `writeAllowed` adds the JSON content-type requirement that a cross-site form
 * cannot satisfy.
 */
export function loopbackOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined || origin.trim() === "" || origin.trim().toLowerCase() === "null") return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Guard for routes that change state.
 *
 * 1. the request must declare a JSON body — a cross-site JSON POST triggers a
 *    preflight this server never approves, and a cross-site form cannot declare
 *    `application/json`;
 * 2. a real `Origin` must be loopback;
 * 3. `Host` must name loopback (stops DNS rebinding).
 */
export function writeAllowed(req) {
  if (!isJsonContentType(req)) return false;
  if (!loopbackOrigin(req)) return false;
  return hostIsLoopback(req.headers.host);
}

/** Write one JSON response with no-store caching. */
export function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read and parse a JSON request body, capped at `limit` bytes; `{}` when empty. */
export function readJsonBody(req, limit = JSON_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      req.destroy();
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(isPlainObject(parsed) ? parsed : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** Read a raw request body as a string, capped at `limit` bytes. */
export function readBodyText(req, limit = CHAT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
      req.destroy();
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return fail(new Error("request body too large"));
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** Parse one URL's query string against a dummy base. */
export function queryOf(req) {
  try {
    return new URL(req.url ?? "/", "http://loopback.invalid").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Path without query string. */
export function pathOf(req) {
  const raw = req.url ?? "/";
  const cut = raw.indexOf("?");
  return cut === -1 ? raw : raw.slice(0, cut);
}
