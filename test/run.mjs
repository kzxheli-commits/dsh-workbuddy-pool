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

/* ------------------------------------------------------------------ *
 * Isolate plugin state into a temp DSH_HOME before importing modules that
 * resolve paths from it.
 * ------------------------------------------------------------------ */
const sandbox = mkdtempSync(join(tmpdir(), "wbp-test-"));
process.env["DSH_HOME"] = join(sandbox, "dsh");
mkdirSync(process.env["DSH_HOME"], { recursive: true });

const { WorkBuddyClient, classifyUpstreamError, parseRateLimitReset, readBusinessCode, parseUpstreamModel, supportsImagesOf } = await import("../lib/upstream.js");
const { parseAuthDocument, discoverCredentials, workbuddyAccountId, regionOfCredential, accountLabel } = await import("../lib/credentials.js");
const { WorkBuddyAccountPool } = await import("../lib/pool.js");
const { WorkBuddyCatalog, FALLBACK_MODELS } = await import("../lib/catalog.js");
const { createShim, repairToolPairs } = await import("../lib/shim.js");
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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
    state: { get: () => ({}), selection: () => ({}) },
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
