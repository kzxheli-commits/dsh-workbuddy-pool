/**
 * Plugin-owned on-disk state.
 *
 * Everything the plugin writes lives under a single folder inside the DSH
 * INSTALLATION directory: `<install>/workbuddy-pool/` (the install root is the
 * directory that holds `bin/dsh` and `app/`, e.g.
 * `/data/user/0/com.dsh.harness/files`). Keeping it there — instead of under
 * `$DSH_HOME` — means the state travels with the installation and is easy to
 * find next to the binary. A custom `DSH_INSTALL_DIR` overrides the root, and a
 * portable/custom `DSH_HOME` without an install marker falls back beside it.
 * An older `$DSH_HOME/.workbuddy-pool` directory is migrated on boot.
 *
 * @module dsh-workbuddy-pool/store
 */

import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Directory name under the DSH install root that owns every file this plugin writes. */
const STATE_DIR_NAME = "workbuddy-pool";
/** Pre-0.4.0 state directory under `DSH_HOME`, migrated on boot. */
const LEGACY_STATE_DIR_NAME = ".workbuddy-pool";
/** The desktop app's auth directory name, relative to each platform root. */
const DESKTOP_AUTH_SUFFIX = join("CodeBuddyExtension", "Data", "Public", "auth");
/** The live sign-in file the desktop app keeps inside its auth directory. */
export const LIVE_AUTH_FILENAME = "workbuddy-desktop.info";
/** Prefix for credential files this plugin writes into the auth directory. */
export const MIRROR_PREFIX = "workbuddy-pool-";

/** `$DSH_HOME` (the Harness home directory). */
export function dshHome() {
  const fromEnv = process.env["DSH_HOME"];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return join(homedir(), ".dsh");
}

/**
 * The DSH installation root: the directory holding `bin/dsh` (or the packaged
 * `app/package.json`). `DSH_INSTALL_DIR` wins; otherwise the root is located by
 * walking up from `DSH_HOME` (installed layout: `<root>/home/.dsh`). When no
 * install marker is found (portable/Docker homes) the state stays beside
 * `DSH_HOME` so nothing writes outside the user's own tree.
 */
export function dshInstallDir() {
  const fromEnv = nonEmpty(process.env["DSH_INSTALL_DIR"]);
  if (fromEnv !== undefined) return fromEnv;
  const home = dshHome();
  let current = home;
  for (let depth = 0; depth < 3; depth += 1) {
    current = dirname(current);
    if (isInstallRoot(current)) return current;
  }
  return home;
}

/** True when `dir` looks like a DSH installation root. */
function isInstallRoot(dir) {
  try {
    return existsSync(join(dir, "bin", "dsh")) || existsSync(join(dir, "app", "package.json")) || existsSync(join(dir, "libexec"));
  } catch {
    return false;
  }
}

/** The plugin's own state directory, next to the installation. */
export function dataDir() {
  return join(dshInstallDir(), STATE_DIR_NAME);
}

/** The pre-0.4.0 state directory (`$DSH_HOME/.workbuddy-pool`), if any. */
export function legacyDataDir() {
  return join(dshHome(), LEGACY_STATE_DIR_NAME);
}

/**
 * Move a pre-0.4.0 state directory to its new home under the install root.
 * Runs once per boot; idempotent, and never deletes the target. A cross-device
 * move falls back to a recursive copy, leaving the legacy folder behind so a
 * failed copy cannot lose data.
 */
export function migrateLegacyState(logger = undefined) {
  // An explicit DSH_INSTALL_DIR is user-managed (packaging/tests); moving a live
  // profile's state into it would be surprising, so only auto-derived roots
  // migrate the legacy folder.
  if (nonEmpty(process.env["DSH_INSTALL_DIR"]) !== undefined) return false;
  const target = dataDir();
  const legacy = legacyDataDir();
  if (legacy === target) return false;
  try {
    if (!existsSync(legacy)) return false;
    if (!existsSync(target)) {
      try {
        renameSync(legacy, target);
        logger?.info?.(`[workbuddy-pool] migrated state: ${legacy} -> ${target}`);
        return true;
      } catch {
        cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });
        logger?.info?.(`[workbuddy-pool] copied state: ${legacy} -> ${target}`);
        return true;
      }
    }
    // Both exist (e.g. the plugin already wrote to the new folder): merge the
    // files the new folder does not have yet.
    let moved = 0;
    for (const entry of readdirSync(legacy)) {
      const from = join(legacy, entry);
      const to = join(target, entry);
      if (existsSync(to)) continue;
      try {
        renameSync(from, to);
        moved += 1;
      } catch {
        try {
          cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
          moved += 1;
        } catch {
          /* keep the legacy file in place */
        }
      }
    }
    if (moved > 0) logger?.info?.(`[workbuddy-pool] merged ${moved} legacy state entr${moved === 1 ? "y" : "ies"} into ${target}`);
    return moved > 0;
  } catch (error) {
    logger?.warn?.(`[workbuddy-pool] state migration failed: ${String(error?.message ?? error)}`);
    return false;
  }
}

/** `mkdir -p` that tolerates an existing directory. */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/** Read and parse a JSON file; `undefined` when it is missing or malformed. */
export function readJsonQuietly(path) {
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Write JSON atomically: a temporary sibling plus a same-directory rename, so a
 * reader never observes half a file and a crash leaves the previous content.
 */
export function writeJsonAtomic(path, value, mode = 0o600) {
  const text = `${JSON.stringify(value, undefined, 1)}\n`;
  writeFileSyncAtomic(path, text, mode);
}

/** Write UTF-8 text atomically (tmp + rename). */
export function writeFileSyncAtomic(path, text, mode = 0o600) {
  ensureDir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8", mode });
  renameSync(temporary, path);
}

/** Append one JSON line to a journal file. */
export function appendJsonl(path, entry) {
  ensureDir(dirname(path));
  try {
    writeFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
  } catch {
    /* a full disk must not fail a model call */
  }
}

/** Read the tail of a JSON-lines journal, newest last. */
export function readJsonlTail(path, limit = 200) {
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    const out = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip one corrupt line rather than the whole journal */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** File size in bytes, or 0 when it does not exist. */
export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The credential state's file paths, resolved lazily so the install root can move. */
export const paths = {
  cooldowns: () => join(dataDir(), "cooldowns.json"),
  accounts: () => join(dataDir(), "accounts-state.json"),
  modelState: () => join(dataDir(), "model-state.json"),
  seen: () => join(dataDir(), "boot-scan.json"),
  requests: () => join(dataDir(), "requests.jsonl"),
  automation: () => join(dataDir(), "automation.json"),
  automationLedger: () => join(dataDir(), "automation-earnings.json"),
  settings: () => join(dataDir(), "settings.json"),
  oauth: () => join(dataDir(), "oauth-last.json"),
  catalog: () => join(dataDir(), "catalog.json"),
  shimSecret: (region) => join(dataDir(), `shim-secret-${region}`),
  importedCredentials: () => join(dataDir(), "credentials"),
};

/**
 * Directories that may hold WorkBuddy desktop sign-in snapshots, for this
 * platform. Windows probes Local before Roaming; a redirected profile still
 * resolves through the environment variable.
 */
export function desktopAuthDirs(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", DESKTOP_AUTH_SUFFIX)];
  }
  if (platform === "win32") {
    const local = nonEmpty(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local");
    const roaming = nonEmpty(env["APPDATA"]) ?? join(home, "AppData", "Roaming");
    return [join(local, DESKTOP_AUTH_SUFFIX), join(roaming, DESKTOP_AUTH_SUFFIX)];
  }
  if (platform === "linux") {
    const config = nonEmpty(env["XDG_CONFIG_HOME"]) ?? join(home, ".config");
    return [join(config, DESKTOP_AUTH_SUFFIX)];
  }
  return [];
}

/** The first existing desktop auth directory, if any. */
export function firstDesktopAuthDir(env = process.env, platform = process.platform, home = homedir()) {
  for (const dir of desktopAuthDirs(env, platform, home)) {
    try {
      if (existsSync(dir)) return dir;
    } catch {
      /* unreadable root: keep probing */
    }
  }
  return undefined;
}

/**
 * Every directory scanned for credentials, in priority order:
 * the desktop app itself (so a fresh app sign-in wins), then the plugin's own
 * imports from QR sign-in/paste JSON.
 */
export function credentialDirs(env = process.env, platform = process.platform, home = homedir()) {
  const out = [];
  const override = nonEmpty(env["WORKBUDDY_AUTH_FILE"]);
  if (override !== undefined) out.push(dirname(override));
  for (const dir of desktopAuthDirs(env, platform, home)) out.push(dir);
  out.push(paths.importedCredentials());
  return [...new Set(out)];
}

/** Non-empty trimmed environment value, or undefined. */
export function nonEmpty(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The loopback shim's shared secret for one region.
 *
 * Generated once and stored with mode 0600; a reload reuses it so the provider
 * row's cached credential (an ephemeral port plus this token) keeps working.
 */
export function shimSecret(region) {
  const path = paths.shimSecret(region);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/u.test(existing)) return existing;
  } catch {
    /* absent: mint below */
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSyncAtomic(path, `${secret}\n`, 0o600);
  return secret;
}

/** Stable short fingerprint of a credential, for logs that must not hold tokens. */
export function tokenFingerprint(accessToken) {
  if (typeof accessToken !== "string" || accessToken === "") return "none";
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 12);
}
