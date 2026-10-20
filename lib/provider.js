/**
 * Registering the pool as a Harness LLM provider.
 *
 * Every model of the route points at the loopback shim, so the Harness adapter
 * never talks to the upstream directly: rotation lives inside the shim and a
 * settings change only has to rebuild the model list.
 *
 * The profile handed to `dsh-llm-pi-ai` must be the same shape its own
 * normalization produces — `piProvider`, `configuredMaxTokens`, `modelErrors`
 * and the image budgets are all read by the adapter, and a profile missing them
 * registers fine but lists zero models and throws on the first call. That is why
 * the assembly below mirrors the reference implementation's adapter block rather
 * than passing a bare `{baseURL, models}` profile.
 *
 * @module dsh-workbuddy-pool/provider
 */

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { displayName as catalogDisplayName } from "./catalog.js";

/** No per-token price is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Harness reasoning levels, in ascending order. */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
/** Idle ceiling while one stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Request-image budgets at the dsh-llm-pi-ai defaults. */
const IMAGE_BUDGETS = {
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 4 * 1024 * 1024,
  requestImageMaxBytes: 1024 * 1024,
};

/** pi-ai auth plane that never manufactures a credential for the loopback route. */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error("workbuddy-pool: this route has no pi-ai credential lifecycle");
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    },
  },
};

/** Map only the reasoning levels the catalog advertises. */
function thinkingLevelMap(info) {
  const efforts = info.reasoning?.supportedEfforts;
  if (efforts === undefined || efforts.length === 0) return undefined;
  const map = {};
  for (const level of LEVELS) map[level] = efforts.includes(level) ? level : null;
  map.off = null;
  return map;
}

/**
 * Build one pi-ai model descriptor.
 *
 * `baseUrl` is per model on purpose: the openai-completions API reads
 * `model.baseUrl` directly, so a model without it cannot be dispatched.
 */
function toModelDescriptor(info, baseUrl, providerId) {
  const map = thinkingLevelMap(info);
  return {
    id: info.id,
    name: catalogDisplayName(info),
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    contextWindow: info.contextWindow,
    maxTokens: info.maxOutputTokens,
    cost: { ...NO_COST },
    input: info.supportsImages === true ? ["text", "image"] : ["text"],
    reasoning: map !== undefined,
    ...(map === undefined ? {} : { thinkingLevelMap: map }),
    ...(map === undefined ? {} : { compat: { supportsReasoningEffort: true } }),
  };
}

/** Build the pi-ai provider object whose models the adapter streams through. */
function buildPiProvider({ providerId, displayName, shim, models }) {
  const baseUrl = `${shim.baseUrl()}/v1`;
  return {
    ...createProvider({
      id: providerId,
      name: displayName,
      baseUrl,
      auth: {
        apiKey: {
          name: "WorkBuddy Pool loopback secret",
          // The shim accepts exactly its own current token; a stored copy can
          // only go stale across a reload, so the live token is resolved here.
          async resolve() {
            return { auth: { apiKey: shim.token() }, source: "WorkBuddy Pool" };
          },
        },
      },
      models: models(baseUrl, providerId),
      api: openAICompletionsApi(),
    }),
    getModels: () => models(baseUrl, providerId),
  };
}

/**
 * Assemble one provider route backed by a shim.
 *
 * `getSelection` reads the current per-region model selection so a settings
 * change is reflected on the next `invalidate()` without re-registering anything.
 */
export function createPoolProvider(options) {
  const { shim, catalog, providerId, displayName, getSelection, attachmentsOf, processPathOf } = options;
  const models = (baseUrl, id) => catalog.visible(getSelection()).map((info) => toModelDescriptor(info, baseUrl, id));
  const buildModels = () => models(`${shim.baseUrl()}/v1`, providerId);

  /**
   * Image inputs arrive as attachments; the adapter can only turn them into
   * pi-ai parts when the host's durable attachment service is reachable. Without
   * these two hooks every image request fails with "requires the durable
   * attachment service", so the route wires them exactly like the host does.
   */
  const resolveAttachments = attachmentsOf === undefined ? undefined : () => attachmentsOf();
  const resolveImageAccess =
    resolveAttachments === undefined
      ? undefined
      : (attachments, ref) =>
          resolveImageAttachmentAccess(attachments, (hostPath) => (processPathOf === undefined ? undefined : processPathOf(hostPath)), ref);

  const makeProfile = () => ({
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    // The route talks to a loopback shim, so a retry after a real upstream fault
    // only adds latency; two attempts absorb a transient blip. The delays are
    // wide on purpose: the reference proxy's hardening checklist forbids retrying
    // the upstream in under 5 seconds ("429 后热重试" is one of the behaviours
    // that escalates risk control), and this policy is the only place the plugin
    // can pace a re-attempt.
    retryPolicy: resolveRetryPolicy(
      { mode: "normal", maxRetries: 2, backoff: { initialDelayMs: 900, maxDelayMs: 5_000, jitterRatio: 0.2 } },
      `${providerId} retryPolicy`,
    ),
    // Fields the adapter reads unconditionally: the two catalogs it consults
    // and the image policy it applies per request.
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...IMAGE_BUDGETS,
    piProvider: buildPiProvider({ providerId, displayName, shim, models }),
  });

  let profiles = new Map([[providerId, makeProfile()]]);
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token(),
    ...(resolveAttachments === undefined ? {} : { resolveAttachments }),
    ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
  });
  return {
    providerId,
    displayName,
    adapter,
    buildModels,
    /** Rebuild the profiles map so the next read sees the new catalog. */
    invalidate() {
      profiles = new Map([[providerId, makeProfile()]]);
    },
    /** The models the picker should show (for model discovery). */
    discoveryModels() {
      return catalog.visible(getSelection()).map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxOutputTokens,
        inputModalities: model.supportsImages === true ? ["text", "image"] : ["text"],
      }));
    },
  };
}
