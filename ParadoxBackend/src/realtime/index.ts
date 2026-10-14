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

import type { Server as HttpServer } from "node:http";

import { logger } from "../logger";
import { RealtimeGateway } from "./RealtimeGateway";
import { DEFAULT_LIMITS, REALTIME_WS_PATHS, RealtimeConfig } from "./types";

let gateway: RealtimeGateway | undefined;

function loadConfig(options: InitRealtimeOptions): RealtimeConfig {
    const enabled = process.env.REALTIME_XMPP_ENABLED === "true";
    // Capture defaults ON whenever the feature is enabled (this is the capture
    // milestone); set REALTIME_XMPP_CAPTURE=false to silence it once protocol
    // fixtures are recorded.
    const captureEnabled = enabled && process.env.REALTIME_XMPP_CAPTURE !== "false";
    const allowedHosts = (process.env.REALTIME_XMPP_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0);

    const envPaths = (process.env.REALTIME_XMPP_WS_PATHS ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

    return {
        enabled,
        wsPaths: envPaths.length > 0 ? envPaths : REALTIME_WS_PATHS,
        allowedHosts,
        captureEnabled,
        limits: DEFAULT_LIMITS,
        trustForwardedFor: options.behindProxy === true,
    };
}

export interface InitRealtimeOptions {
    /** [2026-10-14 M2] The listener is behind a loopback reverse proxy (the proxy's X-Forwarded-For names the client). */
    behindProxy?: boolean;
}

/**
 * Attach the realtime WebSocket upgrade handler to the HTTPS server, or, behind a reverse proxy, to the plain HTTP listener
 * ([2026-10-14 M2] same upgrade path, same Host allowlist). Always safe to call: when REALTIME_XMPP_ENABLED != "true" the
 * gateway rejects every upgrade and holds no state, so ordinary HTTPS/REST is unaffected (plan §21 server rollback).
 */
export function initRealtime(server: HttpServer, options: InitRealtimeOptions = {}): RealtimeGateway {
    if (gateway) {
        logger.warn("[XMPP] initRealtime called more than once; reusing existing gateway");
        return gateway;
    }
    const config = loadConfig(options);
    gateway = new RealtimeGateway(config);
    gateway.attach(server);
    if (!config.enabled) {
        logger.info("[XMPP] realtime disabled (set REALTIME_XMPP_ENABLED=true to enable the owned XMPP WSS endpoint)");
    }
    return gateway;
}

export async function shutdownRealtime(): Promise<void> {
    if (gateway) {
        await gateway.shutdown();
        gateway = undefined;
    }
}

export function getRealtimeGateway(): RealtimeGateway | undefined {
    return gateway;
}
