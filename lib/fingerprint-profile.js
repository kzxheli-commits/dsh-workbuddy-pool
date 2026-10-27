/**
 * The rotating request fingerprint.
 *
 * The gateway checks that a chat request comes from an official client, and the
 * values that make it look official are also the values a risk engine can pin to a
 * single installation. Sending one frozen fingerprint forever is therefore worse
 * than sending a plausible one that changes: a real installation is one of many, and
 * what it looks like is a *distribution*, not a constant.
 *
 * So the fingerprint is a small profile of header values that is regenerated on a
 * timer. Design rules, all of them load-bearing:
 *
 * - **Rotate rarely.** A desktop app does not change its build every request. The
 *   default interval is 3 hours and the minimum is 3 hours: rotating per request
 *   would be a fingerprint no real client ever has, which is a stronger signal than
 *   a stable one.
 * - **Rotate the stable identity, not the per-request ids.** Trace ids, span ids and
 *   conversation ids are already fresh per request (see `fingerprint.js`); they are
 *   not part of the profile and rotating them here would be meaningless.
 * - **Every value is individually editable.** The card shows the whole parameter
 *   list and lets one value be changed without touching the rest, because the
 *   measured-working values must remain reachable when a randomised pick turns out
 *   to be refused.
 * - **Only values measured to be accepted are ever generated.** The candidate lists
 *   below contain versions the live gateway answered 200 for; a random pick can make
 *   the request *look* different but never structurally wrong.
 *
 * @module dsh-workbuddy-pool/fingerprint-profile
 */

/** Rotation floor, in hours. The user-facing setting cannot go below this. */
export const MIN_ROTATE_HOURS = 3;
/** Default rotation interval, in hours. */
export const DEFAULT_ROTATE_HOURS = 3;

/**
 * Candidate values, all from the official client's own release line.
 *
 * The desktop build installed on this machine is 5.9.2 with bundled CLI 2.165.0,
 * read out of `resources/install-manifest.json` and
 * `resources/app.asar.unpacked/cli/package.json`. The neighbours below are the
 * builds a machine that has not auto-updated would still be on, which is what makes
 * a rotation look like a real installation rather than a random string. Every
 * combination was answered 200 by both gateways on 2026-10-27, so a rotation cannot
 * produce a refused request.
 */
const APP_VERSIONS = ["5.9.2", "5.9.1", "5.9.0", "5.8.2", "5.8.0"];
/** Bundled CLI versions that ship with those desktop builds. */
const CLI_VERSIONS = ["2.165.0", "2.164.0", "2.163.2", "2.160.0"];
/** Accept-Language values the client can send. */
const ACCEPT_LANGUAGES = ["*", "zh-CN", "en-US"];
/** Agent intents the official client uses for a normal chat turn. */
const AGENT_INTENTS = ["craft", "conversation"];

/** Pick one element, avoiding the current value when the list has an alternative. */
function pickOther(list, current) {
  const options = list.length > 1 ? list.filter((value) => value !== current) : list;
  return options[Math.floor(Math.random() * options.length)] ?? list[0];
}

/** Official User-Agent for one build: `WorkBuddy/<v> WorkBuddy/<v> CLI/<cli>`. */
export function clientUserAgent(version, cliVersion) {
  return `WorkBuddy/${version} WorkBuddy/${version} CLI/${cliVersion}`;
}

/** Backwards-compatible alias for the old CN helper name. */
export const cnUserAgent = clientUserAgent;
/** Backwards-compatible alias for the old intl helper name. */
export const intlUserAgent = clientUserAgent;

/**
 * The shipped, measured-working profile.
 *
 * Both regions carry the same official identity, because the official client is one
 * binary that serves both gateways; the CN profile additionally carries the extras
 * the CN gateway accepted (`x-product-code`, `x-env-id`, `accept-language`).
 */
export function defaultProfile() {
  const version = "5.9.2";
  const cli = "2.165.0";
  return {
    version: 1,
    schema: PROFILE_SCHEMA,
    revision: 0,
    rotatedAt: 0,
    enabled: true,
    rotateHours: DEFAULT_ROTATE_HOURS,
    cn: {
      "user-agent": clientUserAgent(version, cli),
      "x-ide-version": version,
      "x-agent-intent": "craft",
      "x-product-code": "codebuddy",
      "x-env-id": "production",
      "accept-language": "*",
    },
    global: {
      "user-agent": clientUserAgent(version, cli),
      "x-ide-version": version,
      "x-agent-intent": "craft",
    },
  };
}

/** Clamp a rotation interval to the supported range. */
export function clampRotateHours(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ROTATE_HOURS;
  return Math.max(MIN_ROTATE_HOURS, Math.min(24 * 30, Math.round(value)));
}

/** Keep only string values that look like a header value. */
function cleanHeaderMap(raw, fallback) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...fallback };
  const out = { ...fallback };
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    const name = key.trim().toLowerCase();
    if (name === "") continue;
    // Header values cannot carry control characters; drop such a value rather than
    // let a card typo produce an unparseable request.
    if (/[\u0000-\u001f\u007f]/u.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Schema revision of the saved profile.
 *
 * Bumped when the *shape* of the fingerprint changes, so a profile saved by an older
 * build cannot pin the request to an identity this build no longer supports. The
 * first release of the profile feature stored `CodeBuddyIDE/4.12.0` for CN and
 * `workbuddy-ai/5.7.6` for intl; those values are no longer what the official client
 * sends, and a stale saved profile would silently override the new defaults.
 */
export const PROFILE_SCHEMA = 2;

/** Merge a saved profile over the defaults; unknown keys are dropped. */
export function normalizeProfile(raw) {
  const base = defaultProfile();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
  // A profile written by an older schema is discarded wholesale rather than merged:
  // merging would keep a few stale headers while replacing others, which is the one
  // outcome that looks official but contradicts itself.
  if (raw["schema"] !== PROFILE_SCHEMA) return { ...base, rotateHours: clampRotateHours(raw["rotateHours"]), enabled: raw["enabled"] !== false };
  return {
    version: 1,
    schema: PROFILE_SCHEMA,
    revision: typeof raw["revision"] === "number" && Number.isFinite(raw["revision"]) ? Math.max(0, Math.round(raw["revision"])) : 0,
    rotatedAt: typeof raw["rotatedAt"] === "number" && Number.isFinite(raw["rotatedAt"]) ? raw["rotatedAt"] : 0,
    enabled: raw["enabled"] !== false,
    rotateHours: clampRotateHours(raw["rotateHours"]),
    cn: cleanHeaderMap(raw["cn"], base.cn),
    global: cleanHeaderMap(raw["global"], base.global),
  };
}

/**
 * Generate a new profile.
 *
 * Every randomised value comes from a list the live gateways accepted, and the
 * User-Agent is rebuilt from the version values so the two can never disagree — a UA
 * claiming one build while `x-ide-version` claims another is exactly the kind of
 * inconsistency a verifier looks for.
 *
 * Both regions rotate together: the official client is one binary, so a machine does
 * not report 5.9.2 to one gateway and 5.8.0 to the other.
 */
export function randomProfile(previous, now = Date.now()) {
  const prior = normalizeProfile(previous);
  const version = pickOther(APP_VERSIONS, prior.cn["x-ide-version"]);
  const cli = pickOther(CLI_VERSIONS, cliOf(prior.cn["user-agent"]));
  const language = pickOther(ACCEPT_LANGUAGES, prior.cn["accept-language"]);
  const cnIntent = pickOther(AGENT_INTENTS, prior.cn["x-agent-intent"]);
  const globalIntent = pickOther(AGENT_INTENTS, prior.global["x-agent-intent"]);
  const userAgent = clientUserAgent(version, cli);
  return {
    version: 1,
    schema: PROFILE_SCHEMA,
    revision: prior.revision + 1,
    rotatedAt: now,
    enabled: prior.enabled,
    rotateHours: prior.rotateHours,
    cn: {
      "user-agent": userAgent,
      "x-ide-version": version,
      "x-agent-intent": cnIntent,
      "x-product-code": "codebuddy",
      "x-env-id": "production",
      "accept-language": language,
    },
    global: {
      "user-agent": userAgent,
      "x-ide-version": version,
      "x-agent-intent": globalIntent,
    },
  };
}

/** The CLI version inside a User-Agent, if it has one. */
function cliOf(userAgent) {
  const match = /CLI\/([\w.]+)/u.exec(typeof userAgent === "string" ? userAgent : "");
  return match?.[1];
}

/** When the next rotation is due (epoch ms). */
export function nextRotationAt(profile) {
  const clean = normalizeProfile(profile);
  if (clean.rotatedAt <= 0) return 0;
  return clean.rotatedAt + clean.rotateHours * 3_600_000;
}

/** True when the profile should be regenerated now. */
export function rotationDue(profile, now = Date.now()) {
  const clean = normalizeProfile(profile);
  if (clean.enabled === false) return false;
  if (clean.rotatedAt <= 0) return true;
  return now >= nextRotationAt(clean);
}

/**
 * Header block for one region, ready to merge into a request.
 *
 * The profile only ever *overrides* the shipped fingerprint: keys the profile does
 * not carry keep the value from `fingerprint.js`, so an older saved profile cannot
 * silently drop a required header.
 */
export function profileHeaders(region, profile) {
  const clean = normalizeProfile(profile);
  const values = region === "global" ? clean.global : clean.cn;
  return { ...values };
}

/**
 * Human-readable rows for the card: one row per parameter, with its value, whether
 * the current value is the shipped default, and whether the field is safe to edit.
 */
export function profileFacts(profile) {
  const clean = normalizeProfile(profile);
  const base = defaultProfile();
  const rows = [];
  for (const region of ["cn", "global"]) {
    for (const [key, value] of Object.entries(clean[region])) {
      rows.push({
        region,
        key,
        value,
        default: base[region][key],
        changed: base[region][key] !== value,
      });
    }
  }
  return rows;
}

/**
 * Apply a manual edit to one parameter.
 *
 * Editing is deliberately narrow: one key, one region, one string value. A value
 * that would make the header block self-contradictory (a User-Agent whose version
 * disagrees with `x-ide-version`) is allowed but reported, because the operator may
 * be reproducing a specific build on purpose.
 */
export function setProfileValue(profile, region, key, value) {
  const clean = normalizeProfile(profile);
  const target = region === "global" ? "global" : "cn";
  const name = String(key).trim().toLowerCase();
  if (name === "") throw new Error("the parameter name is empty");
  if (typeof value !== "string") throw new Error("the value must be a string");
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("the value contains control characters");
  const next = { ...clean, [target]: { ...clean[target], [name]: value }, revision: clean.revision + 1 };
  return { profile: next, warning: inconsistencyOf(next, target) };
}

/** Report a version mismatch between the UA and the version headers. */
export function inconsistencyOf(profile, region) {
  const clean = normalizeProfile(profile);
  const values = region === "global" ? clean.global : clean.cn;
  const ua = values["user-agent"] ?? "";
  const version = values["x-ide-version"];
  if (typeof version !== "string" || version === "") return undefined;
  if (!ua.includes(version)) return `User-Agent does not mention version ${version}`;
  return undefined;
}

/** Drop one parameter back to its shipped default. */
export function resetProfileValue(profile, region, key) {
  const clean = normalizeProfile(profile);
  const base = defaultProfile();
  const target = region === "global" ? "global" : "cn";
  const name = String(key).trim().toLowerCase();
  const fallback = base[target][name];
  if (fallback === undefined) throw new Error(`unknown parameter ${name}`);
  return { ...clean, [target]: { ...clean[target], [name]: fallback }, revision: clean.revision + 1 };
}
