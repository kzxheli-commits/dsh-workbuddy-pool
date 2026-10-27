/**
 * The settings card's HTTP surface, mounted on the host web server.
 *
 * Every route lives under `/plugins/dsh-workbuddy-pool/` and follows the same
 * rules as the shim: loopback origins only, and every state-changing route must
 * carry a JSON body (that content-type requirement is what a cross-site form
 * cannot satisfy, and this server never approves a CORS preflight).
 *
 * @module dsh-workbuddy-pool/routes
 */

import { paths, readJsonQuietly } from "./store.js";
import { JOB_KINDS } from "./automation.js";
import { MIN_ROTATE_HOURS, clampRotateHours, nextRotationAt, normalizeProfile, profileFacts, resetProfileValue, setProfileValue } from "./fingerprint-profile.js";
import { sanitizeRuleSummary } from "./sanitize.js";
import { pollSignIn, startSignIn } from "./oauth.js";
import { isSignInUrl, qrSvg } from "./qr.js";
import { json, loopbackOrigin, queryOf, readJsonBody, safeMessage, writeAllowed } from "./util.js";

/** Route prefix, one place so the card cannot drift. */
export const ROUTE_PREFIX = "/plugins/dsh-workbuddy-pool";

/** Every path this plugin serves. */
export const ROUTES = {
  status: `${ROUTE_PREFIX}/status`,
  rescan: `${ROUTE_PREFIX}/accounts/rescan`,
  importAccount: `${ROUTE_PREFIX}/accounts/import`,
  disableAccount: `${ROUTE_PREFIX}/accounts/disable`,
  reserveAccount: `${ROUTE_PREFIX}/accounts/credit-reserve`,
  removeAccount: `${ROUTE_PREFIX}/accounts/remove`,
  refreshCredits: `${ROUTE_PREFIX}/accounts/refresh-credits`,
  oauthStart: `${ROUTE_PREFIX}/oauth/start`,
  oauthPoll: `${ROUTE_PREFIX}/oauth/poll`,
  qr: `${ROUTE_PREFIX}/qr.svg`,
  resetCooldowns: `${ROUTE_PREFIX}/cooldowns/reset`,
  saveModels: `${ROUTE_PREFIX}/models/save`,
  refreshModels: `${ROUTE_PREFIX}/models/refresh`,
  automationRun: `${ROUTE_PREFIX}/automation/run`,
  automationConfig: `${ROUTE_PREFIX}/automation/config`,
  sanitizeConfig: `${ROUTE_PREFIX}/sanitize/config`,
  fingerprintConfig: `${ROUTE_PREFIX}/fingerprint/config`,
  fingerprintRotate: `${ROUTE_PREFIX}/fingerprint/rotate`,
  fingerprintSet: `${ROUTE_PREFIX}/fingerprint/set`,
  version: `${ROUTE_PREFIX}/version`,
};

/** Read a numeric field with a floor and default. */
function numberField(body, key, fallback, min = 0) {
  const value = body?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.round(value));
}

/**
 * Mount every route. `deps` is the live runtime assembled by `apply`.
 * Registration failures are reported to the caller, never swallowed.
 */
export function registerPoolRoutes(ctx, deps) {
  const mounted = ctx.effect(() => {
    const disposers = [];
    const route = (path, handler) => {
      disposers.push(ctx.webServer.register({ kind: "exact", path, handler }));
    };
    const guardRead = (req, res, handler) => {
      if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
      try {
        return handler();
      } catch (error) {
        return json(res, 500, { error: safeMessage(error) });
      }
    };
    const guardWrite = async (req, res, handler) => {
      if (!writeAllowed(req)) return json(res, 403, { error: "origin-not-trusted" });
      try {
        const body = await readJsonBody(req);
        return await handler(body);
      } catch (error) {
        return json(res, 400, { error: safeMessage(error) });
      }
    };

    route(ROUTES.status, (req, res) => {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      return guardRead(req, res, () => json(res, 200, deps.statusPayload(queryOf(req).get("region") === "global" ? "global" : "cn")));
    });

    route(ROUTES.rescan, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async () => {
        const scan = deps.rescan();
        deps.refreshCatalog().catch(() => undefined);
        deps.refreshCredits().catch(() => undefined);
        return json(res, 200, {
          accounts: scan.accounts.length,
          newIds: scan.newIds,
          warnings: scan.warnings,
          automationStarted: deps.scheduler.runForNewAccounts(scan.newIds),
        });
      });
    });

    route(ROUTES.importAccount, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, (body) => {
        const raw = typeof body?.["document"] === "string" ? body["document"] : "";
        if (raw.trim() === "") return json(res, 400, { error: "粘贴的内容是空的" });
        let document;
        try {
          document = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: "不是合法的 JSON（应当是一份 .info 文件的内容）" });
        }
        if (typeof document !== "object" || document === null || Array.isArray(document)) {
          return json(res, 400, { error: "顶层必须是一个对象" });
        }
        const normalized = document["auth"] === undefined && typeof document["accessToken"] === "string" ? { auth: document, account: {} } : document;
        let saved;
        try {
          saved = deps.importCredential(normalized);
        } catch (error) {
          return json(res, 400, { error: safeMessage(error) });
        }
        const scan = deps.rescan();
        return json(res, 200, {
          ok: true,
          label: saved.label,
          file: saved.name,
          accounts: scan.accounts.length,
          newIds: scan.newIds,
          automationStarted: deps.scheduler.runForNewAccounts(scan.newIds),
        });
      });
    });

    route(ROUTES.disableAccount, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const id = typeof body?.["id"] === "string" ? body["id"] : "";
        if (id === "") return json(res, 400, { error: "id is required" });
        const disabled = body?.["disabled"] !== false;
        const current = new Set(deps.state.get().disabledAccountIds);
        if (disabled) current.add(id);
        else current.delete(id);
        await deps.applyState({ disabledAccountIds: [...current] });
        return json(res, 200, { ok: true, disabled: [...current] });
      });
    });

    route(ROUTES.reserveAccount, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const id = typeof body?.["id"] === "string" ? body["id"] : "";
        if (id === "") return json(res, 400, { error: "id is required" });
        const reserve = numberField(body, "reserve", 0);
        const reserves = { ...deps.state.reserves() };
        if (reserve > 0) reserves[id] = reserve;
        else delete reserves[id];
        await deps.applyState({ creditReserves: reserves });
        return json(res, 200, { ok: true, reserves });
      });
    });

    route(ROUTES.removeAccount, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, (body) => {
        const id = typeof body?.["id"] === "string" ? body["id"] : "";
        if (id === "") return json(res, 400, { error: "id is required" });
        const removed = deps.removeCredential(id);
        const scan = deps.rescan();
        return json(res, 200, { ok: removed, accounts: scan.accounts.length });
      });
    });

    route(ROUTES.refreshCredits, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async () => {
        await deps.refreshCredits(true);
        return json(res, 200, { ok: true });
      });
    });

    route(ROUTES.oauthStart, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const region = body?.["region"] === "global" ? "global" : "cn";
        const started = await startSignIn(region);
        return json(res, 200, started);
      });
    });

    route(ROUTES.oauthPoll, (req, res) => {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      return guardRead(req, res, async () => {
        const query = queryOf(req);
        const state = query.get("state") ?? "";
        const region = query.get("region") === "global" ? "global" : "cn";
        if (state === "") return json(res, 400, { error: "state is required" });
        const outcome = await pollSignIn(region, state);
        if (outcome.status === "ok") {
          const scan = deps.rescan();
          return json(res, 200, { ...outcome, accounts: scan.accounts.length });
        }
        return json(res, 200, outcome);
      });
    });

    // The sign-in QR is rendered locally: no third-party image service ever sees
    // the one-time gateway token.
    route(ROUTES.qr, (req, res) => {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      return guardRead(req, res, () => {
        const url = queryOf(req).get("url") ?? "";
        if (!isSignInUrl(url)) return json(res, 400, { error: "url must be an https sign-in link" });
        const svg = qrSvg(url);
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
        res.end(svg);
      });
    });

    // Manual catalog pull: the card's "refresh from upstream" button, so a
    // stale roster can be replaced without waiting for the periodic timer.
    route(ROUTES.refreshModels, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const region = body?.["region"] === "global" ? "global" : "cn";
        try {
          const result = await deps.refreshCatalogFor(region);
          return json(res, 200, { ok: result?.ok === true, region, count: result?.count ?? 0, fallback: result?.fallback === true, error: result?.error });
        } catch (error) {
          return json(res, 502, { ok: false, region, error: safeMessage(error) });
        }
      });
    });

    route(ROUTES.resetCooldowns, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async () => {
        deps.pool.resetCooldowns();
        return json(res, 200, { ok: true });
      });
    });

    route(ROUTES.saveModels, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const region = body?.["region"] === "global" ? "global" : "cn";
        const selection = deps.state.selection(region);
        const next = { ...selection };
        if (Array.isArray(body["enabledModelIds"])) {
          next.enabledModelIds = body["enabledModelIds"].filter((id) => typeof id === "string" && id !== "");
        }
        if (body["enabledModelIds"] === null) delete next.enabledModelIds;
        // Per-model image capability: an explicit list enables exactly those
        // models; null clears the override and follows the upstream catalog.
        if (Array.isArray(body["imageModelIds"])) {
          next.imageModelIds = body["imageModelIds"].filter((id) => typeof id === "string" && id !== "");
        }
        if (body["imageModelIds"] === null) delete next.imageModelIds;
        if (body["contextBudgets"] !== undefined) {
          if (typeof body["contextBudgets"] !== "object" || body["contextBudgets"] === null || Array.isArray(body["contextBudgets"])) {
            return json(res, 400, { error: "contextBudgets must be an object" });
          }
          const budgets = {};
          for (const [id, value] of Object.entries(body["contextBudgets"])) {
            if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000) continue;
            budgets[id] = value;
          }
          next.contextBudgets = budgets;
        }
        await deps.applyState({ modelSelection: { ...deps.state.get().modelSelection, [region]: next } });
        return json(res, 200, { ok: true, selection: next });
      });
    });

    route(ROUTES.automationRun, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const kind = typeof body?.["kind"] === "string" ? body["kind"] : "";
        if (!JOB_KINDS.includes(kind)) return json(res, 400, { error: `kind must be one of ${JOB_KINDS.join(", ")}` });
        const result = await deps.scheduler.runJob(kind);
        return json(res, 200, result);
      });
    });

    route(ROUTES.automationConfig, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const automation = { ...deps.state.get().automation };
        if (typeof body["enabled"] === "boolean") automation.enabled = body["enabled"];
        if (typeof body["hours"] === "object" && body["hours"] !== null && !Array.isArray(body["hours"])) {
          const hours = {};
          for (const kind of JOB_KINDS) {
            const value = body["hours"][kind];
            if (!Array.isArray(value)) continue;
            hours[kind] = [...new Set(value.filter((hour) => typeof hour === "number" && Number.isInteger(hour) && hour >= 0 && hour <= 23))].sort((a, b) => a - b);
          }
          automation.hours = { ...(automation.hours ?? {}), ...hours };
        }
        await deps.applyState({ automation });
        return json(res, 200, { ok: true, automation });
      });
    });

    route(ROUTES.sanitizeConfig, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const current = { ...deps.state.sanitize() };
        for (const key of ["enabled", "brand", "triggers"]) {
          if (typeof body?.[key] === "boolean") current[key] = body[key];
        }
        await deps.applyState({ sanitize: current });
        return json(res, 200, { ok: true, sanitize: current, rules: sanitizeRuleSummary() });
      });
    });

    route(ROUTES.fingerprintConfig, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const current = normalizeProfile(deps.state.fingerprint());
        const next = { ...current };
        if (typeof body?.["enabled"] === "boolean") next.enabled = body["enabled"];
        if (body?.["rotateHours"] !== undefined) {
          if (typeof body["rotateHours"] !== "number" || !Number.isFinite(body["rotateHours"])) {
            return json(res, 400, { error: "rotateHours must be a number" });
          }
          if (body["rotateHours"] < MIN_ROTATE_HOURS) {
            return json(res, 400, { error: `rotateHours cannot be below ${MIN_ROTATE_HOURS}` });
          }
          next.rotateHours = clampRotateHours(body["rotateHours"]);
        }
        // A rotation counts from now when the interval is shortened, so a profile
        // that has already outlived the new interval is replaced on the next tick
        // instead of silently waiting for the old deadline.
        if (body?.["rotateHours"] !== undefined && next.rotatedAt > 0) next.rotatedAt = Date.now();
        await deps.applyState({ fingerprint: next });
        return json(res, 200, { ok: true, fingerprint: next, facts: profileFacts(next), nextRotateAt: nextRotationAt(next) });
      });
    });

    route(ROUTES.fingerprintRotate, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const region = body?.["region"];
        const profile = deps.rotateFingerprint(region === "global" || region === "cn" ? region : undefined);
        return json(res, 200, { ok: true, fingerprint: profile, facts: profileFacts(profile), nextRotateAt: nextRotationAt(profile) });
      });
    });

    route(ROUTES.fingerprintSet, (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      return guardWrite(req, res, async (body) => {
        const region = body?.["region"] === "global" ? "global" : "cn";
        const key = typeof body?.["key"] === "string" ? body["key"] : "";
        if (key === "") return json(res, 400, { error: "key is required" });
        const current = normalizeProfile(deps.state.fingerprint());
        if (body?.["reset"] === true) {
          const next = resetProfileValue(current, region, key);
          await deps.applyState({ fingerprint: next });
          return json(res, 200, { ok: true, fingerprint: next, facts: profileFacts(next), nextRotateAt: nextRotationAt(next) });
        }
        if (typeof body?.["value"] !== "string") return json(res, 400, { error: "value must be a string" });
        let outcome;
        try {
          outcome = setProfileValue(current, region, key, body["value"]);
        } catch (error) {
          return json(res, 400, { error: safeMessage(error) });
        }
        await deps.applyState({ fingerprint: outcome.profile });
        return json(res, 200, {
          ok: true,
          fingerprint: outcome.profile,
          facts: profileFacts(outcome.profile),
          nextRotateAt: nextRotationAt(outcome.profile),
          warning: outcome.warning,
        });
      });
    });

    route(ROUTES.version, (req, res) => {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      return guardRead(req, res, () =>
        json(res, 200, {
          name: deps.name,
          version: deps.version,
          status: deps.pool.status("cn").total + deps.pool.status("global").total,
          shim: { cn: deps.shims.cn(), global: deps.shims.global() },
        }),
      );
    });

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* a disposed registration is not an error */
        }
      }
    };
  });
  if (mounted === undefined) throw new Error("webServer is not available; the settings card routes were not mounted");
}

/** Build the whole card payload for one region. */
export function createStatusPayload(deps) {
  /**
   * Built per request, NOT once at registration: the region tabs render these
   * numbers, and a snapshot captured at apply time kept showing the pool as it
   * was at boot (`1/1`) even after cooldowns, disables or new scans changed it.
   */
  const buildRegionSummaries = () => {
    const summaries = {};
    for (const key of ["cn", "global"]) {
      const summary = deps.pool.status(key);
      summaries[key] = {
        total: summary.total,
        available: summary.available,
        provider: deps.providers[key]?.providerId,
        displayName: deps.providers[key]?.displayName,
        shim: deps.shims[key](),
      };
    }
    return summaries;
  };
  return (region) => {
    const pool = deps.pool.status(region);
    const providers = {};
    for (const key of ["cn", "global"]) {
      const provider = deps.providers[key];
      providers[key] =
        provider === undefined
          ? { registered: false }
          : {
              registered: true,
              providerId: provider.providerId,
              displayName: provider.displayName,
              models: provider.buildModels().length,
              baseUrl: deps.shims[key](),
            };
    }
    return {
      ok: true,
      region,
      plugin: { name: deps.name, version: deps.version, bootAt: deps.bootAt, uptimeMs: Date.now() - deps.bootAt },
      regions: buildRegionSummaries(),
      providers,
      pool,
      catalog: deps.catalogs[region].status(deps.state.selection(region)),
      automation: deps.scheduler.status(),
      settings: deps.state.get(),
      sanitize: { ...deps.state.sanitize(), rules: sanitizeRuleSummary() },
      fingerprint: {
        ...normalizeProfile(deps.state.fingerprint()),
        facts: profileFacts(deps.state.fingerprint()),
        nextRotateAt: nextRotationAt(deps.state.fingerprint()),
        minRotateHours: MIN_ROTATE_HOURS,
      },
      scan: { at: deps.pool.lastScanAt || null, warnings: deps.pool.lastScanWarnings },
      oauth: readJsonQuietly(paths.oauth()) ?? null,
      http: { status: `${ROUTE_PREFIX}/status` },
    };
  };
}
