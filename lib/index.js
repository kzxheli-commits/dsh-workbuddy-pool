/**
 * Host half of `dsh-workbuddy-pool`.
 *
 * Responsibilities, in boot order:
 *   1. build the pool, catalog, scheduler and the two loopback shims;
 *   2. register one Harness provider per region once both shims listen;
 *   3. mount the settings-card routes on the host web server;
 *   4. discover credentials, read balances, seed the model catalogs, and arm
 *      the automation scheduler.
 *
 * Every resource is registered through `ctx.effect`, so a reload closes the
 * shims and withdraws the provider registrations instead of leaking ports.
 *
 * @module dsh-workbuddy-pool
 */

import { readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, sep } from "node:path";

import z from "@deepseek-ai/schemastery";

import { WorkBuddyScheduler, DEFAULT_JOB_HOURS } from "./automation.js";
import { ensureAtRestKeys } from "./at-rest.js";
import { WorkBuddyCatalog } from "./catalog.js";
import { persistCredentialDocument, regionOfCredential } from "./credentials.js";
import { setFingerprintProfile } from "./fingerprint.js";
import { normalizeProfile, randomProfile, rotationDue } from "./fingerprint-profile.js";
import { WorkBuddyAccountPool } from "./pool.js";
import { createPoolProvider } from "./provider.js";
import { createStatusPayload, registerPoolRoutes, ROUTES } from "./routes.js";
import { PluginState } from "./settings.js";
import { createShim } from "./shim.js";
import { dataDir, desktopAuthDirs, migrateLegacyState, paths, shimSecret, writeJsonAtomic } from "./store.js";
import { safeMessage } from "./util.js";
import { WorkBuddyClient } from "./upstream.js";

/** Stable Cordis plugin name. */
export const name = "llm-workbuddy-pool";
/** Services that must exist before the provider can register. */
export const inject = ["llm", "settings"];
/** Settings namespace shared by both provider routes and the client card. */
export const WORKBUDDY_POOL_SETTINGS_NS = "llm-workbuddy-pool";
/** Provider route per region. */
export const PROVIDER_IDS = { cn: "workbuddy-pool", global: "workbuddy-pool-global" };
/** Display name per region, so the picker can group them. */
export const DISPLAY_NAMES = { cn: "WorkBuddy 积分池（国内）", global: "WorkBuddy 积分池（国际）" };
/** This package's version, for the card and `/version`. */
export const VERSION = readVersion();

function readVersion() {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof parsed["version"] === "string" ? parsed["version"] : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/**
 * Runtime defaults for every Config field.
 *
 * A row that never touched the card arrives here with an empty config object,
 * and Cordis does not materialize schema defaults for an absent config, so the
 * defaults are stated once as a plain object and merged at the top of `apply`.
 */
const DEFAULT_CONFIG = Object.freeze({
  cnPort: 18120,
  globalPort: 18121,
  maxAttempts: 8,
  cooldownMs: 60_000,
  cooldownMaxMs: 7_200_000,
  serverCooldownMs: 15_000,
  hardCreditCooldownMs: 1_800_000,
  breakerThreshold: 3,
  breakerMs: 1_800_000,
  leaseLimit: 2,
  minUsableCredits: 50,
  distribution: "balanced",
  authFile: "",
  disabledAccountIds: [],
  creditReserves: {},
  automation: { enabled: false },
});

/** One region's model selection. */
const modelSelectionSchema = z.object({
  enabledModelIds: z.array(z.string()).description("该区域启用的模型 id（缺省 = 全部启用）"),
  imageModelIds: z.array(z.string()).description("该区域接受图片输入的模型 id（缺省 = 跟随上游）"),
  contextBudgets: z.dict(z.number().step(1).min(1)).description("按模型的上下文窗口覆盖值"),
});

/** Automation schedule. */
const automationSchema = z.object({
  enabled: z.boolean().default(false).description("启用每日积分自动化"),
  checkinHours: z.array(z.number().step(1).min(0).max(23)).description("每日签到的小时（本地时间）"),
  reportHours: z.array(z.number().step(1).min(0).max(23)).description("活跃上报的小时"),
  taskHours: z.array(z.number().step(1).min(0).max(23)).description("任务报名/领取的小时"),
  streakHours: z.array(z.number().step(1).min(0).max(23)).description("连登兑换的小时"),
  travelHours: z.array(z.number().step(1).min(0).max(23)).description("猫猫旅行的小时"),
});

/**
 * Plugin configuration schema.
 *
 * Every field carries a default so a row that never touched the card still
 * folds cleanly. The card's own mutable state lives in `settings.json`; these
 * fields are the deployment knobs.
 */
export const Config = z.object({
  cnPort: z.number().step(1).min(0).max(65535).default(18120).description("国内池回环端口（0 = 随机）"),
  globalPort: z.number().step(1).min(0).max(65535).default(18121).description("国际池回环端口（0 = 随机）"),
  maxAttempts: z.number().step(1).min(1).max(32).default(8).description("单次请求最多尝试的不同账号数"),
  cooldownMs: z.number().step(1).min(1_000).default(60_000).description("限流冷却，毫秒"),
  cooldownMaxMs: z.number().step(1).min(1_000).default(7_200_000).description("限流冷却上限，毫秒"),
  serverCooldownMs: z.number().step(1).min(1_000).default(15_000).description("网关故障冷却，毫秒"),
  hardCreditCooldownMs: z.number().step(1).min(1_000).default(1_800_000).description("积分耗尽后的休息时长，毫秒"),
  breakerThreshold: z.number().step(1).min(1).max(20).default(3).description("连续被拒多少次后移出轮换"),
  breakerMs: z.number().step(1).min(1_000).default(1_800_000).description("熔断移出时长，毫秒"),
  leaseLimit: z.number().step(1).min(1).max(64).default(2).description("单账号并发上限，达到后让路"),
  minUsableCredits: z.number().step(1).min(0).default(50).description("低于该余额的账号不再派活（0 = 关闭门槛）"),
  distribution: z
    .union(["priority", "round-robin", "balanced"])
    .default("balanced")
    .description("选号策略：priority 用尽一个再用下一个；round-robin 依次轮转；balanced 空闲加权随机"),
  authFile: z.string().default("").description("额外的 .info 文件路径（其所在目录会被扫描）"),
  disabledAccountIds: z.array(z.string()).default([]).description("停用的账号 id（空 = 全部参与）"),
  creditReserves: z.dict(z.number().step(1).min(0)).default({}).description("单账号积分保留线"),
  modelSelectionCn: modelSelectionSchema.description("国内区域的模型选择"),
  modelSelectionGlobal: modelSelectionSchema.description("国际区域的模型选择"),
  automation: automationSchema.description("每日积分自动化"),
});

// [0.2.0] mark the whole config editable through the settings service.
try {
  Config.meta ??= {};
  Config.meta.volatile = true;
} catch {
  /* older hosts do not need the marker */
}

/** Assemble the runtime objects without registering anything. */
export function createCore(logger) {
  const client = new WorkBuddyClient();
  const pool = new WorkBuddyAccountPool({ logger, client });
  return {
    client,
    pool,
    catalogs: { cn: new WorkBuddyCatalog({ client, logger, region: "cn" }), global: new WorkBuddyCatalog({ client, logger, region: "global" }) },
    scheduler: new WorkBuddyScheduler({ pool, client, logger }),
  };
}

/** The effective model selection for a region (config defaults under card state). */
function mergeSelection(config, state, region) {
  const fromConfig = region === "global" ? config.modelSelectionGlobal : config.modelSelectionCn;
  return { ...(fromConfig ?? {}), ...state.selection(region) };
}

/**
 * Start the pool. The provider registration waits for `shim.ready` because the
 * base URL carries the bound port.
 */
export function apply(ctx, rawConfig = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...(rawConfig ?? {}),
    automation: { ...DEFAULT_CONFIG.automation, ...(rawConfig?.automation ?? {}) },
    modelSelectionCn: rawConfig?.modelSelectionCn ?? {},
    modelSelectionGlobal: rawConfig?.modelSelectionGlobal ?? {},
  };
  // State used to live under $DSH_HOME/.workbuddy-pool; it now lives next to the
  // DSH installation. Move the old directory before any reader opens a file.
  try {
    migrateLegacyState(ctx.logger);
  } catch {
    /* keep running from the old location if the move is impossible */
  }
  const core = createCore(ctx.logger);
  const state = new PluginState(paths.settings());
  const bootAt = Date.now();
  let stopped = false;
  const disposers = [];

  // Seed card state from the config on a fresh profile, then let the card own it.
  if (state.get().disabledAccountIds.length === 0 && (config.disabledAccountIds ?? []).length > 0) {
    state.value.disabledAccountIds = [...config.disabledAccountIds];
  }
  if (Object.keys(state.get().creditReserves).length === 0 && Object.keys(config.creditReserves ?? {}).length > 0) {
    state.value.creditReserves = { ...config.creditReserves };
  }
  if (state.get().automation.enabled === false && config.automation?.enabled === true) {
    state.value.automation = { ...config.automation, hours: { ...DEFAULT_JOB_HOURS, ...(config.automation.hours ?? {}) } };
  }

  /** Push the pool knobs from config + card state into the runtime. */
  const applyRuntime = () => {
    const cardState = state.get();
    core.pool.applyConfig({
      maxAttempts: config.maxAttempts,
      cooldownMs: config.cooldownMs,
      cooldownMaxMs: config.cooldownMaxMs,
      serverCooldownMs: config.serverCooldownMs,
      hardCreditCooldownMs: config.hardCreditCooldownMs,
      breakerThreshold: config.breakerThreshold,
      breakerMs: config.breakerMs,
      leaseLimit: config.leaseLimit,
      minUsableCredits: config.minUsableCredits,
      distribution: config.distribution,
      disabledAccountIds: cardState.disabledAccountIds,
      creditReserves: cardState.creditReserves,
    });
    core.scheduler.applyOptions({ ...(config.automation ?? {}), ...cardState.automation });
    // The fingerprint profile is process-wide (every request reads it), so a card
    // change has to be pushed into the module that builds the headers.
    setFingerprintProfile(cardState.fingerprint);
    for (const region of ["cn", "global"]) providers[region]?.invalidate();
  };

  /**
   * Regenerate the fingerprint.
   *
   * `region` narrows a manual rotation to one gateway; the automatic rotation always
   * replaces both, because a real installation does not keep one region's build
   * frozen while the other moves.
   */
  const rotateFingerprint = (region) => {
    const current = normalizeProfile(state.get().fingerprint);
    const rotated = randomProfile(current);
    const next =
      region === undefined
        ? rotated
        : {
            ...current,
            revision: current.revision + 1,
            rotatedAt: Date.now(),
            [region]: rotated[region],
          };
    // Persist synchronously enough for the caller to answer with the new profile;
    // the interval timer only needs the in-memory value.
    state.value.fingerprint = next;
    setFingerprintProfile(next);
    void state.set({ ...state.value, fingerprint: next });
    return next;
  };

  const shims = {
    cn: createShim({
      pool: core.pool,
      catalog: core.catalogs.cn,
      region: "cn",
      token: shimSecret("cn"),
      port: config.cnPort,
      logger: ctx.logger,
      streamIdleTimeoutMs: 300_000,
      selection: () => mergeSelection(config, state, "cn"),
      sanitize: () => state.get().sanitize,
    }),
    global: createShim({
      pool: core.pool,
      catalog: core.catalogs.global,
      region: "global",
      token: shimSecret("global"),
      port: config.globalPort,
      logger: ctx.logger,
      streamIdleTimeoutMs: 300_000,
      selection: () => mergeSelection(config, state, "global"),
      sanitize: () => state.get().sanitize,
    }),
  };

  /** Adapters, filled after `shim.ready`. */
  const providers = {};

  /** Scan credentials from disk, applying auth-dir overrides. */
  const rescan = () => {
    const scan = core.pool.scan();
    applyRuntime();
    return scan;
  };

  /** Refresh one region's catalog from its own credential (manual action). */
  const refreshCatalogFor = async (region) => {
    const key = region === "global" ? "global" : "cn";
    const credential = [...core.pool.accounts.values()].find((account) => regionOfCredential(account.credential) === key)?.credential;
    const result = await core.catalogs[key].refresh(credential);
    providers[key]?.invalidate();
    return result;
  };

  /** Refresh both model catalogs from one credential of each region. */
  const refreshCatalog = async () => {
    for (const region of ["cn", "global"]) {
      await refreshCatalogFor(region);
    }
  };

  /** Read every account's balance. */
  const refreshCredits = async () => {
    await core.pool.refreshAllCredits();
  };

  /** Persist a card-state patch and apply it to the runtime immediately. */
  const applyState = async (partial) => {
    await state.patch(partial);
    applyRuntime();
  };

  /** Import one pasted `.info` document. */
  const importCredential = (document) => persistCredentialDocument(document);

  /** Remove one of OUR credential files (never a desktop app file). */
  const removeCredential = (id) => {
    const account = core.pool.accounts.get(id);
    if (account === undefined) return false;
    const source = account.credential.sourcePath;
    if (typeof source !== "string" || source === "") return false;
    // Only files this plugin wrote may be deleted: its own import directory,
    // or a mirror file it placed in the desktop auth directory. A credential the
    // DESKTOP APP wrote is never removed from here.
    const importedRoot = paths.importedCredentials();
    const inImportDir = source === importedRoot || source.startsWith(`${importedRoot}${sep}`);
    const mirrorName = /^workbuddy-(?:pool|scan)-[^/\\]+\.info$/u.test(basename(source));
    const inDesktopDir = mirrorName && desktopAuthDirs().some((root) => source.startsWith(`${root}${sep}`));
    if (!inImportDir && !inDesktopDir) return false;
    try {
      unlinkSync(source);
      return true;
    } catch {
      return false;
    }
  };

  /** Write the boot-scan record so "did discovery run?" is answerable from disk. */
  const writeBootRecord = (payload) => {
    try {
      writeJsonAtomic(paths.seen(), { at: new Date().toISOString(), ...payload });
    } catch {
      /* diagnostics only */
    }
  };

  const deps = {
    name,
    version: VERSION,
    bootAt,
    pool: core.pool,
    catalogs: core.catalogs,
    providers,
    shims: {
      cn: () => shims.cn.baseUrl(),
      global: () => shims.global.baseUrl(),
    },
    scheduler: core.scheduler,
    state,
    rescan,
    refreshCatalog,
    refreshCatalogFor,
    refreshCredits,
    applyState,
    rotateFingerprint,
    importCredential,
    removeCredential,
  };
  const statusPayload = createStatusPayload(deps);
  deps.statusPayload = statusPayload;

  // Routes are mounted on a context that actually owns `webServer`; Desktop
  // startup order must not be able to make the registration disappear.
  try {
    ctx.inject(["webServer"], (webCtx) => {
      registerPoolRoutes(webCtx, deps);
    });
  } catch (error) {
    ctx.logger?.warn?.(`workbuddy-pool: settings routes were not mounted: ${safeMessage(error)}`);
  }

  Promise.all([shims.cn.ready, shims.global.ready]).then(
    async () => {
      if (stopped) return;
      try {
        for (const region of ["cn", "global"]) {
          providers[region] = createPoolProvider({
            shim: shims[region],
            catalog: core.catalogs[region],
            providerId: PROVIDER_IDS[region],
            displayName: DISPLAY_NAMES[region],
            getSelection: () => mergeSelection(config, state, region),
            // Image inputs need the host's durable attachment service; without
            // these hooks pi-ai rejects every image request.
            attachmentsOf: () => ctx.get("attachments"),
            processPathOf: (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath),
          });
        }
        const releaseCn = ctx.llm.registerAdapter([PROVIDER_IDS.cn], providers.cn.adapter);
        const releaseGlobal = ctx.llm.registerAdapter([PROVIDER_IDS.global], providers.global.adapter);
        const releaseDirectory = ctx.llm.registerConfigurableProviders([
          { provider: PROVIDER_IDS.cn, displayName: DISPLAY_NAMES.cn, settingsNs: WORKBUDDY_POOL_SETTINGS_NS, settingsPath: [] },
          { provider: PROVIDER_IDS.global, displayName: DISPLAY_NAMES.global, settingsNs: WORKBUDDY_POOL_SETTINGS_NS, settingsPath: [] },
        ]);
        const releaseDiscovery = ctx.llm.registerModelDiscovery(WORKBUDDY_POOL_SETTINGS_NS, async (request) => {
          const region = request.provider === PROVIDER_IDS.global ? "global" : "cn";
          return providers[region]?.discoveryModels() ?? [];
        });
        disposers.push(releaseCn, releaseGlobal, releaseDirectory, releaseDiscovery);
        ctx.logger?.info?.(`workbuddy-pool: providers registered (cn=${shims.cn.baseUrl()}, global=${shims.global.baseUrl()})`);
      } catch (error) {
        ctx.logger?.error?.("workbuddy-pool: provider registration failed", error);
        return;
      }
      armBackgroundWork();
    },
    (error) => ctx.logger?.error?.("workbuddy-pool: loopback shim failed to listen", error),
  );

  /** Boot scan, catalog seed, credits, then the periodic refreshes. */
  function armBackgroundWork() {
    applyRuntime();
    const timers = [];
    // Install the saved fingerprint before the first request can go out.
    setFingerprintProfile(state.get().fingerprint);
    const boot = () => {
      if (stopped) return;
      void (async () => {
        try {
          await ensureAtRestKeys().catch(() => undefined);
          const scan = rescan();
          writeBootRecord({
            ok: true,
            count: scan.accounts.length,
            labels: scan.accounts.map((account) => account.label ?? account.id),
            warnings: scan.warnings,
            scanAt: scan.at ?? new Date().toISOString(),
          });
          ctx.logger?.info?.(`workbuddy-pool: ${scan.accounts.length} account(s) in rotation`);
          await refreshCredits().catch(() => undefined);
          await refreshCatalog().catch(() => undefined);
          core.scheduler.applyOptions({ ...(config.automation ?? {}), ...state.get().automation });
          if (core.scheduler.options.enabled === true) core.scheduler.start();
          core.scheduler.runForNewAccounts(scan.newIds);
        } catch (error) {
          writeBootRecord({ ok: false, count: 0, error: safeMessage(error) });
          ctx.logger?.warn?.("workbuddy-pool: boot scan failed", error);
        }
      })();
    };
    const bootTimer = setTimeout(boot, 1_500);
    bootTimer.unref?.();
    timers.push(bootTimer);
    const creditsTimer = setInterval(() => {
      void refreshCredits().catch(() => undefined);
    }, 300_000);
    creditsTimer.unref?.();
    timers.push(creditsTimer);
    const catalogTimer = setInterval(() => {
      void refreshCatalog().catch(() => undefined);
    }, 1_800_000);
    catalogTimer.unref?.();
    timers.push(catalogTimer);
    // Fingerprint rotation: a cheap check every minute, and the profile only
    // actually changes once its own interval has elapsed (never below three hours,
    // because a fingerprint that changes per request is itself a signal).
    const fingerprintTimer = setInterval(() => {
      try {
        if (!rotationDue(state.get().fingerprint)) return;
        const rotated = rotateFingerprint();
        ctx.logger?.info?.(`workbuddy-pool: fingerprint rotated to revision ${rotated.revision}`);
      } catch (error) {
        ctx.logger?.warn?.("workbuddy-pool: fingerprint rotation failed", error);
      }
    }, 60_000);
    fingerprintTimer.unref?.();
    timers.push(fingerprintTimer);
    // Rotate immediately on boot when the saved profile is already past its
    // interval, so a machine that was off for a day does not come back with a
    // fingerprint it used yesterday.
    if (rotationDue(state.get().fingerprint)) {
      const bootRotate = setTimeout(() => {
        try {
          rotateFingerprint();
        } catch {
          /* the periodic timer will retry */
        }
      }, 2_000);
      bootRotate.unref?.();
      timers.push(bootRotate);
    }
    disposers.push(() => {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    });
  }

  const dispose = () => {
    if (stopped) return;
    stopped = true;
    core.scheduler.dispose();
    core.pool.dispose();
    for (const release of disposers.splice(0)) {
      try {
        release?.();
      } catch {
        /* shutdown is best-effort */
      }
    }
    void shims.cn.close().catch(() => undefined);
    void shims.global.close().catch(() => undefined);
    ctx.logger?.info?.("workbuddy-pool: disposed");
  };
  try {
    ctx.effect(() => dispose);
  } catch {
    // A context without effects (test harness) still gets cleanup on process exit.
    process.once("exit", dispose);
  }
  return { core, state, shims, providers, deps };
}

export { ROUTES };
