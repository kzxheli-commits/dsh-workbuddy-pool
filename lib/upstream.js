/**
 * The WorkBuddy upstream client: chat, token refresh, model catalog, credits.
 *
 * The gateway speaks an OpenAI-compatible chat protocol, so the shim forwards a
 * normalised OpenAI body and re-frames the SSE it gets back. Everything here is
 * account-scoped: one credential in, one HTTP call out.
 *
 * @module dsh-workbuddy-pool/upstream
 */

import { gzipSync } from "node:zlib";

import {
  billingBase,
  billingHeaders,
  catalogHeaders,
  chatBase,
  chatHeaders,
  globalBase,
  refreshHeaders,
  regionOfCredential,
  upstreamPaths,
} from "./credentials.js";

/** Cap on an error body kept for diagnostics. */
const ERROR_BODY_LIMIT = 4096;
/** Default JSON timeout for the non-streaming helper calls. */
const JSON_TIMEOUT_MS = 30_000;
/** Request bodies above this size are gzipped before they leave the process. */
const GZIP_THRESHOLD_BYTES = 4096;

/** Session-invalidation markers: "this credential is dead; rotate". */
const SESSION_DEAD_MARKERS = [
  "Offline user session not found",
  "12153",
  "api key is invalid",
  "invalid api key",
  "invalid_api_key",
  "api密钥无效",
  "密钥无效",
  "无效的密钥",
  "unauthorized",
  "token expired",
  "token is invalid",
  "login expired",
  "please login",
  "未登录",
  "登录已失效",
  "重新登录",
];

/**
 * Failures that belong to the REQUEST, not to any account: the same body fails
 * identically on every account, so rotating would only multiply the failure.
 */
const REQUEST_FAULT_MARKERS = [
  "context length",
  "context_length_exceeded",
  "context window",
  "maximum context",
  "too many tokens",
  "max_tokens",
  "prompt is too long",
  "input is too long",
  "image is invalid",
  "invalid image",
  "unsupported image",
  "unmarshal chat params failed",
  "invalid request body",
  "请求体过长",
  "上下文超限",
  "图片不合法",
  "图片格式",
  "参数错误",
];

/** Insufficient-credit markers (ASCII lowercase plus the original Chinese). */
const HARD_CREDIT_MARKERS = [
  "insufficient credit",
  "no credit",
  "credit exhausted",
  "out of credit",
  "quota exceeded",
  "quota exhaust",
  "payment required",
  "credit not enough",
  "not enough credit",
  "积分不足",
  "额度不足",
  "余额不足",
  "积分用完",
  "额度用尽",
  "没有积分",
];

/** Wordings for "this account was restricted by the platform" (re-login cannot help). */
const ACCOUNT_RESTRICTED_MARKERS = [
  "账号存在异常行为",
  "帳號存在異常行為",
  "unusual activity",
  "account has been restricted",
  "account is restricted",
  "已被限制使用",
];

/** Wordings for "that model is not available to you". */
const MODEL_BLOCKED_MARKERS = [
  "service info not found",
  "model unavailable",
  "model not found",
  "model not exist",
  "no such model",
  "invalid model",
  "unsupported model",
  "模型不可用",
  "模型不存在",
  "当前模型不可用",
];

/** Business codes: request-side faults. */
const REQUEST_FAULT_CODES = new Set([11101, 11115, 11148]);
/** Business codes: this backend does not serve that model. */
const MODEL_BLOCKED_CODES = new Set([11102]);
/** Business codes: the account is platform-restricted (not an expired credential). */
const ACCOUNT_RESTRICTED_CODES = new Set([11140, 11142]);
/** Wordings for "today is already checked in" (an idempotent success). */
const ALREADY_CHECKIN_MARKERS = ["已签到", "already"];

/** Depth-limited search for a numeric `code` field anywhere in a parsed body. */
function findNumericField(value, key, depth) {
  if (depth > 4 || typeof value !== "object" || value === null) return undefined;
  const direct = value[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (typeof direct === "string" && /^\d{3,6}$/u.test(direct)) return Number(direct);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findNumericField(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The upstream's numeric business code, when the body carries one. */
export function readBusinessCode(body) {
  try {
    const found = findNumericField(JSON.parse(body), "code", 0);
    if (found !== undefined) return found;
  } catch {
    /* fall through to the text scan */
  }
  const match = /"(?:code|statusCode)"\s*:\s*"?(\d{3,6})"?/u.exec(body);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 *
 * The question is not "what went wrong" but "whose fault is it", because the
 * pool acts on that: an account fault is cooled and rotated past, a request
 * fault is answered immediately. Ordering matters and is documented inline.
 *
 * @returns {string} one of `hard_credit | session_dead | account_restricted |
 *   model_blocked | request_fault | soft_rate | not_found | server | client | transport`
 */
export function classifyUpstreamError(status, body) {
  if (status === 402) return "hard_credit";
  if (status === 401) return "session_dead";
  if (status === 403) {
    const businessCode = readBusinessCode(body);
    if (businessCode !== undefined && REQUEST_FAULT_CODES.has(businessCode)) return "request_fault";
    if (businessCode !== undefined && MODEL_BLOCKED_CODES.has(businessCode)) return "model_blocked";
    if (businessCode !== undefined && ACCOUNT_RESTRICTED_CODES.has(businessCode)) return "account_restricted";
    const lower = body.toLowerCase();
    for (const marker of ACCOUNT_RESTRICTED_MARKERS) {
      if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "account_restricted";
    }
    for (const marker of MODEL_BLOCKED_MARKERS) {
      if (lower.includes(marker.toLowerCase())) return "model_blocked";
    }
    return "session_dead";
  }
  const lower = body.toLowerCase();
  for (const marker of REQUEST_FAULT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "request_fault";
  }
  const code = readBusinessCode(body);
  if (code !== undefined) {
    if (REQUEST_FAULT_CODES.has(code)) return "request_fault";
    if (MODEL_BLOCKED_CODES.has(code)) return "model_blocked";
  }
  // A 429 body often says "quota exceeded"; the status is the more specific
  // signal here and must win over the exhausted-credit markers below.
  if (status === 429) return "soft_rate";
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return "session_dead";
  }
  if (/"(?:code|statusCode)"\s*:\s*"?6004"?/u.test(body)) return "soft_rate";
  if (body.includes("soft_rate") || body.includes("频率限制")) return "soft_rate";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}

/**
 * Parse the reset time the upstream reports for a rate limit, when present.
 * Sentence forms carry a wall clock with no zone; the upstream means UTC+8.
 */
export function parseRateLimitReset(body) {
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*"?(\d{13})"?/u.exec(body);
  if (epochMs !== null) {
    const parsed = Number(epochMs[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/u.exec(body);
  if (localized !== null) {
    const parsed = Date.parse(`${localized[1].replace(" ", "T")}+08:00`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const english = /reset at\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/iu.exec(body);
  if (english !== null) {
    const parsed = Date.parse(`${english[1].replace(" ", "T")}+08:00`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** Whether an error means "today is already checked in" (a success for the scheduler). */
export function isAlreadyCheckin(body) {
  for (const marker of ALREADY_CHECKIN_MARKERS) {
    if (body.includes(marker)) return true;
  }
  return false;
}

/** Parse the `{code, data, msg}` envelope every gateway JSON answer uses. */
export async function readEnvelope(response) {
  const text = await response.text().catch(() => "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const envelope = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  return {
    status: response.status,
    ok: response.ok,
    code: typeof envelope["code"] === "number" ? envelope["code"] : undefined,
    msg: typeof envelope["msg"] === "string" ? envelope["msg"] : typeof envelope["message"] === "string" ? envelope["message"] : text.slice(0, ERROR_BODY_LIMIT),
    data: typeof envelope["data"] === "object" && envelope["data"] !== null ? envelope["data"] : {},
    raw: envelope,
  };
}

/** An Error carrying the envelope's code/status so callers can classify it. */
export class EnvelopeError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "EnvelopeError";
    this.status = options?.status ?? 0;
    this.code = options?.code;
    this.body = options?.body ?? "";
  }
}

/** Build an EnvelopeError from one failed envelope read. */
function envelopeError(envelope) {
  const message = envelope.msg !== "" ? envelope.msg : `upstream HTTP ${envelope.status}`;
  return new EnvelopeError(message, { status: envelope.status, code: envelope.code, body: envelope.msg });
}

/**
 * Whether one upstream model row accepts image input.
 *
 * The gateway has spelled this three ways over time — a boolean
 * `supportsImages`, an `input: ["text","image"]` modality list, and a
 * `capabilities: { vision: true }` object — so all of them are read, and an
 * unknown shape stays undefined (callers treat that as "no image input").
 */
export function supportsImagesOf(raw) {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (typeof raw["supportsImages"] === "boolean") return raw["supportsImages"];
  if (typeof raw["supportsVision"] === "boolean") return raw["supportsVision"];
  if (typeof raw["imageInput"] === "boolean") return raw["imageInput"];
  // A modality list is authoritative: if the build lists modalities and image is
  // not among them, the model is text-only.
  const lists = [raw["input"], raw["inputModalities"], raw["modalities"]?.input, raw["capabilities"]?.input];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    return list.some((item) => typeof item === "string" && /image|vision/iu.test(item));
  }
  const vision = raw["capabilities"]?.vision ?? raw["capabilities"]?.images;
  if (typeof vision === "boolean") return vision;
  return undefined;
}

/** Parse an upstream model row into the catalog's internal shape. */
export function parseUpstreamModel(value) {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value;
  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  if (id === "" || raw["disabled"] === true) return undefined;
  const input = typeof raw["maxInputTokens"] === "number" ? raw["maxInputTokens"] : 0;
  const output = typeof raw["maxOutputTokens"] === "number" ? raw["maxOutputTokens"] : 0;
  if (input <= 0 || output <= 0) return undefined;
  const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
  const creditMultiplier = parseCreditMultiplier(raw["credits"]);
  const reasoning = parseReasoning(raw["reasoning"]);
  const tags = Array.isArray(raw["tags"]) ? raw["tags"].filter((tag) => typeof tag === "string") : undefined;
  return {
    id,
    name,
    contextWindow: input,
    maxOutputTokens: output,
    ...(creditMultiplier === undefined ? {} : { creditMultiplier }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(typeof raw["supportsToolCall"] === "boolean" ? { supportsToolCall: raw["supportsToolCall"] } : {}),
    ...(supportsImagesOf(raw) === undefined ? {} : { supportsImages: supportsImagesOf(raw) }),
    ...(typeof raw["descriptionZh"] === "string" && raw["descriptionZh"] !== "" ? { descriptionZh: raw["descriptionZh"] } : {}),
    ...(typeof raw["descriptionEn"] === "string" && raw["descriptionEn"] !== "" ? { descriptionEn: raw["descriptionEn"] } : {}),
    ...(tags === undefined ? {} : { tags }),
  };
}

/** Parse the upstream's `"x0.11"` style credit rate. */
export function parseCreditMultiplier(value) {
  if (typeof value !== "string") return undefined;
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The single-letter effort ladder older builds send instead of `supportedEfforts`. */
function singularEffortLadder(raw) {
  if (typeof raw["effort"] !== "string") return undefined;
  return ["low", "medium", "high"].filter((level) => raw[level] === true || raw["effort"] === level);
}

/** Parse the upstream reasoning block into supported effort levels. */
export function parseReasoning(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value;
  const effort = typeof raw["effort"] === "string" ? raw["effort"] : undefined;
  const supportedEfforts = Array.isArray(raw["supportedEfforts"])
    ? raw["supportedEfforts"].filter((entry) => typeof entry === "string")
    : singularEffortLadder(raw);
  const defaultEffort = typeof raw["defaultEffort"] === "string" ? raw["defaultEffort"] : effort;
  const canDisableThinking = typeof raw["canDisableThinking"] === "boolean" ? raw["canDisableThinking"] : undefined;
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) return undefined;
  return {
    ...(supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(canDisableThinking === undefined ? {} : { canDisableThinking }),
  };
}

/** Normalize a formatted UTC+8 timestamp the credits query expects. */
function formatQueryTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * One credential's upstream client.
 *
 * `fetchImpl` is injectable so the mock-upstream suite can drive the real code
 * paths without network access.
 */
export class WorkBuddyClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.timeoutMs = options.timeoutMs ?? JSON_TIMEOUT_MS;
  }

  /**
   * POST one streaming chat completion. Never throws for upstream HTTP failures.
   *
   * Bodies over `GZIP_THRESHOLD_BYTES` are gzipped: the official client compresses
   * its large chat requests, and a long DSH conversation is exactly the "超大
   * 上下文 + 未压缩 body" profile the reference proxy's postmortem ties to the
   * 6004/11140 risk-control escalations (`Zhengyuuuui/workbuddy2api`). Verified
   * against the live CN gateway: a gzipped body returns 200.
   *
   * `options.model` feeds the CN `x-model-id` header; `options.conversationId`
   * keeps the trace chain stable across the turns of one conversation.
   */
  async chatStream(credential, body, options = {}) {
    const { signal, model, conversationId } = options;
    let response;
    try {
      const headers = chatHeaders(credential, { model, conversationId });
      let payload = body;
      if (typeof body === "string" && Buffer.byteLength(body, "utf8") > GZIP_THRESHOLD_BYTES) {
        payload = gzipSync(Buffer.from(body, "utf8"));
        headers["content-encoding"] = "gzip";
      }
      response = await this.fetchImpl(`${chatBase(credential)}${upstreamPaths.chat}`, {
        method: "POST",
        headers,
        body: payload,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return { ok: false, kind: "transport", status: 0, message: `transport error: ${String(error)}`, retryAfterMs: undefined };
    }
    if (response.ok) return { ok: true, response };
    const text = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
    return {
      ok: false,
      kind: classifyUpstreamError(response.status, text),
      status: response.status,
      message: text,
      retryAfterMs: response.status === 429 ? parseRateLimitReset(text) : undefined,
    };
  }

  /** POST the token-refresh endpoint and return the merged outcome. */
  async refreshToken(credential) {
    const response = await this.fetchImpl(`${chatBase(credential)}${upstreamPaths.refresh}`, {
      method: "POST",
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(envelope);
    const data = envelope.data;
    const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
    if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again");
    const outcome = { accessToken };
    if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
    if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
    if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
    return outcome;
  }

  /**
   * Fetch one credential's model catalog. CN serves the roster at
   * `/v2/enterprises/personal/models`; global serves it inside `/v3/config` and
   * only to the desktop client channel. Both share the `{models, agents}` shape.
   */
  async fetchModels(credential, signal) {
    const global = regionOfCredential(credential) === "global";
    const url = global
      ? `${globalBase(credential)}${upstreamPaths.globalConfig}`
      : `${chatBase(credential)}${upstreamPaths.models}`;
    const response = await this.fetchImpl(url, {
      headers: catalogHeaders(credential),
      ...(signal === undefined ? {} : { signal }),
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(envelope);
    const data = envelope.data;
    const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
    const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
    let cliIds;
    for (const agent of agents) {
      if (typeof agent === "object" && agent !== null && agent["name"] === "cli" && Array.isArray(agent["models"])) {
        cliIds = agent["models"].filter((id) => typeof id === "string");
        break;
      }
    }
    const byId = new Map();
    for (const model of rawModels) {
      const parsed = parseUpstreamModel(model);
      if (parsed !== undefined) byId.set(parsed.id, parsed);
    }
    const models = (cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()])
      .map((id) => byId.get(id))
      .filter((model) => model !== undefined);
    if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
    return models;
  }

  /** Read-only credits query, aggregated from the billing packages. */
  async fetchCredits(credential) {
    const now = new Date();
    const response = await this.fetchImpl(`${billingBase(credential)}${upstreamPaths.credits}`, {
      method: "POST",
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: upstreamPaths.creditProductCode,
        Status: [0, 3],
        PackageEndTimeRangeBegin: formatQueryTime(now),
        PackageEndTimeRangeEnd: formatQueryTime(new Date(now.getTime() + 3_185_136_000_000)),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(envelope);
    const wrapper = envelope.data;
    const data = typeof wrapper["Response"] === "object" && wrapper["Response"] !== null ? wrapper["Response"] : {};
    const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
    const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
    let total = 0;
    let nearestExpiryMs;
    let expiringSoon = 0;
    const soonWindowMs = 259_200_000;
    const parseDate = (raw) => {
      if (typeof raw === "number" && raw > 100_000_000_000) return raw;
      if (typeof raw === "string" && raw !== "") {
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed)) return parsed;
      }
      return undefined;
    };
    for (const raw of rawAccounts) {
      if (typeof raw !== "object" || raw === null) continue;
      const account = raw;
      const num = (key) => (typeof account[key] === "number" ? account[key] : 0);
      const monthly = num("CapacityType") === 4;
      const remain = monthly ? num("CycleCapacityRemain") : num("CapacityRemain");
      const capped = remain < 0 ? 0 : remain;
      const cycleEndMs = parseDate(account["CycleEndTime"]);
      const expiresAtMs = monthly ? undefined : parseDate(account["ExpiredTime"]) ?? cycleEndMs;
      if (!monthly && (capped <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))) continue;
      total += capped;
      if (expiresAtMs !== undefined) {
        if (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs;
        if (expiresAtMs - Date.now() <= soonWindowMs) expiringSoon += capped;
      }
    }
    return {
      total,
      ...(nearestExpiryMs === undefined ? {} : { nearestExpiryMs }),
      expiringSoon,
      packages: rawAccounts.length,
    };
  }

  /**
   * One automation-side JSON call (check-in, report, task claim, ...), shared by
   * every task so each one only supplies its path and body.
   */
  async callAutomation(credential, path, options = {}) {
    const response = await this.fetchImpl(`${billingBase(credential)}${path}`, {
      method: options.method ?? "POST",
      headers: {
        ...billingHeaders(credential),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(envelope);
    return envelope.data;
  }
}
