/**
 * Prove that `npm pack` refuses to build a tarball from a client bundle that
 * does not load.
 *
 * The 0.4.40 incident shipped exactly such a bundle, so `prepack` now runs the
 * load gate. This script injects the historical break into a throwaway COPY of
 * the package (never the working tree), runs `npm pack` there, and asserts it
 * fails. The working tree is left untouched — earlier attempts to inject and
 * restore in place raced with `npm pack` and proved nothing.
 *
 * Usage: node test/prove-prepack-gate.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolved from this file, so the proof runs from any checkout or drive. */
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/u, "");
const BACKTICK = String.fromCharCode(96);
const NEEDLE = ".wbp-btn--primary{background:";

const workDir = mkdtempSync(join(tmpdir(), "wbp-prepack-"));
const pkgDir = join(workDir, "pkg");

/** Copy only what `npm pack` needs, so the throwaway tree is small and clean. */
for (const entry of ["package.json", "lib", "test", "cordis.patch.yml", "locale", "icon.png", "README.md", "CHANGELOG.md"]) {
  cpSync(join(ROOT, entry), join(pkgDir, entry), { recursive: true });
}

const clientPath = join(pkgDir, "lib", "client.js");
const healthy = readFileSync(clientPath, "utf8");
assert.ok(healthy.includes(NEEDLE), "could not find the primary button rule");
assert.ok(!healthy.includes(`${BACKTICK}theme${BACKTICK}`), "the copy already contains the marker");

// The exact historical break: a backtick inside a comment that lives in the CSS
// template literal. Backticks are built from a char code so this file's own
// source stays readable.
const broken = healthy.replace(NEEDLE, `/* see ${BACKTICK}theme tokens${BACKTICK} */\n${NEEDLE}`);
assert.notEqual(broken, healthy);
writeFileSync(clientPath, broken, "utf8");

// Sanity: the broken copy really is unparseable.
let parses = true;
try {
  execFileSync(process.execPath, ["--check", clientPath], { stdio: "pipe" });
} catch {
  parses = false;
}
assert.equal(parses, false, "the injected break did not break the file — check the injection");

let packFailed = false;
let output = "";
// Run npm's own CLI through this same node binary. Shelling out to npm.cmd on
// Windows loses the child's output entirely, which would make the assertion
// below vacuous; this form keeps stdout/stderr piped and readable.
/**
 * Locate npm's CLI next to the node running this test.
 *
 * Derived from `process.execPath` instead of a hard-coded install path, so the proof
 * works on any machine and does not record where this one keeps its user profile.
 * A global npm installed beside node lives two levels up from the binary.
 */
function findNpmCli() {
  const execDir = dirname(process.execPath);
  const candidates = [
    // npm bundled inside a standard Node installation.
    join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // npm installed as a global package (Windows keeps it under %APPDATA%).
    process.env["APPDATA"] === undefined ? "" : join(process.env["APPDATA"], "npm", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env["npm_config_prefix"] === undefined ? "" : join(process.env["npm_config_prefix"], "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => candidate !== "");
  return candidates.find((candidate) => existsSync(candidate));
}

const npmCli = findNpmCli();
if (npmCli === undefined) throw new Error("could not locate npm-cli.js next to this node installation");

try {
  output = execFileSync(process.execPath, [npmCli, "pack"], { cwd: pkgDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (error) {
  packFailed = true;
  output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}
rmSync(workDir, { recursive: true, force: true });

assert.ok(packFailed, `npm pack built a tarball from a broken client bundle:\n${output}`);
assert.match(output, /does not parse|stylesheet|prepack/u);
console.log("proved: npm pack refuses a build whose client bundle does not load");
console.log(output.split("\n").filter((line) => /does not parse|stylesheet|prepack|command failed/iu.test(line)).slice(0, 3).join("\n"));
