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
import { rateLimit } from "express-rate-limit";
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
import { RequestRateLimitOptions } from "./security/rateLimit.js";
import { GetRequestId, RequestContextMiddleware } from "./observability/requestContext.js";
import { launcherGuardRouter } from "./routes/launcherGuard.js";
import { GetPersistenceLifecycle } from "./persistence";
import { GetServiceReadiness } from "./observability/serviceReadiness";
import { ReadMetagameServiceRole } from "./config/serviceRole";
import { AdjustMetric, IncrementMetric, ObserveMetric } from "./observability/metrics";
import { metricsRouter } from "./routes/metrics";
import { GetP2PExtension } from "./extensions/p2p";

// Optional player-hosted hunt module (dedicated-only defaults when it is absent).
const Extension = GetP2PExtension();

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

// req.ip / X-Forwarded-For trust. The in-process DLL redirect (see the strip
// middleware below) points the game straight at this server over TLS — there is
// no nginx in front. Kept as "loopback" so a future same-box reverse proxy still
// resolves the real client for per-IP rate limiting (security/rateLimit.ts);
// change this only if a trusted L7 proxy is actually deployed ahead of Metagame.
app.set("trust proxy", "loopback");

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

// Routes of an optional module that need their own body parser are mounted before the shared
// parsers. All other routes use Express's default limit.
Extension.http.mountEarlyRoutes(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// [move5 diagnostic — 2026-07-10]
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
    logger.info(`[REQ] requestId=${requestId} ${req.method} ${req.headers.host || "?"}${loggedUrl}${originHost ? ` origin=${originHost}` : ""} gsKey=${gsKey}${Extension.http.requestLogTags(req)} bearer=${authBearer}`);
    if (BODY_CAPTURE_ENABLED && req.method === "POST" && /(pjm|progression|breadcrumbs|store|reconcile|balance|purchase|unlock|merit|currenc|inventory)/i.test(req.originalUrl)) {
        try { logger.info(`[BODY-CAPTURE] ${req.method} ${loggedUrl} body=${JSON.stringify(req.body)}`); } catch { /* ignore */ }
    }
    res.on("finish", () => {
        AdjustMetric("mysticparadox_http_inflight", -1);
        IncrementMetric("mysticparadox_http_responses_total", 1, { class: metricClass, status: `${Math.floor(res.statusCode / 100)}xx` });
        ObserveMetric("mysticparadox_http_request_duration_ms", Date.now() - started, { class: metricClass });
        // Authentication may add safe ` key=value` tags (for example an optional module's runtime identity).
        const responseTags = typeof res.locals.responseLogTags === "string" ? res.locals.responseLogTags : "";
        logger.info(`[RES] requestId=${requestId} ${req.method} ${loggedUrl} → ${res.statusCode}` +
            `${responseTags} (${Date.now() - started}ms)`);
    });
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

// Per-address request budget for every router below (security/rateLimit.ts). The health probes above stay outside
// it; the request log above still records each 429.
app.use(rateLimit(RequestRateLimitOptions()));

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
app.use("/", adminLauncherLogsRouter);
app.use("/", adminRouter);
Extension.http.mountRoutes(app);
app.use("/", launcherGuardRouter);

app.use((req, res) => {
    logger.warn(`Unstubbed route ${req.method} ${req.path}`)

    res.status(404);
    res.send();
});

Extension.http.mountErrorHandlers(app);
