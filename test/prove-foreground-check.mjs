/**
 * Prove the new "no background token as a foreground" check actually fails on
 * the old bug, so the guard is not decorative.
 *
 * Usage: node test/prove-foreground-check.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "C:/Users/lenovo/Documents/deepseek-harness/default-workspace/workbuddy-pool";
const sandbox = join(ROOT, "_tmpcheck");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });

const source = readFileSync(join(ROOT, "lib/client.js"), "utf8");
const fixedRule = /\.wbp-btn--primary\{[^}]*\}/u.exec(source)?.[0];
assert.ok(fixedRule !== undefined, "the primary button rule is not in the stylesheet");
assert.ok(fixedRule.includes("--dsw-alias-label-primary-foreground"), "the fixed rule does not use the foreground token");
// Re-introduce the exact historical bug: paint the label with a background token.
const brokenRule = fixedRule.replace(/color:var\([^}]*\)\}/u, "color:var(--dsw-alias-bg-base)}");
assert.notEqual(brokenRule, fixedRule, "could not rewrite the rule into the broken form");
writeFileSync(join(sandbox, "client.js"), source.replace(fixedRule, brokenRule), "utf8");

const checker = readFileSync(join(ROOT, "test/check-client-static.mjs"), "utf8");
assert.ok(checker.includes('join(ROOT, "lib", "client.js")'), "checker does not read lib/client.js");
// Point the copy at the broken stylesheet instead of the real one.
writeFileSync(
  join(sandbox, "check.mjs"),
  checker.replace('join(ROOT, "lib", "client.js")', 'join(ROOT, "_tmpcheck", "client.js")').replace(/^const ROOT = .*$/mu, `const ROOT = ${JSON.stringify(ROOT)};`),
  "utf8",
);

let failed = false;
let output = "";
try {
  output = execFileSync(process.execPath, [join(sandbox, "check.mjs")], { encoding: "utf8", stdio: "pipe" });
} catch (error) {
  failed = true;
  output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}
rmSync(sandbox, { recursive: true, force: true });

assert.ok(failed, "the check passed on the old broken rule — it is not guarding anything");
// Either assertion may fire first (the rule-shape assertion or the "painted with
// a background token" one); both mean the regression was caught.
assert.match(output, /background token|label-primary-foreground/iu);
console.log("proved: the check rejects a foreground painted with a background token");
console.log(output.split("\n").filter((line) => /background token|label-primary-foreground|FAILED/iu.test(line)).slice(0, 2).join("\n"));
