/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { HostIneligibilityReason, P2PHostEligibilityPolicy } from "../config/p2pHostPolicy";
import type { P2PHostPresenceRecord } from "../persistence/contracts/P2PHuntRepository";

// [2026-10-13 realms S1] Switches and thresholds of the realm hosting stage (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md
// section 1): MYSTICPARADOX_REALMS_HOSTING, P2P_REALM_HUB_CAPABILITY_TTL_HOURS, P2P_REALM_MIN_FREE_MEMORY_MIB_PER_SERVER.

/** MYSTICPARADOX_REALMS_HOSTING=on|true|1 (the realms module's own switch spelling). Anything else is off. */
export function IsRealmHostingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    return /^(on|true|1)$/i.test((environment.MYSTICPARADOX_REALMS_HOSTING ?? "").trim());
}

function BoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
    if (value === undefined || !/^\d{1,10}$/.test(value.trim())) return fallback;
    const parsed = Number(value.trim());
    return parsed >= min && parsed <= max ? parsed : fallback;
}

export interface RealmHubPolicy {
    /** How long a hub host's capability lives (the launcher restarts the hub before it ends). */
    capabilityTtlMs: number;
    /** Free physical memory the host needs for one more server of the realm. */
    minimumFreeMemoryMiB: number;
    /** Commit headroom the host needs for one more server of the realm. */
    minimumCommitHeadroomMiB: number;
    /** Server limit used when the realm's host never reported one. */
    defaultMaxServers: number;
}

export const DEFAULT_REALM_MIN_FREE_MEMORY_MIB = 3072;
export const DEFAULT_REALM_MIN_COMMIT_HEADROOM_MIB = 4096;
export const DEFAULT_REALM_MAX_SERVERS = 6;
export const DEFAULT_HUB_CAPABILITY_TTL_HOURS = 24;

export function ReadRealmHubPolicy(environment: NodeJS.ProcessEnv = process.env): RealmHubPolicy {
    return {
        capabilityTtlMs: BoundedInteger(environment.P2P_REALM_HUB_CAPABILITY_TTL_HOURS, DEFAULT_HUB_CAPABILITY_TTL_HOURS, 1, 168) * 3_600_000,
        minimumFreeMemoryMiB: BoundedInteger(environment.P2P_REALM_MIN_FREE_MEMORY_MIB_PER_SERVER, DEFAULT_REALM_MIN_FREE_MEMORY_MIB, 512, 262_144),
        minimumCommitHeadroomMiB: DEFAULT_REALM_MIN_COMMIT_HEADROOM_MIB,
        defaultMaxServers: DEFAULT_REALM_MAX_SERVERS
    };
}

/** The build and transport constants every session is frozen with (the same variables a hunt reads). */
export function ReadHubTransportConstants(environment: NodeJS.ProcessEnv = process.env): { build: number; bridgeProtocol: number; virtualPort: number } {
    return {
        build: BoundedInteger(environment.TARGET_CHANGELIST, 647472, 1, 2_147_483_647),
        bridgeProtocol: BoundedInteger(environment.P2P_BRIDGE_PROTOCOL, 1, 1, 255),
        // Steam P2P virtual ports are logical rendezvous channels, not UDP socket ports (as for hunts).
        virtualPort: BoundedInteger(environment.P2P_VIRTUAL_PORT, 1, 1, 999)
    };
}

/**
 * Why a realm's host may not start a server right now, or undefined. The host's own presence report (consent, launcher
 * version, verified artifacts, ready transport, Guard) must be fresh and acceptable, as for an official host, with the
 * realm's relaxations (design section 3.4): round-trip time, jitter and loss are not asked (the members are the host's
 * friends and the relay path is measured later), an earlier session of the same host is not a conflict (the hub, Training
 * and hunts run side by side), reliability cooldowns do not apply (the launcher restarts a dead hub within seconds), and
 * the memory floors are the realm's per-server ones.
 */
export function RealmHostIneligibilityReason(
    presence: P2PHostPresenceRecord,
    hostPolicy: P2PHostEligibilityPolicy,
    realmPolicy: Pick<RealmHubPolicy, "minimumFreeMemoryMiB" | "minimumCommitHeadroomMiB">,
    guardRequired: boolean,
    nowMs: number
): string | undefined {
    const relaxed: P2PHostEligibilityPolicy = {
        ...hostPolicy,
        maximumWorstPeerRttMs: Number.POSITIVE_INFINITY,
        maximumJitterMs: Number.POSITIVE_INFINITY,
        maximumPacketLossPercent: 100,
        minimumFreeMemoryMiB: realmPolicy.minimumFreeMemoryMiB,
        minimumCommitHeadroomMiB: realmPolicy.minimumCommitHeadroomMiB
    };
    return HostIneligibilityReason(presence, undefined, 0, relaxed, guardRequired, nowMs);
}
