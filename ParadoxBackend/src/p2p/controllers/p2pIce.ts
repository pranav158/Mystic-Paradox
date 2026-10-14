/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { logger } from "../../logger";
import { IncrementMetric } from "../../observability/metrics";
import { ReadP2PIceConfig } from "../config/p2pIcePolicy";
import { ReadP2PPolicy } from "../config/p2pPolicy";
import { GetP2PRepositories, P2PHuntSessionRecord } from "../persistence";
import { IsRealmHub, IsRealmSession, PRESENCE_LIVE_STATES } from "../realm/realmHubRules";
import {
    FilterRelayOnly,
    IcePeersFor,
    IcePresenceRow,
    MAXIMUM_HUB_PEERS,
    IsIceActiveState,
    ParseIceSignal,
    ResolveIceRole,
    SignalRouteAllowed
} from "../security/iceSessionRules";
import { LauncherApiError } from "../security/p2pErrors";
import { GetP2POperationsPolicy } from "../services/p2pOperationsPolicy";
import { FetchLike, HourlyCounter, IssueRelayGrant, RelayUsageCache } from "../services/relayCredentials";

// [2026-10-13] Plan step 1 (SteamDocs/HOSTING_TIERS_AND_REALMS_PLAN_2026_10_13.md §6.1): the backend half of the
// ICE co-op transport. POST .../transport-config hands a participant its ICE servers (STUN, plus TURN relay
// credentials within the monthly quota) and the keys of the pairs it belongs to; POST .../signal passes ICE
// descriptions and candidates between the host and a joiner through the existing control channel (ICE_SIGNAL).
// Both answer only while the operations policy selects the ICE transport.

const SIGNALS_PER_HOUR = 300;
// [2026-10-13 realms S1] A hub's host is the sender for every member that joins; and a realm's members and hunts ask for their
// transport configuration more often than the hunts of one party (an entry into the hub, a travel, a return).
const HUB_HOST_SIGNALS_PER_HOUR = 3000;
const REALM_CONFIGS_PER_HOUR = 120;
const SIGNAL_LIFETIME_MS = 120_000;
const TTL_GRACE_SECONDS = 600;

const configCounter = new HourlyCounter();
const signalCounter = new HourlyCounter();
const usageCache = new RelayUsageCache();

async function RequireP2PRunning(): Promise<void> {
    if (!ReadP2PPolicy().enabled) throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are disabled.");
    if ((await GetP2POperationsPolicy()).p2pEmergencyStop) {
        throw new LauncherApiError("P2P_EMERGENCY_STOP", "Player-hosted hunts are currently stopped by operations policy.");
    }
}

// The hunt's own frozen transport decides, not the current policy: a dashboard switch never changes a running hunt.
async function LoadActiveIceHunt(sessionId: string, generation: unknown): Promise<P2PHuntSessionRecord> {
    if (!Number.isSafeInteger(generation)) throw new LauncherApiError("P2P_TICKET_INVALID", "The hunt generation is missing.");
    const hunt = await GetP2PRepositories().p2pHunts.findHunt(sessionId);
    if (hunt == undefined) throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Hunt session not found.");
    if (hunt.coopTransport !== "ICE") {
        throw new LauncherApiError("P2P_TRANSPORT_MISMATCH", "This hunt does not use the ICE co-op transport.");
    }
    if (hunt.generation !== generation) {
        throw new LauncherApiError("P2P_GENERATION_FENCED", "This request belongs to a stale hunt generation.");
    }
    if (!IsIceActiveState(hunt.state)) throw new LauncherApiError("P2P_SESSION_NOT_READY", "The hunt is not running.");
    return hunt;
}

/** The members of a hub (rows PENDING, TICKETED, ADMITTED); undefined for a hunt, whose roster is on the session. */
async function HubPresenceOf(hunt: P2PHuntSessionRecord): Promise<IcePresenceRow[] | undefined> {
    if (!IsRealmHub(hunt)) return undefined;
    return GetP2PRepositories().realmHub.listByState(hunt.sessionId, hunt.generation, PRESENCE_LIVE_STATES, MAXIMUM_HUB_PEERS + 1);
}

/** Credential lifetime: the hunt's remaining lifetime plus a grace period, within the configured bounds. */
export function RelayTtlSeconds(huntExpiresAt: string, nowMs: number, maxTtlSeconds: number): number {
    const remaining = Math.ceil((Date.parse(huntExpiresAt) - nowMs) / 1000);
    const wanted = Number.isFinite(remaining) ? remaining + TTL_GRACE_SECONDS : maxTtlSeconds;
    return Math.min(maxTtlSeconds, Math.max(300, wanted));
}

/** The credential-lifetime cap for this session: a realm hub's own (default 24 h), else the general one (default 3 h). */
export function RelayTtlCapSeconds(hunt: Pick<P2PHuntSessionRecord, "sessionKind">,
    config: Pick<ReturnType<typeof ReadP2PIceConfig>, "maxCredentialTtlSeconds" | "realmHubCredentialTtlSeconds">): number {
    return IsRealmHub(hunt as P2PHuntSessionRecord) && config.realmHubCredentialTtlSeconds !== undefined
        ? config.realmHubCredentialTtlSeconds
        : config.maxCredentialTtlSeconds;
}

export async function CreateIceTransportConfig(accountId: string, sessionId: string, body: any,
    fetchImpl: FetchLike = fetch as unknown as FetchLike) {
    await RequireP2PRunning();
    const config = ReadP2PIceConfig();
    if (config.transportKeySecret == undefined) {
        throw new LauncherApiError("P2P_ICE_UNAVAILABLE", "The co-op transport is not configured on this server.");
    }
    const hunt = await LoadActiveIceHunt(sessionId, body?.generation);
    const presence = await HubPresenceOf(hunt);
    const role = ResolveIceRole(hunt, accountId, presence);
    if (role == undefined) throw new LauncherApiError("P2P_NOT_ROSTERED", "This account is not part of the hunt.");
    const now = new Date();
    const configsPerHour = IsRealmSession(hunt) ? Math.max(config.configsPerHour, REALM_CONFIGS_PER_HOUR) : config.configsPerHour;
    if (!configCounter.allow(accountId, configsPerHour, now.getTime())) {
        throw new LauncherApiError("P2P_RELAY_RATE_LIMITED", "Too many co-op transport requests; try again later.");
    }

    const ttlSeconds = RelayTtlSeconds(hunt.expiresAt, now.getTime(), RelayTtlCapSeconds(hunt, config));
    const grant = await IssueRelayGrant(config, accountId, ttlSeconds, { fetchImpl, usageCache, now });
    const peers = IcePeersFor(hunt, accountId, role, config.transportKeySecret, presence);
    const relayResult = grant.relay.allowed ? "ISSUED" : grant.relay.reason;
    IncrementMetric("mysticparadox_p2p_relay_grants_total", 1, { result: relayResult });
    logger.info({
        event: "p2p_ice_config_issued", sessionId, generation: hunt.generation, accountId, role,
        relay: relayResult, ttlSeconds: grant.relay.allowed ? ttlSeconds : undefined, peers: peers.length
    }, `[ICE] transport config session=${sessionId} generation=${hunt.generation} role=${role} relay=${relayResult}`);
    return {
        sessionId,
        generation: hunt.generation,
        role,
        // The 64-bit peer ids the admission tickets carry (the transport links' ids, transportPeerIds.ts).
        localAccountId: accountId,
        localPeerId: PeerIdOf(hunt, accountId, presence),
        hostAccountId: hunt.hostAccountId,
        hostPeerId: hunt.hostSteamId,
        forceRelay: ReadP2PPolicy().forceSdr,
        iceServers: grant.iceServers,
        relay: grant.relay,
        peers: peers.map((peer) => ({ ...peer, peerId: PeerIdOf(hunt, peer.accountId, presence) }))
    };
}

/** A participant's transport peer id as frozen in the hunt (the host's is hostSteamId). */
export function PeerIdOf(hunt: P2PHuntSessionRecord, accountId: string, presence?: readonly IcePresenceRow[]): string {
    if (accountId === hunt.hostAccountId) return hunt.hostSteamId;
    if (hunt.sessionKind === "REALM_HUB") return presence?.find((row) => row.accountId === accountId)?.peerId ?? "";
    return hunt.roster.find((entry) => entry.accountId === accountId)?.steamId ?? "";
}

export async function SubmitIceSignal(accountId: string, sessionId: string, body: any) {
    await RequireP2PRunning();
    const signal = ParseIceSignal(body);
    if (signal == undefined) throw new LauncherApiError("P2P_SIGNAL_INVALID", "The ICE signal is malformed or too large.");
    const hunt = await LoadActiveIceHunt(sessionId, signal.generation);
    const presence = await HubPresenceOf(hunt);
    if (!SignalRouteAllowed(hunt, accountId, signal.toAccountId, presence)) {
        throw new LauncherApiError("P2P_NOT_ROSTERED", "Signals go only between the host and a joiner of this hunt.");
    }
    const now = new Date();
    const signalLimit = IsRealmHub(hunt) && accountId === hunt.hostAccountId ? HUB_HOST_SIGNALS_PER_HOUR : SIGNALS_PER_HOUR;
    if (!signalCounter.allow(`${sessionId}:${hunt.generation}:${accountId}`, signalLimit, now.getTime())) {
        throw new LauncherApiError("P2P_SIGNAL_LIMIT", "Too many ICE signals for this hunt.");
    }

    const data = ReadP2PPolicy().forceSdr ? FilterRelayOnly(signal.kind, signal.data) : signal.data;
    if (data == undefined) {
        IncrementMetric("mysticparadox_p2p_ice_signals_total", 1, { result: "FILTERED_RELAY_ONLY" });
        return { delivered: false, reason: "FILTERED_RELAY_ONLY" };
    }
    const signalId = crypto.randomUUID();
    const fromRole = ResolveIceRole(hunt, accountId, presence);
    await GetP2PRepositories().p2pHunts.enqueueControlMessage({
        accountId: signal.toAccountId,
        messageType: "ICE_SIGNAL",
        sessionId,
        generation: hunt.generation,
        payload: { sessionId, generation: hunt.generation, signalId, fromAccountId: accountId, fromRole,
            kind: signal.kind, data },
        createdAt: now.toISOString(),
        expiresAt: new Date(Math.min(Date.parse(hunt.expiresAt), now.getTime() + SIGNAL_LIFETIME_MS)).toISOString()
    });
    IncrementMetric("mysticparadox_p2p_ice_signals_total", 1, { result: "DELIVERED" });
    return { delivered: true, signalId };
}
