/**
 * WorkBuddy desktop "at-rest" credential decryption.
 *
 * From desktop 5.6.0 the app stores `auth.accessToken` / `auth.refreshToken` as
 * an encrypted field wrapper instead of plain strings:
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64 of a JSON envelope>" }
 *
 * The envelope is `{suite, keyId, nonce, authTag, ciphertext}` for AES-256-GCM
 * with a 12-byte nonce and a 16-byte tag, and the additional authenticated data
 * is a length-prefixed transcript over scheme, suite, keyId and framing.
 *
 * The field key is NOT a user secret: it is a build-time constant inside the
 * app's own Electron native module. The app exposes it through
 * `process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()`,
 * hashes the returned base64 STRING (not the decoded bytes) for the 32-byte key,
 * and the envelope's `keyId` is the first 16 hex of that key's SHA-256.
 *
 * So the honest way to open these fields is to ask the installed app for the
 * same payload, which is what this module does. On a machine without the
 * desktop app (for example the Android/Web build) there is nothing to ask:
 * every caller must keep working with plaintext credentials and report the
 * encrypted case instead of guessing a key.
 *
 * Ported from `2861292267/DSH-Official-WorkBuddy-Credit-Proxy` (`lib/index.js`,
 * MIT, Copyright (c) 2026 XDTrees, adapted by 2861292267), whose at-rest module
 * in turn credits `dingminhua/dsh-connect-workbuddy` (MIT, LaoDing). The logic is
 * kept faithful because every branch here was derived from real captured files.
 *
 * @module dsh-workbuddy-pool/at-rest
 */

import { execFile, execFileSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 };
const STANDARD_FORMAT_ID = { file: "WBEF1", field: "WBEV1", record: "WBER1", stream: "WBES1" };
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
const SYMMETRIC_SCHEME = "sym-v1";
const WORKBUDDY_APP_EXECUTABLE_ENV = "WORKBUDDY_APP_EXECUTABLE";
const KEY_FETCH_TIMEOUT_MS = 10_000;
const KEY_FAILURE_BACKOFF_MS = 60_000;
const APP_EXECUTABLE_NAMES = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
const MACOS_APP_BUNDLE_NAMES = ["WorkBuddy.app", "WorkBuddy AI.app"];
const KEY_SCRIPT =
  "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";

function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeUint32(bytes.length), bytes]);
}

/** The AAD transcript for one `sym-v1`, field-framed envelope. */
function fieldAad(keyId, suite) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error("workbuddy: envelope keyId is malformed");
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID.field),
    encodeLengthPrefixed(SYMMETRIC_SCHEME),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE.field]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** Whether a JSON value is the app's encrypted-field wrapper. */
export function isEncryptedFieldWrapper(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 2 &&
    keys[0] === "$wbEncrypted" &&
    keys[1] === "envelope" &&
    value["$wbEncrypted"] === 1 &&
    typeof value["envelope"] === "string"
  );
}

/** The key id a derived 32-byte key reports (first 16 hex of its SHA-256). */
function deriveAtRestKeyId(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Derive the 32-byte field key from the app's key payload JSON. */
function deriveAtRestKey(payloadJson) {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error("workbuddy: at-rest key payload is not valid JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("workbuddy: at-rest key payload is not an object");
  }
  const secret = payload["atRestSecretKey"];
  if (typeof secret !== "string" || secret === "") {
    throw new Error("workbuddy: at-rest key payload carries no atRestSecretKey");
  }
  // The app hashes the base64 STRING, not the decoded bytes; hashing the bytes
  // yields a different key and every field fails to open.
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Open one encrypted field with a derived key and return its plaintext. */
export function openEncryptedField(field, key) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
  } catch {
    throw new Error("workbuddy: encrypted field envelope is not valid JSON");
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("workbuddy: encrypted field envelope is not an object");
  }
  const { suite, keyId, nonce, authTag, ciphertext } = envelope;
  if (typeof suite !== "number" || typeof keyId !== "string") {
    throw new Error("workbuddy: encrypted field envelope is missing suite or keyId");
  }
  if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") {
    throw new Error("workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext");
  }
  const expectedKeyId = deriveAtRestKeyId(key);
  if (keyId !== expectedKeyId) {
    throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/** The key id an encrypted envelope demands, or undefined when unreadable. */
export function encryptedFieldKeyId(field) {
  try {
    const record = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
    return typeof record["keyId"] === "string" ? record["keyId"] : undefined;
  } catch {
    return undefined;
  }
}

/** The executable inside a macOS app bundle, read from its own Info.plist. */
function macosBundleExecutable(bundle) {
  let plist;
  try {
    plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
  } catch {
    return undefined;
  }
  const name = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)?.[1]?.trim();
  if (name === undefined || name === "" || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    return undefined;
  }
  return join(bundle, "Contents", "MacOS", name);
}

/** Windows install locations recorded by the app's own uninstaller. */
function windowsRegistryAppPaths() {
  if (process.platform !== "win32") return [];
  const roots = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const out = [];
  for (const root of roots) {
    let listing;
    try {
      listing = execFileSync("reg", ["query", root, "/s", "/v", "DisplayName"], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    const blocks = listing.split(/\r?\n(?=HKEY_)/u).filter((block) => /WorkBuddy|CodeBuddy/iu.test(block));
    for (const block of blocks) {
      const keyPath = /^(HKEY_[^\r\n]+)/u.exec(block)?.[1]?.trim();
      if (keyPath === undefined) continue;
      for (const name of ["DisplayIcon", "InstallLocation"]) {
        try {
          const value = execFileSync("reg", ["query", keyPath, "/v", name], {
            encoding: "utf8",
            timeout: 5_000,
            windowsHide: true,
          });
          const raw = /REG_(?:SZ|EXPAND_SZ)\s+(.+)$/mu.exec(value)?.[1]?.trim();
          if (raw === undefined || raw === "") continue;
          const cleaned = raw.replace(/^"/u, "").replace(/",-?\d+$/u, "").replace(/,-?\d+$/u, "").trim();
          out.push(cleaned);
        } catch {
          /* a missing value is normal */
        }
      }
    }
  }
  return out;
}

/** Windows fallbacks for an app the registry did not cover. */
function windowsFallbackAppPaths(env) {
  const out = [];
  const roots = new Set();
  for (const key of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
    const value = env?.[key]?.trim();
    if (value !== undefined && value !== "") roots.add(value);
  }
  for (let code = 67; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      if (!existsSync(drive)) continue;
    } catch {
      continue;
    }
    roots.add(join(drive, "Program Files"));
    roots.add(join(drive, "Program Files (x86)"));
  }
  for (const root of roots) {
    for (const name of APP_EXECUTABLE_NAMES) {
      out.push(join(root, "WorkBuddy", name));
      out.push(join(root, "WorkBuddy AI", name));
      out.push(join(root, "Programs", "WorkBuddy", name));
    }
  }
  return out;
}

/** Candidate desktop executables for this machine. */
export function appExecutableCandidates(platform = process.platform, home = homedir(), env = process.env) {
  const candidates = [env?.[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()];
  if (platform === "win32") {
    candidates.push(...windowsRegistryAppPaths(), ...windowsFallbackAppPaths(env));
  } else if (platform === "darwin") {
    for (const name of MACOS_APP_BUNDLE_NAMES) {
      candidates.push(macosBundleExecutable(join(home, "Applications", name)));
      candidates.push(macosBundleExecutable(join("/Applications", name)));
    }
  }
  return [...new Set(candidates.filter((candidate) => candidate !== undefined && candidate !== ""))];
}

/** Ask one installed app binary for its at-rest key payload. */
function fetchAtRestKeyPayload(executable) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["-e", KEY_SCRIPT],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${String(stderr).trim() || error.message})`));
          return;
        }
        const payload = String(stdout).trim();
        if (payload === "") {
          reject(new Error("workbuddy: the desktop app returned an empty at-rest key payload"));
          return;
        }
        resolve(payload);
      },
    );
  });
}

/** Derived keys by keyId, cached for the process lifetime; never persisted. */
const keysById = new Map();
let inflightSweep;
let lastKeyFailureAtMs = 0;

/**
 * Load every installed build's key. A build that fails to answer is skipped on
 * its own; a failed sweep is negatively cached so a machine without the app does
 * not spawn a doomed child on every credential read.
 */
async function sweepKeys() {
  const payloads = await Promise.allSettled(appExecutableCandidates().map((executable) => fetchAtRestKeyPayload(executable)));
  let found = 0;
  for (const result of payloads) {
    if (result.status !== "fulfilled") continue;
    try {
      const key = deriveAtRestKey(result.value);
      const keyId = deriveAtRestKeyId(key);
      if (!keysById.has(keyId)) {
        keysById.set(keyId, key);
        found += 1;
      }
    } catch {
      /* one malformed payload must not poison the others */
    }
  }
  if (found === 0) {
    lastKeyFailureAtMs = Date.now();
    throw new Error("workbuddy: no installed desktop app provided an at-rest key");
  }
  return keysById;
}

/** Ensure the key map is populated (or fail fast while backing off). */
export async function ensureAtRestKeys() {
  if (keysById.size > 0) return keysById;
  if (lastKeyFailureAtMs !== 0 && Date.now() - lastKeyFailureAtMs < KEY_FAILURE_BACKOFF_MS) {
    throw new Error("workbuddy: the desktop app did not provide its at-rest key (recent failure, backing off)");
  }
  inflightSweep ??= sweepKeys().finally(() => {
    inflightSweep = undefined;
  });
  return inflightSweep;
}

/** Whether an encrypted field can even be attempted on this machine. */
export function atRestAvailable() {
  if (keysById.size > 0) return true;
  if (appExecutableCandidates().length === 0) return false;
  return lastKeyFailureAtMs === 0 || Date.now() - lastKeyFailureAtMs >= KEY_FAILURE_BACKOFF_MS;
}

/**
 * The synchronous decrypt used by the credential parser.
 *
 * The parser must stay synchronous because it runs inside a directory walk, so
 * the key sweep happens once up front (`await ensureAtRestKeys()`) and this
 * function then opens the field from the cached map.
 */
export function decryptField(value) {
  if (!isEncryptedFieldWrapper(value)) return undefined;
  const keyId = encryptedFieldKeyId(value);
  const key = keyId === undefined ? undefined : keysById.get(keyId);
  if (key === undefined) throw new Error("workbuddy: the at-rest key for this field is not available");
  return openEncryptedField(value, key);
}

/** Test seam: install a derived key without spawning the app. */
export function setAtRestKeyForTest(key) {
  keysById.clear();
  keysById.set(deriveAtRestKeyId(key), key);
  lastKeyFailureAtMs = 0;
}
