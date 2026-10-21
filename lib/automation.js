/**
 * Daily points automation: check-in, activity report, task rewards, streak
 * redemption and the buddy travel loop — plus the scheduler that decides when
 * each pass runs.
 *
 * Every job is idempotent upstream (an already-claimed task answers
 * `already_claimed`, a repeated check-in answers "已签到"), so a pass that dies
 * halfway is safe to replay. The scheduler never lets a failing job stop the
 * others and never throws into the plugin.
 *
 * @module dsh-workbuddy-pool/automation
 */

import { randomUUID } from "node:crypto";

import { campaignDeadlineIso, campaignOpen } from "./campaign.js";
import { billingBase, billingHeaders, chatBase, chatHeaders } from "./credentials.js";
import { EnvelopeError, isAlreadyCheckin, readEnvelope } from "./upstream.js";
import { paths, readJsonQuietly, writeJsonAtomic } from "./store.js";
import { dayKey, sleep } from "./util.js";

/** Job kinds the scheduler knows. */
export const JOB_KINDS = ["checkin", "report", "tasks", "streak", "travel", "compensation"];
/** Default local hours per job, matching the reference plugin's schedule. */
export const DEFAULT_JOB_HOURS = {
  checkin: [9],
  report: [10],
  tasks: [11],
  streak: [12],
  travel: [9, 21],
  // Late morning on purpose: the offer only turns `active` once the outage
  // bookkeeping settles, so an early pass finds nothing to claim.
  compensation: [10],
};
/** User-facing labels. */
export const JOB_LABELS = {
  checkin: "每日签到",
  report: "活跃上报",
  tasks: "任务奖励",
  streak: "连登奖励",
  travel: "猫猫旅行",
  compensation: "服务异常补偿",
};

/* ------------------------------------------------------------------ *
 * Upstream automation calls
 * ------------------------------------------------------------------ */

/** POST one billing endpoint with an empty JSON object body. */
async function billingPost(client, credential, path, body = {}) {
  const response = await client.fetchImpl(`${billingBase(credential)}${path}`, {
    method: "POST",
    headers: billingHeaders(credential),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) throw new EnvelopeError(envelope.msg, { status: envelope.status, code: envelope.code, body: envelope.msg });
  return envelope.data;
}

/** GET/POST one growth endpoint (chat host, billing header set, no `/v2`). */
async function growthJson(client, credential, method, path, body) {
  const response = await client.fetchImpl(`${chatBase(credential)}${path}`, {
    method,
    headers: billingHeaders(credential),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) throw new EnvelopeError(envelope.msg, { status: envelope.status, code: envelope.code, body: envelope.msg });
  return envelope.data;
}

const asRecord = (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {});
const numOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Read the daily check-in state. */
export async function checkinStatus(client, credential) {
  const data = await billingPost(client, credential, "/v2/billing/meter/checkin-activity-status");
  return {
    active: data["active"] === true,
    todayCheckedIn: data["today_checked_in"] === true,
    streakDays: numOf(data["streak_days"]),
    dailyCredit: numOf(data["daily_credit"]),
    todayCredit: numOf(data["today_credit"]),
    isStreakDay: data["is_streak_day"] === true,
    claimButtonText: typeof data["claim_button_text"] === "string" ? data["claim_button_text"] : "",
  };
}

/** Claim today's check-in. An "already checked in" answer counts as success. */
export async function claimCheckin(client, credential) {
  try {
    const data = await billingPost(client, credential, "/v2/billing/meter/daily-checkin");
    return { credit: numOf(data["credit"]), streakDays: numOf(data["streak_days"]), already: false };
  } catch (error) {
    if (error instanceof EnvelopeError && isAlreadyCheckin(error.body ?? error.message)) {
      return { credit: 0, already: true };
    }
    throw error;
  }
}

/** Report one chat activity event (the CLI/billing fingerprint family). */
export async function reportActivity(client, credential) {
  const conversationId = `wb2pool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const event = {
    eventCode: "chat_request_send",
    timestamp: now,
    reportDelay: 0,
    mode: "craft",
    conversationId,
    requestId: conversationId,
    inputLength: 12,
    requestModelId: "deepseek-v4.1-flash",
    requestModelName: "DeepSeek V4.1 Flash",
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: "",
    mentionContextCount: 0,
    command: "",
    expertId: "",
    recommendId: "",
    skillId: "",
    skillCount: 0,
    totalCount: 0,
    fileUri: "",
    presentAt: now,
    traceId: "",
    rootRequestId: conversationId,
    parentConversationId: conversationId,
    agentName: "default",
    agentType: "conversation",
    userId: credential.uid ?? "",
  };
  await billingPost(client, credential, "/v2/report", [event]);
  return { conversationId };
}

/** The growth streak in days (the read-back oracle for the activity report). */
export async function growthStreakDays(client, credential) {
  const data = await growthJson(client, credential, "GET", "/activity/growth/streak");
  return numOf(asRecord(data["streak"])["days"]);
}

/** The full streak picture: days, next tier, makeup cards, tier table. */
export async function growthStreakFull(client, credential) {
  const data = await growthJson(client, credential, "GET", "/activity/growth/streak");
  const streak = asRecord(data["streak"]);
  const redemption = asRecord(data["redemption_status"]);
  const cards = asRecord(data["makeup_cards"]);
  const tiers = [];
  if (Array.isArray(redemption["tiers"])) {
    for (const entry of redemption["tiers"]) {
      const tier = asRecord(entry);
      const name = typeof tier["tier"] === "string" ? tier["tier"] : "";
      if (name === "") continue;
      tiers.push({
        tier: name,
        days: numOf(tier["days"]),
        credit: numOf(tier["credit"]),
        energy: numOf(tier["energy"]),
        cards: numOf(tier["cards"]),
        chances: numOf(tier["chances"]),
        status: String(redemption[`tier_${name}_status`] ?? ""),
      });
    }
  }
  return {
    days: numOf(streak["days"]),
    monthTotalDays: numOf(streak["month_total_days"]),
    nextTier: typeof streak["next_tier"] === "string" ? streak["next_tier"] : "",
    nextTierRemaining: numOf(streak["next_tier_remaining"]),
    makeupCards: numOf(cards["balance"]),
    tiers,
  };
}

/** Redeem one unlocked streak tier. */
export async function redeemStreakTier(client, credential, tier) {
  await growthJson(client, credential, "POST", "/activity/growth/redeem", { tier, client_token: randomUUID() });
}

/** How many lottery draws are available. */
export async function lotteryChances(client, credential) {
  return numOf(asRecord(await growthJson(client, credential, "GET", "/activity/growth/lottery/summary"))["chances"]);
}

/** Draw the lottery once. */
export async function lotteryDraw(client, credential) {
  return growthJson(client, credential, "POST", "/activity/growth/lottery/draw", { client_token: randomUUID() });
}

/** Parse one growth task row; `claimable` is derived locally. */
function parseTask(entry) {
  const task = asRecord(entry);
  const taskCode = typeof task["task_code"] === "string" ? task["task_code"] : "";
  if (taskCode === "") return undefined;
  const progress = asRecord(task["progress"]);
  const current = Object.keys(progress).length > 0 ? numOf(progress["current"]) : numOf(task["current"]);
  const target = Object.keys(progress).length > 0 ? numOf(progress["target"]) : numOf(task["target"]);
  const acceptStatus = String(task["accept_status"] ?? "");
  const claimed = acceptStatus === "claimed";
  return {
    taskCode,
    title: typeof task["title"] === "string" ? task["title"] : taskCode,
    rewardCredit: numOf(task["reward_credit"]),
    rewardEnergy: numOf(task["reward_energy"]),
    hasReward: task["has_reward"] === true,
    current,
    target,
    acceptStatus,
    locked: task["locked"] === true,
    claimable: !claimed && target > 0 && current >= target,
  };
}

/** List the growth tasks of one account. */
export async function listTasks(client, credential) {
  const response = await client.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks`, {
    headers: chatHeaders(credential),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) throw new EnvelopeError(envelope.msg, { status: envelope.status, body: envelope.msg });
  const raw = Array.isArray(envelope.data["tasks"]) ? envelope.data["tasks"] : [];
  return raw.map(parseTask).filter((task) => task !== undefined);
}

/** Enrol in tasks by code. */
export async function acceptTasks(client, credential, taskCodes) {
  if (taskCodes.length === 0) return;
  const response = await client.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks/accept`, {
    method: "POST",
    headers: chatHeaders(credential),
    body: JSON.stringify({ task_codes: [...taskCodes] }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) throw new EnvelopeError(envelope.msg, { status: envelope.status, body: envelope.msg });
}

/** Claim one task reward. A repeat claim answers `already_claimed`. */
export async function claimTaskReward(client, credential, taskCode) {
  const headers = {
    ...billingHeaders(credential),
    Accept: "application/json, text/plain, */*",
    Origin: "https://www.workbuddy.cn",
    Referer: "https://www.workbuddy.cn/profile/growth-center",
    "x-client-platform": "web",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  };
  const response = await client.fetchImpl(`https://www.workbuddy.cn/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await readEnvelope(response);
  if (!response.ok || envelope.code !== 0) throw new EnvelopeError(envelope.msg, { status: envelope.status, body: envelope.msg });
  const data = asRecord(envelope.data);
  if (data["already_claimed"] === true) return { credit: 0, energy: 0 };
  return { credit: numOf(data["credit"]), energy: numOf(data["energy"]) };
}

/** The buddy profile, or undefined when the account has not adopted one yet. */
export async function buddyInfo(client, credential) {
  const buddy = asRecord(asRecord(await growthJson(client, credential, "GET", "/activity/growth/buddy/info"))["buddy"]);
  if (Object.keys(buddy).length === 0) return undefined;
  return { instanceId: numOf(buddy["instance_id"]), name: String(buddy["name"] ?? "") };
}

/** Agree to the buddy terms (idempotent upstream). */
export async function buddyAgree(client, credential) {
  await growthJson(client, credential, "POST", "/activity/growth/buddy/agreement", { agree: true });
}

/** Adopt the first buddy (gated on today's activity). */
export async function buddyAdoptFirst(client, credential) {
  await growthJson(client, credential, "POST", "/activity/growth/buddy/first", {});
}

/** Current travel state. */
export async function buddyTravelStatus(client, credential) {
  const data = await growthJson(client, credential, "GET", "/activity/growth/buddy/travel/status");
  return {
    state: typeof data["state"] === "string" ? data["state"] : "",
    recordId: numOf(data["record_id"]),
    dailyLimitReached: data["daily_limit_reached"] === true,
    rewardCredit: numOf(data["reward_credit"]),
  };
}

/** Send the buddy travelling (location 4 = 古镇客栈). */
export async function buddyTravelDepart(client, credential, locationId = 4) {
  await growthJson(client, credential, "POST", "/activity/growth/buddy/travel/depart", { location_id: locationId });
}

/** Collect an arrived trip's reward. */
export async function buddyTravelClaim(client, credential, recordId) {
  return numOf(asRecord(await growthJson(client, credential, "POST", "/activity/growth/buddy/travel/claim", { record_id: recordId }))["reward_credit"]);
}

/**
 * Gift / compensation campaign status and claim.
 *
 * The compensation pair is the one-off "DeepSeek 模型服务异常额外补偿" offer
 * (500 credits). Its routes sit at `/billing/meter/*` — WITHOUT the `/v2`
 * prefix the check-in family uses — and only answer POST; the reference proxy
 * documented both facts against the live gateway, so they are load-bearing here
 * too.
 */
export async function giftStatus(client, credential) {
  const data = await billingPost(client, credential, "/billing/meter/check-gift-claimed");
  return { claimed: data["claimed"] === true, active: data["active"] === true, credit: numOf(data["credit_num"]) };
}
export async function claimGift(client, credential) {
  const data = await billingPost(client, credential, "/billing/meter/claim-gift");
  return { credit: numOf(data["credit_num"]) || numOf(data["credit"]), claimed: data["claimed"] === true };
}
/** Read the compensation offer: whether it is open, already claimed, and how big. */
export async function compensationStatus(client, credential) {
  const data = await billingPost(client, credential, "/billing/meter/compensation-status");
  const endTime = typeof data["end_time"] === "string" ? data["end_time"] : undefined;
  return {
    claimed: data["claimed"] === true,
    active: data["active"] === true,
    credit: numOf(data["credit_num"]),
    ...(endTime === undefined || endTime === "" ? {} : { endTime }),
    ...(typeof data["claimed_at"] === "string" && data["claimed_at"] !== "" ? { claimedAt: data["claimed_at"] } : {}),
  };
}
/** Claim the compensation offer, then re-read the status as the authority. */
export async function claimCompensation(client, credential) {
  const data = await billingPost(client, credential, "/billing/meter/claim-compensation");
  return { credit: numOf(data["credit_num"]) || numOf(data["credit"]), claimed: data["claimed"] === true };
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

/**
 * Job runner: one account in, one small outcome out.
 *
 * `now` is passed in rather than read from the global clock so the campaign
 * window is evaluated against the scheduler's own clock (tests pin it, and a
 * long-lived process keeps one consistent notion of "now").
 */
async function runJob(kind, client, credential, now = Date.now()) {
  if (kind === "checkin") {
    const status = await checkinStatus(client, credential);
    if (status.todayCheckedIn) return { status: "already", credit: 0, detail: `今日已签 ${status.streakDays} 天` };
    const claimed = await claimCheckin(client, credential);
    return { status: claimed.already ? "already" : "ok", credit: claimed.credit, detail: claimed.credit > 0 ? `+${claimed.credit}` : "已签" };
  }
  if (kind === "report") {
    await reportActivity(client, credential);
    const days = await growthStreakDays(client, credential).catch(() => undefined);
    return { status: "ok", credit: 0, detail: days === undefined ? "已上报" : `已上报 · 连登 ${days} 天` };
  }
  if (kind === "tasks") {
    const tasks = await listTasks(client, credential);
    const open = tasks.filter((task) => task.acceptStatus === "not_accepted" && !task.locked).map((task) => task.taskCode);
    if (open.length > 0) await acceptTasks(client, credential, open);
    const claimable = (await listTasks(client, credential)).filter((task) => task.claimable && !task.locked);
    let credit = 0;
    let claimed = 0;
    for (const task of claimable) {
      const reward = await claimTaskReward(client, credential, task.taskCode);
      credit += reward.credit;
      if (reward.credit > 0 || reward.energy > 0) claimed += 1;
      await sleep(300);
    }
    return { status: "ok", credit, detail: `报名 ${open.length} · 领取 ${claimed}` };
  }
  if (kind === "streak") {
    const status = await growthStreakFull(client, credential);
    let credit = 0;
    let redeemed = 0;
    for (const tier of status.tiers) {
      if (tier.status === "locked" || tier.status === "claimed") continue;
      try {
        await redeemStreakTier(client, credential, tier.tier);
        credit += tier.credit;
        redeemed += 1;
      } catch {
        /* a locked tier answers 403; the status read already told us which are open */
      }
      await sleep(300);
    }
    let draws = 0;
    try {
      const chances = await lotteryChances(client, credential);
      for (let draw = 0; draw < chances; draw += 1) {
        await lotteryDraw(client, credential);
        draws += 1;
        await sleep(300);
      }
    } catch {
      /* the lottery is a bonus, never a failure of the streak pass */
    }
    const pending = status.tiers.find((tier) => tier.status === "locked");
    const detail = pending === undefined ? `连登 ${status.days} 天 · 兑换 ${redeemed} · 抽奖 ${draws}` : `连登 ${status.days} 天 · ${pending.tier} 还差 ${Math.max(0, pending.days - status.days)} 天`;
    return { status: "ok", credit, detail };
  }
  if (kind === "travel") {
    if ((await buddyInfo(client, credential)) === undefined) {
      await buddyAgree(client, credential).catch(() => undefined);
      const adopted = await buddyAdoptFirst(client, credential).then(
        () => true,
        () => false,
      );
      return { status: adopted ? "ok" : "pending", credit: 0, detail: adopted ? "已领养伙伴" : "等待活跃任务解锁领养" };
    }
    const travel = await buddyTravelStatus(client, credential);
    if (travel.state === "arrived") {
      if (travel.recordId === 0) return { status: "warn", credit: 0, detail: "已到达但无 record_id" };
      const reward = await buddyTravelClaim(client, credential, travel.recordId);
      return { status: "ok", credit: reward, detail: `领取旅行 +${reward}` };
    }
    if (travel.state === "idle" && !travel.dailyLimitReached) {
      await buddyTravelDepart(client, credential);
      return { status: "ok", credit: 0, detail: "已出发，稍后领取" };
    }
    return { status: "idle", credit: 0, detail: travel.dailyLimitReached ? "今日已达上限" : "旅行中" };
  }
  if (kind === "compensation") {
    // One-off campaign: outside its window the correct behaviour is to do
    // nothing at all rather than to call an endpoint that can only refuse.
    if (!campaignOpen(now)) return { status: "skipped", credit: 0, detail: "活动已结束" };
    const status = await compensationStatus(client, credential);
    if (status.claimed) return { status: "already", credit: 0, detail: "已领取" };
    if (!status.active || status.credit <= 0) return { status: "idle", credit: 0, detail: "暂无可领补偿" };
    // The claim response is NOT trustworthy as a success signal: measured on the
    // live gateway it answers `claimed: false` for a claim that landed, and a
    // repeat answers `code 10001 每人限领一次`. So confirm by re-reading the
    // status, which is the only authority on "was it actually granted".
    try {
      await claimCompensation(client, credential);
    } catch (error) {
      // A refusal on the claim call can mean the account was already served
      // (the campaign is idempotent upstream); the status read below decides.
      const message = error instanceof Error ? error.message : String(error);
      if (!/已领取|已领|限领一次|already/i.test(message)) throw error;
    }
    const after = await compensationStatus(client, credential);
    if (!after.claimed) return { status: "warn", credit: 0, detail: "上游未确认领取" };
    // The status read repeats the amount and is authoritative over the claim.
    const credit = after.credit > 0 ? after.credit : status.credit;
    return { status: "ok", credit, detail: `补偿 +${credit}` };
  }
  return { status: "skipped", credit: 0, detail: "unknown job" };
}

/**
 * The scheduler: arms the daily passes, records every outcome, and exposes the
 * ledger to the card. It never throws into the Host.
 */
export class WorkBuddyScheduler {
  constructor(options = {}) {
    this.pool = options.pool;
    this.client = options.client;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.options = {
      enabled: false,
      hours: { ...DEFAULT_JOB_HOURS },
      delayMs: 400,
      ...(options.options ?? {}),
    };
    this.timer = undefined;
    this.running = new Set();
    this.state = this.load();
    this.lastError = undefined;
  }

  load() {
    const saved = readJsonQuietly(paths.automation());
    const ledger = readJsonQuietly(paths.automationLedger());
    const day = dayKey(this.now());
    return {
      day: saved?.day === day ? day : day,
      runs: saved?.day === day && typeof saved.runs === "object" && saved.runs !== null ? saved.runs : {},
      earnings: typeof ledger === "object" && ledger !== null ? ledger : {},
    };
  }

  persist() {
    try {
      writeJsonAtomic(paths.automation(), { day: this.state.day, runs: this.state.runs });
      writeJsonAtomic(paths.automationLedger(), this.state.earnings);
    } catch {
      /* a read-only profile keeps the in-memory ledger */
    }
  }

  /** Roll the ledger over at local midnight. */
  rollDay() {
    const day = dayKey(this.now());
    if (this.state.day === day) return;
    this.state.day = day;
    this.state.runs = {};
    this.persist();
  }

  /** Apply the config row's automation block. */
  applyOptions(automation) {
    this.options = {
      ...this.options,
      ...(automation ?? {}),
      hours: { ...DEFAULT_JOB_HOURS, ...(automation?.hours ?? {}) },
    };
    if (this.options.enabled === true) this.start();
    else this.stop();
  }

  /** Start the tick timer and the catch-up pass. */
  start() {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref?.();
    // Catch-up: an hour that passed while the app was closed still runs, once.
    setTimeout(() => this.tick(), 5_000).unref?.();
  }

  /** Stop the tick timer. */
  stop() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run every job whose hour has arrived and that has not run today. */
  tick() {
    if (this.options.enabled !== true || this.pool.stopped) return;
    this.rollDay();
    const hour = this.now().getHours();
    for (const kind of JOB_KINDS) {
      if (this.running.has(kind)) continue;
      // A closed one-off campaign must not be armed again: the runner would
      // answer "skipped" every day and the ledger would keep a dead row alive.
      if (kind === "compensation" && !campaignOpen(this.now().getTime())) continue;
      const hours = Array.isArray(this.options.hours[kind]) ? this.options.hours[kind] : [];
      const due = hours.some((value) => hour >= value);
      if (!due || this.state.runs[kind] !== undefined) continue;
      void this.runJob(kind).catch((error) => {
        this.logger?.warn?.(`workbuddy-pool automation ${kind} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  /** Run one job for every account in the pool (or the given ids). */
  async runJob(kind, options = {}) {
    if (!JOB_KINDS.includes(kind)) throw new Error(`unknown automation job ${kind}`);
    if (this.running.has(kind)) return { kind, skipped: "running" };
    this.running.add(kind);
    const accounts = [...this.pool.accounts.values()].filter(
      (state) => !state.disabled && (options.accountIds === undefined || options.accountIds.has(state.id)),
    );
    const results = [];
    const queue = [...accounts];
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      for (;;) {
        const account = queue.shift();
        if (account === undefined) break;
        const startedAt = Date.now();
        try {
          const outcome = await runJob(kind, this.client, account.credential, this.now().getTime());
          results.push({ account: account.id, label: account.label, ok: outcome.status === "ok" || outcome.status === "already", ...outcome, ms: Date.now() - startedAt });
          if (outcome.credit > 0) this.recordEarnings(account.id, kind, outcome.credit);
        } catch (error) {
          results.push({ account: account.id, label: account.label, ok: false, status: "error", credit: 0, error: error instanceof Error ? error.message : String(error), ms: Date.now() - startedAt });
        }
        if (this.options.delayMs > 0) await sleep(this.options.delayMs);
      }
    });
    await Promise.all(workers);
    this.running.delete(kind);
    const credit = results.reduce((sum, result) => sum + (result.credit ?? 0), 0);
    const record = { at: Date.now(), credit, results };
    this.state.runs[kind] = { at: Date.now(), credit, ok: results.filter((result) => result.ok).length, total: results.length, results };
    this.persist();
    this.logger?.info?.(`workbuddy-pool automation ${kind}: ${results.length} account(s), +${credit}`);
    return { kind, credit, results, ...record };
  }

  /** Run every scheduled job once for newly discovered accounts. */
  runForNewAccounts(ids) {
    if (this.options.enabled !== true || ids.length === 0) return false;
    const set = new Set(ids);
    for (const kind of JOB_KINDS) {
      void this.runJob(kind, { accountIds: set }).catch(() => undefined);
    }
    return true;
  }

  /** Fold one reward into the persisted earnings ledger. */
  recordEarnings(accountId, kind, credit) {
    const day = dayKey(this.now());
    const ledger = this.state.earnings;
    ledger[day] ??= { total: 0, accounts: {} };
    ledger[day].total += credit;
    ledger[day].accounts[accountId] ??= {};
    ledger[day].accounts[accountId][kind] = (ledger[day].accounts[accountId][kind] ?? 0) + credit;
    this.persist();
  }

  /** The automation block of the card payload. */
  status() {
    const safeRuns = {};
    for (const kind of JOB_KINDS) {
      const run = this.state.runs[kind];
      safeRuns[kind] = run === undefined ? null : { at: run.at, credit: run.credit, ok: run.ok, total: run.total, results: run.results };
    }
    const dayKeys = [];
    const today = this.now();
    for (let offset = 0; offset < 30; offset += 1) {
      const date = new Date(today);
      date.setDate(date.getDate() - offset);
      dayKeys.push(dayKey(date));
    }
    const sum = (keys) => keys.reduce((total, day) => total + (this.state.earnings[day]?.total ?? 0), 0);
    // Today's ledger split by job kind, so the card can say WHERE the credits
    // came from even when the latest pass re-claimed nothing (idempotent tasks).
    const todayLedger = this.state.earnings[this.state.day] ?? { total: 0, accounts: {} };
    const earningsByKind = {};
    let rewardsToday = 0;
    for (const perAccount of Object.values(todayLedger.accounts ?? {})) {
      for (const [kind, credit] of Object.entries(perAccount ?? {})) {
        if (typeof credit !== "number" || credit <= 0) continue;
        earningsByKind[kind] = (earningsByKind[kind] ?? 0) + credit;
        rewardsToday += 1;
      }
    }
    return {
      enabled: this.options.enabled === true,
      hours: this.options.hours,
      labels: JOB_LABELS,
      day: this.state.day,
      runs: safeRuns,
      running: [...this.running],
      lastError: this.lastError ?? null,
      // Campaign bookkeeping: the card hides the one-off row once this flips.
      campaign: { open: campaignOpen(this.now().getTime()), deadline: campaignDeadlineIso() },
      earnings: { today: this.state.earnings[this.state.day]?.total ?? 0, last7: sum(dayKeys.slice(0, 7)), month: sum(dayKeys) },
      earningsByKind,
      rewardsToday,
    };
  }

  /** Stop the timer (plugin unload). */
  dispose() {
    this.stop();
  }
}
