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

import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import tls from "node:tls";

import { app } from "./app";
import { DrainAndRegisterAPIKeys } from "./controllers/apikeys";
import { DrainAndRegisterUserAPIKeys } from "./controllers/auth";
import { AssertApiKeyHashSecret } from "./security/apiKeyHash";
import { GetPersistenceLifecycle } from "./persistence";
import { initRealtime, shutdownRealtime } from "./realtime";
import { logger } from "./logger";
import { partyOutboxDispatcher } from "./realtime/PartyOutboxDispatcher";
import { AssertRuntimeSafety } from "./config/runtimeSafety";
import { ReadMetagameServiceRole } from "./config/serviceRole";
import { SetServiceReadiness } from "./observability/serviceReadiness";
import { GetP2PExtension } from "./extensions/p2p";

const PORT = process.env.PORT?.trim() || "3000";

// HTTPS listener for the game client. The injected DLL rewrites the official backend
// hosts (*.steelyard.ca, *.steelyard.online, ...) to https://paradox.mysticfox.dev/__origin/...
// via the in-process SetURL redirect, so the game connects DIRECTLY here and Metagame
// terminates TLS with the single paradox identity (no nginx, no interceptor).
// Internal callers (DeployServer, gameserver) keep using plain HTTP on PORT with
// their API keys. Serve the paradox FULLCHAIN (leaf + intermediates) so clients can
// build the trust path. In production set HTTPS_PORT=443 (rewritten URLs carry no port).
const HTTPS_PORT = process.env.HTTPS_PORT?.trim() || "3443";
const PARADOX_CERT_PATH = process.env.PARADOX_CERT_PEM_PATH ?? "../ParadoxCertificates/paradox.mysticfox.dev-chain.pem";
const PARADOX_KEY_PATH = process.env.PARADOX_KEY_PEM_PATH ?? "../ParadoxCertificates/paradox.mysticfox.dev-key.pem";
// The shipped paradox key is an AES-256-CBC-encrypted RSA key, so its passphrase must be
// supplied out-of-band via env (never committed). Without it the paradox HTTPS identity
// fails to load and the HTTPS listener cannot start.
const PARADOX_KEY_PASSPHRASE = process.env.PARADOX_KEY_PASSPHRASE || undefined;

function LoadTlsContext(CertPath: string, KeyPath: string, Label: string, Passphrase?: string): tls.SecureContext | undefined {
    try {
        const options: tls.SecureContextOptions = { cert: fs.readFileSync(CertPath), key: fs.readFileSync(KeyPath) };
        if (Passphrase) {
            options.passphrase = Passphrase;
        }
        return tls.createSecureContext(options);
    } catch (e) {
        logger.warn(`TLS identity '${Label}' unavailable (cert=${CertPath}, key=${KeyPath}): ${e}`
            + (Passphrase ? "" : " (if the key is passphrase-encrypted, set PARADOX_KEY_PASSPHRASE)"));
        return undefined;
    }
}

// [hardening] Mongo connection + index setup MUST finish (and be awaited) before anything
// DB-dependent runs. Previously this was fired without awaiting, and DrainAndRegisterAPIKeys()
// (itself DB-dependent) started on the very next tick — two concurrent first-callers into
// GetMongoClient() before connect() resolved, each seeing the cache as empty. That race is now
// closed at the client-singleton level too (see persistence/mongo/client.ts), but startup should
// still be sequenced explicitly: fail fast and loud if Mongo/index setup fails, rather than
// half-booting and accepting traffic against an unready database.
//
// [hardening] Server handles are captured here (rather than left as fire-and-forget .listen()
// calls) so graceful shutdown (below) can stop accepting new connections before closing the
// Mongo client — GetPersistenceLifecycle().stop() existed already but nothing ever called it.
let HttpServer: import("node:http").Server | undefined;
let HttpsServer: https.Server | undefined;

function HandleListenerError(Label: "HTTP" | "HTTPS", Error: Error, ServiceRole: ReturnType<typeof ReadMetagameServiceRole>): void {
    const reason = `${Label}_LISTENER_ERROR`;
    SetServiceReadiness({ ready: false, reason, role: ServiceRole });
    logger.error(`${Label} listener error: ${Error}`);
    // A production API that cannot bind its required listener must terminate so the
    // supervisor can restart it. Leaving the HTTP process alive with readiness=false
    // would keep a partially serving instance around and can hide a failed HTTPS bind.
    if (process.env.NODE_ENV === "production") {
        void GracefulShutdown(`${Label}_LISTENER_ERROR`, 1);
    }
}

async function Main(): Promise<void> {
    AssertRuntimeSafety();
    const serviceRole = ReadMetagameServiceRole();
    const moduleSummary = GetP2PExtension().server.startupSummary(serviceRole);
    if (moduleSummary != undefined) logger.info(moduleSummary, "[Startup] Optional module policy");
    if (serviceRole !== "combined" && serviceRole !== "api") {
        throw new Error(`server.ts serves the combined or api role; ${serviceRole} has its own entry point.`);
    }
    const ParadoxCtx = LoadTlsContext(PARADOX_CERT_PATH, PARADOX_KEY_PATH, "paradox.mysticfox.dev", PARADOX_KEY_PASSPHRASE);
    if (process.env.NODE_ENV === "production" && ParadoxCtx == undefined) {
        throw new Error("Production API startup requires a valid HTTPS certificate and key.");
    }
    // API keys are HMAC-hashed under API_KEY_HASH_SECRET; refuse to start without it rather than reject every
    // gameserver request later.
    AssertApiKeyHashSecret();
    await GetPersistenceLifecycle().start();

    await DrainAndRegisterAPIKeys();
    await DrainAndRegisterUserAPIKeys();

    partyOutboxDispatcher.start();
    GetP2PExtension().server.start(serviceRole);

    HttpServer = app.listen(PORT, () => {
        logger.info(`Mystic Paradox Metagame (HTTP) on port ${PORT}`);
        logger.info(`Clear Skies, Slayer.`);
    });
    HttpServer.on("error", (error) => {
        HandleListenerError("HTTP", error, serviceRole);
    });

    if (ParadoxCtx == undefined) {
        logger.error("No HTTPS certificate available - HTTPS listener not started (game client TLS will fail)");
    } else {
        try {
            const HttpsOptions: https.ServerOptions = {
                cert: fs.readFileSync(PARADOX_CERT_PATH),
                key: fs.readFileSync(PARADOX_KEY_PATH),
            };
            // The paradox key is an AES-256-CBC-encrypted RSA key, so the context needs its
            // passphrase. Without this the context throws "bad decrypt".
            if (PARADOX_KEY_PASSPHRASE) {
                HttpsOptions.passphrase = PARADOX_KEY_PASSPHRASE;
            }
            const RealtimeHttpsServer = https.createServer(HttpsOptions, app);
            // [XMPP] Attach the realtime WebSocket upgrade handler to the HTTPS server BEFORE
            // listen (plan §8.1). No-op for ordinary HTTPS/REST unless REALTIME_XMPP_ENABLED=true;
            // when disabled, every WS upgrade is rejected cleanly and no XMPP state exists.
            initRealtime(RealtimeHttpsServer);
            HttpsServer = RealtimeHttpsServer.listen(Number(HTTPS_PORT), () => {
                logger.info(`Mystic Paradox Metagame (HTTPS) on port ${HTTPS_PORT} [paradox=ready]`);
                SetServiceReadiness({ ready: true, reason: "API_AND_HTTPS_RUNNING", role: serviceRole });
            });
            HttpsServer.on("error", (error) => {
                HandleListenerError("HTTPS", error, serviceRole);
            });
        } catch (e) {
            logger.error(`Failed to start HTTPS listener (cert=${PARADOX_CERT_PATH}): ${e}`);
            SetServiceReadiness({ ready: false, reason: "HTTPS_LISTENER_FAILED", role: serviceRole });
            if (process.env.NODE_ENV === "production") throw e;
        }
    }
    if (ParadoxCtx == undefined && process.env.NODE_ENV !== "production") {
        SetServiceReadiness({ ready: true, reason: "HTTP_ONLY_DEVELOPMENT", role: serviceRole });
    }

    // [1.14.7 QOS FIX 2026-10-04] The client measures regions by pinging every regionUrl returned by
    // /candidate/regions over PLAIN HTTP on port 80, expecting exactly
    //   <!DOCTYPE html><html><body>pong</body></html>
    // (DauntlessEndpointDocumentation/Matchmaking/Candidate/GetRegions.md:
    //  "Each of these, client will ping as specified. GET to base URL. Websites answer with ...pong...").
    //
    // Nothing listened on :80, so every datacenter in the client's own region table measured
    // "9999ms (0.00%) Invalid", it logged
    //   LogQos [Warning] Unable to set a good region!
    //   LogQos [Warning] Wanted to set NONE, failed to fall back to
    //   LogQos [Display] Current:            <- empty
    // and it travelled with no region at all - the last unexplained failure before the 20s
    // ServerConnectionTimeout. This listener answers that contract on every path.
    //
    // A bind failure is logged and deliberately does NOT change readiness: the game is still playable
    // without a latency measurement, so a busy QoS port must never take the API down.
    const QOS_PORT = Number(process.env.QOS_PORT?.trim() || "80");
    try {
        const QosServer = http.createServer((_req, res) => {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html");
            res.end("<!DOCTYPE html><html><body>pong</body></html>");
        });
        QosServer.listen(QOS_PORT, () => {
            logger.info(`QoS latency-test listener on port ${QOS_PORT} (answers pong for region pings)`);
        });
        QosServer.on("error", (error) => {
            logger.warn(`QoS listener on port ${QOS_PORT} failed: ${error}`);
        });
    } catch (e) {
        logger.warn(`QoS listener could not start on port ${QOS_PORT}: ${e}`);
    }
}

// [hardening] Graceful shutdown: on SIGINT/SIGTERM, stop accepting new connections first, THEN
// close the Mongo client — GetPersistenceLifecycle().stop() already existed (see
// persistence/mongo/client.ts) but nothing ever wired it to process signals, so every stop was
// effectively a hard kill (in-flight requests dropped, Mongo connections never cleanly closed).
// A hard timeout forces exit even if a listener/request hangs, so a stuck shutdown can never
// leave the process running forever.
const SHUTDOWN_TIMEOUT_MS = 10000;
let ShuttingDown = false;

function CloseServer(Server: import("node:http").Server | https.Server | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (Server == undefined) {
            resolve();
            return;
        }
        Server.close(() => resolve());
    });
}

async function GracefulShutdown(Signal: string, ExitCode = 0): Promise<void> {
    if (ShuttingDown) {
        return;
    }
    ShuttingDown = true;

    logger.info(`Received ${Signal} - shutting down gracefully (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);

    const ForceExitTimer = setTimeout(() => {
        logger.error(`Graceful shutdown did not complete within ${SHUTDOWN_TIMEOUT_MS}ms - forcing exit`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Unref so this timer alone doesn't keep the event loop alive if everything else finishes.
    ForceExitTimer.unref();

    try {
        // [XMPP] Stop accepting WS upgrades and close live realtime sockets before the
        // listeners go away (plan §8.4). No-op when realtime is disabled.
        await shutdownRealtime();
        partyOutboxDispatcher.stop();
        await GetP2PExtension().server.stop();
        logger.info("Realtime (XMPP) gateway stopped");

        await Promise.all([CloseServer(HttpServer), CloseServer(HttpsServer)]);
        logger.info("HTTP/HTTPS listeners closed");

        await GetPersistenceLifecycle().stop();
        logger.info("Persistence layer stopped cleanly");

        clearTimeout(ForceExitTimer);
        process.exit(ExitCode);
    } catch (Err) {
        logger.error(`Error during graceful shutdown: ${Err}`);
        clearTimeout(ForceExitTimer);
        process.exit(1);
    }
}

process.on("SIGINT", () => { GracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { GracefulShutdown("SIGTERM"); });

Main().catch((Err) => {
    logger.error(`Fatal startup error: ${Err}`);
    process.exitCode = 1;
});
