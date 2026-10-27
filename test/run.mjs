/**
 * Offline verification suite for dsh-workbuddy-pool.
 *
 * Everything runs against a local mock of the WorkBuddy gateway: the real
 * upstream needs a signed-in account, which a test machine must not require.
 * The suite drives the real modules (pool, shim, protocol translation,
 * automation, at-rest decryption) over real HTTP, so the only faked part is the
 * gateway itself.
 *
 * Run: node test/run.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/* ------------------------------------------------------------------ *
 * Isolate plugin state into a temp DSH_HOME before importing modules that
 * resolve paths from it.
 * ------------------------------------------------------------------ */
const sandbox = mkdtempSync(join(tmpdir(), "wbp-test-"));
process.env["DSH_HOME"] = join(sandbox, "dsh");
mkdirSync(process.env["DSH_HOME"], { recursive: true });

const { WorkBuddyClient, classifyUpstreamError, parseRateLimitReset, readBusinessCode, parseUpstreamModel, supportsImagesOf } = await import("../lib/upstream.js");
const credentials = await import("../lib/credentials.js");
const { parseAuthDocument, discoverCredentials, workbuddyAccountId, regionOfCredential, accountLabel } = credentials;
const { WorkBuddyAccountPool } = await import("../lib/pool.js");
const { WorkBuddyCatalog, FALLBACK_MODELS } = await import("../lib/catalog.js");
const { createShim, repairToolPairs, sanitizeChatMessages, desensitizeSystemText } = await import("../lib/shim.js");
const { conversationIdOf, fingerprintHeaders, getFingerprintProfile, resetFingerprintState, setFingerprintProfile } = await import("../lib/fingerprint.js");
const { MIN_ROTATE_HOURS, PROFILE_SCHEMA, clampRotateHours, defaultProfile, normalizeProfile, profileHeaders, randomProfile, resetProfileValue, rotationDue, setProfileValue } = await import(
  "../lib/fingerprint-profile.js"
);
const protocol = await import("../lib/protocol.js");
const automation = await import("../lib/automation.js");
const atRest = await import("../lib/at-rest.js");
const settingsModule = await import("../lib/settings.js");
const store = await import("../lib/store.js");

/* ------------------------------------------------------------------ *
 * Mock upstream
 * ------------------------------------------------------------------ */

const hits = { chat: 0, models: 0, credits: 0, refresh: 0, automation: 0 };
const perToken = new Map();
let lastChatBody;
let lastChatHeaders;
let mock;

function sse(res, frames, options = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  if (options.done !== false) res.write("data: [DONE]\n\n");
  res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      // Large chat bodies arrive gzipped, exactly like the real upstream sees them.
      resolve(req.headers["content-encoding"] === "gzip" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
    });
  });
}

const mockServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const path = url.pathname;
  const auth = String(req.headers.authorization ?? "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const body = await readBody(req);
  let parsedBody = {};
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = {};
  }

  if (path === "/v2/chat/completions") {
    hits.chat += 1;
    lastChatBody = parsedBody;
    lastChatHeaders = req.headers;
    const count = (perToken.get(token) ?? 0) + 1;
    perToken.set(token, count);
    // Account A is rate-limited on its first two calls, then recovers.
    if (token === "token-a" && count <= 2) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 429, msg: "rate limited", data: {} }));
      return;
    }
    if (token === "token-dead") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 14015, msg: "token expired", data: {} }));
      return;
    }
    if (parsedBody.model === "no-done-model") {
      sse(res, [{ choices: [{ index: 0, delta: { content: "no done frame" }, finish_reason: "stop" }] }], { done: false });
      return;
    }
    if (parsedBody.model === "tool-model") {
      sse(res, [
        { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ]);
      return;
    }
    sse(res, [
      { choices: [{ index: 0, delta: { content: "Hello" } }] },
      { choices: [{ index: 0, delta: { content: " from mock" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
    ]);
    return;
  }
  if (path === "/v2/enterprises/personal/models" || path === "/v3/config") {
    hits.models += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        code: 0,
        data: {
          models: [
            { id: "glm-5.3", name: "GLM-5.3", maxInputTokens: 200000, maxOutputTokens: 128000, credits: "x0.11", supportsImages: true, reasoning: { supportedEfforts: ["low", "medium", "high"] } },
            { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", maxInputTokens: 1000000, maxOutputTokens: 128000, credits: "x0.11" },
            { id: "tool-model", name: "Tool Model", maxInputTokens: 200000, maxOutputTokens: 128000 },
          ],
          agents: [{ name: "cli", models: ["glm-5.3", "deepseek-v4.1-flash"] }],
        },
      }),
    );
    return;
  }
  if (path === "/v2/plugin/auth/token/refresh") {
    hits.refresh += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { accessToken: "token-b", refreshToken: "r-b", expiresIn: 7200, domain: "www.codebuddy.cn" } }));
    return;
  }
  if (path === "/v2/billing/meter/get-user-resource") {
    hits.credits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        code: 0,
        data: {
          Response: {
            Data: {
              Accounts: [{ CapacityType: 1, CapacitySize: 1000, CapacityRemain: 900, ExpiredTime: Date.now() + 86_400_000 }],
            },
          },
        },
      }),
    );
    return;
  }
  if (path === "/v2/billing/meter/checkin-activity-status") {
    hits.automation += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { active: true, today_checked_in: false, streak_days: 5, daily_credit: 20 } }));
    return;
  }
  if (path === "/v2/billing/meter/daily-checkin") {
    hits.automation += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { credit: 20, streak_days: 6 } }));
    return;
  }
  if (path === "/activity/growth/streak") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { streak: { days: 6 }, redemption_status: { tiers: [{ tier: "7d", days: 7, credit: 50 }], tier_7d_status: "locked" }, makeup_cards: { balance: 1 } } }));
    return;
  }
  if (path.startsWith("/v2/activity/growth/tasks") || path.startsWith("/activity/growth/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { tasks: [], chances: 0, buddy: null } }));
    return;
  }
  if (path === "/v2/report" || path.startsWith("/v2/billing/meter") || path.startsWith("/billing/meter") || path.startsWith("/activity/growth/tasks/")) {
    hits.automation += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: {} }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 404, msg: "Route Not Found" }));
});

const mockBase = await new Promise((resolve) => {
  mockServer.listen(0, "127.0.0.1", () => {
    const address = mockServer.address();
    resolve(`http://127.0.0.1:${address.port}`);
  });
});

/** Route every upstream host to the mock, keeping path + query. */
const fetchImpl = async (url, init) => {
  const parsed = new URL(url);
  return fetch(`${mockBase}${parsed.pathname}${parsed.search}`, init);
};
const client = new WorkBuddyClient({ fetchImpl });

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** One plaintext `.info` document. */
function authDocument({ token, uin, nickname, domain = "www.codebuddy.cn", refreshToken }) {
  return {
    auth: {
      accessToken: token,
      domain,
      expiresAt: Date.now() + 7 * 86_400_000,
      ...(refreshToken === undefined ? {} : { refreshToken }),
    },
    account: { uin, nickname },
  };
}

const credDir = join(sandbox, "auth");
mkdirSync(credDir, { recursive: true });
writeFileSync(join(credDir, "a.info"), JSON.stringify(authDocument({ token: "token-a", uin: "a1", nickname: "账号甲", refreshToken: "r-a" })));
writeFileSync(join(credDir, "b.info"), JSON.stringify(authDocument({ token: "token-b", uin: "b1", nickname: "账号乙" })));

const testEnv = { WORKBUDDY_AUTH_FILE: join(credDir, "a.info") };
const testHome = join(sandbox, "home");
mkdirSync(testHome, { recursive: true });

/* ------------------------------------------------------------------ *
 * Tiny test harness
 * ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n         ${error?.message ?? error}\n`);
  }
}
function section(name) {
  process.stdout.write(`\n# ${name}\n`);
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

section("credentials");

await test("parses the nested desktop shape and derives a stable id", () => {
  const credential = parseAuthDocument(JSON.stringify(authDocument({ token: "token-a", uin: "a1", nickname: "账号甲" })), "a.info");
  assert.equal(credential.accessToken, "token-a");
  assert.equal(credential.uin, "a1");
  assert.equal(regionOfCredential(credential), "cn");
  assert.match(workbuddyAccountId(credential), /^[0-9a-f]{16}$/u);
  assert.match(accountLabel(credential), /账号甲/u);
});

await test("rejects a document with no access token", () => {
  assert.equal(parseAuthDocument(JSON.stringify({ auth: { domain: "x" } }), "x.info"), undefined);
});

await test("routes an international domain to the global region", () => {
  const credential = parseAuthDocument(JSON.stringify(authDocument({ token: "t", uin: "g1", domain: "www.workbuddy.ai" })), "g.info");
  assert.equal(regionOfCredential(credential), "global");
});

await test("discovers one freshest credential per account and skips expired refreshes", () => {
  writeFileSync(join(credDir, "expired.info"), JSON.stringify({ auth: { accessToken: "dead", refreshExpiresAt: Date.now() - 1000 }, account: { uin: "z" } }));
  const found = discoverCredentials(testEnv, "linux", testHome);
  const ids = [...found.credentials.keys()];
  assert.equal(ids.length, 2);
  assert.ok(![...found.credentials.values()].some((credential) => credential.accessToken === "dead"));
});

await test("decrypts $wbEncrypted fields with the app's at-rest key", () => {
  const key = createHash("sha256").update("test-secret", "utf8").digest();
  atRest.setAtRestKeyForTest(key);
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const plaintext = "token-from-envelope";
  const nonce = randomBytes(12);
  const aad = fieldAadForTest(keyId, 1);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope = { suite: 1, keyId, nonce: nonce.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  const wrapper = { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64") };
  assert.equal(atRest.decryptField(wrapper), plaintext);
  const document = parseAuthDocument(JSON.stringify({ auth: { accessToken: wrapper }, account: { uin: "enc" } }), "enc.info");
  assert.equal(document.accessToken, plaintext);
});

/** Mirror of the at-rest field AAD, for encrypting a fixture. */
function fieldAadForTest(keyId, suite) {
  const uint32 = (value) => {
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const lenPrefixed = (value) => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([uint32(bytes.length), bytes]);
  };
  return Buffer.concat([
    Buffer.from("WB-AAD\0", "ascii"),
    Buffer.from([1]),
    lenPrefixed("WBEV1"),
    lenPrefixed("sym-v1"),
    uint32(suite),
    lenPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

section("upstream classification");

await test("classifies statuses and bodies the way the gateway words them", () => {
  assert.equal(classifyUpstreamError(402, ""), "hard_credit");
  assert.equal(classifyUpstreamError(401, ""), "session_dead");
  assert.equal(classifyUpstreamError(403, '{"code":11140}'), "account_restricted");
  assert.equal(classifyUpstreamError(403, '{"code":11102,"msg":"model unavailable"}'), "model_blocked");
  assert.equal(classifyUpstreamError(403, '{"code":11148}'), "request_fault");
  assert.equal(classifyUpstreamError(429, '{"msg":"quota exceeded"}'), "soft_rate");
  assert.equal(classifyUpstreamError(500, ""), "server");
  assert.equal(classifyUpstreamError(400, '{"msg":"context length exceeded"}'), "request_fault");
  assert.equal(classifyUpstreamError(400, '{"msg":"积分不足"}'), "hard_credit");
  assert.equal(readBusinessCode('{"data":{"code":6004}}'), 6004);
});

await test("parses the 429 reset time from body text only", () => {
  assert.equal(parseRateLimitReset('{"resetAt":1730000000123}'), 1730000000123);
  const localized = parseRateLimitReset("请求将在 2026-10-20 12:00:00 恢复");
  assert.equal(typeof localized, "number");
});

section("catalog");

await test("serves the static fallback before a live fetch", () => {
  const catalog = new WorkBuddyCatalog({ client, region: "cn" });
  // A previous test run's cache may exist under the temp DSH_HOME; fallback or live are both valid.
  assert.ok(catalog.models().length > 0);
  assert.ok(FALLBACK_MODELS.some((model) => model.id === "glm-5.3"));
});

await test("fetches the live roster, keeps the cli agent filter, and honours a model selection", async () => {
  const catalog = new WorkBuddyCatalog({ client, region: "cn" });
  const refresh = await catalog.refresh({ accessToken: "token-b", uid: "b1", domain: "www.codebuddy.cn", enterpriseId: undefined });
  assert.equal(refresh.ok, true);
  assert.equal(catalog.isFallback(), false);
  assert.deepEqual(catalog.models().map((model) => model.id), ["glm-5.3", "deepseek-v4.1-flash"]);
  assert.equal(catalog.visible({ enabledModelIds: ["glm-5.3"] }).length, 1);
  // An empty list and a stale id list both mean "no filter": the provider must
  // never be registered with zero models.
  assert.equal(catalog.visible({ enabledModelIds: [] }).length, catalog.models().length);
  assert.equal(catalog.visible({ enabledModelIds: ["model-that-was-removed"] }).length, catalog.models().length);
  // Image support can only be narrowed, never granted: listing a text-only model
  // must not turn its image input on.
  const images = catalog.visible({ imageModelIds: ["glm-5.3"] });
  assert.equal(images.find((model) => model.id === "glm-5.3").supportsImages, true);
  assert.equal(images.find((model) => model.id === "deepseek-v4.1-flash").supportsImages, false);
  const wronglyGranted = catalog.visible({ imageModelIds: ["deepseek-v4.1-flash"] });
  assert.equal(wronglyGranted.find((model) => model.id === "deepseek-v4.1-flash").supportsImages, false);
  assert.equal(wronglyGranted.find((model) => model.id === "glm-5.3").supportsImages, false);
  // An empty override turns image input off everywhere.
  const noImages = catalog.visible({ imageModelIds: [] });
  assert.equal(noImages.every((model) => model.supportsImages === false), true);
  assert.equal(catalog.toOpenAiModels().data.length, 2);
  assert.match(catalog.toOpenAiModels().data[0].name, /x0\.11/u);
  // The status payload must carry the unfiltered roster too: the settings page
  // needs every model to be able to re-enable one that the saved selection hides.
  const filtered = catalog.status({ enabledModelIds: ["glm-5.3"] });
  assert.equal(filtered.visible, 1);
  assert.deepEqual(filtered.models.map((model) => model.id), ["glm-5.3"]);
  assert.deepEqual(filtered.roster.map((model) => model.id), catalog.models().map((model) => model.id));
  assert.equal(catalog.status({ enabledModelIds: [] }).roster.length, catalog.models().length);
});


section("model capability parsing");

await test("reads image support from every upstream shape", () => {
  // Boolean flag (current gateway).
  assert.equal(supportsImagesOf({ supportsImages: true }), true);
  assert.equal(supportsImagesOf({ supportsImages: false }), false);
  // Modality lists and capability objects used by other builds.
  assert.equal(supportsImagesOf({ input: ["text", "image"] }), true);
  assert.equal(supportsImagesOf({ input: ["text"] }), false);
  assert.equal(supportsImagesOf({ inputModalities: ["image"] }), true);
  assert.equal(supportsImagesOf({ capabilities: { vision: true } }), true);
  assert.equal(supportsImagesOf({ capabilities: { vision: false } }), false);
  assert.equal(supportsImagesOf({ supportsVision: true }), true);
  // Unknown shape: leave it undefined so callers treat it as text-only.
  assert.equal(supportsImagesOf({}), undefined);
  assert.equal(supportsImagesOf({ supportsImages: "yes" }), undefined);
});

await test("keeps parsed model image flags through the catalog", () => {
  const withFlag = parseUpstreamModel({ id: "a", maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: true });
  const listOnly = parseUpstreamModel({ id: "b", maxInputTokens: 1000, maxOutputTokens: 100, input: ["text", "image"] });
  const textOnly = parseUpstreamModel({ id: "c", maxInputTokens: 1000, maxOutputTokens: 100 });
  assert.equal(withFlag.supportsImages, true);
  assert.equal(listOnly.supportsImages, true);
  assert.equal(textOnly.supportsImages, undefined);
});

section("pool");

/** Build a pool over the fixture directory. */
function buildPool(options = {}) {
  const pool = new WorkBuddyAccountPool({
    client,
    scanner: () => discoverCredentials(testEnv, "linux", testHome),
    logger: { info() {}, warn() {}, error() {} },
  });
  pool.applyConfig({ distribution: "priority", minUsableCredits: 0, ...options });
  pool.scan();
  return pool;
}

await test("scan finds both accounts and reports ids", () => {
  const pool = buildPool();
  assert.equal(pool.accounts.size, 2);
  assert.equal(pool.accountsOf("cn").length, 2);
  pool.dispose();
});

await test("rotates past a rate-limited account and cools it per model", async () => {
  const pool = buildPool();
  const result = await pool.chat({
    region: "cn",
    model: "glm-5.3",
    sessionKey: "s-1",
    body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.account.credential.accessToken, "token-b");
  const cooled = [...pool.accounts.values()].filter((account) => account.cooldownUntil > Date.now());
  assert.equal(cooled.length, 1);
  assert.equal(cooled[0].credential.accessToken, "token-a");
  assert.equal(cooled[0].modelCooldowns.get("glm-5.3") > Date.now(), true);
  result.release();
  assert.equal(pool.sticky.get("s-1"), undefined);
  pool.finishSuccess({ account: result.account, model: "glm-5.3", sessionKey: "s-1", inputTokens: 12, outputTokens: 4, queueMs: result.queueMs, totalMs: 30 });
  assert.equal(pool.sticky.get("s-1"), result.account.id);
  assert.equal(pool.status("cn").requests.length, 2);
  pool.resetCooldowns();
  assert.equal([...pool.accounts.values()].every((account) => account.cooldownUntil === 0), true);
  pool.dispose();
});

await test("answers a request fault without rotating", async () => {
  const pool = buildPool();
  const failing = {
    chatStream: async () => ({ ok: false, kind: "request_fault", status: 400, message: "context length exceeded" }),
  };
  const isolated = new WorkBuddyAccountPool({ client: failing, scanner: () => discoverCredentials(testEnv, "linux", testHome) });
  isolated.applyConfig({ minUsableCredits: 0 });
  isolated.scan();
  await assert.rejects(
    () => isolated.chat({ region: "cn", model: "glm-5.3", body: "{}" }),
    (error) => error.reason === "request-invalid" && error.status === 400 && error.attempts === 1,
  );
  isolated.dispose();
  pool.dispose();
});

await test("refreshes a dead credential once before retiring the account", async () => {
  const dir = join(sandbox, "dead");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "dead.info"), JSON.stringify(authDocument({ token: "token-dead", uin: "dead", nickname: "死号", refreshToken: "r-dead" })));
  const pool = new WorkBuddyAccountPool({
    client,
    scanner: () => discoverCredentials({ WORKBUDDY_AUTH_FILE: join(dir, "dead.info") }, "linux", join(sandbox, "home2")),
  });
  pool.applyConfig({ minUsableCredits: 0 });
  pool.scan();
  const account = [...pool.accounts.values()][0];
  const refreshed = await pool.refreshCredential(account);
  assert.equal(refreshed, true);
  assert.equal(account.credential.accessToken, "token-b");
  assert.ok(hits.refresh >= 1);
  pool.dispose();
});

await test("usage and the request log are per region and survive a restart", () => {
  const dir = join(sandbox, "usage");
  mkdirSync(dir, { recursive: true });
  const previous = process.env["DSH_INSTALL_DIR"];
  process.env["DSH_INSTALL_DIR"] = dir;
  try {
    const pool = buildPool();
    pool.record({ at: Date.now(), region: "cn", model: "glm-5.3", ok: true, status: 200, queueMs: 0, totalMs: 10, inputTokens: 100, outputTokens: 50 });
    pool.record({ at: Date.now(), region: "global", model: "glm-5.3", ok: true, status: 200, queueMs: 0, totalMs: 20, inputTokens: 7, outputTokens: 3 });
    assert.equal(pool.usageStatus("cn").today.requests, 1);
    assert.equal(pool.usageStatus("global").today.requests, 1);
    assert.equal(pool.usageStatus("cn").today.input, 100);
    assert.equal(pool.usageStatus("global").today.input, 7);
    assert.equal(pool.status("cn").requests.length, 1);
    assert.equal(pool.status("cn").stats.length, 1);
    assert.equal(pool.status("global").requests.length, 1);
    pool.dispose();

    // A fresh instance over the same install dir must rebuild both ledgers from
    // the persisted request log.
    const reopened = buildPool();
    assert.equal(reopened.usageStatus("cn").today.requests, 1);
    assert.equal(reopened.usageStatus("global").today.input, 7);
    assert.equal(reopened.status("cn").requests.length, 1);
    assert.equal(reopened.status("global").stats.length, 1);
    reopened.dispose();
  } finally {
    if (previous === undefined) delete process.env["DSH_INSTALL_DIR"];
    else process.env["DSH_INSTALL_DIR"] = previous;
  }
});

section("shim (real HTTP)");

/** Build one shim over a two-account pool and a live catalog. */
async function buildShim() {
  const pool = buildPool();
  const catalog = new WorkBuddyCatalog({ client, region: "cn" });
  await catalog.refresh({ accessToken: "token-b", uid: "b1", domain: "www.codebuddy.cn" });
  const shim = createShim({ pool, catalog, region: "cn", token: "shim-secret", port: 0, logger: { warn() {} } });
  const ready = await shim.ready;
  return { pool, catalog, shim, base: ready.baseUrl };
}

const shimFixture = await buildShim();
const authHeaders = { authorization: "Bearer shim-secret", "content-type": "application/json" };

await test("rejects a request without the loopback secret", async () => {
  const response = await fetch(`${shimFixture.base}/v1/models`);
  assert.equal(response.status, 401);
});

await test("lists models for the harness adapter", async () => {
  const response = await fetch(`${shimFixture.base}/v1/models`, { headers: { authorization: "Bearer shim-secret" } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "list");
  assert.ok(body.data.length >= 2);
});

await test("serves a non-streaming chat completion", async () => {
  shimFixture.pool.resetCooldowns();
  const response = await fetch(`${shimFixture.base}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Hello from mock");
  assert.equal(body.usage.prompt_tokens, 12);
});

await test("relays a streaming chat completion verbatim with [DONE]", async () => {
  shimFixture.pool.resetCooldowns();
  const response = await fetch(`${shimFixture.base}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const text = await response.text();
  assert.match(text, /"content":"Hello"/u);
  assert.match(text, /\[DONE\]/u);
  assert.match(text, /"usage"/u);
});

await test("answers the Responses API in both modes", async () => {
  shimFixture.pool.resetCooldowns();
  const plain = await fetch(`${shimFixture.base}/v1/responses`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: "glm-5.3", input: "hi" }),
  });
  const body = await plain.json();
  assert.equal(plain.status, 200);
  assert.equal(body.object, "response");
  assert.equal(body.output_text, "Hello from mock");
  assert.equal(body.output[0].type, "message");

  const streamed = await fetch(`${shimFixture.base}/v1/responses`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: "glm-5.3", input: "hi", stream: true }),
  });
  const text = await streamed.text();
  assert.match(text, /event: response\.created/u);
  assert.match(text, /event: response\.output_text\.delta/u);
  assert.match(text, /event: response\.completed/u);
});

await test("answers the Anthropic Messages API in both modes", async () => {
  shimFixture.pool.resetCooldowns();
  const plain = await fetch(`${shimFixture.base}/v1/messages`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: "glm-5.3", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await plain.json();
  assert.equal(plain.status, 200);
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "Hello from mock");
  assert.equal(body.stop_reason, "end_turn");

  const streamed = await fetch(`${shimFixture.base}/v1/messages`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: "glm-5.3", max_tokens: 100, messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const text = await streamed.text();
  assert.match(text, /event: message_start/u);
  assert.match(text, /event: content_block_delta/u);
  assert.match(text, /event: message_stop/u);
});

await test("maps tool calls to Anthropic tool_use with stop_reason tool_use", async () => {
  shimFixture.pool.resetCooldowns();
  const response = await fetch(`${shimFixture.base}/v1/messages`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: "tool-model", max_tokens: 100, tools: [{ name: "bash", input_schema: { type: "object" } }], messages: [{ role: "user", content: "run ls" }] }),
  });
  const body = await response.json();
  assert.equal(body.stop_reason, "tool_use");
  const toolUse = body.content.find((block) => block.type === "tool_use");
  assert.equal(toolUse.name, "bash");
  assert.deepEqual(toolUse.input, { command: "ls" });
});

await test("terminates a relayed stream even when the gateway omits [DONE]", async () => {
  shimFixture.pool.resetCooldowns();
  const response = await fetch(`${shimFixture.base}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: "no-done-model", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const text = await response.text();
  assert.match(text, /no done frame/u);
  assert.match(text, /\[DONE\]\s*$/u);
});

await test("requires a JSON content type on model routes", async () => {
  const response = await fetch(`${shimFixture.base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer shim-secret", "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(response.status, 415);
});

section("protocol translation");

await test("repairs tool-call/tool-result pairing", () => {
  const repaired = repairToolPairs([
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }] },
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "call_orphan", content: "orphan" },
  ]);
  // The call without a result and the result without a call are both dropped.
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].role, "user");
});

await test("renames developer and desensitises the harness phrase the gateway blocks", () => {
  const sanitized = sanitizeChatMessages([
    { role: "developer", content: "You are an AI agent powered by DeepSeek Harness." },
    { role: "user", content: "explain DeepSeek Harness" },
    { role: "system", content: [{ type: "text", text: "The DeepSeek  Harness checkout." }, { type: "text", text: "unrelated" }] },
    { role: "assistant", content: "DeepSeek Harness" },
  ]);
  assert.equal(sanitized[0].role, "system");
  // The brand is renamed in prose, so the prompt the model reads names WorkBuddy.
  assert.equal(sanitized[0].content, "You are an AI agent running inside WorkBuddy.");
  // Every role is covered now, not just `system`: the filter reads the whole prompt.
  assert.equal(sanitized[1].content, "explain WorkBuddy Harness");
  // A doubled space in the source collapses as part of the phrase rewrite.
  assert.equal(sanitized[2].content[0].text, "The WorkBuddy Harness checkout.");
  assert.equal(sanitized[2].content[1].text, "unrelated");
  assert.equal(sanitized[3].content, "WorkBuddy Harness");
  // Idempotent: an already-sanitised text is left alone.
  assert.equal(desensitizeSystemText(sanitized[0].content), sanitized[0].content);
});

await test("desensitisation never touches paths, file names, URLs or model ids", () => {
  const text = [
    "Read C:\\Users\\lenovo\\Documents\\deepseek-harness\\README.md before editing.",
    "The repo is deepseek-harness and the file is lib/shim.js.",
    "Fetch https://example.com/deepseek/harness.json for details.",
    "Install @deepseek-ai/schemastery and run deepseek-v4.1-flash.",
    "Then check $env:DSH_HOME and ./scripts/build.ps1.",
    "DeepSeek Harness is the product name here.",
  ].join(" ");
  const out = desensitizeSystemText(text);
  // Every protected span survives byte for byte.
  for (const span of [
    "C:\\Users\\lenovo\\Documents\\deepseek-harness\\README.md",
    "deepseek-harness",
    "lib/shim.js",
    "https://example.com/deepseek/harness.json",
    "@deepseek-ai/schemastery",
    "deepseek-v4.1-flash",
    "$env:DSH_HOME",
    "./scripts/build.ps1",
  ]) {
    assert.ok(out.includes(span), `expected ${span} to survive unchanged`);
  }
  // ...while the prose brand mention is renamed.
  assert.ok(out.includes("WorkBuddy Harness"), "the prose brand mention is renamed");
  assert.ok(!/\bDeepSeek Harness\b/u.test(out), "no prose DeepSeek mention is left behind");
});

await test("the measured filter trigger sentence is rewritten", () => {
  const trigger = "Tokens prefixed with @ are paths the user explicitly referenced.";
  const out = desensitizeSystemText(trigger);
  assert.notEqual(out, trigger, "the triggering sentence must be rewritten");
  assert.ok(out.includes("@"), "the instruction still mentions @-prefixed tokens");
  // The rewrite is stable: running it twice changes nothing further.
  assert.equal(desensitizeSystemText(out), out);
  // With the trigger rule off the sentence is left alone.
  assert.equal(desensitizeSystemText(trigger, { triggers: false, brand: false }), trigger);
});

await test("sends the upstream a sanitized body with a string tool_choice", async () => {
  shimFixture.pool.resetCooldowns();
  const response = await fetch(`${shimFixture.base}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      model: "glm-5.3",
      stream: false,
      messages: [
        { role: "developer", content: "You are an AI agent powered by DeepSeek Harness." },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "bash" } },
    }),
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(lastChatBody.messages[0].role, "system");
  // The brand is renamed for the outbound request, so the prompt no longer carries
  // the phrase the gateway's channel check refuses.
  assert.equal(lastChatBody.messages[0].content, "You are an AI agent running inside WorkBuddy.");
  // The gateway types `tool_choice` as a string; the object form is a 400.
  assert.equal(lastChatBody.tool_choice, "bash");
  assert.equal(lastChatBody.stream, true);
  // The loopback body the client sent is not mutated in place.
  assert.equal(lastChatBody.messages[1].content, "hi");
  // Official-client fingerprint headers travel with every chat call.
  assert.equal(lastChatBody.model, "glm-5.3");
  assert.match(String(lastChatHeaders["user-agent"]), /^WorkBuddy\/5\.9\.2 WorkBuddy\/5\.9\.2 CLI\/2\.165\.0$/u);
  assert.equal(lastChatHeaders["x-ide-name"], "WorkBuddy");
  assert.equal(lastChatHeaders["x-ide-version"], "5.9.2");
  assert.equal(lastChatHeaders["x-product-code"], "codebuddy");
  assert.equal(lastChatHeaders["x-model-id"], "glm-5.3");
  assert.match(String(lastChatHeaders["x-request-trace-id"]), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.match(String(lastChatHeaders["x-conversation-id"]), /^[0-9a-f]{32}$/u);
  assert.match(String(lastChatHeaders["x-b3-traceid"]), /^[0-9a-f]{32}$/u);
});

await test("keeps one trace chain per conversation and a fresh one for a new prompt", () => {
  resetFingerprintState();
  const messages = [
    { role: "system", content: "You are an AI agent powered by DSH." },
    { role: "user", content: "first question" },
  ];
  const conversationId = conversationIdOf(messages);
  assert.match(conversationId, /^[0-9a-f]{32}$/u);
  // Stable for the same opening, different for a different first user turn.
  assert.equal(conversationIdOf(messages), conversationId);
  assert.notEqual(conversationIdOf([messages[0], { role: "user", content: "another question" }]), conversationId);

  const first = fingerprintHeaders({ region: "cn", model: "glm-5.3", conversationId });
  const second = fingerprintHeaders({ region: "cn", model: "glm-5.3", conversationId });
  assert.equal(first["x-conversation-id"], second["x-conversation-id"]);
  assert.equal(first["x-b3-traceid"], second["x-b3-traceid"]);
  // Each request gets its own span, and names the previous one as its parent.
  assert.notEqual(first["x-b3-spanid"], second["x-b3-spanid"]);
  assert.equal(second["x-b3-parentspanid"], first["x-b3-spanid"]);
  // Per-request ids are fresh; the conversation id and trace id are not.
  assert.notEqual(first["x-conversation-request-id"], second["x-conversation-request-id"]);
  assert.notEqual(first["x-request-id"], second["x-request-id"]);
  // The ids are uuid-shaped, exactly as the official client writes them.
  assert.match(String(first["x-request-id"]), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.match(String(first["x-conversation-request-id"]), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  // The official client sends an ACP connection id per request.
  assert.match(String(first["acp-connection-id"]), /^[0-9a-f]{8}-/u);
  // b3 carries four fields, as the official client writes it.
  assert.match(String(first["b3"]), /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/u);
});

await test("both regions send the same official identity", () => {
  const cn = fingerprintHeaders({ region: "cn", model: "glm-5.3", conversationId: "0".repeat(32) });
  const global = fingerprintHeaders({ region: "global", model: "glm-5.3", conversationId: "0".repeat(32) });
  // One official binary serves both gateways, so the identity is identical.
  assert.match(String(cn["user-agent"]), /^WorkBuddy\/5\.9\.2 WorkBuddy\/5\.9\.2 CLI\/2\.165\.0$/u);
  assert.equal(global["user-agent"], cn["user-agent"]);
  assert.equal(global["x-ide-version"], cn["x-ide-version"]);
  assert.equal(global["x-ide-name"], "WorkBuddy");
  assert.equal(global["x-ide-type"], "WorkBuddy");
  assert.equal(global["x-private-data"], "true");
  assert.equal(global["x-product"], "SaaS");
  assert.equal(global["x-agent-purpose"], "conversation");
  // The invented stainless block the old profile sent is gone.
  for (const header of ["x-stainless-runtime", "x-stainless-os", "x-stainless-arch", "x-stainless-lang"]) {
    assert.equal(global[header], undefined, `the official client sends no ${header}`);
  }
  // CN-only extras stay off the intl request.
  for (const header of ["x-product-code", "x-env-id", "x-model-id", "x-request-trace-id", "monitor_httpsendtime", "accept-language", "sec-fetch-mode"]) {
    assert.equal(global[header], undefined, `intl fingerprint must not send ${header}`);
  }
  // ...and stay on the CN request.
  assert.equal(cn["x-product-code"], "codebuddy");
  assert.equal(cn["x-env-id"], "production");
});

await test("gzips a large chat body and the upstream still reads it", async () => {
  shimFixture.pool.resetCooldowns();
  const filler = "lorem ipsum dolor sit amet ".repeat(400);
  const response = await fetch(`${shimFixture.base}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      model: "glm-5.3",
      stream: false,
      messages: [
        { role: "system", content: filler },
        { role: "user", content: "hi" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(lastChatHeaders["content-encoding"], "gzip");
  // The mock gunzips before parsing, so the body surviving proves it is readable.
  assert.equal(lastChatBody.messages[0].content, filler);
});

await test("converts a Responses request into a chat body", () => {
  const body = protocol.responsesToChatBody({
    model: "glm-5.3",
    instructions: "be brief",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ],
    tools: [{ type: "function", name: "bash", description: "run", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "bash" },
    max_output_tokens: 64,
    reasoning: { effort: "high" },
  });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content[0].text, "hello");
  assert.equal(body.messages[2].tool_calls[0].id, "c1");
  assert.equal(body.messages[3].role, "tool");
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "bash" } });
  assert.equal(body.max_tokens, 64);
  assert.equal(body.reasoning_effort, "high");
});

await test("converts an Anthropic request into a chat body", () => {
  const body = protocol.anthropicToChatBody({
    model: "glm-5.3",
    max_tokens: 32,
    system: "sys",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
    ],
    tools: [{ name: "bash", input_schema: { type: "object" } }],
    tool_choice: { type: "any" },
  });
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content, "hi");
  assert.equal(body.messages[2].tool_calls[0].function.name, "bash");
  assert.equal(body.messages[3].role, "tool");
  assert.equal(body.tool_choice, "required");
  assert.equal(body.tools[0].function.name, "bash");
});

await test("collects a chat stream into a completion object", async () => {
  const response = await fetchImpl("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer token-b", "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", messages: [] }),
  });
  const completion = await protocol.collectChatCompletion(response.body, { model: "glm-5.3" });
  assert.equal(completion.choices[0].message.content, "Hello from mock");
  assert.equal(completion.usage.completion_tokens, 4);
});

section("automation");

await test("reads check-in state, claims it, and records earnings", async () => {
  const credential = { accessToken: "token-b", uid: "b1", domain: "www.codebuddy.cn" };
  const status = await automation.checkinStatus(client, credential);
  assert.equal(status.todayCheckedIn, false);
  assert.equal(status.streakDays, 5);
  const claim = await automation.claimCheckin(client, credential);
  assert.equal(claim.credit, 20);

  const pool = buildPool();
  const scheduler = new automation.WorkBuddyScheduler({ pool, client, logger: { info() {}, warn() {}, error() {} } });
  const result = await scheduler.runJob("checkin");
  assert.equal(result.kind, "checkin");
  assert.ok(result.results.length >= 2, `expected at least 2 account results, saw ${result.results.length}`);
  assert.ok(result.credit >= 40);
  const schedulerStatus = scheduler.status();
  assert.equal(schedulerStatus.earnings.today, result.credit);
  // The ledger split is what the automation card renders: per-kind credits and
  // the number of claimed rewards, independent of a later idempotent pass.
  assert.equal(schedulerStatus.earningsByKind.checkin, result.credit);
  const claimedRewards = result.results.filter((entry) => entry.ok === true && (entry.credit ?? 0) > 0).length;
  assert.equal(schedulerStatus.rewardsToday, claimedRewards);
  scheduler.dispose();
  pool.dispose();
});

await test("treats an already-checked-in answer as success", async () => {
  const alreadyClient = new WorkBuddyClient({
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 400, msg: "今日已签到" }), { status: 400, headers: { "content-type": "application/json" } }),
  });
  const result = await automation.claimCheckin(alreadyClient, { accessToken: "t", domain: "www.codebuddy.cn" });
  assert.equal(result.already, true);
});

await test("recognises a rejected sign-in in both shapes the gateway uses", () => {
  const make = (message, status) => {
    const error = new Error(message);
    if (status !== undefined) error.status = status;
    return error;
  };
  // Shape 1: a bare 401 HTML page from the billing/growth hosts.
  const html401 = "<html><head><title>401 Authorization Required</title></head><body><hr><center>openresty</center></body></html>";
  assert.equal(automation.isSessionRejected(make(html401)), true);
  // Shape 2: the parameterised envelope when the refresh token is also tried.
  assert.equal(automation.isSessionRejected(make("12153:refresh token failed:400 Bad Request: invalid_grant: Session not active")), true);
  assert.equal(automation.isSessionRejected(make("x", 401)), true);
  // Ordinary job failures must NOT be mistaken for a dead sign-in.
  assert.equal(automation.isSessionRejected(make("每人限领一次，您已领取过无法重复领取")), false);
  assert.equal(automation.isSessionRejected(make("404 page not found")), false);
  assert.equal(automation.isSessionRejected(undefined), false);
});

await test("tells an offline grant from a session-bound one", () => {
  // A JWT payload is base64url; build both kinds with real claims.
  const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.s`;
  const offline = { refreshToken: jwt({ typ: "Offline", scope: "openid acr profile basic email offline_access" }) };
  const session = { refreshToken: jwt({ typ: "Refresh", scope: "openid acr profile basic web-origins roles email" }) };
  const opaque = { refreshToken: "not-a-jwt" };

  assert.deepEqual(credentials.refreshGrantOf(offline), { kind: "offline", type: "Offline", offline: true });
  assert.deepEqual(credentials.refreshGrantOf(session), { kind: "session", type: "Refresh", offline: false });
  assert.deepEqual(credentials.refreshGrantOf(opaque), { kind: "unknown" });
  assert.equal(credentials.refreshIsSessionBound(session), true);
  assert.equal(credentials.refreshIsSessionBound(offline), false);
});

await test("a rejected session leaves rotation and the card says why", async () => {
  const pool = buildPool();
  const account = pool.accountsOf("cn")[0];
  assert.equal(pool.usable(account), true);
  pool.markSignedOut(account, "登录会话已失效");
  assert.equal(pool.usable(account), false);
  const row = pool.status("cn").accounts.find((entry) => entry.id === account.id);
  assert.equal(row.state, "blocked");
  assert.equal(row.reason, "needs-sign-in");
  // A balance from the dead session is not shown as spendable credit.
  assert.equal(row.credits, null);
  assert.equal(row.signedOut.reason, "登录会话已失效");
  pool.markSignedIn(account);
  assert.equal(pool.usable(account), true);
  pool.dispose();
});

await test("renews an offline grant before it expires, never a session grant", () => {
  const sameDay = Date.UTC(2026, 9, 25, 8, 0, 0);
  const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.s`;

  const pool = new WorkBuddyAccountPool({
    client,
    scanner: () => discoverCredentials(testEnv, "linux", testHome),
    logger: { info() {}, warn() {}, error() {} },
  });
  pool.applyConfig({ distribution: "priority", minUsableCredits: 0 });
  pool.scan();
  const account = pool.accountsOf("cn")[0];

  // An offline grant whose access token expires inside the window is due.
  account.credential = {
    ...account.credential,
    accessToken: jwt({ exp: Math.floor((sameDay + 45 * 60_000) / 1000) }),
    refreshToken: jwt({ typ: "Offline", scope: "openid offline_access" }),
    expiresAtMs: 0,
  };
  assert.equal(pool.needsRefresh(account, sameDay), true);
  assert.deepEqual(pool.refreshDue(sameDay).map((state) => state.id), [account.id]);

  // Plenty of time left -> not due.
  assert.equal(pool.needsRefresh(account, sameDay - 3 * 3_600_000), false);

  // A session-bound grant is never proactively renewed: it cannot be.
  account.credential = {
    ...account.credential,
    refreshToken: jwt({ typ: "Refresh", scope: "openid email" }),
  };
  assert.equal(pool.needsRefresh(account, sameDay), false);
  assert.deepEqual(pool.refreshDue(sameDay), []);

  pool.dispose();
});

/** A client that answers the compensation routes and records what was called. */
function compensationClient(data, calls = []) {
  let claimed = data.status.claimed;
  return new WorkBuddyClient({
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: init?.method });
      if (path === "/billing/meter/compensation-status") {
        return new Response(JSON.stringify({ code: 0, data: { ...data.status, claimed } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/billing/meter/claim-compensation") {
        // Mirrors the live gateway: the claim body does NOT report the grant.
        if (claimed) {
          return new Response(JSON.stringify({ code: 10001, msg: "每人限领一次，您已领取过无法重复领取" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        claimed = true;
        return new Response(JSON.stringify({ code: 0, data: { claimed: false, credit_num: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: 404, msg: "Route Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    },
  });
}

await test("reads and claims the one-off compensation offer on the right routes", async () => {
  const calls = [];
  const client = compensationClient(
    { status: { active: true, claimed: false, credit_num: 500, end_time: "2026-10-22 23:59:59" } },
    calls,
  );
  const credential = { accessToken: "t", domain: "www.codebuddy.cn" };
  const status = await automation.compensationStatus(client, credential);
  assert.equal(status.active, true);
  assert.equal(status.claimed, false);
  assert.equal(status.credit, 500);
  assert.equal(status.endTime, "2026-10-22 23:59:59");
  // The campaign family lives at /billing/meter/*, NOT /v2/billing/meter/*.
  assert.deepEqual(calls.map((call) => call.path), ["/billing/meter/compensation-status"]);
  assert.ok(calls.every((call) => call.method === "POST"));
});

await test("the compensation job claims once per account, then reports already-claimed", async () => {
  const pool = buildPool();
  // Per-account state: two workers run at once, and a shared "claimed" flag
  // would make the second account look already-served.
  const claimedByAccount = new Map();
  const client = new WorkBuddyClient({
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const account = String(init?.headers?.authorization ?? "");
      const claimed = claimedByAccount.get(account) === true;
      if (path === "/billing/meter/compensation-status") {
        return new Response(JSON.stringify({ code: 0, data: { active: true, claimed, credit_num: 500 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/billing/meter/claim-compensation") {
        if (claimed) {
          return new Response(JSON.stringify({ code: 10001, msg: "每人限领一次，您已领取过无法重复领取" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        claimedByAccount.set(account, true);
        // The live gateway does not report the grant in the claim body.
        return new Response(JSON.stringify({ code: 0, data: { claimed: false, credit_num: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: 404, msg: "Route Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    },
  });
  const scheduler = new automation.WorkBuddyScheduler({ pool, client, logger: { info() {}, warn() {}, error() {} } });
  // Pin the clock INSIDE the campaign window: the real deadline (Beijing
  // midnight 2026-10-22) has passed, and this test is about the claim flow, not
  // about the closure. A wall-clock-dependent test turned red the day the offer
  // ended even though the code was correct.
  scheduler.now = () => new Date(Date.UTC(2026, 9, 21, 4, 0, 0));
  const run = await scheduler.runJob("compensation");
  // One 500-credit claim per account the gateway serves, confirmed by the
  // re-read status even though the claim response reports no grant. The fixture
  // pool also holds the token-dead account an earlier test registered, so the
  // claimable count is not the run size.
  const claimed = run.results.filter((entry) => entry.status === "ok");
  assert.equal(claimed.length, 2, "the two live fixture accounts are the ones the gateway serves");
  assert.equal(run.credit, 500 * claimed.length);
  assert.ok(claimed.every((entry) => entry.credit === 500));
  // The token-dead account cannot reach the campaign and must not be counted.
  const dead = run.results.find((entry) => entry.label?.includes("dead"));
  assert.equal(dead.credit, 0);
  scheduler.dispose();

  const second = compensationClient({ status: { active: true, claimed: true, credit_num: 500 } });
  const again = new automation.WorkBuddyScheduler({ pool, client: second, logger: { info() {}, warn() {}, error() {} } });
  again.now = () => new Date(Date.UTC(2026, 9, 21, 4, 0, 0));
  const rerun = await again.runJob("compensation");
  assert.equal(rerun.credit, 0);
  assert.ok(rerun.results.every((entry) => entry.status === "already"));
  again.dispose();
  pool.dispose();
});

await test("the compensation campaign closes at Beijing midnight on 2026-10-22", async () => {
  const campaign = await import("../lib/campaign.js");
  const beforeDeadline = Date.UTC(2026, 9, 21, 15, 59, 59);
  const afterDeadline = Date.UTC(2026, 9, 21, 16, 0, 0);
  assert.equal(campaign.campaignOpen(beforeDeadline), true);
  assert.equal(campaign.campaignOpen(afterDeadline), false);
  assert.equal(campaign.CAMPAIGN_DEADLINE_MS, afterDeadline);
  assert.equal(new Date(campaign.CAMPAIGN_DEADLINE_MS).toISOString(), "2026-10-21T16:00:00.000Z");
  assert.equal(campaign.campaignDeadlineIso(), "2026-10-21T16:00:00.000Z");

  // After the deadline the job answers "skipped" and never touches the network.
  const pool = buildPool();
  const offline = new WorkBuddyClient({
    fetchImpl: async () => {
      throw new Error("the gateway must not be called after the campaign closed");
    },
  });
  const scheduler = new automation.WorkBuddyScheduler({ pool, client: offline, logger: { info() {}, warn() {}, error() {} } });
  scheduler.now = () => new Date(afterDeadline);
  const closed = await scheduler.runJob("compensation");
  assert.equal(closed.credit, 0);
  assert.ok(closed.results.every((entry) => entry.status === "skipped"));
  scheduler.dispose();
  pool.dispose();
});

await test("the card is told when the campaign is closed, and the job is not re-armed", async () => {
  const pool = buildPool();
  const scheduler = new automation.WorkBuddyScheduler({ pool, client, logger: { info() {}, warn() {}, error() {} } });
  const status = scheduler.status();
  assert.equal(typeof status.campaign.open, "boolean");
  assert.equal(status.campaign.deadline, "2026-10-21T16:00:00.000Z");
  assert.ok(status.labels.compensation !== undefined);

  // A fresh day after the deadline: the tick loop must not arm a closed
  // campaign even though its hour matches and no run is recorded yet.
  scheduler.now = () => new Date(Date.UTC(2026, 9, 22, 3, 0, 0));
  scheduler.state = scheduler.load();
  scheduler.options.enabled = true;
  scheduler.options.hours.compensation = [0];
  scheduler.tick();
  assert.equal(scheduler.state.runs.compensation, undefined);

  scheduler.dispose();
  pool.dispose();
});

section("rotating fingerprint");

await test("the shipped profile is the measured-working header set", () => {
  const profile = defaultProfile();
  assert.equal(profile.cn["x-ide-version"], "5.9.2");
  assert.equal(profile.cn["user-agent"], "WorkBuddy/5.9.2 WorkBuddy/5.9.2 CLI/2.165.0");
  assert.equal(profile.global["user-agent"], "WorkBuddy/5.9.2 WorkBuddy/5.9.2 CLI/2.165.0");
  assert.equal(profile.enabled, true);
  assert.equal(profile.rotateHours, 3);
});

await test("rotation cannot be configured below three hours", () => {
  assert.equal(MIN_ROTATE_HOURS, 3);
  assert.equal(clampRotateHours(1), 3);
  assert.equal(clampRotateHours(0), 3);
  assert.equal(clampRotateHours(-5), 3);
  assert.equal(clampRotateHours(6), 6);
  // A saved profile that somehow carries a lower value is clamped on read.
  assert.equal(normalizeProfile({ rotateHours: 1 }).rotateHours, 3);
});

await test("a rotation changes the identity but keeps the header set valid", () => {
  const before = defaultProfile();
  let rotated;
  // Rotation picks a different value per randomised field, so one rotation is
  // always observable.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    rotated = randomProfile(before);
    if (rotated.cn["x-ide-version"] !== before.cn["x-ide-version"]) break;
  }
  assert.notEqual(rotated.cn["x-ide-version"], before.cn["x-ide-version"]);
  assert.equal(rotated.revision, before.revision + 1);
  assert.ok(rotated.rotatedAt > 0);
  // The UA is rebuilt from the version, so the two can never disagree.
  assert.ok(rotated.cn["user-agent"].includes(rotated.cn["x-ide-version"]));
  // Both regions rotate together: one official binary serves both gateways.
  assert.equal(rotated.global["x-ide-version"], rotated.cn["x-ide-version"]);
  assert.equal(rotated.global["user-agent"], rotated.cn["user-agent"]);
  // The UA still carries a CLI half, so the gateway can parse the copilot version.
  assert.match(rotated.cn["user-agent"], /CLI\/[\d.]+$/u);
  // No required header is dropped by a rotation.
  const headers = profileHeaders("cn", rotated);
  for (const key of ["user-agent", "x-ide-version", "x-product-code", "x-env-id", "x-agent-intent", "accept-language"]) {
    assert.equal(typeof headers[key], "string", `rotation dropped ${key}`);
  }
});

await test("a rotation is only due once its interval has elapsed", () => {
  const now = Date.UTC(2026, 9, 27, 0, 0, 0);
  const fresh = randomProfile(defaultProfile(), now);
  assert.equal(rotationDue(fresh, now + 60_000), false);
  assert.equal(rotationDue(fresh, now + 3 * 3_600_000 - 1), false);
  assert.equal(rotationDue(fresh, now + 3 * 3_600_000), true);
  // A profile that was never rotated is due immediately, and a disabled profile
  // never rotates.
  assert.equal(rotationDue(defaultProfile(), now), true);
  assert.equal(rotationDue({ ...fresh, enabled: false }, now + 10 * 3_600_000), false);
});

await test("one parameter can be edited alone, and reset back", () => {
  const base = defaultProfile();
  const edited = setProfileValue(base, "cn", "accept-language", "zh-CN");
  assert.equal(edited.profile.cn["accept-language"], "zh-CN");
  // Everything else is untouched.
  assert.equal(edited.profile.cn["x-ide-version"], base.cn["x-ide-version"]);
  assert.equal(edited.profile.global["user-agent"], base.global["user-agent"]);
  // A UA that disagrees with the version header is reported, not silently accepted.
  const broken = setProfileValue(base, "cn", "user-agent", "CodeBuddyIDE/9.9.9 CodeBuddy/9.9.9");
  assert.ok(typeof broken.warning === "string" && broken.warning.includes(base.cn["x-ide-version"]));
  // Reset restores the shipped value.
  assert.equal(resetProfileValue(edited.profile, "cn", "accept-language").cn["accept-language"], base.cn["accept-language"]);
  // Control characters are refused: they would make the header unparseable.
  assert.throws(() => setProfileValue(base, "cn", "x-ide-version", "4.12.0\r\nX-Evil: 1"), /control characters/u);
});

await test("the active profile is what the request headers carry", () => {
  const original = getFingerprintProfile();
  try {
    const rotated = randomProfile(original);
    setFingerprintProfile(rotated);
    const headers = fingerprintHeaders({ region: "cn", model: "glm-5.3", conversationId: "0".repeat(32) });
    assert.equal(headers["user-agent"], rotated.cn["user-agent"]);
    assert.equal(headers["x-ide-version"], rotated.cn["x-ide-version"]);
    assert.equal(headers["accept-language"], rotated.cn["accept-language"]);
    // Per-request ids stay per-request: they are not part of the profile.
    assert.match(String(headers["x-b3-spanid"]), /^[0-9a-f]{16}$/u);
  } finally {
    setFingerprintProfile(original);
  }
});

await test("a profile saved by an older schema cannot pin a stale identity", () => {
  // This is the exact shape the previous build persisted: a CN UA that mixes the
  // CodeBuddyIDE prefix with a WorkBuddy version, plus the invented stainless block.
  const stale = {
    version: 1,
    revision: 3,
    rotatedAt: 1793115730659,
    enabled: true,
    rotateHours: 5,
    cn: { "user-agent": "CodeBuddyIDE/5.9.2 CodeBuddy/5.9.2", "x-ide-version": "4.12.1", "x-product-version": "4.12.1" },
    global: { "user-agent": "workbuddy-ai/5.8.0 workbuddy-ai/5.8.0 CLI/2.155.3", "x-ide-version": "5.8.0", "x-stainless-os": "MacOS" },
  };
  const clean = normalizeProfile(stale);
  assert.equal(clean.schema, PROFILE_SCHEMA);
  assert.equal(clean.cn["user-agent"], "WorkBuddy/5.9.2 WorkBuddy/5.9.2 CLI/2.165.0");
  assert.equal(clean.global["user-agent"], "WorkBuddy/5.9.2 WorkBuddy/5.9.2 CLI/2.165.0");
  assert.equal(clean.cn["x-product-version"], undefined, "a dropped header must not survive the migration");
  assert.equal(clean.global["x-stainless-os"], undefined);
  // The operator's own interval survives, because it is a setting, not an identity.
  assert.equal(clean.rotateHours, 5);
  // A profile at the current schema round-trips unchanged.
  const fresh = randomProfile(defaultProfile(), 1_800_000_000_000);
  assert.equal(normalizeProfile(fresh).cn["user-agent"], fresh.cn["user-agent"]);
});

section("status payload");

await test("region summaries are computed per request, not frozen at boot", async () => {
  const { createStatusPayload } = await import("../lib/routes.js");
  const poolState = { cn: { total: 1, available: 1 }, global: { total: 0, available: 0 } };
  const deps = {
    name: "llm-workbuddy-pool",
    version: "test",
    bootAt: Date.now(),
    pool: { status: (region) => ({ ...poolState[region] }), lastScanAt: 0, lastScanWarnings: [] },
    catalogs: { cn: { status: () => ({}) }, global: { status: () => ({}) } },
    providers: { cn: undefined, global: undefined },
    shims: { cn: () => "http://127.0.0.1:1", global: () => "http://127.0.0.1:2" },
    scheduler: { status: () => ({ enabled: false }) },
    state: { get: () => ({}), selection: () => ({}), sanitize: () => ({ enabled: true, brand: true, triggers: true }), fingerprint: () => ({}) },
  };
  const payload = createStatusPayload(deps);
  assert.deepEqual(payload("cn").regions.cn, { total: 1, available: 1, provider: undefined, displayName: undefined, shim: "http://127.0.0.1:1" });
  // The pool cools down / a second account disappears while the plugin stays up.
  poolState.cn = { total: 1, available: 0 };
  assert.equal(payload("cn").regions.cn.available, 0, "the region tab must follow the live pool state");
  poolState.global = { total: 2, available: 2 };
  assert.equal(payload("cn").regions.global.available, 2);
});

section("storage");

await test("state lives next to the DSH installation and the legacy folder migrates", () => {
  const root = join(sandbox, "install-root");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "dsh"), "");
  const home = join(root, "home", ".dsh");
  mkdirSync(join(home, ".workbuddy-pool"), { recursive: true });
  writeFileSync(join(home, ".workbuddy-pool", "settings.json"), '{"migrated":true}\n');
  const previousHome = process.env["DSH_HOME"];
  const previousInstall = process.env["DSH_INSTALL_DIR"];
  process.env["DSH_HOME"] = home;
  delete process.env["DSH_INSTALL_DIR"];
  try {
    assert.equal(store.dshInstallDir(), root);
    assert.equal(store.dataDir(), join(root, "workbuddy-pool"));
    assert.equal(store.migrateLegacyState(), true);
    assert.equal(readFileSync(join(root, "workbuddy-pool", "settings.json"), "utf8"), '{"migrated":true}\n');
    assert.equal(existsSync(join(home, ".workbuddy-pool")), false);
  } finally {
    if (previousHome === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = previousHome;
    if (previousInstall === undefined) delete process.env["DSH_INSTALL_DIR"];
    else process.env["DSH_INSTALL_DIR"] = previousInstall;
  }
});

await test("an explicit install dir is user-managed and never auto-migrates into it", () => {
  const home = join(sandbox, "override-home");
  mkdirSync(join(home, ".workbuddy-pool"), { recursive: true });
  const custom = join(sandbox, "custom-install");
  const previousHome = process.env["DSH_HOME"];
  const previousInstall = process.env["DSH_INSTALL_DIR"];
  process.env["DSH_HOME"] = home;
  process.env["DSH_INSTALL_DIR"] = custom;
  try {
    assert.equal(store.dshInstallDir(), custom);
    assert.equal(store.dataDir(), join(custom, "workbuddy-pool"));
    assert.equal(store.migrateLegacyState(), false);
    assert.equal(existsSync(custom), false);
  } finally {
    if (previousHome === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = previousHome;
    if (previousInstall === undefined) delete process.env["DSH_INSTALL_DIR"];
    else process.env["DSH_INSTALL_DIR"] = previousInstall;
  }
});

section("settings state");

await test("persists card-owned state through the JSON file", async () => {
  const state = new settingsModule.PluginState();
  await state.set({ disabledAccountIds: ["a1"], creditReserves: { a1: 50 }, modelSelection: { cn: { enabledModelIds: ["glm-5.3"] }, global: {} }, automation: { enabled: true } });
  const reloaded = new settingsModule.PluginState();
  assert.deepEqual(reloaded.get().disabledAccountIds, ["a1"]);
  assert.equal(reloaded.get().creditReserves.a1, 50);
  assert.deepEqual(reloaded.selection("cn").enabledModelIds, ["glm-5.3"]);
  assert.equal(reloaded.get().automation.enabled, true);
});

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

shimFixture.pool.dispose();
mockServer.close();
await new Promise((resolve) => setTimeout(resolve, 50));

process.stdout.write(`\n${passed} passed, ${failures.length} failed, ${hits.chat} mock chat call(s)\n`);
if (failures.length > 0) {
  for (const failure of failures) {
    process.stdout.write(`\nFAILED: ${failure.name}\n${failure.error?.stack ?? failure.error}\n`);
  }
  process.exit(1);
}
process.exit(0);
