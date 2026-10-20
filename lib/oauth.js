/**
 * QR / state-handshake sign-in against the WorkBuddy plugin gateway.
 *
 * The desktop app signs in with a state handshake rather than an OAuth2 code
 * flow: ask for a `state`, show the returned `authUrl` to the phone (as a QR or
 * as a link), then poll until the phone confirms. Three calls, all recovered
 * from the shipped desktop client:
 *
 *   POST /v2/plugin/auth/state?platform=workbuddy  -> {code:0, data:{state, authUrl}}
 *   GET  /v2/plugin/auth/token?state=...           -> 11217 while waiting, 0/200 when done
 *   GET  /v2/plugin/login/account?state=...        -> identity of the signed-in account
 *
 * This is the only way to obtain a credential on a machine that never ran the
 * desktop app, so the settings card exposes it as an explicit button; nothing
 * here runs automatically.
 *
 * @module dsh-workbuddy-pool/oauth
 */

import { createHash } from "node:crypto";

import { CLIENT_UA, persistCredentialDocument } from "./credentials.js";
import { paths, writeJsonAtomic } from "./store.js";
import { pickText } from "./util.js";

const OAUTH_PLATFORM_CN = "workbuddy";
const OAUTH_PLATFORM_GLOBAL = "workbuddy-ai";
/** Business code the gateway returns while the phone has not scanned yet. */
const PENDING_CODE = 11217;

/**
 * The plugin gateway origin for one region.
 *
 * The intl build resolves its runtime endpoint from `/v3/config` and lands on
 * `www.codebuddy.ai` (alias `www.workbuddy.ai`); both answer, the alias is kept
 * so a credential signed in through it stays on the same host later.
 */
export function oauthGateway(region) {
  return region === "global" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";
}

/**
 * The platform query the official client passes to `/auth/state`.
 *
 * CN signs in as `workbuddy`, the intl desktop client as `workbuddy-ai` — the
 * platform decides which kind of token the handshake mints, so the two must not
 * be shared (verified: both values return a state, but only the intl token is
 * chat-capable on the intl gateway).
 */
export function oauthPlatform(region) {
  return region === "global" ? OAUTH_PLATFORM_GLOBAL : OAUTH_PLATFORM_CN;
}

/** One call into the gateway; throws when the answer is not JSON. */
export async function oauthCall(region, path, options = {}) {
  const platform = oauthPlatform(region);
  const response = await fetch(`${oauthGateway(region)}/v2/plugin${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Client-Platform": platform,
      "User-Agent": CLIENT_UA,
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gateway answered HTTP ${response.status} for ${path}`);
  }
}

/** A field-shaped summary of an upstream document, so diagnostics never carry tokens. */
export function oauthShape(value, depth = 0) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") {
    if (depth >= 2) return "{...}";
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = oauthShape(item, depth + 1);
    return out;
  }
  if (typeof value === "string") return value === "" ? "empty-string" : `string(${value.length})`;
  return typeof value;
}

/** Record the last sign-in outcome (shape only). */
function writeOauthRecord(payload) {
  try {
    writeJsonAtomic(paths.oauth(), { at: new Date().toISOString(), ...payload });
  } catch {
    /* diagnostics are best-effort */
  }
}

/** Whether a `/auth/token` envelope code means "signed in" (0 and 200 both count). */
export function oauthCodeSucceeded(code) {
  return code === 0 || code === 200;
}

/** Build a credential document from the gateway's answer. */
export function oauthCredentialDocument(token, account, region) {
  const sources = [token, token?.["data"], account, account?.["data"], account?.["account"]];
  const accessToken = pickText(sources, ["access_token", "accessToken"]);
  if (accessToken === undefined) return undefined;
  const identity = {};
  const nickname = pickText(sources, ["nickname", "nickName", "name"]);
  if (nickname !== undefined) identity["nickname"] = nickname;
  const phone = pickText(sources, ["phoneNumber", "phone", "mobile"]);
  if (phone !== undefined) identity["phoneNumber"] = phone;
  for (const key of ["uin", "uid", "enterpriseId", "oneidAccountId"]) {
    const value = pickText(sources, [key]);
    if (value !== undefined) identity[key] = value;
  }
  const auth = {
    accessToken,
    domain: pickText(sources, ["domain"]) ?? (region === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn"),
  };
  const refreshToken = pickText(sources, ["refresh_token", "refreshToken"]);
  if (refreshToken !== undefined) auth["refreshToken"] = refreshToken;
  const tokenType = pickText(sources, ["token_type", "tokenType"]);
  if (tokenType !== undefined) auth["tokenType"] = tokenType;
  const expiresAt = pickText(sources, ["expires_at", "expiresAt"]);
  if (expiresAt !== undefined && /^\d+$/.test(expiresAt)) auth["expiresAt"] = Number(expiresAt);
  return { account: identity, accounts: [identity], allAccounts: [identity], auth };
}

/** Start one sign-in: returns the state and the URL the phone must open. */
export async function startSignIn(region) {
  const started = await oauthCall(region, `/auth/state?platform=${encodeURIComponent(oauthPlatform(region))}`, { method: "POST", body: "{}" });
  const data = started?.["data"] ?? {};
  if (started?.["code"] !== 0 || typeof data["state"] !== "string" || typeof data["authUrl"] !== "string") {
    writeOauthRecord({ stage: "start", region, shape: oauthShape(started) });
    throw new Error(started?.["msg"] ?? "the gateway did not return a sign-in state");
  }
  writeOauthRecord({ stage: "start", region, state: hashState(data["state"]), shape: oauthShape(started) });
  return { state: data["state"], authUrl: data["authUrl"], region };
}

/** Short fingerprint of a state value (the record must not carry the secret). */
function hashState(state) {
  return createHash("sha256").update(state).digest("hex").slice(0, 12);
}

/** Poll one pending sign-in; persists the credential on success. */
export async function pollSignIn(region, state) {
  if (typeof state !== "string" || state === "") throw new Error("state is required");
  const token = await oauthCall(region, `/auth/token?state=${encodeURIComponent(state)}`, {});
  const code = token?.["code"];
  if (code === PENDING_CODE) {
    writeOauthRecord({ stage: "poll", region, status: "pending", code });
    return { status: "pending" };
  }
  if (!oauthCodeSucceeded(code) || typeof token?.["data"] !== "object" || token?.["data"] === null) {
    writeOauthRecord({ stage: "poll", region, status: "expired", code, shape: oauthShape(token) });
    return { status: "expired", code, message: token?.["msg"] ?? "sign-in was not confirmed" };
  }
  const accessToken = pickText([token["data"]], ["access_token", "accessToken"]);
  let account;
  try {
    account = await oauthCall(region, `/login/account?state=${encodeURIComponent(state)}`, {
      headers: accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    account = { error: error instanceof Error ? error.message : String(error) };
  }
  const document = oauthCredentialDocument(token["data"], account, region);
  if (document === undefined) {
    writeOauthRecord({ stage: "poll", region, status: "credential-missing", shape: oauthShape(token) });
    return { status: "expired", message: "the gateway answer carried no access token" };
  }
  const saved = persistCredentialDocument(document, { region });
  writeOauthRecord({ stage: "poll", region, status: "saved", label: saved.label, shape: oauthShape(token) });
  return { status: "ok", label: saved.label, id: saved.id, region: saved.region };
}
