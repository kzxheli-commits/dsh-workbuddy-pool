/**
 * Static contract checks for the browser half.
 *
 * This is deliberately NOT a renderer: visual verification needs browser
 * control, which this environment does not provide, and emulating React/DOM to
 * approximate a screenshot would not prove what the user sees. What can be
 * proven without a browser is checked here:
 *
 *   1. the module parses and keeps the `__ModuleLoader__` contract;
 *   2. every dictionary key exists in both languages, 1:1;
 *   3. every `t("...")` key and dynamic `state*`/`reason*` key is defined;
 *   4. every client route matches the server route table exactly;
 *   5. every colour in the stylesheet resolves from a Host theme token;
 *   6. slot registrations kept their ids (`main` key + sidebar entry id);
 *   7. no innerHTML / dangerouslySetInnerHTML path can inject markup.
 *
 * Usage: node test/check-client-static.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const source = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
const server = readFileSync(join(ROOT, "lib", "routes.js"), "utf8");

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok   ${name}\n`);
}

/** Extract one dictionary's top-level keys. */
function dictionaryKeys(name) {
  const body = new RegExp(`const ${name} = \\{(.*?)\\n    \\};`, "su").exec(source)?.[1] ?? "";
  return new Set([...body.matchAll(/^ {6}([A-Za-z0-9_]+):/gmu)].map((match) => match[1]));
}

check("module keeps the browser module contract", () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*id: "dsh-workbuddy-pool"/u);
  assert.match(source, /factory: \(require\) =>/u);
  assert.match(source, /require\("react"\)/u);
  assert.match(source, /inject: \["slots", "locale"\]/u);
  assert.match(source, /name: "dsh-workbuddy-pool-client"/u);
});

check("both dictionaries define the same keys", () => {
  const zh = dictionaryKeys("zh");
  const en = dictionaryKeys("en");
  assert.ok(zh.size > 100, `expected a substantive dictionary, saw ${zh.size}`);
  assert.deepEqual([...zh].sort(), [...en].sort());
});

check("every referenced translation key is defined", () => {
  const zh = dictionaryKeys("zh");
  const missing = new Set();
  for (const match of source.matchAll(/\bt\("([^"]+)"\)/gu)) if (!zh.has(match[1])) missing.add(match[1]);
  // Dynamic keys: state legend hints and reason labels are looked up through maps.
  const dynamic = ["stateReadyHint", "stateCoolingHint", "stateBlockedHint", "stateRestrictedHint", "stateDisabledHint"];
  for (const key of dynamic) if (!zh.has(key)) missing.add(key);
  for (const match of source.matchAll(/"(reason[A-Za-z]+)":/gu)) if (!zh.has(match[1])) missing.add(match[1]);
  assert.deepEqual([...missing], []);
});

check("state and job maps cover every server value", () => {
  const states = ["ready", "cooling", "blocked", "restricted", "disabled"];
  for (const state of states) {
    assert.match(source, new RegExp(`\\b${state}: "(state|ok|warn|bad|idle)`, "u"));
  }
  for (const kind of ["checkin", "report", "tasks", "streak", "travel"]) {
    assert.match(source, new RegExp(`\\["${kind}", t\\("autoJob`, "u"));
  }
});

check("every client route exists on the server", () => {
  const base = "/plugins/dsh-workbuddy-pool";
  const serverPaths = new Set([...server.matchAll(/: `\$\{ROUTE_PREFIX\}([^`]*)`/gu)].map((match) => `${base}${match[1]}`));
  const clientPaths = Object.fromEntries([...source.matchAll(/(\w+): "(\/plugins\/dsh-workbuddy-pool[^"]*)"/gu)].map((match) => [match[1], match[2]]));
  assert.deepEqual(Object.keys(clientPaths).sort(), [
    "automationConfig",
    "automationRun",
    "disableAccount",
    "importAccount",
    "oauthPoll",
    "oauthStart",
    "qr",
    "refreshCredits",
    "refreshModels",
    "removeAccount",
    "rescan",
    "reserveAccount",
    "resetCooldowns",
    "saveModels",
    "status",
  ]);
  for (const [name, path] of Object.entries(clientPaths)) assert.ok(serverPaths.has(path), `route ${name} -> ${path} is not served`);
});

check("styles use only host theme tokens for colours", () => {
  const css = /const CSS = `([\s\S]*?)`;/u.exec(source)?.[1] ?? "";
  assert.ok(css.length > 2_000, "stylesheet is suspiciously small");
  const hex = css.match(/(?<![-\w])#[0-9a-fA-F]{3,8}\b/gu) ?? [];
  assert.deepEqual(hex, []);
  const functions = css.match(/\b(?:rgba?|hsla?)\(/gu) ?? [];
  assert.deepEqual(functions, []);
  const withoutTokens = css.replace(/var\(--dsw-alias-[a-z0-9-]+\)/gu, "");
  const bareColorWords = withoutTokens.match(/:\s*(?:red|blue|green|black|white|gray|grey|orange|yellow)\b/gu) ?? [];
  assert.deepEqual(bareColorWords, []);
});

/**
 * A background token is not a foreground colour.
 *
 * `color: var(--dsw-alias-bg-base)` only survives the stock theme, where the
 * brand fill happens to be light and the page base dark. Any theme that lightens
 * the base (or darkens the fill the other way) collapses text into the fill and
 * the label vanishes while every other label keeps rendering — reported as
 * "missing fonts under a third-party theme". The foreground token is
 * `--dsw-alias-label-primary-foreground`; assert that no rule ever paints text
 * (or a dot on a fill) with a background token again.
 */
check("never paints foregrounds with a background token", () => {
  const css = /const CSS = `([\s\S]*?)`;/u.exec(source)?.[1] ?? "";
  // Strip comments first: the stylesheet explains this very rule in prose, and a
  // naive rule splitter would flag that sentence as a declaration.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const offenders = withoutComments
    .split("}")
    .map((rule) => rule.trim())
    .filter((rule) => /(?:^|[;{])\s*color:\s*var\(--dsw-alias-(?:bg|mask)-/u.test(rule));
  assert.deepEqual(offenders, [], `foreground painted with a background token:\n${offenders.join("\n")}`);

  // The primary button and an active switch dot both sit ON a brand-coloured
  // fill, so both must name the foreground token.
  assert.match(withoutComments, /\.wbp-btn--primary\{[^}]*color:var\(--dsw-alias-label-primary-foreground/u);
  assert.match(withoutComments, /\.wbp-switch\[aria-checked="true"\] \.wbp-switch-dot\{[^}]*background:var\(--dsw-alias-label-primary-foreground/u);
});

check("slot registrations keep their addressing", () => {
  assert.match(source, /name: "main", key: PANEL_ID/u);
  assert.match(source, /name: "sidebar\.panellist", id: PANEL_ID/u);
  assert.match(source, /const PANEL_ID = "workbuddy-pool"/u);
  assert.match(source, /label: \(\) => t\("nav"\)/u);
});

check("no markup injection path exists", () => {
  assert.ok(!source.includes("dangerouslySetInnerHTML"));
  assert.ok(!source.includes("innerHTML"));
  assert.ok(!/\beval\(/u.test(source));
});

check("every action renders a pending state and failure feedback", () => {
  assert.match(source, /aria-busy/u);
  assert.match(source, /role: "status", "aria-live": "polite"/u);
  assert.match(source, /toastFailed/u);
});

/**
 * Adding accounts is repeatable: a finished sign-in used to leave the QR dialog
 * in its "done" phase, which renders neither the start button nor the retry
 * one, so a second account could not be added at all.
 */
check("the add-account dialogs can be reused for another account", () => {
  // Opening the QR dialog always discards the previous sign-in record.
  assert.match(source, /const openAddQr = React\.useCallback\(\(\) => \{\s*stopQrPolling\(\);\s*setQr\(undefined\);/u);
  // A finished sign-in offers a fresh start instead of a dead end.
  assert.match(source, /qr\?\.phase === "done"[\s\S]{0,1500}t\("qrAnother"\)/u);
  // The sign-in region is chosen in the dialog, not inherited from the page view.
  assert.match(source, /api\(ROUTES\.oauthStart, \{ region \}\)/u);
  assert.match(source, /oauthPoll\}\?state=\$\{encodeURIComponent\(started\.state\)\}&region=\$\{region\}/u);
  // The paste dialog keeps accepting documents after a successful import.
  assert.match(source, /setImportSaved\(\{ label: result\.label \}\);\s*setImportText\(""\);/u);
  assert.match(source, /t\("importAnotherHint"\)/u);
});

/**
 * The settings tab bar selects with `aria-selected` (role="tab"), so a stylesheet
 * that only knows `[aria-pressed]` leaves the selected page invisible — exactly
 * the reported "can't tell which tab is active". It must share one rule with the
 * region switch, not grow a look of its own.
 */
check("the selected tab and segment share one visual rule", () => {
  const css = /const CSS = `([\s\S]*?)`;/u.exec(source)?.[1] ?? "";
  assert.match(css, /\.wbp-seg-btn\[aria-pressed="true"\],\.wbp-seg-btn\[aria-selected="true"\]\{/u);
  assert.ok(!css.includes("wbp-seg--tabs"), "the settings tabs must not carry a variant of their own");
  assert.match(source, /role: "tab"/u);
  assert.match(source, /"aria-selected": settingsTab === key/u);
  assert.match(source, /className: "wbp-seg wbp-seg--fill", role: "tablist"/u);
});

/**
 * Reserve and removal are account actions: they belong to the always-visible
 * action row next to Disable, not inside the collapsed details panel.
 */
check("account actions sit outside the details fold", () => {
  const detailsAt = source.indexOf('{ className: "wbp-account-details" }');
  assert.ok(detailsAt > 0, "details container not found");
  assert.ok(source.indexOf("onReserve(reserveValue)") < detailsAt, "reserve control must render in the header row");
  assert.ok(source.indexOf("confirmRemove ? onRemove() : setConfirmRemove(true)") < detailsAt, "remove control must render in the header row");
  // Order in the action row: remove first, then the bordered reserve field.
  assert.ok(
    source.indexOf("confirmRemove ? onRemove() : setConfirmRemove(true)") < source.indexOf("onReserve(reserveValue)"),
    "remove must come before the reserve field",
  );
  const css = /const CSS = `([\s\S]*?)`;/u.exec(source)?.[1] ?? "";
  assert.match(css, /\.wbp-field\{[^}]*border:1px solid/u, "the reserve control must be framed");
});

/**
 * The account card reads identity → stat strip → actions → details, so the
 * numbers that decide "can it serve now" stay visible without opening details.
 */
check("account card leads with a visible stat strip", () => {
  assert.match(source, /function AccountStat\(/u);
  assert.match(source, /className: "wbp-acct-stats"/u);
  const statsAt = source.indexOf('className: "wbp-acct-stats"');
  const detailsAt = source.indexOf('{ className: "wbp-account-details" }');
  assert.ok(statsAt > 0 && detailsAt > 0 && statsAt < detailsAt, "stat strip must render before the details panel");
});

check("account cards pair up on wide screens", () => {
  const css = /const CSS = `([\s\S]*?)`;/u.exec(source)?.[1] ?? "";
  assert.match(source, /className: "wbp-accounts"/u);
  assert.match(css, /\.wbp-accounts\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(380px,1fr\)\)/u);
  // Cards own their spacing now; the old stacked-sibling margin would break the grid.
  assert.ok(!css.includes(".wbp-account + .wbp-account"), "cards must not carry their own vertical margin");
});

/**
 * The legend explains what every badge colour means, so it is part of the card
 * page instead of a collapsible extra.
 */
check("the state legend is always rendered", () => {
  assert.match(source, /h\(StateLegend, \{ t \}\)/u);
  assert.ok(!source.includes("legendOpen"), "the legend must not hide behind a toggle");
});

/**
 * Auto refresh is a behaviour, not a preference: the switch is gone and the
 * interval is fixed at 30 seconds.
 */
check("auto refresh is always on at 30 seconds", () => {
  assert.match(source, /const POLL_MS = 30_000;/u);
  assert.ok(!source.includes("setAutoRefresh"), "the auto-refresh switch must stay removed");
});

/**
 * Dialogs belong to the plugin page, not to the whole app: the dialog is
 * positioned inside `.wbp-root`, draws no scrim, and lets clicks through the
 * transparent layer to the card only. The run-all confirmation is a dialog
 * rather than a `window.confirm` popup.
 */
check("dialogs float inside the plugin page without a scrim", () => {
  const css = /const CSS = `([\s\S]*?)`;/u.exec(source)?.[1] ?? "";
  assert.match(css, /\.wbp-root\{position:relative;/u);
  assert.match(css, /\.wbp-modal\{position:absolute;[^}]*pointer-events:none/u);
  assert.ok(!/\.wbp-modal\{[^}]*background:/u.test(css), "the dialog layer must not paint a scrim");
  assert.ok(!/\.wbp-modal\{position:fixed/u.test(css), "the dialog must not cover the whole app");
  assert.match(css, /\.wbp-modal-card\{[^}]*pointer-events:auto/u);
  assert.ok(!source.includes("window.confirm"), "confirmations use the in-page dialog");
  assert.match(source, /t\("runAllTitle"\)/u);
});

/** The card is split into a scrolling body and a fixed action bar; no glow. */
check("dialogs use a fixed action bar and no glow", () => {
  const css = /const CSS = `([\s\S]*?)`;/u.exec(source)?.[1] ?? "";
  assert.match(css, /\.wbp-modal-body\{/u);
  assert.match(css, /\.wbp-modal-actions\{/u);
  assert.ok(!/\.wbp-modal-card\{[^}]*box-shadow/u.test(css), "the dialog must not glow");
  assert.ok((source.match(/footer: \[/gu) ?? []).length >= 3, "each dialog supplies its action bar");
});


/** Every dialog closes from its action bar only; no corner × is rendered. */
check("dialogs hide the corner close button", () => {
  assert.match(source, /hideClose === true/u);
  assert.ok((source.match(/hideClose: true/gu) ?? []).length >= 3, "each dialog must opt out of the corner ×");
});


/** The request log scrolls inside a capped box; the per-model stats never fold. */
check("the request log is capped and the stats are always shown", () => {
  const css = /const CSS = `([\s\S]*?)`;/u.exec(source)?.[1] ?? "";
  assert.match(css, /\.wbp-table-wrap--request\{max-height:/u);
  assert.match(source, /wbp-table-wrap wbp-table-wrap--request/u);
  assert.ok(!source.includes("statsOpen"), "the per-model stats must not hide behind a toggle");
});


/** Every model row carries its own image switch, saved through imageModelIds. */
check("model rows expose a per-model image switch", () => {
  assert.match(source, /className: "wbp-image-toggle"/u);
  assert.match(source, /toggleImageFor\(key, model\.id\)/u);
  assert.match(source, /imageModelIds: image\.draft/u);
  assert.match(source, /const imageInfoOf = /u);
});


/** The image switch is offered only where the upstream catalog says the model
 * accepts images; the control must not grant the capability. */
check("the image switch follows the model capability", () => {
  assert.match(source, /model\.supportsImages === true\s*\?\s*h\(\s*"label",\s*\{ className: "wbp-image-toggle"/u);
  assert.match(source, /imageInfo\.enabled\.has\(model\.id\)/u);
});


/** The sidebar entry renders the packaged artwork, not a text glyph. */
check("the sidebar icon uses the packaged artwork", () => {
  assert.match(source, /const ICON_PNG = "data:image\/png;base64,[A-Za-z0-9+/=]+"/u);
  assert.match(source, /src: ICON_PNG/u);
  assert.ok(!source.includes("\u25cd"), "the placeholder glyph must stay removed");
});

process.stdout.write(`\n${passed} static client checks passed\n`);