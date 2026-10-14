/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession } from "mongodb";
import { IncrementMetric } from "../../observability/metrics";
import { ReadP2PIceConfig } from "../config/p2pIcePolicy";
import { ReadP2PPolicy } from "../config/p2pPolicy";
import {
    GetP2PRepositories,
    P2PHuntSessionRecord,
    P2PRepositoryProvider,
    RealmHubPresenceRecord
} from "../persistence";
import {
    HubTicketDenial,
    HubTicketDenialError,
    HubTicketDenialReason,
    IsRealmHub,
    PRESENCE_LIVE_STATES
} from "../realm/realmHubRules";
import { GetRealmsPort, RealmsPort } from "../realm/realmsPort";
import { IssueAdmissionTicket } from "../security/admissionTickets";
import { DeriveIcePairKey, IsIceActiveState } from "../security/iceSessionRules";
import { LauncherApiError } from "../security/p2pErrors";
import { GetP2POperationsPolicy } from "../services/p2pOperationsPolicy";
import { HourlyCounter } from "../services/relayCredentials";

// [2026-10-13 realms S1] Admission of a joiner into a realm hub (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 4.4):
// one fresh admission ticket per entry, issued only for an expected, still-eligible member, consumed by the host, and the
// host's list of the peers it should be connected to. The ticket, its signing and its single-use consumption are the same
// code as for a hunt; what differs is that the member's state is a presence row, not a roster entry (so nothing here writes
// the session document and no reconnect counter exists).

type HubRepos = Pick<P2PRepositoryProvider, "p2pHunts" | "realmHub">;

/** The window an admission ticket of a hub entry lives (the protocol's maximum, as for a hunt). */
const TICKET_LIFETIME_SECONDS = 180;
/** Most peers the host's list carries (the runtime's hub ceiling). */
export const MAXIMUM_PEER_LIST = 64;
const PEER_LISTS_PER_HOUR = 3600;
const peerListCounter = new HourlyCounter();

function DenialError(reason: HubTicketDenial): LauncherApiError {
    const { code, message } = HubTicketDenialError(reason);
    return new LauncherApiError(code, message);
}

/** Admission ticket for the account's open entry into the hub. Runs inside the caller's transaction. */
export async function IssueHubAdmissionTicket(repos: HubRepos, session: ClientSession | undefined, hub: P2PHuntSessionRecord,
    accountId: string, realms: RealmsPort = GetRealmsPort(), nowMs = Date.now()) {
    const presence = await repos.realmHub.findPresence(hub.sessionId, accountId, session);
    const link = await repos.p2pHunts.findSteamLink(accountId, session);
    const check = {
        hub, accountId, presence, link, nowMs, isMember: true, isBanned: false
    };
    // The cheap checks first; the realm's membership is asked only for an entry that is otherwise in order.
    const early = HubTicketDenialReason(check);
    if (early != undefined) throw DenialError(early);
    const [isBanned, isMember] = await Promise.all([realms.isBanned(hub.realmId!, accountId), realms.isMember(hub.realmId!, accountId)]);
    const denial = HubTicketDenialReason({ ...check, isBanned, isMember });
    if (denial != undefined) throw DenialError(denial);

    const issuedAtMs = Date.now();
    const issued = IssueAdmissionTicket({
        accountId,
        joinerSteamId: presence!.peerId,
        hostSteamId: hub.hostSteamId,
        sessionId: hub.sessionId,
        generation: hub.generation,
        partyId: hub.partyId,
        partyRevision: hub.partyRevision,
        huntDefinitionId: hub.huntDefinitionId,
        build: hub.build,
        bridgeProtocol: hub.bridgeProtocol,
        virtualPort: hub.virtualPort,
        lifetimeSeconds: TICKET_LIFETIME_SECONDS
    });
    const ticketExpiresAt = new Date(issued.claims.expiresAt * 1000).toISOString();
    // The row stays live as long as the ticket does; the guard inside the update decides a race with an expiry or a removal.
    const ticketed = await repos.realmHub.markTicketed({
        sessionId: hub.sessionId, generation: hub.generation, accountId, now: new Date(issuedAtMs).toISOString(), ticketExpiresAt
    }, session);
    if (ticketed == undefined) throw new LauncherApiError("P2P_NOT_ROSTERED", "This account has no open entry into the hub.");
    await repos.p2pHunts.createAdmissionTicket({
        jtiDigest: issued.jtiDigest,
        keyId: issued.claims.keyId,
        sessionId: hub.sessionId,
        generation: hub.generation,
        accountId,
        joinerSteamId: presence!.peerId,
        hostSteamId: hub.hostSteamId,
        bridgeProtocol: hub.bridgeProtocol,
        virtualPort: hub.virtualPort,
        issuedAt: new Date(issued.claims.issuedAt * 1000).toISOString(),
        expiresAt: ticketExpiresAt,
        status: "ISSUED"
    }, session);
    return {
        ticket: issued.token,
        expiresAt: ticketExpiresAt,
        rendezvous: {
            sessionId: hub.sessionId,
            generation: hub.generation,
            lobbyId: hub.lobbyId,
            hostSteamId: hub.hostSteamId,
            virtualPort: hub.virtualPort,
            bridgeProtocol: hub.bridgeProtocol,
            build: hub.build
        }
    };
}

/**
 * The host consumed a member's ticket: the member's presence row becomes ADMITTED (no stateVersion write) and, if the hub
 * was still ADMITTING, the first admitted peer takes it to RUNNING (the usual path is the host's own route-ready, which does
 * so). Runs inside ConsumeAdmissionTicket's transaction after the ticket and the transport admission were recorded.
 */
export async function AdmitHubPeer(repos: HubRepos, session: ClientSession | undefined, hub: P2PHuntSessionRecord, input: {
    accountId: string;
    admissionId: string;
    admittedAt: string;
}): Promise<RealmHubPresenceRecord | undefined> {
    // [2026-10-14 repro] The host's own local client: its transport consumes the host ticket at startup (STARTING), before
    // the host's route-ready creates the host's presence row ADMITTED (MarkLocalRouteReady -> admitHost) - there is no entry
    // to mark yet, as a hunt's host is simply on its roster. Requiring one refused every hub start (`host:backend_http_409`).
    if (input.accountId === hub.hostAccountId) return undefined;
    const admitted = await repos.realmHub.markAdmitted({
        sessionId: hub.sessionId, generation: hub.generation, accountId: input.accountId, admissionId: input.admissionId,
        admittedAt: input.admittedAt, now: input.admittedAt
    }, session);
    if (admitted == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "This account has no open entry into the hub.");
    if (hub.state === "ADMITTING") {
        const running = await repos.p2pHunts.compareAndSetHunt({
            sessionId: hub.sessionId, generation: hub.generation, expectedStates: ["ADMITTING"], expectedStateVersion: hub.stateVersion,
            set: { state: "RUNNING" }, unset: ["startupDeadline", "offerExpiresAt"]
        }, session);
        if (running != undefined) {
            await repos.p2pHunts.appendHuntTransition({
                sessionId: hub.sessionId, generation: hub.generation, fromState: "ADMITTING", toState: "RUNNING",
                stateVersion: running.stateVersion, reason: "PARTICIPANT_ADMITTED", actorType: "PARTICIPANT",
                actorAccountId: input.accountId, at: input.admittedAt
            }, session);
        }
    }
    return admitted;
}

/** The transport link of an admitted member closed: its row becomes LOST (a fresh entry is needed to come back). */
export async function HubPeerDisconnected(repos: HubRepos, session: ClientSession | undefined, hub: P2PHuntSessionRecord, input: {
    accountId: string;
    admissionId: string;
    disconnectedAt: string;
    purgeAt: string;
}): Promise<boolean> {
    const lost = await repos.realmHub.markLost({
        sessionId: hub.sessionId, generation: hub.generation, accountId: input.accountId, admissionId: input.admissionId,
        lostAt: input.disconnectedAt, purgeAt: input.purgeAt
    }, session);
    return lost != undefined;
}

/** A member's launcher published its loopback port into the hub (MarkLocalRouteReady, joiner path). */
export async function HubJoinerRouteReady(repos: HubRepos, session: ClientSession | undefined, hub: P2PHuntSessionRecord, input: {
    accountId: string;
    generation: number;
    localBridgePort: number;
    readyAt: string;
}): Promise<RealmHubPresenceRecord | undefined> {
    if (hub.generation !== input.generation || !["HOST_READY", "ADMITTING", "RUNNING"].includes(hub.state)) return undefined;
    return repos.realmHub.markRouteReady({
        sessionId: hub.sessionId, generation: hub.generation, accountId: input.accountId, localBridgePort: input.localBridgePort,
        readyAt: input.readyAt, now: input.readyAt
    }, session);
}

// ---------------------------------------------------------------------------------------------------------------
// POST /launcher/v1/p2p/hunts/:sessionId/peers - the host's list of who to be connected to
// ---------------------------------------------------------------------------------------------------------------

export interface HubPeerListEntry {
    accountId: string;
    peerId: string;
    transportKey: string;
    state: "PENDING" | "TICKETED" | "ADMITTED";
}

/**
 * The peers a hub's host should hold a transport link with: every member that is expected (PENDING, TICKETED) or connected
 * (ADMITTED), the host itself excluded, at most 64, each with the key of its host-member pair. Stateless and mints no relay
 * credential: the launcher diffs the list against its links (adds the new, removes the missing). Only the hub's host may ask.
 */
export async function ListHubPeers(accountId: string, sessionId: string, body: unknown) {
    if (!ReadP2PPolicy().enabled) throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are disabled.");
    if ((await GetP2POperationsPolicy()).p2pEmergencyStop) {
        throw new LauncherApiError("P2P_EMERGENCY_STOP", "Player-hosted hunts are currently stopped by operations policy.");
    }
    const generation = (body as { generation?: unknown } | undefined)?.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation)) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The hub generation is missing.");
    }
    const secret = ReadP2PIceConfig().transportKeySecret;
    if (secret == undefined) throw new LauncherApiError("P2P_ICE_UNAVAILABLE", "The co-op transport is not configured on this server.");
    const repos = GetP2PRepositories();
    const hub = await repos.p2pHunts.findHunt(sessionId);
    if (hub == undefined || !IsRealmHub(hub)) throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Hub session not found.");
    if (hub.hostAccountId !== accountId) throw new LauncherApiError("P2P_NOT_ROSTERED", "Only the hub's host may list its peers.");
    if (hub.generation !== generation) throw new LauncherApiError("P2P_GENERATION_FENCED", "This request belongs to a stale hub generation.");
    if (!IsIceActiveState(hub.state)) throw new LauncherApiError("P2P_SESSION_NOT_READY", "The hub is not running.");
    if (!peerListCounter.allow(`${sessionId}:${hub.generation}`, PEER_LISTS_PER_HOUR, Date.now())) {
        throw new LauncherApiError("P2P_SIGNAL_LIMIT", "Too many peer list requests for this hub.");
    }
    const rows = await repos.realmHub.listByState(hub.sessionId, hub.generation, PRESENCE_LIVE_STATES, MAXIMUM_PEER_LIST + 1);
    const peers: HubPeerListEntry[] = rows.filter((row) => row.accountId !== hub.hostAccountId).slice(0, MAXIMUM_PEER_LIST).map((row) => ({
        accountId: row.accountId,
        peerId: row.peerId,
        transportKey: DeriveIcePairKey(secret, hub.sessionId, hub.generation, hub.hostAccountId, row.accountId),
        state: row.state as HubPeerListEntry["state"]
    }));
    IncrementMetric("mysticparadox_p2p_realm_hub_peer_lists_total", 1);
    return { generation: hub.generation, peers };
}
