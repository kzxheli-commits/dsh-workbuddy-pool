/**
 * Load the browser half of the plugin the way the Host does, in a stubbed
 * environment, so a broken client bundle is caught before it ships.
 *
 * Why this exists: 0.4.40 put a backtick inside the CSS template literal (in a
 * comment). The file stopped parsing, the Host's web boot failed with
 * "1 entry did not activate", and the desktop fell back to its fatal-recovery
 * path, which disabled every third-party bundle. The static checker did not
 * notice because it extracted the stylesheet with a regex that happily stopped
 * at the stray backtick. This check parses and executes the real file instead.
 *
 * The path is resolved RELATIVE TO THIS SCRIPT, so the same gate works from the
 * source tree, from an installed package copy, and as the npm `prepack` step —
 * where the working directory is whatever package is being packed, not this
 * repository. (An absolute path here made `prepack` validate the repo copy while
 * a different file was being packaged.)
 *
 * Usage: node test/check-client-loads.mjs [path-to-client.js]
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const clientPath = process.argv[2] ?? fileURLToPath(new URL("../lib/client.js", import.meta.url));
const source = readFileSync(clientPath, "utf8");
console.log(`checking ${clientPath}`);

/* ------------------------------------------------------------------ *
 * 1. It must be syntactically valid JavaScript.
 * ------------------------------------------------------------------ */
try {
  new vm.Script(source, { filename: "client.js" });
} catch (error) {
  throw new Error(`client.js does not parse: ${error.message}`);
}
console.log("ok   client.js parses");

/* ------------------------------------------------------------------ *
 * 2. The stylesheet literal must be a single, complete template string.
 *
 * A stray backtick inside the CSS closes the literal early; the file may still
 * parse in some shapes, so verify the extracted CSS independently: it must end
 * like a stylesheet (a closing brace) and must not contain another backtick.
 * ------------------------------------------------------------------ */
const cssMatch = /const CSS = `([\s\S]*?)`;/u.exec(source);
assert.ok(cssMatch !== null, "the stylesheet literal was not found");
const css = cssMatch[1];
assert.ok(css.length > 2_000, `stylesheet is suspiciously small (${css.length} chars)`);
assert.ok(css.trimEnd().endsWith("}"), "the extracted stylesheet does not end with a rule — the literal was cut early");
assert.ok(!css.includes("`"), "the extracted stylesheet still contains a backtick");
const backticks = (source.match(/`/gu) ?? []).length;
assert.equal(backticks % 2, 0, `client.js has an odd number of backticks (${backticks}) — a template literal is unbalanced`);
console.log(`ok   stylesheet literal intact (${css.length} chars, ${backticks} backticks balanced)`);

/* ------------------------------------------------------------------ *
 * 3. It must register the way the Host expects.
 * ------------------------------------------------------------------ */
let registration;
/** Minimal React surface: the bundle extends Component and calls a few hooks. */
class StubComponent {
  constructor(props) {
    this.props = props ?? {};
    this.state = {};
  }
  setState(next) {
    this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) };
  }
  forceUpdate() {}
  render() {
    return null;
  }
}
const reactStub = new Proxy(
  {
    Component: StubComponent,
    PureComponent: StubComponent,
    Fragment: Symbol.for("react.fragment"),
    createElement: (type, props, ...children) => ({ type, props, children }),
  },
  {
    get: (target, key) => {
      if (key in target) return target[key];
      // Hooks and anything else the factory touches: a no-op is enough here,
      // because this check exercises module construction, not rendering.
      return () => undefined;
    },
  },
);
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => void (registration = definition) } },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: "client.js" });

assert.ok(registration !== undefined, "client.js did not call window.__ModuleLoader__.load()");
assert.equal(registration.id, "dsh-workbuddy-pool", "unexpected module id");
assert.equal(typeof registration.factory, "function", "the module has no factory");
console.log(`ok   registers ${registration.id}`);

/* ------------------------------------------------------------------ *
 * 4. The factory must build its export object with only the injected modules.
 * ------------------------------------------------------------------ */
const factory = registration.factory;
const exported = factory((name) => {
  if (name === "react") return reactStub;
  throw new Error(`unexpected require(${JSON.stringify(name)}) — the browser bundle may only require react`);
});

assert.equal(typeof exported?.name, "string", "the factory did not return a definition with a name");
assert.ok(Array.isArray(exported?.inject), "the definition does not declare its injected services");
assert.ok(exported.inject.includes("slots"), "the definition does not inject the slots service");
assert.equal(typeof exported.apply, "function", "the definition has no apply()");
console.log(`ok   factory builds ${exported.name} (inject: ${exported.inject.join(", ")})`);

console.log("\nclient bundle loads");
