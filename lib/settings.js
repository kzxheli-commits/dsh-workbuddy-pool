/**
 * Plugin-owned mutable settings (card actions that must survive a reload).
 *
 * The static knobs live in the plugin row's Config schema; this file holds what
 * the settings card changes at runtime — account enable/disable, per-account
 * credit reserves, per-region model selection and the automation schedule.
 * Keeping it separate means a card action never has to rewrite the profile's
 * composed config.
 *
 * @module dsh-workbuddy-pool/settings
 */

import { paths, readJsonQuietly, writeJsonAtomic } from "./store.js";
import { createMutex } from "./util.js";
import { defaultProfile, normalizeProfile } from "./fingerprint-profile.js";
import { SANITIZE_DEFAULTS } from "./sanitize.js";

/** Defaults for the card-owned state. */
export function defaultState() {
  return {
    version: 1,
    disabledAccountIds: [],
    creditReserves: {},
    modelSelection: { cn: {}, global: {} },
    automation: { enabled: false },
    // Outbound prompt rewriting: brand rename + the measured filter triggers.
    sanitize: { ...SANITIZE_DEFAULTS },
    // Rotating request fingerprint (see fingerprint-profile.js).
    fingerprint: defaultProfile(),
  };
}

/** Merge saved state over the defaults; unknown keys are preserved. */
export function normalizeState(raw) {
  const base = defaultState();
  if (typeof raw !== "object" || raw === null) return base;
  const state = {
    ...base,
    ...raw,
    disabledAccountIds: Array.isArray(raw["disabledAccountIds"]) ? raw["disabledAccountIds"].filter((id) => typeof id === "string") : [],
    creditReserves:
      typeof raw["creditReserves"] === "object" && raw["creditReserves"] !== null
        ? Object.fromEntries(Object.entries(raw["creditReserves"]).filter(([, value]) => typeof value === "number" && value >= 0))
        : {},
    modelSelection: {
      cn: typeof raw["modelSelection"]?.["cn"] === "object" && raw["modelSelection"]["cn"] !== null ? raw["modelSelection"]["cn"] : {},
      global: typeof raw["modelSelection"]?.["global"] === "object" && raw["modelSelection"]["global"] !== null ? raw["modelSelection"]["global"] : {},
    },
    automation: typeof raw["automation"] === "object" && raw["automation"] !== null ? { ...base.automation, ...raw["automation"] } : { ...base.automation },
    sanitize:
      typeof raw["sanitize"] === "object" && raw["sanitize"] !== null
        ? {
            enabled: raw["sanitize"]["enabled"] !== false,
            brand: raw["sanitize"]["brand"] !== false,
            triggers: raw["sanitize"]["triggers"] !== false,
          }
        : { ...base.sanitize },
    fingerprint: normalizeProfile(raw["fingerprint"]),
  };
  return state;
}

/** One JSON-backed state file with an async write queue. */
export class PluginState {
  constructor(file = paths.settings) {
    this.file = typeof file === "function" ? file() : file;
    this.value = normalizeState(readJsonQuietly(this.file));
    this.write = createMutex();
    this.listeners = new Set();
  }

  /** The current state (live object; treat as read-only). */
  get() {
    return this.value;
  }

  /** Replace the state and persist it. */
  async set(next) {
    this.value = normalizeState(next);
    for (const listener of this.listeners) {
      try {
        listener(this.value);
      } catch {
        /* a broken listener must not fail the write */
      }
    }
    await this.write(() => {
      try {
        writeJsonAtomic(this.file, this.value);
      } catch {
        /* read-only profile: keep the in-memory value */
      }
    });
    return this.value;
  }

  /** Patch the state with a partial object (shallow per key). */
  async patch(partial) {
    return this.set({ ...this.value, ...partial });
  }

  /** Subscribe to changes (used to apply automation options immediately). */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The model selection of one region. */
  selection(region) {
    return this.value.modelSelection[region] ?? {};
  }

  /** Disabled account ids as a set. */
  disabledSet() {
    return new Set(this.value.disabledAccountIds);
  }

  /** Per-account credit reserves. */
  reserves() {
    return this.value.creditReserves;
  }

  /** Outbound prompt-rewriting settings. */
  sanitize() {
    return this.value.sanitize;
  }

  /** The rotating fingerprint profile. */
  fingerprint() {
    return this.value.fingerprint;
  }
}

/** Path used by the default constructor. */
export const stateFile = () => paths.settings();
