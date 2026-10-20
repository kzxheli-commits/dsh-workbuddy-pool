/**
 * The multi-account pool: selection, rotation, cooldowns, leases, accounting.
 *
 * One request may be attempted on several accounts. The pool decides the order,
 * charges each failure to the account that produced it, and stops rotating when
 * the failure belongs to the request instead of any account.
 *
 * @module dsh-workbuddy-pool/pool
 */

import { accountLabel, discoverCredentials, persistCredentialDocument, regionOfCredential, workbuddyAccountId } from "./credentials.js";
import { appendJsonl, paths, readJsonQuietly, readJsonlTail, writeFileSyncAtomic, writeJsonAtomic } from "./store.js";
import { createMutex, dayKey, percentile, ringPush, round2 } from "./util.js";

/** Defaults for every pool knob; the config row overrides them through `applyConfig`. */
export const POOL_DEFAULTS = {
  /** Maximum distinct accounts one request may try. */
  maxAttempts: 8,
  /** Rate-limit cooldown when the upstream names no reset time. */
  cooldownMs: 60_000,
  /** Hard ceiling for a rate-limit cooldown, however far the upstream reset is. */
  cooldownMaxMs: 7_200_000,
  /** Gateway/5xx cooldown: brief, and tracked separately from rate limits. */
  serverCooldownMs: 15_000,
  /** How long a hard-credit account rests before being offered again. */
  hardCreditCooldownMs: 1_800_000,
  /** Consecutive credential rejections before an account leaves rotation. */
  breakerThreshold: 3,
  /** How long a tripped breaker keeps the account out. */
  breakerMs: 1_800_000,
  /** In-flight requests one account may carry before it is deprioritised. */
  leaseLimit: 2,
  /** Balance below which an account cannot pay for a call (0 disables). */
  minUsableCredits: 50,
  /** How requests are spread: priority, round-robin, or balanced. */
  distribution: "balanced",
  /** Request records kept in memory for the card. */
  recordLimit: 500,
  /** Credits are re-read at most this often per account. */
  creditsTtlMs: 300_000,
};

/** Failure kinds that belong to the request: rotating cannot help. */
const TERMINAL_KINDS = new Set(["request_fault", "model_blocked", "not_found"]);
/** Failure kinds that cost the ACCOUNT a cooldown (or a break). */
const ACCOUNT_FAULTS = new Set(["soft_rate", "server", "session_dead", "hard_credit", "account_restricted"]);

/** A pool failure with a stable reason the shim maps to an HTTP status. */
export class PoolError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "PoolError";
    this.reason = options.reason ?? "upstream";
    this.status = options.status ?? 0;
    this.kind = options.kind;
    this.attempts = options.attempts ?? 0;
  }
}

/** Round-robin index for a `(region, model)` pair, used by the round-robin mode. */
const roundRobinCursor = new Map();

/** One discovered credential plus everything the pool learned about it. */
class AccountState {
  constructor(credential) {
    this.credential = credential;
    this.id = workbuddyAccountId(credential);
    this.region = regionOfCredential(credential);
    this.credits = undefined;
    this.creditsAt = 0;
    this.creditsError = undefined;
    this.lastUsedAt = 0;
    this.lastResult = undefined;
    this.failures = 0;
    this.consecutiveRejections = 0;
    this.breakerUntil = 0;
    this.cooldownUntil = 0;
    this.cooldownReason = undefined;
    this.modelCooldowns = new Map();
    this.leases = 0;
    this.requests = 0;
    this.successes = 0;
    this.lastError = undefined;
    this.tokensIn = 0;
    this.tokensOut = 0;
  }

  /** The account's display label (used by diagnostics and the boot record). */
  get label() {
    return labelOf(this.credential);
  }

  /** User-facing status for one account. */
  status(now, options) {
    const modelCooldowns = [];
    for (const [model, until] of this.modelCooldowns) {
      if (until > now) modelCooldowns.push({ model, until });
      else this.modelCooldowns.delete(model);
    }
    const cooldownUntil = Math.max(this.cooldownUntil, this.breakerUntil);
    const usableCredits = this.credits === undefined || this.credits >= options.minUsableCredits;
    let state = "ready";
    let reason;
    if (this.disabled) {
      state = "disabled";
      reason = "disabled-manually";
    } else if (this.breakerUntil > now) {
      state = "blocked";
      reason = "needs-sign-in";
    } else if (!usableCredits) {
      state = "restricted";
      reason = "low-credits";
    } else if (this.credits !== undefined && this.credits <= (options.creditReserves?.[this.id] ?? 0)) {
      state = "restricted";
      reason = "below-reserve";
    } else if (this.cooldownUntil > now) {
      state = "cooling";
      reason = this.cooldownReason ?? "cooldown";
    } else if (modelCooldowns.length > 0) {
      state = "ready";
      reason = "model-cooldown";
    }
    return {
      id: this.id,
      label: labelOf(this.credential),
      region: this.region,
      state,
      reason,
      credits: this.credits ?? null,
      creditsAt: this.creditsAt || null,
      creditsError: this.creditsError ?? null,
      cooldownUntil: cooldownUntil > now ? cooldownUntil : null,
      modelCooldowns,
      breakerUntil: this.breakerUntil > now ? this.breakerUntil : null,
      disabled: this.disabled === true,
      reserve: options.creditReserves?.[this.id] ?? 0,
      inFlight: this.leases,
      requests: this.requests,
      successes: this.successes,
      lastUsedAt: this.lastUsedAt || null,
      lastResult: this.lastResult ?? null,
      lastError: this.lastError ?? null,
      tokens: { input: this.tokensIn, output: this.tokensOut },
      expiresAt: this.credential.expiresAtMs || null,
      source: this.credential.sourcePath,
      hasRefreshToken: typeof this.credential.refreshToken === "string" && this.credential.refreshToken !== "",
      issuerRegion: this.region,
    };
  }
}

/** The label of one account's credential. */
function labelOf(credential) {
  return accountLabel(credential);
}

/** One model's latency/throughput samples for the card. */
class ModelStats {
  constructor() {
    this.samples = 0;
    this.queue = [];
    this.total = [];
    this.firstByte = [];
    this.outputTokens = [];
    this.failures = 0;
  }

  record({ queueMs, totalMs, firstByteMs, outputTokens, ok }) {
    this.samples += 1;
    if (!ok) {
      this.failures += 1;
      return;
    }
    ringPush(this.queue, queueMs, 200);
    ringPush(this.total, totalMs, 200);
    if (firstByteMs !== undefined) ringPush(this.firstByte, firstByteMs, 200);
    if (outputTokens !== undefined && totalMs > 0) ringPush(this.outputTokens, (outputTokens / totalMs) * 1000, 200);
  }

  status(id) {
    const avg = (values) => (values.length === 0 ? null : round2(values.reduce((sum, value) => sum + value, 0) / values.length));
    return {
      id,
      samples: this.samples,
      failures: this.failures,
      queueP50: percentile(this.queue, 0.5) ?? null,
      queueP95: percentile(this.queue, 0.95) ?? null,
      totalP50: percentile(this.total, 0.5) ?? null,
      totalP95: percentile(this.total, 0.95) ?? null,
      firstByteP50: percentile(this.firstByte, 0.5) ?? null,
      tpsP50: percentile(this.outputTokens, 0.5) ?? null,
      tpsMax: this.outputTokens.length === 0 ? null : Math.max(...this.outputTokens),
    };
  }
}

/**
 * The account pool.
 *
 * `scanner` is injectable so tests can supply fixed credentials; the default
 * scans the machine the way a real install would.
 */
export class WorkBuddyAccountPool {
  constructor(options = {}) {
    this.client = options.client;
    this.logger = options.logger;
    this.scanner = options.scanner ?? (() => discoverCredentials());
    this.accounts = new Map();
    this.disabled = new Set();
    this.creditReserves = {};
    this.options = { ...POOL_DEFAULTS, ...(options.options ?? {}) };
    this.sticky = new Map();
    this.records = [];
    this.modelStats = new Map();
    // Usage is a per-day, per-region ledger rebuilt from the persisted request
    // log, so a restart keeps today's numbers and the request list intact.
    this.usage = { days: {} };
    this.lastScanNewIds = [];
    this.lastScanAt = 0;
    this.lastScanWarnings = [];
    this.saveCooldowns = createMutex();
    this.cooldownTimer = undefined;
    this.stopped = false;
    this.loadCooldowns();
    this.loadState();
    this.loadHistory();
  }

  /** Restore the recent request log and rebuild the ledgers from it. */
  loadHistory() {
    const limit = this.options.recordLimit;
    let rows;
    try {
      rows = readJsonlTail(paths.requests(), Math.max(limit * 4, 500));
    } catch {
      rows = [];
    }
    if (rows.length === 0) return;
    this.records = rows.slice(-limit);
    for (const record of this.records) this.fold(record);
    // Keep the file bounded: rewrite it with the retained rows once it grows
    // well past what the card can show.
    if (rows.length > Math.max(limit * 4, 500)) {
      try {
        writeFileSyncAtomic(paths.requests(), `${this.records.map((record) => JSON.stringify(record)).join("\n")}\n`, 0o600);
      } catch {
        /* a failed compaction only costs disk space */
      }
    }
  }

  /** Fold one record into the per-region usage and per-model statistics. */
  fold(record) {
    const region = record.region === "global" ? "global" : "cn";
    if (record.totalMs !== undefined) {
      const key = `${region}\u0000${record.model}`;
      const stats = this.modelStats.get(key) ?? new ModelStats();
      stats.record({ queueMs: record.queueMs ?? 0, totalMs: record.totalMs, firstByteMs: record.firstByteMs, outputTokens: record.outputTokens, ok: record.ok });
      this.modelStats.set(key, stats);
    }
    if (record.ok !== true) return;
    const day = dayKey(new Date(typeof record.at === "number" ? record.at : Date.now()));
    const bucket = this.usage.days[day] ?? (this.usage.days[day] = {});
    const row = bucket[region] ?? (bucket[region] = { requests: 0, input: 0, output: 0 });
    row.requests += 1;
    row.input += record.inputTokens ?? 0;
    row.output += record.outputTokens ?? 0;
  }

  /** Merge the persisted cooldowns (they survive a reload on purpose). */
  loadCooldowns() {
    const saved = readJsonQuietly(paths.cooldowns());
    if (typeof saved !== "object" || saved === null) return;
    this.cooldownSnapshot = saved;
  }

  /** Restore account-level state that is not derivable (credits, counters). */
  loadState() {
    const saved = readJsonQuietly(paths.accounts());
    this.persisted = typeof saved === "object" && saved !== null ? saved : {};
  }

  /** Apply one persisted snapshot to a freshly scanned account. */
  hydrate(state) {
    const saved = this.persisted?.[state.id];
    if (saved === undefined) return;
    if (typeof saved.credits === "number") {
      state.credits = saved.credits;
      state.creditsAt = saved.creditsAt ?? 0;
    }
    if (typeof saved.requests === "number") state.requests = saved.requests;
    if (typeof saved.successes === "number") state.successes = saved.successes;
    if (typeof saved.tokensIn === "number") state.tokensIn = saved.tokensIn;
    if (typeof saved.tokensOut === "number") state.tokensOut = saved.tokensOut;
    state.lastUsedAt = saved.lastUsedAt ?? 0;
    const cooldown = this.cooldownSnapshot?.[state.id];
    if (cooldown !== undefined && typeof cooldown.until === "number") {
      state.cooldownUntil = cooldown.until;
      state.cooldownReason = cooldown.reason;
    }
    if (cooldown !== undefined && typeof cooldown.breakerUntil === "number") {
      state.breakerUntil = cooldown.breakerUntil;
    }
    if (cooldown !== undefined && typeof cooldown.modelCooldowns === "object" && cooldown.modelCooldowns !== null) {
      for (const [model, until] of Object.entries(cooldown.modelCooldowns)) {
        if (typeof until === "number" && until > Date.now()) state.modelCooldowns.set(model, until);
      }
    }
  }

  /** Persist cooldowns (debounced: callers may hit this once per failure). */
  scheduleCooldownSave() {
    if (this.cooldownTimer !== undefined) return;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = undefined;
      void this.saveCooldowns(() => this.writeCooldowns());
    }, 250);
    this.cooldownTimer.unref?.();
  }

  writeCooldowns() {
    const snapshot = {};
    for (const state of this.accounts.values()) {
      if (
        state.cooldownUntil <= Date.now() &&
        state.breakerUntil <= Date.now() &&
        state.modelCooldowns.size === 0
      ) {
        continue;
      }
      snapshot[state.id] = {
        until: state.cooldownUntil,
        reason: state.cooldownReason,
        breakerUntil: state.breakerUntil,
        modelCooldowns: Object.fromEntries(state.modelCooldowns),
      };
    }
    this.cooldownSnapshot = snapshot;
    try {
      writeJsonAtomic(paths.cooldowns(), snapshot);
      writeJsonAtomic(paths.accounts(), this.stateSnapshot());
    } catch {
      /* persistence must never fail a request */
    }
  }

  /** The non-derivable part of each account's state. */
  stateSnapshot() {
    const snapshot = {};
    for (const state of this.accounts.values()) {
      snapshot[state.id] = {
        credits: state.credits,
        creditsAt: state.creditsAt,
        requests: state.requests,
        successes: state.successes,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        lastUsedAt: state.lastUsedAt,
      };
    }
    return snapshot;
  }

  /** Apply the config row's pool knobs. */
  applyConfig(config = {}) {
    const next = { ...this.options };
    for (const key of Object.keys(POOL_DEFAULTS)) {
      if (config[key] !== undefined) next[key] = config[key];
    }
    this.options = next;
    this.disabled = new Set(Array.isArray(config.disabledAccountIds) ? config.disabledAccountIds : []);
    this.creditReserves = typeof config.creditReserves === "object" && config.creditReserves !== null ? config.creditReserves : {};
    for (const state of this.accounts.values()) state.disabled = this.disabled.has(state.id);
  }

  /**
   * Re-read credentials from disk. Returns the account list and the ids that are
   * new to the pool, so the caller can run the automation for those only.
   */
  scan() {
    let discovered;
    try {
      discovered = this.scanner();
    } catch (error) {
      this.lastScanWarnings = [`scan failed: ${error instanceof Error ? error.message : String(error)}`];
      return { accounts: [...this.accounts.values()], newIds: [], warnings: this.lastScanWarnings };
    }
    const { credentials, warnings } = discovered;
    const newIds = [];
    const seen = new Set();
    for (const [id, credential] of credentials) {
      seen.add(id);
      const existing = this.accounts.get(id);
      if (existing === undefined) {
        const state = new AccountState(credential);
        state.disabled = this.disabled.has(id);
        this.hydrate(state);
        this.accounts.set(id, state);
        newIds.push(id);
      } else {
        // Keep the state, take the fresher token material and identity.
        existing.credential = credential;
        existing.region = regionOfCredential(credential);
      }
    }
    for (const id of [...this.accounts.keys()]) {
      if (!seen.has(id)) this.accounts.delete(id);
    }
    this.lastScanNewIds = newIds;
    this.lastScanAt = Date.now();
    this.lastScanWarnings = warnings ?? [];
    return { accounts: [...this.accounts.values()], newIds, warnings: this.lastScanWarnings };
  }

  /** Accounts that belong to one region. */
  accountsOf(region) {
    return [...this.accounts.values()].filter((state) => state.region === region);
  }

  /** Whether one account can serve a request right now (ignoring the model). */
  usable(state, now = Date.now()) {
    if (state.disabled) return false;
    if (state.breakerUntil > now) return false;
    if (state.cooldownUntil > now) return false;
    if (this.options.minUsableCredits > 0 && state.credits !== undefined && state.credits < this.options.minUsableCredits) return false;
    const reserve = this.creditReserves[state.id] ?? 0;
    if (reserve > 0 && state.credits !== undefined && state.credits <= reserve) return false;
    return true;
  }

  /** Whether a specific model is cooling down for one account. */
  modelCooling(state, model, now = Date.now()) {
    const until = state.modelCooldowns.get(model);
    if (until === undefined) return false;
    if (until <= now) {
      state.modelCooldowns.delete(model);
      return false;
    }
    return true;
  }

  /**
   * Ordered candidate accounts for one request.
   *
   * The session's sticky binding is tried first so prompt caching survives a
   * conversation; the rest are ordered by the configured distribution, with
   * accounts already at their lease limit moved to the back rather than dropped.
   */
  candidates({ region, model, sessionKey }) {
    const now = Date.now();
    const all = this.accountsOf(region).filter(
      (state) => this.usable(state, now) && !this.modelCooling(state, model, now),
    );
    const stickyId = sessionKey === undefined ? undefined : this.sticky.get(sessionKey);
    const sticky = all.find((state) => state.id === stickyId);
    let rest = all.filter((state) => state.id !== stickyId);
    const byIdle = (a, b) => a.lastUsedAt - b.lastUsedAt;
    if (this.options.distribution === "priority") {
      rest.sort(byIdle);
    } else if (this.options.distribution === "round-robin") {
      const cursorKey = `${region}\0${model}`;
      const cursor = roundRobinCursor.get(cursorKey) ?? 0;
      rest.sort((a, b) => a.id.localeCompare(b.id));
      const offset = rest.length === 0 ? 0 : cursor % rest.length;
      rest = [...rest.slice(offset), ...rest.slice(0, offset)];
      roundRobinCursor.set(cursorKey, cursor + 1);
    } else {
      // balanced: idle-seeded random top-five, then the rest by idleness.
      const ordered = rest.sort(byIdle);
      const head = ordered.slice(0, Math.min(5, ordered.length));
      for (let index = head.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        [head[index], head[swap]] = [head[swap], head[index]];
      }
      rest = [...head, ...ordered.slice(head.length)];
    }
    const ordered = [...(sticky === undefined ? [] : [sticky]), ...rest];
    // Accounts at their lease limit yield to fresh ones.
    const free = ordered.filter((state) => state.leases < this.options.leaseLimit);
    const busy = ordered.filter((state) => state.leases >= this.options.leaseLimit);
    return [...free, ...busy];
  }

  /** Charge one failure to an account (cooldown, model cooldown, or breaker). */
  chargeFailure(state, result, model) {
    const now = Date.now();
    const kind = result.kind;
    state.lastError = { at: now, kind, status: result.status, message: String(result.message ?? "").slice(0, 400) };
    state.lastResult = "error";
    if (!ACCOUNT_FAULTS.has(kind)) {
      // A request-side answer says nothing about the account's health.
      if (kind === "client") state.failures += 1;
      return;
    }
    if (kind === "soft_rate") {
      const resetAt = typeof result.retryAfterMs === "number" && result.retryAfterMs > now ? result.retryAfterMs : undefined;
      const until = Math.min(Math.max(resetAt ?? now + this.options.cooldownMs, now + 1), now + this.options.cooldownMaxMs);
      state.cooldownUntil = Math.max(state.cooldownUntil, until);
      state.cooldownReason = "rate-limit";
      // A per-model limit only closes that model; the account stays usable.
      if (typeof model === "string" && model !== "") {
        state.modelCooldowns.set(model, Math.max(state.modelCooldowns.get(model) ?? 0, until));
      }
      state.consecutiveRejections = 0;
    } else if (kind === "server") {
      state.cooldownUntil = Math.max(state.cooldownUntil, now + this.options.serverCooldownMs);
      state.cooldownReason = "gateway-error";
    } else if (kind === "hard_credit") {
      state.credits = 0;
      state.creditsAt = now;
      state.cooldownUntil = Math.max(state.cooldownUntil, now + this.options.hardCreditCooldownMs);
      state.cooldownReason = "credits-exhausted";
    } else if (kind === "account_restricted") {
      state.cooldownUntil = Math.max(state.cooldownUntil, now + this.options.breakerMs);
      state.cooldownReason = "account-restricted";
    } else if (kind === "session_dead") {
      state.consecutiveRejections += 1;
      if (state.consecutiveRejections >= this.options.breakerThreshold) {
        state.breakerUntil = Math.max(state.breakerUntil, now + this.options.breakerMs);
        state.consecutiveRejections = 0;
      }
      state.cooldownUntil = Math.max(state.cooldownUntil, now + this.options.cooldownMs);
      state.cooldownReason = "needs-sign-in";
    }
    this.scheduleCooldownSave();
  }

  /** Note one successful call: counters, sticky binding, cooldown clearing. */
  chargeSuccess(state, { model, sessionKey, inputTokens, outputTokens }) {
    const now = Date.now();
    state.lastUsedAt = now;
    state.lastResult = "ok";
    state.requests += 1;
    state.successes += 1;
    state.failures = 0;
    state.consecutiveRejections = 0;
    state.cooldownUntil = 0;
    state.cooldownReason = undefined;
    if (typeof inputTokens === "number") state.tokensIn += inputTokens;
    if (typeof outputTokens === "number") state.tokensOut += outputTokens;
    if (sessionKey !== undefined) this.sticky.set(sessionKey, state.id);
    // Keep the sticky table small; a session key only matters while it is recent.
    if (this.sticky.size > 500) {
      const [oldest] = this.sticky.keys();
      this.sticky.delete(oldest);
    }
    this.scheduleCooldownSave();
  }

  /** Try to refresh one account's access token in place. */
  async refreshCredential(state) {
    if (typeof state.credential.refreshToken !== "string" || state.credential.refreshToken === "") return false;
    try {
      const outcome = await this.client.refreshToken(state.credential);
      const updated = {
        ...state.credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        ...(outcome.domain === undefined ? {} : { domain: outcome.domain }),
        ...(outcome.expiresInSec === undefined ? {} : { expiresAtMs: Date.now() + outcome.expiresInSec * 1000 }),
        lastRefreshAtMs: Date.now(),
      };
      state.credential = updated;
      state.breakerUntil = 0;
      state.consecutiveRejections = 0;
      state.cooldownUntil = 0;
      // Persist the refreshed copy where the next scan will find it; the
      // original desktop file is never rewritten.
      try {
        persistCredentialDocument({
          auth: {
            accessToken: updated.accessToken,
            ...(updated.refreshToken === undefined ? {} : { refreshToken: updated.refreshToken }),
            domain: updated.domain,
            ...(updated.expiresAtMs === undefined ? {} : { expiresAt: Math.round(updated.expiresAtMs / 1000) }),
            lastRefreshTime: Math.round(Date.now() / 1000),
          },
          account: {
            ...(updated.nickname === undefined ? {} : { nickname: updated.nickname }),
            ...(updated.uin === undefined ? {} : { uin: updated.uin }),
            ...(updated.uid === undefined ? {} : { uid: updated.uid }),
            ...(updated.enterpriseId === undefined ? {} : { enterpriseId: updated.enterpriseId }),
          },
        });
      } catch {
        /* a read-only profile keeps the in-memory token */
      }
      return true;
    } catch (error) {
      state.lastError = {
        at: Date.now(),
        kind: "refresh-failed",
        message: error instanceof Error ? error.message : String(error),
      };
      return false;
    }
  }

  /**
   * Read one account's credits.
   * Errors are stored on the account instead of thrown: a failed balance read
   * must not fail a model call or a status poll.
   */
  async refreshCredits(state) {
    const now = Date.now();
    if (state.creditsAt !== 0 && now - state.creditsAt < this.options.creditsTtlMs) return state.credits;
    try {
      const credits = await this.client.fetchCredits(state.credential);
      state.credits = credits.total;
      state.creditsAt = Date.now();
      state.creditsError = undefined;
      this.scheduleCooldownSave();
      return credits.total;
    } catch (error) {
      state.creditsError = error instanceof Error ? error.message : String(error);
      return state.credits;
    }
  }

  /** Refresh every account's balance, a few at a time. */
  async refreshAllCredits(limit = 4) {
    const states = [...this.accounts.values()];
    const queue = [...states];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (;;) {
        const state = queue.shift();
        if (state === undefined) return;
        await this.refreshCredits(state);
      }
    });
    await Promise.all(workers);
  }

  /**
   * Run one chat request across the pool.
   *
   * Resolves with the upstream `Response` and the account that served it; the
   * caller must call `release()` once the body has been consumed so the lease
   * is returned. Throws a {@link PoolError} when every candidate failed or the
   * failure belonged to the request.
   *
   * `conversationId` is forwarded to the upstream client, which keeps the
   * official trace chain (conversation id / b3 trace id) stable across turns.
   */
  async chat({ region, model, sessionKey, body, signal, onAttempt, conversationId }) {
    const started = Date.now();
    const tried = new Set();
    const rejected = [];
    let lastFailure;
    for (let attempt = 0; attempt < this.options.maxAttempts; attempt += 1) {
      const candidate = this.candidates({ region, model, sessionKey }).find((state) => !tried.has(state.id));
      if (candidate === undefined) break;
      tried.add(candidate.id);
      onAttempt?.(candidate);
      const queueMs = Date.now() - started;
      candidate.leases += 1;
      const attemptStarted = Date.now();
      let result;
      try {
        result = await this.client.chatStream(candidate.credential, body, { signal, model, conversationId });
      } catch (error) {
        result = { ok: false, kind: "transport", status: 0, message: String(error) };
      }
      if (result.ok) {
        // Accounting for a success happens once the caller knows the token
        // usage, so this only hands the response back with its lease.
        return {
          response: result.response,
          account: candidate,
          attempts: attempt + 1,
          queueMs,
          release: () => {
            candidate.leases = Math.max(0, candidate.leases - 1);
          },
        };
      }
      candidate.leases = Math.max(0, candidate.leases - 1);
      lastFailure = result;
      this.chargeFailure(candidate, result, model);
      // A session bound to the account that just failed is re-bound on the
      // next pass instead of being retried against a cooling account.
      if (sessionKey !== undefined && this.sticky.get(sessionKey) === candidate.id) this.sticky.delete(sessionKey);
      rejected.push({ account: candidate.id, kind: result.kind, status: result.status });
      this.record({
        at: attemptStarted,
        region,
        model,
        account: candidate.id,
        label: labelOf(candidate.credential),
        ok: false,
        status: result.status,
        kind: result.kind,
        attempts: attempt + 1,
        queueMs,
        totalMs: Date.now() - attemptStarted,
        error: String(result.message ?? "").slice(0, 300),
      });
      // A dead credential with a refresh token is worth one renewal before the
      // account is retired.
      if (result.kind === "session_dead") {
        const refreshed = await this.refreshCredential(candidate);
        if (refreshed) {
          candidate.cooldownUntil = 0;
          candidate.breakerUntil = 0;
          // Give the renewed account one more shot in this same request.
          tried.delete(candidate.id);
        }
      }
      if (TERMINAL_KINDS.has(result.kind)) break;
      if (attempt === 0 && result.kind === "client" && rejected.length === 1) {
        // A plain client error is not account-specific either.
        break;
      }
    }
    if (lastFailure === undefined) {
      const reason = this.emptyReason(region);
      throw new PoolError(reason.message, {
        reason: reason.reason,
        status: reason.status,
        attempts: tried.size,
      });
    }
    throw new PoolError(`all accounts failed: ${String(lastFailure.message ?? "").slice(0, 300)}`, {
      reason: reasonFor(lastFailure.kind),
      status: statusFor(lastFailure.kind),
      kind: lastFailure.kind,
      attempts: tried.size,
    });
  }

  /** Record a completed success (token usage known) and update the account. */
  finishSuccess({ account, model, sessionKey, inputTokens, outputTokens, queueMs, totalMs, firstByteMs }) {
    this.chargeSuccess(account, { model, sessionKey, inputTokens, outputTokens });
    this.record({
      at: Date.now() - (totalMs ?? 0),
      region: account.region,
      model,
      account: account.id,
      label: labelOf(account.credential),
      ok: true,
      status: 200,
      queueMs: queueMs ?? 0,
      totalMs: totalMs ?? 0,
      firstByteMs,
      inputTokens,
      outputTokens,
    });
  }

  /** Record a failure that happened after the pool returned a response. */
  failStream(account, { model, error }) {
    const message = error instanceof Error ? error.message : String(error);
    this.chargeFailure(account, { kind: "server", status: 502, message }, model);
    this.record({
      at: Date.now(),
      region: account.region,
      model,
      account: account.id,
      label: labelOf(account.credential),
      ok: false,
      status: 502,
      kind: "stream",
      queueMs: 0,
      totalMs: 0,
      error: message.slice(0, 300),
    });
  }

  /** Why no account could serve a request, in words the user can act on. */
  emptyReason(region) {
    const accounts = this.accountsOf(region);
    if (accounts.length === 0) {
      return {
        reason: "no-accounts",
        status: 401,
        message:
          region === "global"
            ? "no WorkBuddy (international) account is available; import one or use the QR sign-in in the settings card"
            : "no WorkBuddy account is available; import one or use the QR sign-in in the settings card",
      };
    }
    const now = Date.now();
    if (accounts.every((state) => state.disabled)) {
      return { reason: "all-disabled", status: 403, message: "every WorkBuddy account is disabled in the pool settings" };
    }
    if (accounts.every((state) => state.breakerUntil > now)) {
      return { reason: "needs-sign-in", status: 401, message: "every WorkBuddy account needs to sign in again" };
    }
    if (accounts.every((state) => state.credits !== undefined && state.credits < this.options.minUsableCredits)) {
      return { reason: "credits-exhausted", status: 402, message: "every WorkBuddy account is below the usable credit floor" };
    }
    return { reason: "rate-limited", status: 429, message: "every WorkBuddy account is rate-limited or cooling down; retry later" };
  }

  /** Reset every cooldown and breaker, as the card's one-click action asks. */
  resetCooldowns() {
    for (const state of this.accounts.values()) {
      state.cooldownUntil = 0;
      state.cooldownReason = undefined;
      state.breakerUntil = 0;
      state.consecutiveRejections = 0;
      state.modelCooldowns.clear();
    }
    this.sticky.clear();
    this.cooldownSnapshot = {};
    void this.saveCooldowns(() => this.writeCooldowns());
  }

  /** Append one request record, fold it into the ledgers, and persist it. */
  record(record) {
    ringPush(this.records, record, this.options.recordLimit);
    this.fold(record);
    appendJsonl(paths.requests(), record);
  }

  /** Usage rollup for one region (today / 7 days / month). */
  usageStatus(region) {
    const key = region === "global" ? "global" : "cn";
    const today = new Date();
    const dayKeys = [];
    for (let offset = 0; offset < 30; offset += 1) {
      const date = new Date(today);
      date.setDate(date.getDate() - offset);
      dayKeys.push(dayKey(date));
    }
    const sum = (keys) =>
      keys.reduce(
        (total, day) => {
          const row = this.usage.days[day]?.[key];
          return {
            requests: total.requests + (row?.requests ?? 0),
            input: total.input + (row?.input ?? 0),
            output: total.output + (row?.output ?? 0),
          };
        },
        { requests: 0, input: 0, output: 0 },
      );
    return {
      day: dayKey(today),
      today: sum([dayKey(today)]),
      last7: sum(dayKeys.slice(0, 7)),
      month: sum(dayKeys),
    };
  }

  /** Everything the settings card needs for one region. */
  status(region) {
    const now = Date.now();
    const accounts = this.accountsOf(region);
    const options = {
      minUsableCredits: this.options.minUsableCredits,
      creditReserves: this.creditReserves,
    };
    const rows = accounts.map((state) => state.status(now, options));
    const available = accounts.filter((state) => this.usable(state, now)).length;
    return {
      region,
      accounts: rows,
      total: accounts.length,
      available,
      limits: {
        maxAttempts: this.options.maxAttempts,
        cooldownMs: this.options.cooldownMs,
        serverCooldownMs: this.options.serverCooldownMs,
        hardCreditCooldownMs: this.options.hardCreditCooldownMs,
        breakerThreshold: this.options.breakerThreshold,
        breakerMs: this.options.breakerMs,
        leaseLimit: this.options.leaseLimit,
        minUsableCredits: this.options.minUsableCredits,
        distribution: this.options.distribution,
      },
      // Every number here belongs to this region only: usage, request log and
      // per-model samples are all filtered, so the CN and global cards differ.
      usage: this.usageStatus(region),
      requests: this.records
        .filter((record) => (record.region === "global" ? "global" : "cn") === region)
        .slice(-100)
        .reverse()
        .map((record) => ({ ...record })),
      stats: [...this.modelStats.entries()]
        .filter(([key]) => key.startsWith(`${region}\u0000`))
        .map(([key, stats]) => stats.status(key.slice(region.length + 1))),
      lastScanAt: this.lastScanAt || null,
      warnings: this.lastScanWarnings,
      stickySessions: this.sticky.size,
    };
  }

  /** Stop pending timers (used when the plugin unloads). */
  dispose() {
    this.stopped = true;
    if (this.cooldownTimer !== undefined) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
  }
}

/** Map an upstream failure kind to a pool reason string. */
function reasonFor(kind) {
  if (kind === "soft_rate") return "rate-limited";
  if (kind === "hard_credit") return "credits-exhausted";
  if (kind === "session_dead" || kind === "account_restricted") return "needs-sign-in";
  if (kind === "request_fault") return "request-invalid";
  if (kind === "model_blocked") return "model-unavailable";
  if (kind === "transport") return "upstream-unreachable";
  return "upstream";
}

/** Map an upstream failure kind to the HTTP status the shim answers. */
function statusFor(kind) {
  if (kind === "soft_rate") return 429;
  if (kind === "hard_credit") return 402;
  if (kind === "session_dead" || kind === "account_restricted") return 401;
  if (kind === "request_fault") return 400;
  if (kind === "model_blocked") return 404;
  if (kind === "transport") return 502;
  if (kind === "server") return 502;
  return 400;
}
