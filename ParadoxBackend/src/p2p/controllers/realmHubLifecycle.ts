/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import { logger } from "../../logger";
import { IncrementMetric } from "../../observability/metrics";
import { ReadP2PHostEligibilityPolicy } from "../config/p2pHostPolicy";
import { ReadP2PPolicy } from "../config/p2pPolicy";
import {
    GetP2PRepositories,
    P2PHuntRepository,
    P2PHuntSessionRecord,
    P2PRepositoryProvider,
    RealmHubKind,
    WithP2PTransaction
} from "../persistence";
import { REALM_HUB_MANIFESTS, HUB_OFFER_LIFETIME_MS, HUB_SESSION_LIFETIME_MS } from "../realm/hubManifests";
import {
    DecideHubTick,
    DecideRealmCapacity,
    HubEndCountsAsHostFailure,
    HubPartyKey,
    IsHubLive,
    IsPresenceLive,
    IsRealmHub,
    ParseHubStartBody,
    ParseHubStopBody,
    PresencePurgeAt,
    REALM_HUB_KINDS,
    RealmLowMemoryNote
} from "../realm/realmHubRules";
import {
    IsRealmHostingEnabled,
    ReadHubTransportConstants,
    ReadRealmHubPolicy,
    RealmHostIneligibilityReason
} from "../realm/realmHubPolicy";
import { GetRealmsPort, RealmEventLike, RealmHubState, RealmsPort } from "../realm/realmsPort";
import { InvalidateHubPresence } from "../security/hostCapabilities";
import { DetailedLauncherApiError, LauncherApiError } from "../security/p2pErrors";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { FenceP2PEmergencyStop, GetP2POperationsPolicy } from "../services/p2pOperationsPolicy";
import { roomService } from "../../realtime/RoomService";

// [2026-10-13 realms S1] The lifecycle of a realm's Ramsgate or Training hub on the host's PC, as a P2P session of kind
// REALM_HUB (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 4): creation by the host's launcher, the state
// machine from HOST_OFFERED to RUNNING (the host's own route-ready admits the host locally), the lease clock the monitor runs
// (TickRealmHub), and the end of a hub in every way it can end (EndRealmHub). The rules are in realm/realmHubRules.ts; the
// members of a hub are in the realmHub repository, never on the session record.

type HubRepos = Pick<P2PRepositoryProvider, "p2pHunts" | "realmHub">;

const CONTROL_MESSAGE_LIFETIME_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 5_000;
const ZERO_BREAKDOWN = {
    latencyRisk: 0, networkRisk: 0, memoryRisk: 0, cpuRisk: 0, stabilityRisk: 0, hostLoadRisk: 0, integrityRisk: 0
};

function IsDuplicateKeyError(error: unknown): boolean {
    return (error as { code?: unknown } | undefined)?.code === 11000;
}

/** The switches every hub request needs: realm hosting on, P2P on, no emergency stop, and the ICE transport selected. */
export async function RequireRealmHosting(): Promise<void> {
    if (!IsRealmHostingEnabled()) throw new LauncherApiError("P2P_DISABLED", "Realm hosting is switched off on this server.");
    if (!ReadP2PPolicy().enabled) throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are disabled.");
    const policy = await GetP2POperationsPolicy();
    if (policy.p2pEmergencyStop) {
        throw new LauncherApiError("P2P_EMERGENCY_STOP", "Player-hosted hunts are currently stopped by operations policy.");
    }
    if ((policy.coopTransport ?? "ICE") !== "ICE") {
        throw new LauncherApiError("REALM_TRANSPORT_UNSUPPORTED", "Realm hosting needs the ICE co-op transport, which is not selected on this server.");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// What the realm directory shows (never self-reported by the host)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Mirrors one hub's state into the realm record (setHosting), with the number of live servers. The directory's "serving"
 * flag is derived from it, so a failure here is logged and never fails the request that caused it: the next transition
 * writes the state again.
 */
export async function MirrorHubState(
    realms: RealmsPort,
    hub: Pick<P2PHuntSessionRecord, "sessionId" | "realmId" | "hubKind">,
    state: RealmHubState,
    activeServers?: number
): Promise<void> {
    if (hub.realmId == undefined) return;
    try {
        const patch: Parameters<RealmsPort["setHosting"]>[1] = hub.hubKind === "TRAINING"
            ? { trainingState: state }
            : { hubState: state, hubSessionId: state === "NONE" ? null : hub.sessionId };
        if (activeServers !== undefined) patch.activeServers = activeServers;
        await realms.setHosting(hub.realmId, patch);
    } catch (error) {
        logger.warn(`[RealmHub] could not mirror hub state ${state} into realm ${hub.realmId}: ${error}`);
    }
}

async function MirrorWithCount(realms: RealmsPort, hub: P2PHuntSessionRecord, state: RealmHubState): Promise<void> {
    let activeServers: number | undefined;
    try {
        activeServers = Math.min(32, await GetP2PRepositories().p2pHunts.countActiveRealmServers(hub.realmId!));
    } catch {
        activeServers = undefined;
    }
    await MirrorHubState(realms, hub, state, activeServers);
}

// ---------------------------------------------------------------------------------------------------------------
// Creation: POST /launcher/v1/realm-hosting/hubs/start
// ---------------------------------------------------------------------------------------------------------------

export interface RealmHubSessionStarted {
    sessionId: string;
    generation: 1;
    hubKind: RealmHubKind;
    state: "HOST_OFFERED";
}

/**
 * The realm's host asks to run its Ramsgate or Training hub. Creates the session already at HOST_OFFERED with an ACCEPTED
 * host offer (so host-bootstrap's precondition holds); the launcher calls host-bootstrap at once. One live hub per realm and
 * kind: the unique activePartyKey makes a second start REALM_HUB_EXISTS.
 */
export async function CreateRealmHubSession(accountId: string, body: unknown, nowMs = Date.now()): Promise<RealmHubSessionStarted> {
    await RequireRealmHosting();
    const parsed = ParseHubStartBody(body);
    if (!parsed.ok) throw new LauncherApiError("REALM_VALIDATION_FAILED", parsed.message);
    const realms = GetRealmsPort();
    const realm = await realms.findHostedRealm(accountId);
    if (realm == undefined || realm.hostAccountId !== accountId) throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");

    const hostPolicy = ReadP2PHostEligibilityPolicy();
    const realmPolicy = ReadRealmHubPolicy();
    const operations = await GetP2POperationsPolicy();
    const guardRequired = operations.guardEnforcement === "ENFORCE" || process.env.P2P_LAUNCHER_GUARD_REQUIRED === "true";
    const repos = GetP2PRepositories();
    const presences = await repos.p2pHunts.listHostPresences([accountId], new Date(nowMs - hostPolicy.presenceMaximumAgeMs).toISOString());
    const presence = presences[0];
    if (presence == undefined) {
        throw new DetailedLauncherApiError("REALM_HOST_INELIGIBLE", "This PC has not reported in as a host (HOST_PRESENCE_MISSING).",
            { reason: "HOST_PRESENCE_MISSING" });
    }
    // [2026-10-14 repro] Guard is not asked at a hub START: a realm host may host without playing, and then no Guard
    // session exists yet - Guard verifies the process it protects, and the hub's process exists only after this start
    // (design 6.4: the host role protects the hub's pid). The 14 Oct repro was refused here (HOST_GUARD_UNVERIFIED) with no
    // game running. Guard then follows the running hub through the host presence (GUARD_REQUIRED there); realm hunts still
    // ask for it at their start (RankRealmHost), when the hub's host-role session exists.
    void guardRequired;
    // [2026-10-16] The memory floors are the capacity's (below), as for a realm hunt (RankRealmHost): eligibility gets none, so a host
    // short of free physical memory is no longer REALM_HOST_INELIGIBLE.
    const ineligible = RealmHostIneligibilityReason(presence, hostPolicy, { minimumFreeMemoryMiB: 0, minimumCommitHeadroomMiB: 0 }, false, nowMs);
    if (ineligible != undefined) {
        throw new DetailedLauncherApiError("REALM_HOST_INELIGIBLE", `This PC cannot host the realm right now (${ineligible}).`, { reason: ineligible });
    }
    const capacityInput = {
        activeServers: await repos.p2pHunts.countActiveRealmServers(realm.realmId),
        maxServers: realm.hosting?.maxServers ?? realmPolicy.defaultMaxServers,
        freePhysicalMemoryMiB: presence.freePhysicalMemoryMiB,
        commitHeadroomMiB: presence.commitHeadroomMiB,
        minimumFreeMemoryMiB: realmPolicy.minimumFreeMemoryMiB,
        minimumCommitHeadroomMiB: realmPolicy.minimumCommitHeadroomMiB
    };
    const capacity = DecideRealmCapacity(capacityInput);
    if (!capacity.ok) {
        if (capacity.reason === "REALM_SERVER_LIMIT") throw new LauncherApiError("REALM_FULL", "This realm already runs the most servers its host allows.");
        throw new DetailedLauncherApiError("REALM_HOST_INELIGIBLE", `This PC cannot host the realm right now (${capacity.reason}).`, { reason: capacity.reason });
    }
    if (capacity.lowFreeMemory) logger.warn(RealmLowMemoryNote(realm.realmId, `${parsed.hubKind} hub`, capacityInput));

    const manifest = REALM_HUB_MANIFESTS[parsed.hubKind];
    const partyKey = HubPartyKey(realm.realmId, parsed.hubKind);
    const peerId = DeriveIcePeerId(accountId);
    const sessionId = crypto.randomUUID();
    const offerId = crypto.randomUUID();
    const at = new Date(nowMs).toISOString();
    const offerExpiresAt = new Date(nowMs + HUB_OFFER_LIFETIME_MS).toISOString();
    const hub: P2PHuntSessionRecord = {
        sessionId,
        generation: 1,
        state: "HOST_OFFERED",
        stateVersion: 1,
        partyId: partyKey,
        activePartyKey: partyKey,
        partyRevision: 1,
        huntDefinitionId: manifest.huntDefinitionId,
        gameMode: manifest.gameMode,
        ...ReadHubTransportConstants(),
        hostAccountId: accountId,
        hostSteamId: peerId,
        bridgeInstanceId: "",
        coopTransport: "ICE",
        roster: [],
        createdAt: at,
        expiresAt: new Date(nowMs + HUB_SESSION_LIFETIME_MS).toISOString(),
        matchmakerHuntId: manifest.matchmakerHuntId,
        mapPath: manifest.mapPath,
        behemothPath: manifest.behemothPath,
        expectedPlayerString: manifest.expectedPlayerString,
        guardCompletionMode: manifest.guardCompletionMode,
        trustTier: 0,
        hostOfferId: offerId,
        offerExpiresAt,
        sessionKind: "REALM_HUB",
        hubKind: parsed.hubKind,
        realmId: realm.realmId,
        hostParticipates: true,
        hubRoomId: realms.hubRoomId(realm.realmId, parsed.hubKind),
        maxPeers: parsed.maxPlayers
    };
    try {
        await WithP2PTransaction(async (txRepos, session) => {
            // Serialize creation against the durable operator stop, as a hunt's creation does.
            if (!await FenceP2PEmergencyStop(session)) {
                throw new LauncherApiError("P2P_EMERGENCY_STOP", "Player-hosted hunts are currently stopped by operations policy.");
            }
            if (await txRepos.p2pHunts.findActiveHuntForParty(partyKey, session) != undefined) {
                throw new LauncherApiError("REALM_HUB_EXISTS", "This realm already has a running hub of that kind.");
            }
            await txRepos.p2pHunts.createHunt(hub, session);
            await txRepos.p2pHunts.appendHuntTransition({
                sessionId, generation: 1, fromState: "REQUESTED", toState: "HOST_OFFERED", stateVersion: 1,
                reason: "REALM_HUB_CREATED", actorType: "HOST", actorAccountId: accountId, at
            }, session);
            await txRepos.p2pHunts.createHostOffer({
                offerId, sessionId, generation: 1, accountId, steamId: peerId, rank: 0, score: 0, scoreBreakdown: { ...ZERO_BREAKDOWN },
                status: "ACCEPTED", offeredAt: at, expiresAt: offerExpiresAt, respondedAt: at, responseReason: "REALM_HOST"
            }, session);
        });
    } catch (error) {
        // The unique index on activePartyKey decides a race between two starts that both passed the check above.
        if (IsDuplicateKeyError(error)) throw new LauncherApiError("REALM_HUB_EXISTS", "This realm already has a running hub of that kind.");
        throw error;
    }
    logger.info({ event: "realm_hub_created", sessionId, realmId: realm.realmId, hubKind: parsed.hubKind, maxPeers: parsed.maxPlayers },
        `[RealmHub] ${parsed.hubKind} hub session ${sessionId} created for realm ${realm.realmId}`);
    IncrementMetric("mysticparadox_p2p_realm_hub_transitions_total", 1, { to: "HOST_OFFERED", kind: parsed.hubKind });
    await MirrorWithCount(realms, hub, "STARTING");
    return { sessionId, generation: 1, hubKind: parsed.hubKind, state: "HOST_OFFERED" };
}

/**
 * POST .../hubs/stop: the realm's host ends its running hub of that kind (a clean end). Idempotent: a realm with no live hub
 * of that kind answers `stopped: false`. Needs no switch to be on - cleaning up must always be possible.
 */
export async function StopRealmHubSession(accountId: string, body: unknown) {
    const parsed = ParseHubStopBody(body);
    if (!parsed.ok) throw new LauncherApiError("REALM_VALIDATION_FAILED", parsed.message);
    const realms = GetRealmsPort();
    const realm = await realms.findHostedRealm(accountId);
    if (realm == undefined || realm.hostAccountId !== accountId) throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
    const hub = await GetP2PRepositories().p2pHunts.findActiveHuntForParty(HubPartyKey(realm.realmId, parsed.hubKind));
    if (hub == undefined || !IsRealmHub(hub) || hub.hostAccountId !== accountId) return { stopped: false, hubKind: parsed.hubKind };
    await MirrorHubState(realms, hub, "STOPPING");
    const ended = await EndRealmHub(hub.sessionId, hub.generation, "HOST_STOPPED", "COMPLETED", { actorType: "HOST", actorAccountId: accountId });
    return { stopped: ended != undefined, hubKind: parsed.hubKind, sessionId: hub.sessionId, state: ended?.record.state };
}

// ---------------------------------------------------------------------------------------------------------------
// The end of a hub
// ---------------------------------------------------------------------------------------------------------------

export interface EndRealmHubOptions {
    actorType: "SYSTEM" | "HOST" | "ADMIN";
    actorAccountId?: string;
    /** The realm is gone (released): do not write the realm record, and the presence rows become REMOVED, not LOST. */
    realmReleased?: boolean;
}

export interface EndRealmHubResult {
    record: P2PHuntSessionRecord;
    /** Accounts whose presence row was live when the hub ended (the host's included). */
    endedAccountIds: string[];
}

/**
 * Ends a live hub (COMPLETED for a clean end, ABORTED for a failure), in one transaction: revokes the generation's host
 * capability and unconsumed admission tickets, closes the session (freeing its activePartyKey), turns every live presence row
 * into LOST (REMOVED for a released realm), tells each affected member (REALM_SESSION_LEAVE) and the host (FENCE_NOW) and
 * records the host's reliability. Afterwards the realm record shows no hub (and the realm offline, for a Ramsgate hub) and
 * the realm's hunts of the same host end with it. Returns undefined when the hub had already moved on.
 */
export async function EndRealmHub(sessionId: string, generation: number, reason: string, terminal: "COMPLETED" | "ABORTED",
    options: EndRealmHubOptions = { actorType: "SYSTEM" }): Promise<EndRealmHubResult | undefined> {
    const now = new Date();
    const at = now.toISOString();
    const ended = await WithP2PTransaction(async (repos, session) => {
        const hub = await repos.p2pHunts.findHunt(sessionId, session);
        if (hub == undefined || !IsRealmHub(hub) || hub.generation !== generation || !IsHubLive(hub.state)) return undefined;
        await repos.p2pHunts.revokeGeneration(sessionId, generation, at, session);
        await repos.p2pHunts.revokeAdmissionTickets(sessionId, generation, session);
        const closed = await repos.p2pHunts.compareAndSetHunt({
            sessionId,
            generation,
            expectedStates: [hub.state],
            expectedStateVersion: hub.stateVersion,
            set: {
                state: terminal,
                terminalAt: at,
                completionReason: reason,
                ...(terminal === "ABORTED" ? { failureReason: reason } : {})
            },
            unset: ["activePartyKey", "leaseExpiresAt", "suspectSince", "suspectDeadline", "preSuspectState", "offerExpiresAt", "startupDeadline"]
        }, session);
        if (closed == undefined) return undefined;
        await repos.p2pHunts.appendHuntTransition({
            sessionId, generation, fromState: hub.state, toState: terminal, stateVersion: closed.stateVersion,
            reason, actorType: options.actorType, actorAccountId: options.actorAccountId, at
        }, session);
        const purgeAt = PresencePurgeAt(now.getTime());
        const rows = options.realmReleased === true && hub.realmId != undefined
            ? await repos.realmHub.removeRealm({ realmId: hub.realmId, at, purgeAt }, session)
            : await repos.realmHub.endSession({ sessionId, generation, at, purgeAt }, session);
        const expiresAt = new Date(now.getTime() + CONTROL_MESSAGE_LIFETIME_MS).toISOString();
        for (const row of rows) {
            if (row.sessionId !== sessionId || row.accountId === hub.hostAccountId) continue;
            await repos.p2pHunts.enqueueControlMessage({
                accountId: row.accountId, messageType: "REALM_SESSION_LEAVE", sessionId, generation,
                payload: { sessionId, generation, reason, hubKind: hub.hubKind, realmId: hub.realmId }, createdAt: at, expiresAt
            }, session);
        }
        await repos.p2pHunts.enqueueControlMessage({
            accountId: hub.hostAccountId, messageType: "FENCE_NOW", sessionId, generation,
            payload: { reason, recoveryAction: "NONE", cleanEnd: terminal === "COMPLETED" }, createdAt: at, expiresAt
        }, session);
        if (terminal === "COMPLETED") {
            await repos.p2pHunts.incrementHostReliability(hub.hostAccountId, { cleanCompletions: 1 }, at, undefined, session);
        } else if (HubEndCountsAsHostFailure(reason)) {
            // No cooldown: the launcher restarts a dead hub within seconds, and a realm host is not selected among others.
            await repos.p2pHunts.incrementHostReliability(hub.hostAccountId,
                reason === "HUB_STARTUP_TIMEOUT" ? { startsFailed: 1 } : { unexpectedFailures: 1 }, at, undefined, session);
        }
        return { record: closed, hub, rows };
    });
    if (ended == undefined) return undefined;
    InvalidateHubPresence(sessionId);
    const { record, hub } = ended;
    logger.info({ event: "realm_hub_ended", sessionId, generation, realmId: hub.realmId, hubKind: hub.hubKind, state: record.state, reason,
        presentAtEnd: ended.rows.length }, `[RealmHub] ${hub.hubKind} hub ${sessionId} ended state=${record.state} reason=${reason} members=${ended.rows.length}`);
    IncrementMetric("mysticparadox_p2p_realm_hub_transitions_total", 1, { to: record.state, kind: hub.hubKind ?? "UNKNOWN" });
    if (options.realmReleased !== true && hub.realmId != undefined) {
        const realms = GetRealmsPort();
        await MirrorWithCount(realms, record, "NONE");
        if (hub.hubKind === "RAMSGATE") {
            try {
                await realms.markOffline(hub.realmId);
            } catch (error) {
                logger.warn(`[RealmHub] could not mark realm ${hub.realmId} offline: ${error}`);
            }
        }
    }
    if (hub.hubKind === "RAMSGATE" && hub.realmId != undefined) await EndRealmHuntsOfHost(hub.realmId, hub.hostAccountId, reason);
    return { record, endedAccountIds: ended.rows.map((row) => row.accountId) };
}

/** The realm's hunts on the same host end with its Ramsgate (their host is gone or going). Best effort, one by one. */
async function EndRealmHuntsOfHost(realmId: string, hostAccountId: string, reason: string): Promise<void> {
    try {
        const hunts = await GetP2PRepositories().p2pHunts.listLiveRealmHunts(realmId, hostAccountId);
        if (hunts.length === 0) return;
        // Loaded here, not at import: p2pHostLifecycle imports this file for the monitor's hub branch.
        const lifecycle = require("./p2pHostLifecycle") as typeof import("./p2pHostLifecycle");
        for (const hunt of hunts) {
            await lifecycle.EndP2PHuntSession(hunt.sessionId, hunt.generation, `REALM_HUB_ENDED_${reason}`.slice(0, 96), {
                allowedStates: lifecycle.SUPERSEDE_STATES, actorType: "SYSTEM"
            });
        }
    } catch (error) {
        logger.warn(`[RealmHub] could not end the realm hunts of host ${hostAccountId} (realm ${realmId}): ${error}`);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The host's own route (MarkLocalRouteReady, host path)
// ---------------------------------------------------------------------------------------------------------------

export interface HubRouteReadyOutcome {
    hub: P2PHuntSessionRecord;
    /** The hub moved to RUNNING by this call (the realm directory is told after the transaction). */
    becameRunning: boolean;
}

/**
 * The host published its loopback port into its own hub. The hub moves HOST_READY -> ADMITTING -> RUNNING at once and the
 * host's presence row is created ADMITTED (the host is admitted locally: no ticket, nothing to consume centrally - what
 * HOST_ADMITTED_LOCALLY does for a hunt). A repeated call (the host's bridge restarted) only updates the port. Returns
 * undefined when the hub or its generation does not accept a route.
 */
export async function HubHostRouteReady(repos: HubRepos, session: ClientSession | undefined, hub: P2PHuntSessionRecord,
    accountId: string, generation: number, localBridgePort: number, now = new Date()): Promise<HubRouteReadyOutcome | undefined> {
    if (hub.generation !== generation || hub.hostAccountId !== accountId ||
        !["HOST_READY", "ADMITTING", "RUNNING"].includes(hub.state)) return undefined;
    const at = now.toISOString();
    let current = hub;
    let becameRunning = false;
    if (current.state === "HOST_READY") {
        const admitting = await repos.p2pHunts.compareAndSetHunt({
            sessionId: current.sessionId, generation: current.generation, expectedStates: ["HOST_READY"],
            expectedStateVersion: current.stateVersion,
            set: { state: "ADMITTING", hostLocalBridgePort: localBridgePort, hostLocalBridgeReadyAt: at }
        }, session);
        if (admitting == undefined) return undefined;
        await repos.p2pHunts.appendHuntTransition({
            sessionId: current.sessionId, generation: current.generation, fromState: "HOST_READY", toState: "ADMITTING",
            stateVersion: admitting.stateVersion, reason: "HOST_LOCAL_ROUTE_READY", actorType: "HOST", actorAccountId: accountId, at
        }, session);
        await repos.p2pHunts.incrementHostReliability(accountId, { startsSucceeded: 1 }, at, undefined, session);
        current = admitting;
    } else if (current.hostLocalBridgePort !== localBridgePort) {
        const updated = await repos.p2pHunts.compareAndSetHunt({
            sessionId: current.sessionId, generation: current.generation, expectedStates: [current.state],
            expectedStateVersion: current.stateVersion,
            set: { hostLocalBridgePort: localBridgePort, hostLocalBridgeReadyAt: at }
        }, session);
        if (updated == undefined) return undefined;
        current = updated;
    }
    await repos.realmHub.admitHost({
        sessionId: current.sessionId, generation: current.generation, realmId: current.realmId!, accountId,
        peerId: current.hostSteamId, localBridgePort, now: at
    }, session);
    if (current.state === "ADMITTING") {
        const running = await repos.p2pHunts.compareAndSetHunt({
            sessionId: current.sessionId, generation: current.generation, expectedStates: ["ADMITTING"],
            expectedStateVersion: current.stateVersion, set: { state: "RUNNING" },
            unset: ["startupDeadline", "offerExpiresAt"]
        }, session);
        if (running == undefined) return undefined;
        await repos.p2pHunts.appendHuntTransition({
            sessionId: current.sessionId, generation: current.generation, fromState: "ADMITTING", toState: "RUNNING",
            stateVersion: running.stateVersion, reason: "HOST_ADMITTED_LOCALLY", actorType: "HOST", actorAccountId: accountId, at
        }, session);
        current = running;
        becameRunning = true;
    }
    return { hub: current, becameRunning };
}

/**
 * The control message that tells a member's launcher to join a hub (the existing JOIN_RENDEZVOUS, with the hub's kind). `entryId`
 * is the member's candidate id: one per entry, so the launcher can tell a repeated message from a new entry.
 */
export function HubJoinRendezvous(hub: Pick<P2PHuntSessionRecord, "sessionId" | "generation" | "hubKind">, entryId: string, now = Date.now()) {
    return {
        messageType: "JOIN_RENDEZVOUS" as const,
        sessionId: hub.sessionId,
        generation: hub.generation,
        payload: { sessionId: hub.sessionId, generation: hub.generation, role: "JOIN", sessionKind: "REALM_HUB", hubKind: hub.hubKind, entryId },
        expiresAt: new Date(now + CONTROL_MESSAGE_LIFETIME_MS).toISOString()
    };
}

/** Sends one member's JOIN_RENDEZVOUS for a hub (the member's launcher joins the hub; see HubJoinRendezvous). */
export async function EnqueueHubJoin(p2pHunts: P2PHuntRepository, hub: Pick<P2PHuntSessionRecord, "sessionId" | "generation" | "hubKind">,
    accountId: string, entryId: string): Promise<void> {
    const message = HubJoinRendezvous(hub, entryId);
    await p2pHunts.enqueueControlMessage({
        accountId, messageType: message.messageType, sessionId: message.sessionId, generation: message.generation,
        payload: message.payload, createdAt: new Date().toISOString(), expiresAt: message.expiresAt
    });
}

/**
 * Asks each waiting member of a hub (PENDING or TICKETED and not expired, the host excluded) to join it now. A Training hub is
 * started on demand, so members who asked while it was starting wait for its route-ready; this is what releases them. An entry
 * that expired while the hub started is not announced: its candidate is refused (REALM_ENTRY_EXPIRED) and the member asks again.
 */
export async function AnnounceWaitingMembers(hub: P2PHuntSessionRecord): Promise<number> {
    const repos = GetP2PRepositories();
    const nowIso = new Date().toISOString();
    const waiting = await repos.realmHub.listByState(hub.sessionId, hub.generation, ["PENDING", "TICKETED"], 256);
    let sent = 0;
    for (const row of waiting) {
        if (row.accountId === hub.hostAccountId || !IsPresenceLive(row, nowIso)) continue;
        await EnqueueHubJoin(repos.p2pHunts, hub, row.accountId, row.candidateId);
        sent += 1;
    }
    return sent;
}

/** After the route-ready transaction: the realm directory shows a serving hub, and the presence cache forgets the old list. */
export async function FinishHubRouteReady(outcome: HubRouteReadyOutcome): Promise<void> {
    InvalidateHubPresence(outcome.hub.sessionId);
    if (!outcome.becameRunning) return;
    logger.info({ event: "realm_hub_running", sessionId: outcome.hub.sessionId, realmId: outcome.hub.realmId, hubKind: outcome.hub.hubKind },
        `[RealmHub] ${outcome.hub.hubKind} hub ${outcome.hub.sessionId} is RUNNING`);
    IncrementMetric("mysticparadox_p2p_realm_hub_transitions_total", 1, { to: "RUNNING", kind: outcome.hub.hubKind ?? "UNKNOWN" });
    await MirrorWithCount(GetRealmsPort(), outcome.hub, "RUNNING");
    try {
        await AnnounceWaitingMembers(outcome.hub);
    } catch (error) {
        logger.warn(`[RealmHub] could not announce the waiting members of hub ${outcome.hub.sessionId}: ${error}`);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The lifecycle monitor's hub branch
// ---------------------------------------------------------------------------------------------------------------

const LastSweepAt = new Map<string, number>();

async function MarkHubSuspect(hub: P2PHuntSessionRecord, reason: string): Promise<void> {
    const now = new Date();
    await WithP2PTransaction(async (repos, session) => {
        const suspect = await repos.p2pHunts.compareAndSetHunt({
            sessionId: hub.sessionId, generation: hub.generation, expectedStates: [hub.state], expectedStateVersion: hub.stateVersion,
            set: {
                state: "SUSPECT",
                preSuspectState: hub.state,
                suspectSince: now.toISOString(),
                suspectDeadline: new Date(now.getTime() + ReadP2PHostEligibilityPolicy().suspectLifetimeMs).toISOString(),
                failureReason: reason
            }
        }, session);
        if (suspect == undefined) return;
        await repos.p2pHunts.appendHuntTransition({
            sessionId: hub.sessionId, generation: hub.generation, fromState: hub.state, toState: "SUSPECT",
            stateVersion: suspect.stateVersion, reason, actorType: "SYSTEM", at: now.toISOString()
        }, session);
    });
}

async function RecoverHub(hub: P2PHuntSessionRecord): Promise<void> {
    const recovered = await GetP2PRepositories().p2pHunts.compareAndSetHunt({
        sessionId: hub.sessionId, generation: hub.generation, expectedStates: ["SUSPECT"], expectedStateVersion: hub.stateVersion,
        set: { state: hub.preSuspectState!, failureReason: "LEASE_RECOVERED" },
        unset: ["suspectSince", "suspectDeadline", "preSuspectState"]
    });
    if (recovered != undefined) {
        await GetP2PRepositories().p2pHunts.appendHuntTransition({
            sessionId: hub.sessionId, generation: hub.generation, fromState: "SUSPECT", toState: recovered.state,
            stateVersion: recovered.stateVersion, reason: "LEASE_RECOVERED", actorType: "SYSTEM", at: new Date().toISOString()
        });
    }
}

/** Expires entries that never came in (PENDING and TICKETED rows past their time); at most every few seconds per hub. */
async function SweepStaleEntries(hub: P2PHuntSessionRecord, nowMs: number): Promise<void> {
    if (nowMs - (LastSweepAt.get(hub.sessionId) ?? 0) < SWEEP_INTERVAL_MS) return;
    LastSweepAt.set(hub.sessionId, nowMs);
    if (LastSweepAt.size > 1024) LastSweepAt.clear();
    const expired = await GetP2PRepositories().realmHub.expireStale({
        sessionId: hub.sessionId, now: new Date(nowMs).toISOString(), purgeAt: PresencePurgeAt(nowMs)
    });
    if (expired.length > 0) {
        InvalidateHubPresence(hub.sessionId);
        logger.info(`[RealmHub] ${expired.length} entry(ies) into hub ${hub.sessionId} expired`);
    }
}

/**
 * One monitor tick for a live hub. Hunt-only logic (HostLossIsCleanEnd, the participant-observation quorum, recovery) never
 * runs for a hub: its lease lapsing makes it SUSPECT, the suspect window running out ends it ABORTED (HOST_LEASE_LOST).
 */
export async function TickRealmHub(hub: P2PHuntSessionRecord, nowMs: number, input: { emergencyStop: boolean }): Promise<void> {
    const decision = DecideHubTick(hub, {
        nowMs,
        emergencyStop: input.emergencyStop,
        hostingEnabled: IsRealmHostingEnabled() && ReadP2PPolicy().enabled
    });
    switch (decision.action) {
        case "END":
            await EndRealmHub(hub.sessionId, hub.generation, decision.reason, decision.terminal, { actorType: "SYSTEM" });
            return;
        case "SUSPECT":
            await MarkHubSuspect(hub, decision.reason);
            return;
        case "RECOVER":
            await RecoverHub(hub);
            return;
        case "NONE":
            if (hub.state === "RUNNING") await SweepStaleEntries(hub, nowMs);
            return;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// What the realms module tells us (SetRealmEventSink)
// ---------------------------------------------------------------------------------------------------------------

const LEAVE_REASON: Record<"KICK" | "BAN" | "LEAVE", string> = { KICK: "KICKED", BAN: "BANNED", LEAVE: "LEFT" };

/**
 * A member was kicked, banned or left: every live presence row of the account in the realm becomes REMOVED, the host's
 * launcher is told to re-read its peer list (it closes the link) and the member's launcher to stop its join. A ticket the
 * member still holds cannot be consumed afterwards (its presence row is no longer live).
 */
export async function RemoveRealmMemberFromHubs(realmId: string, accountId: string, reason: "KICK" | "BAN" | "LEAVE"): Promise<number> {
    const now = new Date();
    const at = now.toISOString();
    const removed = await WithP2PTransaction(async (repos, session) => {
        const rows = await repos.realmHub.removeAccountFromRealm({ realmId, accountId, at, purgeAt: PresencePurgeAt(now.getTime()) }, session);
        const expiresAt = new Date(now.getTime() + CONTROL_MESSAGE_LIFETIME_MS).toISOString();
        for (const row of rows) {
            const hub = await repos.p2pHunts.findHunt(row.sessionId, session);
            if (hub == undefined || !IsRealmHub(hub)) continue;
            await repos.p2pHunts.revokeAdmissionTicketsForAccount(hub.sessionId, accountId, session);
            await repos.p2pHunts.enqueueControlMessage({
                accountId: hub.hostAccountId, messageType: "REALM_PEER_EXPECTED", sessionId: hub.sessionId, generation: hub.generation,
                payload: { sessionId: hub.sessionId, generation: hub.generation }, createdAt: at, expiresAt
            }, session);
            await repos.p2pHunts.enqueueControlMessage({
                accountId, messageType: "REALM_SESSION_LEAVE", sessionId: hub.sessionId, generation: hub.generation,
                payload: { sessionId: hub.sessionId, generation: hub.generation, reason: LEAVE_REASON[reason], hubKind: hub.hubKind, realmId },
                createdAt: at, expiresAt
            }, session);
        }
        return rows;
    });
    for (const row of removed) InvalidateHubPresence(row.sessionId);
    if (removed.length > 0) logger.info(`[RealmHub] member removed from ${removed.length} hub session(s) of realm ${realmId} reason=${reason}`);
    return removed.length;
}

/** The realms module's event sink (InstallRealmEventSink). Errors propagate to the module, which logs them and moves on. */
export async function HandleRealmEvent(event: RealmEventLike): Promise<void> {
    switch (event.type) {
        case "MEMBER_REMOVED":
            await RemoveRealmMemberFromHubs(event.realmId, event.accountId, event.reason);
            // [2026-10-14 realms S2, design section 7.5] The member's City chat room (the hub's) goes with the membership: a kicked,
            // banned or departed member is removed from it at once, and the chat's own rule refuses the rejoin.
            roomService.evictRealmMember(event.realmId, event.accountId);
            return;
        case "REALM_RELEASED":
            for (const kind of REALM_HUB_KINDS) {
                const hub = await GetP2PRepositories().p2pHunts.findActiveHuntForParty(HubPartyKey(event.realmId, kind));
                if (hub != undefined && IsRealmHub(hub)) {
                    await EndRealmHub(hub.sessionId, hub.generation, "REALM_RELEASED", "COMPLETED", { actorType: "SYSTEM", realmReleased: true });
                }
            }
            return;
        case "HOST_OFFLINE":
            // The host's lease is the truth about a running hub; the directory's own offline notice changes nothing here.
            logger.info(`[RealmHub] realm ${event.realmId} reported offline by the directory`);
            return;
    }
}
