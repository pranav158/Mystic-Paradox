//0503
/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import express from "express";
import { loginRouter } from "./routes/login.js";
import { logger } from "./logger.js";
import { eosRouter } from "./routes/eos.js";
import { systemRouter } from "./routes/system.js";
import { characterRouter } from "./routes/character.js";
import { inventoryRouter } from "./routes/inventory.js";
import { storeRouter } from "./routes/store.js";
import { guildRouter } from "./routes/guild.js";
import { tuningRouter } from "./routes/tuning.js";
import { matchmakingRouter } from "./routes/matchmaking.js";
import { partyRouter } from "./routes/party.js";
import { progressionRouter } from "./routes/progression.js";
import { loadoutRouter } from "./routes/loadout.js";
import { launcherAuthRouter } from "./routes/launcherAuth.js";
import { friendsRouter } from "./routes/friends.js";
import { launcherUpdatesRouter } from "./routes/launcherUpdates.js";
import { launcherLogsRouter } from "./routes/launcherLogs.js";
import { adminLauncherLogsRouter } from "./routes/adminLauncherLogs.js";
import { adminRouter } from "./routes/admin.js";
import { sanitizeUrlForLog } from "./security/logRedaction.js";
import { CreateRequestRateLimiter } from "./security/rateLimit.js";
import { GetRequestId, RequestContextMiddleware } from "./observability/requestContext.js";
import { launcherGuardRouter } from "./routes/launcherGuard.js";
import { GetPersistenceLifecycle } from "./persistence";
import { GetServiceReadiness } from "./observability/serviceReadiness";
import { ReadMetagameServiceRole } from "./config/serviceRole";
import { AdjustMetric, IncrementMetric, ObserveMetric } from "./observability/metrics";
import { metricsRouter } from "./routes/metrics";
import { GetP2PExtension } from "./extensions/p2p";
import { releaseGatesRouter } from "./routes/releaseGates";
import { ReadAdminApiPolicy } from "./config/adminApi";
import { MountRealmsModule } from "./realms";
import { TRUST_PROXY_SETTING } from "./config/proxyTrust";
import { CaptureAdminRawBody } from "./security/managerOperator";

// Optional player-hosted hunt module (dedicated-only defaults when it is absent).
const Extension = GetP2PExtension();
// [2026-10-15] MYSTICPARADOX_ADMIN_API (config/adminApi.ts): off unless set, or unless the manager bridge is on. An invalid value
// throws here, so startup stops.
export const AdminApi = ReadAdminApiPolicy();

// Request tagged with the original backend host, decoded from the /__origin/<host>/
// prefix that the injected DLL's SetURL hook adds (see the strip middleware below).
type OriginTaggedRequest = express.Request & { originHost?: string };

// Backend hosts the injected DLL is allowed to encode into /__origin/<host>/. Mirrors
// the DLL's MpIsRedirectHost allowlist; anything else is rejected as a spoofing guard.
const ORIGIN_ALLOWLIST_APEXES = ["steelyard.ca", "steelyard.online", "ol.epicgames.com", "api.epicgames.dev"] as const;

// True only for a bare hostname (no scheme, port, credentials or path) that matches an
// allowlisted apex exactly or as a dot-delimited subdomain. Caller lowercases first.
function isAllowedOriginHost(host: string): boolean {
    if (host.length === 0 || host.length > 253) return false;
    if (!/^[a-z0-9.-]+$/.test(host)) return false;   // rejects ':', '@', '/', '%', spaces, ...
    if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
    return ORIGIN_ALLOWLIST_APEXES.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

export const app = express();

// req.ip / X-Forwarded-For trust. With the in-process HTTPS listener the game connects straight to this
// server. [2026-10-14 M2] Behind nginx (MYSTICPARADOX_TLS_TERMINATED_BY_PROXY=on) the peer is the loopback
// proxy, so req.ip is the client the proxy forwarded (per-IP rate limiting, security/rateLimit.ts); any other
// peer is its own address, whatever X-Forwarded-For says (config/proxyTrust.ts, tested).
app.set("trust proxy", TRUST_PROXY_SETTING);

// Install the request context before parsers and routers so every downstream async log,
// including the DeployServer fetch, carries one safe correlation identifier.
app.use(RequestContextMiddleware);

// [1.12.0 in-process HTTPS redirect] The injected DLL hooks FCurlHttpRequest::SetURL
// and rewrites allowlisted official backend URLs (*.steelyard.ca, *.steelyard.online,
// *.ol.epicgames.com, api.epicgames.dev) to
//   https://paradox.mysticfox.dev/__origin/<original-host>/<original-path-and-query>
// This replaces the old nginx /dauntless/ proxy (api.mysticfox.dev.conf): strip the
// /__origin/<host> prefix and rewrite req.url so the existing path-based routers below
// handle the request unchanged. The original host is preserved on req.originHost for
// logging and any host-specific handling. Routing is path-based, so encoding the host
// in the path avoids collisions without depending on the (now rewritten) Host header.
app.use((req, res, next) => {
    const match = /^\/__origin\/([^/?#]+)(.*)$/.exec(req.url);
    if (match) {
        let originHost: string;
        try {
            originHost = decodeURIComponent(match[1]).toLowerCase(); // canonicalize
        } catch {
            logger.warn("[origin] rejected /__origin request with malformed percent-encoding");
            res.status(400).send();
            return;
        }
        // Reject credentials (user@host), explicit ports (host:port) and any value that
        // is not a bare, allowlisted hostname. Guards against origin spoofing / unintended
        // access through the prefix (isAllowedOriginHost enforces the character set too).
        if (!isAllowedOriginHost(originHost)) {
            logger.warn(`[origin] rejected /__origin host: ${originHost}`);
            res.status(400).send();
            return;
        }
        const rest = match[2] && match[2].length > 0 ? match[2] : "/";
        (req as OriginTaggedRequest).originHost = originHost;
        req.url = rest.startsWith("/") ? rest : `/${rest}`;
    }
    next();
});

// [1.14.7 diagnostic 2026-10-03] Env-gated capture of the EXACT bodies served to the game client's
// /__origin requests. The hub logs "Json Value of type 'String' used as a 'Object'" three times at
// tick 2 while loading player data, and every candidate endpoint's shape has been checked by hand -
// this records what the client really received so the offending payload can be identified instead of
// guessed. Off unless MYSTICPARADOX_LOG_ORIGIN_BODIES=1.
if ((process.env.MYSTICPARADOX_LOG_ORIGIN_BODIES ?? "0") === "1") {
    app.use((req, res, next) => {
        if ((req as OriginTaggedRequest).originHost === undefined) { next(); return; }
        const originalJson = res.json.bind(res);
        (res as any).json = (body: any) => {
            try {
                const Text = JSON.stringify(body) ?? "null";
                logger.info(`[origin-body] ${req.method} ${req.url} -> ${Text.slice(0, 900)}`);
            } catch { /* body not serializable - ignore */ }
            return originalJson(body);
        };
        next();
    });
}

// Per-address request budget (security/rateLimit.ts). One instance, counted once per request.
const RequestLimiter = CreateRequestRateLimiter();

// [move5 diagnostic — 2026-07-10]
// [2026-10-16] Mounted ahead of the request budget and the early (player-host) routes: /mystic/v1/hunts (lease, Guard evidence,
// completion) used to bypass it, so a refused completion or lease never appeared in the backend log.
// Log every incoming request BEFORE any router so we can definitively answer:
//   1. Does this request reach the metagame at all?
//   2. Does it carry the x-mysticparadox-gameserver-apikey header? (→ IsGameserver path)
//   3. What status did it return, and how long did it take?
//
// Kept minimal to avoid log noise: method + host + sanitized path/query + gsKey presence +
// status/timing. Sensitive query values are replaced before logging; headers and bodies are omitted.
// [BODY-CAPTURE] Toggle: dump request bodies for progression/store/currency POST paths to learn the client
// contract (Slayer's Path unlocks, currency spends). OFF by default; enable with env MYSTICPARADOX_BODY_CAPTURE=1
// (accepts 1/true/on/yes). Kept behind a flag so it can be re-enabled for future contract debugging.
/** [2026-10-16] The player-host lease and Guard evidence routes (see the request log below). */
const HIGH_FREQUENCY_HOST_ROUTE = /^\/mystic\/v1\/hunts\/[^/]+\/(lease|event-batches)$/;
const BODY_CAPTURE_ENABLED = /^(1|true|on|yes)$/i.test(process.env.MYSTICPARADOX_BODY_CAPTURE ?? "");

app.use((req, res, next) => {
    const started = Date.now();
    const metricClass = Extension.http.metricClass(req.path) ??
        (req.path.startsWith("/admin/") ? "admin" :
            req.path.startsWith("/health/") ? "health" :
                req.path.startsWith("/launcher/") ? "launcher" : "game");
    IncrementMetric("mysticparadox_http_requests_total", 1, { class: metricClass, method: req.method });
    AdjustMetric("mysticparadox_http_inflight", 1);
    const requestId = GetRequestId() ?? "missing";
    const gsKey = req.headers["x-mysticparadox-gameserver-apikey"] ? "Y" : "N";
    const authBearer = typeof req.headers.authorization === "string" && req.headers.authorization.toLowerCase().startsWith("bearer ") ? "Y" : "N";
    const originHost = (req as OriginTaggedRequest).originHost;
    const loggedUrl = sanitizeUrlForLog(req.originalUrl);
    const requestLine = `[REQ] requestId=${requestId} ${req.method} ${req.headers.host || "?"}${loggedUrl}${originHost ? ` origin=${originHost}` : ""} gsKey=${gsKey}${Extension.http.requestLogTags(req)} bearer=${authBearer}`;
    // [2026-10-16] A player host renews its lease every ~2 s and sends one Guard evidence batch per event: those two are logged
    // only when refused (both lines then, at the answer), so a failure shows without a line pair per heartbeat and per hit.
    const quietWhenOk = HIGH_FREQUENCY_HOST_ROUTE.test(req.path);
    if (!quietWhenOk) logger.info(requestLine);
    res.on("finish", () => {
        AdjustMetric("mysticparadox_http_inflight", -1);
        IncrementMetric("mysticparadox_http_responses_total", 1, { class: metricClass, status: `${Math.floor(res.statusCode / 100)}xx` });
        ObserveMetric("mysticparadox_http_request_duration_ms", Date.now() - started, { class: metricClass });
        // Authentication may add safe ` key=value` tags (for example an optional module's runtime identity).
        const responseTags = typeof res.locals.responseLogTags === "string" ? res.locals.responseLogTags : "";
        if (quietWhenOk && res.statusCode < 400) return;
        if (quietWhenOk) logger.info(requestLine);
        logger.info(`[RES] requestId=${requestId} ${req.method} ${loggedUrl} → ${res.statusCode}` +
            `${responseTags} (${Date.now() - started}ms)`);
    });
    next();
});

// [2026-10-11 P2P, plan 39_ §13.1 B4] The player-hosted hunt routes are mounted early (below) for their own body
// parser, which put them ahead of the request budget: lease, admission, Guard evidence and completion calls were
// never limited. They now pass the same budget (hosts get their own bucket there) before their router.
app.use("/mystic/v1/hunts", RequestLimiter);

// Routes of an optional module that need their own body parser are mounted before the shared
// parsers. All other routes use Express's default limit.
Extension.http.mountEarlyRoutes(app);

// [2026-10-14, P5.1] The verify hook keeps the raw bytes of /admin/v1 bodies for the manager operator signature (security/managerOperator.ts).
app.use(express.json({ verify: CaptureAdminRawBody }));
app.use(express.urlencoded({ extended: true }));

// [BODY-CAPTURE] (see BODY_CAPTURE_ENABLED above) needs the parsed body, so it runs after the shared parsers.
app.use((req, _res, next) => {
    if (BODY_CAPTURE_ENABLED && req.method === "POST" && /(pjm|progression|breadcrumbs|store|reconcile|balance|purchase|unlock|merit|currenc|inventory)/i.test(req.originalUrl)) {
        try { logger.info(`[BODY-CAPTURE] ${req.method} ${sanitizeUrlForLog(req.originalUrl)} body=${JSON.stringify(req.body)}`); } catch { /* ignore */ }
    }
    next();
});

app.get("/", (req, res) => {
    res.status(200).send("ok");
});

// These endpoints intentionally expose only process/readiness state. They do not include
// database topology, account identifiers, policy contents, or credentials. A service can be
// alive while not ready: production traffic must wait for persistence, TLS and role startup.
app.get("/health/live", (_req, res) => {
    res.status(200).json({ ok: true, service: "paradox-backend", role: ReadMetagameServiceRole() });
});

app.get("/health/ready", async (_req, res) => {
    const state = GetServiceReadiness();
    let persistenceHealthy = false;
    try { persistenceHealthy = await GetPersistenceLifecycle().isHealthy(); } catch { persistenceHealthy = false; }
    const ready = state.ready && persistenceHealthy;
    res.status(ready ? 200 : 503).json({
        ok: ready,
        service: "paradox-backend",
        role: state.role,
        reason: ready ? "READY" : state.reason,
        persistence: persistenceHealthy ? "ready" : "unavailable"
    });
});

// [2026-10-14] Manager preflight (observability/releaseGates.ts). Loopback peers only, refused by the route itself; mounted with the
// health probes, before the request budget and before any router's auth. [2026-10-15] Only with the admin API on.
if (AdminApi.enabled) app.use("/", releaseGatesRouter);

// Per-address request budget for every router below (security/rateLimit.ts). The health probes above stay outside
// it; the request log above still records each 429.
app.use(RequestLimiter);

app.use("/", metricsRouter);

app.use("/", loginRouter);
app.use("/", eosRouter);
app.use("/", systemRouter);
app.use("/", characterRouter);
app.use("/", inventoryRouter);
app.use("/", storeRouter);
app.use("/", guildRouter);
app.use("/", tuningRouter);
app.use("/", matchmakingRouter);
app.use("/", partyRouter);
app.use("/", progressionRouter);
app.use("/", loadoutRouter);
app.use("/", friendsRouter);
app.use("/", launcherAuthRouter);
app.use("/", launcherUpdatesRouter);
app.use("/", launcherLogsRouter);
// [2026-10-15] With the admin API off, every /admin path answers 404 here, before the admin routers and before the optional
// module's own /admin routes (mounted below), so a self-hosted backend exposes no admin surface.
app.use("/admin", (_req, res, next) => {
    if (AdminApi.enabled) {
        next();
        return;
    }
    res.status(404).end();
});
if (AdminApi.enabled) {
    app.use("/", adminLauncherLogsRouter);
    app.use("/", adminRouter);
}
// [2026-10-13 realms S2] Paradox realms directory (src/realms), /launcher/v1/realms with its own launcher auth. Mounted only
// when MYSTICPARADOX_REALMS_MODULE is on|true|1; off by default.
MountRealmsModule(app);
Extension.http.mountRoutes(app);
app.use("/", launcherGuardRouter);

app.use((req, res) => {
    logger.warn(`Unstubbed route ${req.method} ${req.path}`)

    res.status(404);
    res.send();
});

Extension.http.mountErrorHandlers(app);
