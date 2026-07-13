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
import tls from "node:tls";

import { app } from "./app";
import { DrainAndRegisterAPIKeys } from "./controllers/apikeys";
import { DrainAndRegisterUserAPIKeys } from "./controllers/auth";
import { GetPersistenceLifecycle } from "./persistence";
import { initRealtime, shutdownRealtime } from "./realtime";
import { logger } from "./logger";

const PORT = process.env.PORT;








const HTTPS_PORT = process.env.HTTPS_PORT ?? "3443";
const PARADOX_CERT_PATH = process.env.PARADOX_CERT_PEM_PATH ?? "../ParadoxCertificates/paradox.example.com-chain.pem";
const PARADOX_KEY_PATH = process.env.PARADOX_KEY_PEM_PATH ?? "../ParadoxCertificates/paradox.example.com-key.pem";



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












let HttpServer: import("node:http").Server | undefined;
let HttpsServer: https.Server | undefined;

async function Main(): Promise<void> {
    await GetPersistenceLifecycle().start();

    await DrainAndRegisterAPIKeys();
    await DrainAndRegisterUserAPIKeys();

    HttpServer = app.listen(PORT, () => {
        logger.info(`Mystic Paradox Metagame (HTTP) on port ${PORT}`);
        logger.info(`Clear Skies, Slayer.`);
    });

    const ParadoxCtx = LoadTlsContext(PARADOX_CERT_PATH, PARADOX_KEY_PATH, "paradox.example.com", PARADOX_KEY_PASSPHRASE);

    if (ParadoxCtx == undefined) {
        logger.error("No HTTPS certificate available - HTTPS listener not started (game client TLS will fail)");
    } else {
        try {
            const HttpsOptions: https.ServerOptions = {
                cert: fs.readFileSync(PARADOX_CERT_PATH),
                key: fs.readFileSync(PARADOX_KEY_PATH),
            };
            
            
            if (PARADOX_KEY_PASSPHRASE) {
                HttpsOptions.passphrase = PARADOX_KEY_PASSPHRASE;
            }
            const RealtimeHttpsServer = https.createServer(HttpsOptions, app);
            
            
            
            initRealtime(RealtimeHttpsServer);
            HttpsServer = RealtimeHttpsServer.listen(Number(HTTPS_PORT), () => {
                logger.info(`Mystic Paradox Metagame (HTTPS) on port ${HTTPS_PORT} [paradox=ready]`);
            });
        } catch (e) {
            logger.error(`Failed to start HTTPS listener (cert=${PARADOX_CERT_PATH}): ${e}`);
        }
    }
}







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

async function GracefulShutdown(Signal: string): Promise<void> {
    if (ShuttingDown) {
        return;
    }
    ShuttingDown = true;

    logger.info(`Received ${Signal} - shutting down gracefully (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`);

    const ForceExitTimer = setTimeout(() => {
        logger.error(`Graceful shutdown did not complete within ${SHUTDOWN_TIMEOUT_MS}ms - forcing exit`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    
    ForceExitTimer.unref();

    try {
        
        
        await shutdownRealtime();
        logger.info("Realtime (XMPP) gateway stopped");

        await Promise.all([CloseServer(HttpServer), CloseServer(HttpsServer)]);
        logger.info("HTTP/HTTPS listeners closed");

        await GetPersistenceLifecycle().stop();
        logger.info("Persistence layer stopped cleanly");

        clearTimeout(ForceExitTimer);
        process.exit(0);
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