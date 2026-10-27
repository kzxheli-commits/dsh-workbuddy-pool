/**
 * Prove `test/check-client-loads.mjs` rejects the 0.4.40 regression: a backtick
 * inside the CSS template literal (which broke the desktop boot).
 *
 * Usage: node test/prove-client-load-gate.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolved from this file, so the proof runs from any checkout or drive. */
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/u, "");
const sandbox = join(ROOT, "_tmpclientcheck");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });

const source = readFileSync(join(ROOT, "lib/client.js"), "utf8");
const marker = ".wbp-btn--primary{background:";
assert.ok(source.includes(marker), "could not find the primary button rule");

// Reintroduce the exact shape of the bug: a backtick in a CSS comment.
const broken = source.replace(
  marker,
  "/* see `theme tokens` */\n" + marker,
);
assert.notEqual(broken, source, "could not inject the broken comment");
writeFileSync(join(sandbox, "client.js"), broken, "utf8");

const checker = join(ROOT, "test", "check-client-loads.mjs");
const brokenPath = join(sandbox, "client.js");

let failed = false;
let output = "";
try {
  // The gate takes the bundle to inspect as its first argument, so the proof hands
  // it the broken copy instead of rewriting the checker's source. (Rewriting source
  // was how this proof silently stopped testing anything when the gate changed.)
  output = execFileSync(process.execPath, [checker, brokenPath], { encoding: "utf8", stdio: "pipe" });
} catch (error) {
  failed = true;
  output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}
rmSync(sandbox, { recursive: true, force: true });

assert.ok(failed, "the gate accepted a backtick inside the CSS literal — it would not have caught 0.4.40");
assert.match(output, /does not parse|stylesheet/u);
console.log("proved: the gate rejects a stray backtick in the CSS literal");
console.log(output.split("\n").filter((line) => /does not parse|stylesheet|backtick/iu.test(line)).slice(0, 2).join("\n"));
