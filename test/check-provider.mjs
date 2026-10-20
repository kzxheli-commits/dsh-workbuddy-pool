/**
 * Provider-adapter check: drives the REAL `dsh-llm-pi-ai` adapter assembled by
 * `lib/provider.js` against a loopback shim backed by a mock upstream.
 *
 * This is the layer the offline suite deliberately does not touch: the suite
 * speaks HTTP to the shim, while the Harness speaks the adapter contract. A
 * profile shaped wrongly by hand registers without complaint and then lists no
 * models / throws on the first call, so this script is what proves the route is
 * actually usable.
 *
 * Requires the Host packages (`@deepseek-ai/dsh-llm-pi-ai`,
 * `@earendil-works/pi-ai`) to be resolvable. Run it from a directory where they
 * are (the profile), or link them into the package's `node_modules` first.
 *
 * Usage: node test/check-provider.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "wbp-provider-"));
process.env["DSH_HOME"] = join(sandbox, "dsh");
mkdirSync(process.env["DSH_HOME"], { recursive: true });

const { WorkBuddyClient } = await import("../lib/upstream.js");
const { WorkBuddyCatalog } = await import("../lib/catalog.js");
const { WorkBuddyAccountPool } = await import("../lib/pool.js");
const { createShim } = await import("../lib/shim.js");
const { createPoolProvider } = await import("../lib/provider.js");

/* Mock gateway: one text model and one tool-calling model. */
function sse(res, frames) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}
const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (req.url?.startsWith("/v2/chat/completions")) {
      if (body.model === "tool-model") {
        sse(res, [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]);
        return;
      }
      sse(res, [
        { choices: [{ index: 0, delta: { content: "Hello" } }] },
        { choices: [{ index: 0, delta: { content: " from adapter" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
      ]);
      return;
    }
    if (req.url?.startsWith("/v2/enterprises/personal/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            models: [
              { id: "glm-5.3", name: "GLM-5.3", maxInputTokens: 200_000, maxOutputTokens: 128_000, credits: "x0.11", supportsImages: true },
              { id: "tool-model", name: "Tool Model", maxInputTokens: 200_000, maxOutputTokens: 128_000 },
            ],
            agents: [{ name: "cli", models: ["glm-5.3", "tool-model"] }],
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 404 }));
  });
});
const mockBase = await new Promise((resolve) => {
  mock.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${mock.address().port}`));
});
const client = new WorkBuddyClient({
  fetchImpl: async (url, init) => fetch(new URL(new URL(url).pathname + new URL(url).search, mockBase), init),
});

const credential = { accessToken: "token", uid: "u1", domain: "www.codebuddy.cn", sourcePath: "(test)" };
const pool = new WorkBuddyAccountPool({
  client,
  scanner: () => ({ credentials: new Map([["id1", credential]]), warnings: [] }),
  logger: { info() {}, warn() {}, error() {} },
});
pool.applyConfig({ minUsableCredits: 0 });
pool.scan();
const catalog = new WorkBuddyCatalog({ client, region: "cn" });
await catalog.refresh(credential);
const shim = createShim({ pool, catalog, region: "cn", token: "secret", port: 0, logger: { warn() {} } });
const ready = await shim.ready;

const provider = createPoolProvider({
  shim,
  catalog,
  providerId: "workbuddy-pool",
  displayName: "WorkBuddy Pool",
  getSelection: () => ({}),
});

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok   ${name}\n`);
}

try {
  await check("adapter lists the configured models", async () => {
    const models = await provider.adapter.listModels("workbuddy-pool");
    assert.deepEqual(
      models.map((model) => model.id),
      ["glm-5.3", "tool-model"],
    );
    assert.equal(models[0].name, "GLM-5.3 · x0.11");
    assert.deepEqual(models[0].inputModalities, ["text", "image"]);
  });

  await check("adapter streams a text turn through the shim", async () => {
    const chunks = [];
    for await (const chunk of provider.adapter.stream({
      provider: "workbuddy-pool",
      model: "glm-5.3",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      chunks.push(chunk);
    }
    const text = chunks
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => chunk.text)
      .join("");
    assert.equal(text, "Hello from adapter");
    const finish = chunks.find((chunk) => chunk.type === "finish");
    assert.equal(finish.reason.kind, "stop");
    const usage = chunks.find((chunk) => chunk.type === "usage");
    assert.equal(usage.usage.inputTokens, 11);
    assert.equal(usage.usage.outputTokens, 3);
  });

  await check("adapter reports tool calls with a tool-calls finish", async () => {
    const chunks = [];
    for await (const chunk of provider.adapter.stream({
      provider: "workbuddy-pool",
      model: "tool-model",
      messages: [{ role: "user", content: [{ type: "text", text: "run ls" }] }],
      tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
    })) {
      chunks.push(chunk);
    }
    const deltas = chunks.filter((chunk) => chunk.type === "tool-call-delta");
    assert.ok(deltas.length >= 2, `expected tool-call deltas, saw ${deltas.length}`);
    assert.equal(deltas[0].name, "bash");
    const finish = chunks.find((chunk) => chunk.type === "finish");
    assert.equal(finish.reason.kind, "tool-calls");
  });

  await check("adapter rejects an unknown model before any I/O", async () => {
    await assert.rejects(async () => {
      for await (const _chunk of provider.adapter.stream({
        provider: "workbuddy-pool",
        model: "no-such-model",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      })) {
        /* unreachable */
      }
    });
  });

  await check("provider invalidate() refreshes the model list", async () => {
    catalog.live = [...catalog.models(), { id: "new-model", name: "New Model", contextWindow: 1000, maxOutputTokens: 100 }];
    provider.invalidate();
    const models = await provider.adapter.listModels("workbuddy-pool");
    assert.ok(models.some((model) => model.id === "new-model"));
  });

  process.stdout.write(`\n${passed} provider checks passed\n`);
} finally {
  await shim.close();
  mock.close();
  pool.dispose();
}
