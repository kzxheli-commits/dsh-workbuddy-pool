/**
 * The model catalog served to the picker and to `/v1/models`.
 *
 * A region's catalog is fetched from that region's own gateway (the two rosters
 * differ) and falls back to a static list so the provider is never empty before
 * the first fetch lands, or while the upstream is unreachable.
 *
 * @module dsh-workbuddy-pool/catalog
 */

import { paths, readJsonQuietly, writeJsonAtomic } from "./store.js";
import { round2 } from "./util.js";

/**
 * Static fallback roster. It exists so a brand-new install has selectable
 * models before any network call succeeds; the live catalog replaces it as soon
 * as one fetch returns. Ids are kept in step with what the gateways serve.
 */
export const FALLBACK_MODELS = [
  { id: "glm-5.3", name: "GLM-5.3", contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "glm-5.2", name: "GLM-5.2", contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "glm-5.1", name: "GLM-5.1", contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: false },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "deepseek-v4.1-flash-sg", name: "DeepSeek-V4.1-Flash-SG", contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "kimi-k3", name: "Kimi-K3", contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "minimax-m3", name: "MiniMax-M3", contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "hy3", name: "Hy3", contextWindow: 32_000, maxOutputTokens: 8_000, supportsImages: true },
  { id: "hy4-preview", name: "Hy4-Preview", contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "step-5-preview", name: "Step-5-Preview", contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true },
  { id: "space-bunny", name: "Space-Bunny", contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: "glm-5v-turbo", name: "GLM-5V-Turbo", contextWindow: 200_000, maxOutputTokens: 64_000, supportsImages: true },
  { id: "kimi-k3-1", name: "Kimi-K3.1", contextWindow: 1_000_000, maxOutputTokens: 32_000, supportsImages: true },
  { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true },
  { id: "kimi-k2.7", name: "Kimi-K2.7", contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true },
  { id: "kimi-k2.6", name: "Kimi-K2.6", contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true },
];

/** Promo tags shown next to a model's name; both free spellings collapse to one label. */
const TAG_LABEL = {
  free: "限时免费",
  "limited-free": "限时免费",
  "night-discount": "夜间折扣",
};
const DISPLAY_SEPARATOR = " · ";

/** The display suffix for one catalog row (`xN.NN` plus promo labels). */
function displaySuffix(info) {
  const parts = [];
  if (typeof info.creditMultiplier === "number" && Number.isFinite(info.creditMultiplier)) {
    parts.push(`x${info.creditMultiplier.toFixed(2)}`);
  }
  for (const tag of info.tags ?? []) {
    const label = TAG_LABEL[tag];
    if (label !== undefined && !parts.includes(label)) parts.push(label);
  }
  return parts.length === 0 ? undefined : parts.join(DISPLAY_SEPARATOR);
}

/** The name rendered in the picker: model name plus rate/promo badges. */
export function displayName(info) {
  const suffix = displaySuffix(info);
  return suffix === undefined ? info.name : `${info.name}${DISPLAY_SEPARATOR}${suffix}`;
}

/** One catalog per region, backed by the last successful fetch for that region. */
export class WorkBuddyCatalog {
  constructor(options = {}) {
    this.client = options.client;
    this.logger = options.logger;
    this.region = options.region ?? "cn";
    this.live = undefined;
    this.fetchedAt = undefined;
    this.lastError = undefined;
    this.load();
  }

  /** Restore the previous successful roster so a restart starts warm. */
  load() {
    const saved = readJsonQuietly(paths.catalog());
    const entry = saved?.[this.region];
    if (entry !== undefined && Array.isArray(entry.models) && entry.models.length > 0) {
      this.live = entry.models;
      this.fetchedAt = typeof entry.at === "number" ? entry.at : undefined;
    }
  }

  /** Persist the live roster for both regions (one file, one writer). */
  save() {
    if (this.live === undefined) return;
    const saved = readJsonQuietly(paths.catalog()) ?? {};
    saved[this.region] = { at: this.fetchedAt ?? Date.now(), models: this.live };
    try {
      writeJsonAtomic(paths.catalog(), saved);
    } catch {
      /* a read-only profile must not fail a model call */
    }
  }

  /** Whether the roster is still the static fallback. */
  isFallback() {
    return this.live === undefined;
  }

  /** Every model this region knows about, live first then fallback. */
  models() {
    return this.live ?? FALLBACK_MODELS;
  }

    /** Model ids the catalog knows, for validating a request. */
  has(id) {
    return this.models().some((model) => model.id === id);
  }

  /** One model row by id. */
  find(id) {
    return this.models().find((model) => model.id === id);
  }

  /**
   * Refresh the roster from one credential of this region.
   * Retries once on a transient failure, keeping the previous roster on failure.
   */
  async refresh(credential, options = {}) {
    if (credential === undefined) {
      this.lastError = "no account in this region to read the catalog";
      return { ok: false, count: this.models().length, error: this.lastError, fallback: this.isFallback() };
    }
    const attempts = options.attempts ?? 2;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const models = await this.client.fetchModels(credential);
        this.live = models;
        this.fetchedAt = Date.now();
        this.lastError = undefined;
        this.save();
        return { ok: true, count: models.length, fallback: false };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
    this.lastError = lastError;
    this.logger?.warn?.(`workbuddy-pool: catalog refresh failed for ${this.region}: ${lastError}`);
    return { ok: false, count: this.models().length, error: lastError, fallback: this.isFallback() };
  }

  /**
   * The roster the picker should show, after the user's selection and context
   * overrides are applied. Context overrides only ever narrow or widen the
   * advertised window; they cannot invent a model.
   */
  visible(selection = {}) {
    const all = this.models();
    // An ABSENT or EMPTY list both mean "everything": the card says unticking
    // every box is the same as no filter, and a provider with zero models would
    // break the picker rather than express a preference.
    const listed = Array.isArray(selection.enabledModelIds) ? selection.enabledModelIds : [];
    const enabled = listed.length > 0 ? new Set(listed) : undefined;
    const budgets = selection.contextBudgets ?? {};
    // An explicit list (even an empty one) narrows what image support is on, but
    // it can never grant it to a model the upstream reports as text-only; a
    // missing or null value keeps following the catalog.
    const imageOverride = Array.isArray(selection.imageModelIds) ? new Set(selection.imageModelIds) : undefined;
    let models = enabled === undefined ? all : all.filter((model) => enabled.has(model.id));
    // A saved selection can go stale after a catalog refresh; keeping the
    // provider empty is worse than ignoring the stale ids.
    if (models.length === 0) models = all;
    return models.map((model) => {
      const override = budgets[model.id];
      const next = { ...model };
      if (typeof override === "number" && override > 0) next.contextWindow = override;
      if (imageOverride !== undefined) next.supportsImages = model.supportsImages === true && imageOverride.has(model.id);
      return next;
    });
  }

  /** `/v1/models` payload (OpenAI shape). */
  toOpenAiModels(selection = {}) {
    return {
      object: "list",
      data: this.visible(selection).map((model) => ({
        id: model.id,
        object: "model",
        owned_by: "workbuddy",
        created: 0,
        name: displayName(model),
        context_window: model.contextWindow,
        max_tokens: model.maxOutputTokens,
        ...(model.creditMultiplier === undefined ? {} : { multiplier: round2(model.creditMultiplier) }),
      })),
    };
  }

  /** Snapshot for the card. */
  status(selection = {}) {
    const toRow = (model) => ({
      id: model.id,
      name: model.name,
      displayName: displayName(model),
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      supportsImages: model.supportsImages === true,
      multiplier: model.creditMultiplier ?? null,
      tags: model.tags ?? [],
    });
    const roster = this.models();
    return {
      region: this.region,
      fallback: this.isFallback(),
      fetchedAt: this.fetchedAt ?? null,
      error: this.lastError ?? null,
      total: roster.length,
      visible: this.visible(selection).length,
      // `models` stays the ENABLED slice (what the picker serves); `roster` is
      // the unfiltered catalog so the settings page can turn a hidden model
      // back on instead of being stuck with whatever was saved earlier.
      models: this.visible(selection).map(toRow),
      roster: roster.map(toRow),
    };
  }
}
