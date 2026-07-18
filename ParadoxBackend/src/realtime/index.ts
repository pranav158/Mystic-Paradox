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

import type { Server as HttpsServer } from "node:https";

import { logger } from "../logger";
import { RealtimeGateway } from "./RealtimeGateway";
import { DEFAULT_LIMITS, REALTIME_WS_PATHS, RealtimeConfig } from "./types";

let gateway: RealtimeGateway | undefined;

function loadConfig(): RealtimeConfig {
    const enabled = process.env.REALTIME_XMPP_ENABLED === "true";
    
    
    
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
    };
}


export function initRealtime(server: HttpsServer): RealtimeGateway {
    if (gateway) {
        logger.warn("[XMPP] initRealtime called more than once; reusing existing gateway");
        return gateway;
    }
    const config = loadConfig();
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
