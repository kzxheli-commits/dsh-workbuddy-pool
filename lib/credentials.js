/**
 * WorkBuddy credentials: discovery, parsing, identity, regions, and persistence.
 *
 * A credential is one signed-in WorkBuddy account. Sources, in priority order:
 *
 * 1. the desktop app's own auth directory (files it wrote while signing in);
 * 2. the plugin's imported credentials (`<DSH install>/workbuddy-pool/credentials`,
 *    written by the QR sign-in route and by pasted `.info` JSON);
 * 3. an explicit `WORKBUDDY_AUTH_FILE` directory.
 *
 * Nothing here starts a login: discovery is read-only.
 *
 * @module dsh-workbuddy-pool/credentials
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { isEncryptedFieldWrapper, decryptField, atRestAvailable } from "./at-rest.js";
import { LIVE_AUTH_FILENAME, MIRROR_PREFIX, credentialDirs, ensureDir, paths, writeFileSyncAtomic } from "./store.js";

/** CN chat/gateway base — the desktop CLI probes this one for chat and models. */
export const CN_CHAT_BASE = "https://copilot.tencent.com";
/** CN console origin: billing reads happen here. */
export const CN_BILLING_BASE = "https://www.codebuddy.cn";
/** Global product base for `workbuddy.ai` sign-ins. */
export const GLOBAL_BASE = "https://www.workbuddy.ai";
/** CLI client spelling; the CN gateway accepts chat/models under this UA. */
export const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/** Desktop app spelling; the global gateway serves its product config only to this channel. */
export const DESKTOP_UA = "WorkBuddy/5.5.2";
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
const GLOBAL_CONFIG_PATH = "/v3/config";
const CHAT_PATH = "/v2/chat/completions";
const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
const CREDITS_PATH = "/v2/billing/meter/get-user-resource";
/** Billing product code the credits query expects. */
const CREDIT_PRODUCT_CODE = "p_tcaca";

/** International hostnames, once each has been stripped of a leading label. */
const GLOBAL_HOSTS = ["workbuddy.ai", "workbuddy.cc", "codebuddy.ai"];

/** Raised when a credential file exists but its fields are encrypted and no desktop app can open them. */
export class WorkBuddyEncryptedCredentialError extends Error {
  constructor(sourcePath) {
    super(`workbuddy: ${basename(sourcePath)} is encrypted; the WorkBuddy desktop app is needed to open it (import a plaintext .info or use QR sign-in instead)`);
    this.name = "WorkBuddyEncryptedCredentialError";
    this.sourcePath = sourcePath;
  }
}

/** Region for a login domain; an empty domain means CN, matching upstream tooling. */
export function regionOf(domain) {
  const lowered = String(domain ?? "").trim().toLowerCase();
  for (const host of GLOBAL_HOSTS) {
    if (lowered === host || lowered.endsWith(`.${host}`)) return "global";
  }
  return "cn";
}

/** The `iss` claim of a JWT access token, or "" when it cannot be read. */
export function issuerOf(token) {
  if (typeof token !== "string" || token === "") return "";
  const parts = token.split(".");
  if (parts.length < 2) return "";
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return typeof payload?.iss === "string" ? payload.iss : "";
  } catch {
    return "";
  }
}

/** Gateway for a global credential (brand domains are not interchangeable). */
export function globalBase(credential) {
  const lowered = String(credential.domain ?? "").trim().toLowerCase();
  if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
  return GLOBAL_BASE;
}

/** Region of a credential, preferring the token's own issuer over the recorded domain. */
export function regionOfCredential(credential) {
  const issuer = issuerOf(credential.accessToken);
  if (issuer !== "") {
    const host = issuer.replace(/^https?:\/\//iu, "").split("/")[0];
    if (host !== "") return regionOf(host);
  }
  return regionOf(credential.domain);
}

/** Chat/gateway base for one credential. */
export function chatBase(credential) {
  return regionOfCredential(credential) === "global" ? globalBase(credential) : CN_CHAT_BASE;
}

/** Billing/console base for one credential. */
export function billingBase(credential) {
  return regionOfCredential(credential) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}

/** The origin/referer the upstream expects for a browser-shaped request. */
function originReferer(credential) {
  return regionOfCredential(credential) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}

/** Headers every upstream request shares. */
function commonHeaders(credential) {
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: originReferer(credential),
    Referer: `${originReferer(credential)}/`,
    "User-Agent": CLIENT_UA,
  };
}

/** Chat request headers, including the `X-No-*` conventions the official CLI uses. */
export function chatHeaders(credential) {
  return {
    ...commonHeaders(credential),
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.accessToken}`,
    ...(credential.uid === "" || credential.uid === undefined ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ""
      ? { "X-No-Enterprise-Id": "1" }
      : { "X-Enterprise-Id": credential.enterpriseId }),
    ...(credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain }),
    "X-Product": "SaaS",
  };
}

/** Token-refresh headers: the refresh token travels in its own header. */
export function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    "X-Refresh-Token": credential.refreshToken ?? "",
    "X-Auth-Refresh-Source": "workbuddy",
  };
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
  }
  return headers;
}

/** Billing query headers. */
export function billingHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (credential.uid !== "" && credential.uid !== undefined) headers["X-User-Id"] = credential.uid;
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
    headers["X-Tenant-Id"] = credential.enterpriseId;
  }
  if (credential.domain !== "") headers["X-Domain"] = credential.domain;
  return headers;
}

/** Model-catalog request headers (the two gateways want different spellings). */
export function catalogHeaders(credential) {
  if (regionOfCredential(credential) === "global") {
    return {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
      ...(credential.uid === undefined || credential.uid === "" ? {} : { "X-User-Id": credential.uid }),
      ...(credential.domain === "" ? {} : { "X-Domain": credential.domain }),
      "X-Product": "SaaS",
      "X-Requested-With": "XMLHttpRequest",
      Connection: "close",
      "User-Agent": DESKTOP_UA,
    };
  }
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: "application/json",
    Origin: originReferer(credential),
    Referer: `${originReferer(credential)}/`,
    "User-Agent": CLIENT_UA,
  };
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
  }
  return headers;
}

/** Upstream URLs for one credential. */
export const upstreamPaths = {
  chat: CHAT_PATH,
  refresh: REFRESH_PATH,
  models: MODELS_CATALOG_PATH,
  globalConfig: GLOBAL_CONFIG_PATH,
  credits: CREDITS_PATH,
  creditProductCode: CREDIT_PRODUCT_CODE,
};

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
  if (typeof value !== "number" || value <= 0) return 0;
  return value > 100_000_000_000 ? value : value * 1000;
}

function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Read one string field that may be plain or the desktop app's encrypted wrapper. */
function decryptableString(value) {
  if (typeof value === "string") return { value, encrypted: false, failed: false };
  if (isEncryptedFieldWrapper(value)) {
    try {
      return { value: decryptField(value) ?? "", encrypted: true, failed: false };
    } catch {
      return { value: "", encrypted: true, failed: true };
    }
  }
  return { value: "", encrypted: false, failed: false };
}

/**
 * Parse a WorkBuddy auth document.
 *
 * Accepts the nested desktop shape `{"auth":{...},"account":{...}}` and the flat
 * panel shape; returns undefined when there is no usable access token.
 */
export function parseAuthDocument(text, sourcePath) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const document = parsed;
  let auth;
  let identity;
  if (typeof document["auth"] === "object" && document["auth"] !== null) {
    auth = document["auth"];
    identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
  } else {
    auth = document;
    identity = document;
  }
  const accessField = decryptableString(auth["accessToken"]);
  if (accessField.encrypted && accessField.failed) throw new WorkBuddyEncryptedCredentialError(sourcePath);
  const accessToken = accessField.value;
  if (accessToken === "") return undefined;
  const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : undefined;
  // A refresh token that is already past its own expiry cannot be renewed: the
  // whole file is dead weight, not a usable account.
  if (refreshExpiresAtMs !== undefined && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) return undefined;
  const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : undefined;
  const nickname = optionalString(decryptableString(identity["nickname"]).value);
  return {
    accessToken,
    refreshToken: decryptableString(auth["refreshToken"]).value,
    expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    ...(lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs }),
    ...(nickname === undefined ? {} : { nickname }),
    ...(optionalString(identity["uin"]) === undefined ? {} : { uin: optionalString(identity["uin"]) }),
    ...(optionalString(identity["uid"]) === undefined ? {} : { uid: optionalString(identity["uid"]) }),
    ...(optionalString(identity["enterpriseId"]) === undefined ? {} : { enterpriseId: optionalString(identity["enterpriseId"]) }),
    ...(optionalString(identity["phoneNumber"]) === undefined ? {} : { phoneNumber: optionalString(identity["phoneNumber"]) }),
    domain: typeof auth["domain"] === "string" ? auth["domain"] : "",
    sourcePath,
  };
}

/** Stable account id: `uin ?? uid ?? phoneNumber ?? nickname`. */
export function workbuddyAccountId(credential) {
  const stable = credential.uin ?? credential.uid ?? credential.phoneNumber ?? credential.nickname ?? "unknown";
  return createHash("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}

/** Mask a phone number wherever it appears in a label (keep the last four digits). */
export function maskPhoneInLabel(value) {
  const text = String(value ?? "");
  if (text === "") return text;
  return text.replace(/(^|[^0-9])(\+?)(\d{11,15})(?![0-9])/gu, (_match, lead, plus, digits) => {
    return `${lead}${plus}${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
  });
}

/** Human label; distinguishes same-nickname accounts by an id suffix. */
export function accountLabel(credential) {
  const nickname = maskPhoneInLabel(credential.nickname ?? "").trim();
  const fallback = maskPhoneInLabel(credential.phoneNumber ?? "").trim();
  const base = nickname !== "" ? nickname : fallback !== "" ? fallback : `WorkBuddy ${workbuddyAccountId(credential).slice(0, 6)}`;
  const suffix = credential.uin ?? credential.uid;
  if (suffix === undefined || suffix === "") return base;
  return `${base} · ${String(suffix).slice(0, 6)}`;
}

/** True when `path` is the desktop app's live sign-in rather than a backup snapshot. */
export function isLiveAuthFile(path) {
  return basename(path) === LIVE_AUTH_FILENAME;
}

/** Which of two credentials for the same account is fresher (lower = fresher). */
function compareFreshness(a, b) {
  const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0;
  const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0;
  if (aLive !== bLive) return bLive - aLive;
  const aIssued = a.lastRefreshAtMs ?? 0;
  const bIssued = b.lastRefreshAtMs ?? 0;
  if (aIssued !== bIssued) return bIssued - aIssued;
  return b.expiresAtMs - a.expiresAtMs;
}

/** True when `candidate` should replace `incumbent` for the same account. */
export function isFresher(candidate, incumbent) {
  return compareFreshness(candidate, incumbent) < 0;
}

/**
 * Scan every credential directory and return the freshest credential per account.
 *
 * `needsDesktopKey` reports whether encrypted files were skipped because no
 * desktop app could provide the key, so the card can explain the empty pool
 * instead of pretending nothing was found.
 */
export function discoverCredentials(env = process.env, platform = process.platform, home = undefined) {
  const dirs = credentialDirs(env, platform, home);
  const byId = new Map();
  const warnings = [];
  let scannedFiles = 0;
  let encryptedSkipped = 0;
  for (const dir of dirs) {
    let entries;
    try {
      if (!existsSync(dir)) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".info")) continue;
      const full = join(dir, entry);
      let text;
      try {
        if (!statSync(full).isFile()) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      scannedFiles += 1;
      let credential;
      try {
        credential = parseAuthDocument(text, full);
      } catch (error) {
        if (error instanceof WorkBuddyEncryptedCredentialError) {
          encryptedSkipped += 1;
          if (!warnings.includes("encrypted")) warnings.push("encrypted");
          continue;
        }
        continue;
      }
      if (credential === undefined) continue;
      const id = workbuddyAccountId(credential);
      const incumbent = byId.get(id);
      if (incumbent === undefined || isFresher(credential, incumbent)) byId.set(id, credential);
    }
  }
  if (encryptedSkipped > 0 && !atRestAvailable()) {
    warnings.push("desktop-app-required");
  }
  return { credentials: byId, warnings, scannedFiles, encryptedSkipped, dirs };
}

/**
 * Persist one credential document written by the QR route or pasted by the user.
 *
 * The document must contain plaintext tokens (the parser is given the raw JSON,
 * so an encrypted wrapper from an old app build is rejected with a clear error).
 * The file is always written into the plugin's own import directory under the
 * DSH install root — the plugin never writes into the desktop app's signed-in
 * directory; those files are only ever read there.
 */
export function persistCredentialDocument(document, options = {}) {
  const text = `${JSON.stringify(document, undefined, 1)}\n`;
  const credential = parseAuthDocument(text, "(import)");
  if (credential === undefined) throw new Error("the document carries no usable WorkBuddy access token");
  const id = workbuddyAccountId(credential);
  const stableKey = credential.uin ?? credential.uid ?? credential.nickname ?? credential.phoneNumber;
  const suffix = stableKey === undefined ? createHash("sha256").update(credential.accessToken).digest("hex").slice(0, 8) : id.slice(0, 8);
  const name = `${MIRROR_PREFIX}${options.region ?? (regionOfCredential(credential) === "global" ? "global" : "cn")}-${suffix}.info`;
  const dir = options.dir ?? paths.importedCredentials();
  ensureDir(dir);
  const target = join(dir, name);
  writeTextAtomic(target, text);
  return { name, path: target, id, label: accountLabel(credential), region: regionOfCredential(credential) };
}

function writeTextAtomic(target, text) {
  writeFileSyncAtomic(target, text, 0o600);
}
