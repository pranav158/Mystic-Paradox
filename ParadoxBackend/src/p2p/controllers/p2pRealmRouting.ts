/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import type { MatchmakingResult } from "../../controllers/matchmaking";
import type { HuntRouteContext, HuntRouteOutcome } from "../../extensions/p2p";
import { logger } from "../../logger";
import { IsKnownRuntimeIncompatible } from "../config/p2pPolicy";
import { GetP2PRepositories, P2PHuntSessionRecord, RealmHubKind } from "../persistence";
import {
    ClassifyRealmRequest,
    EntryExpiresAt,
    HubPartyKey,
    IsHubLive,
    IsRealmHub,
    RealmRequestClass
} from "../realm/realmHubRules";
import { GetRealmsPort, RealmSummary } from "../realm/realmsPort";
import { InvalidateHubPresence } from "../security/hostCapabilities";
import { LauncherApiError } from "../security/p2pErrors";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { CreateRealmHubSession, EnqueueHubJoin, RequireRealmHosting } from "./realmHubLifecycle";
import { CloseRecoveredSessionForParty, NoteHubReturn } from "./p2pHostLifecycle";

// [2026-10-14 realms S2] A realm member's matchmaking request (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md sections 3.1-3.4):
// a request of a member of a realm whose presence is bound to it is answered here and never falls back to a dedicated server.
// The realm's Ramsgate and Training hubs take the member and its party (the members present in the realm); a hunt goes to the
// realm's host through the shared hunt creation. Membership, bans and the host's state come from the realms module (GetRealmsPort).

/** A Training hub that is not running this long after it was asked for is refused (REALM_HUB_START_TIMEOUT). */
export const REALM_HUB_START_TIMEOUT_MS = 90_000;
// [2026-10-14] Every hunt class routes as a realm hunt (owner decision; design section 12 D2 is superseded). Gauntlet is refused
// before this route by RouteP2PHunt (MYSTICPARADOX_GAUNTLET), and FTUE stays refused (IsKnownRuntimeIncompatible).
const CONTROL_MESSAGE_LIFETIME_MS = 10 * 60_000;
const HOST_LOOPBACK = "127.0.0.1";

/** What a realm hunt is created with (the shared hunt creation, with the realm option). */
export interface RealmHuntStart {
    gameMode: string;
    huntId: string;
    partyId: string;
    partyRevision: number;
    /** The party's members who are in the realm, the requester first. The rest of the party is left alone. */
    members: string[];
    realmId: string;
    hostAccountId: string;
}

export interface RealmRouteDeps {
    /** Starts the realm hunt (CreatePlayerHostedMatchmaking with the realm option); a refusal is the cancel reason. */
    createRealmHunt(Context: HuntRouteContext, start: RealmHuntStart): Promise<{ created: true } | { created: false; reason: string }>;
    /**
     * [2026-10-14 realms S5] The requester's own solo party, for a request that carries no party state: the party POST /party creates
     * for a player on first use (controllers/party.ts GetOrCreateParty).
     */
    soloParty(accountId: string, buildId: string): Promise<{ partyId: string; revision: number }>;
}

/** The candidate of a hub entry: the matchmaker answers its status from the hub session (Source REALM_HUB, see candidate status). */
export function HubCandidate(hub: P2PHuntSessionRecord, candidateId: string, ready: boolean, port?: number): MatchmakingResult {
    return {
        Ready: ready,
        CandidateId: candidateId,
        GameSessionId: hub.hubRoomId ?? "",
        HuntId: hub.huntDefinitionId,
        Host: ready ? HOST_LOOPBACK : "",
        Port: ready ? (port ?? 0) : 0,
        ReadyAt: 0,
        Source: "REALM_HUB",
        SourceSessionId: hub.sessionId
    };
}

function Refuse(Context: HuntRouteContext, accountIds: readonly string[], reason: string): HuntRouteOutcome {
    return { handled: true, result: Context.cancel(Context.huntId, accountIds, reason) };
}

/** The live hub of one kind of a realm (a RUNNING, STARTING or otherwise live session), or undefined. */
async function LiveHub(realmId: string, kind: RealmHubKind): Promise<P2PHuntSessionRecord | undefined> {
    const hub = await GetP2PRepositories().p2pHunts.findActiveHuntForParty(HubPartyKey(realmId, kind));
    return hub != undefined && IsRealmHub(hub) && IsHubLive(hub.state) ? hub : undefined;
}

/** The party's members that are in the realm: the requester (checked by the caller) plus each other member bound to it. */
async function MembersInRealm(Context: HuntRouteContext, realm: RealmSummary): Promise<string[]> {
    const realms = GetRealmsPort();
    const placed = [Context.playerId];
    for (const accountId of new Set(Context.partyMembers ?? [])) {
        if (accountId === Context.playerId) continue;
        const presence = await realms.presenceOf(accountId);
        if (presence?.realmId !== realm.realmId) continue;
        if (await realms.isBanned(realm.realmId, accountId) || !(await realms.isMember(realm.realmId, accountId))) continue;
        placed.push(accountId);
    }
    return placed;
}

/**
 * Starts a Training hub on demand (the realm's host runs it): the hub session is created, and the host's launcher is told to
 * bootstrap it (HUNT_BOOTSTRAP, the backend-initiated start). A concurrent start that won the activePartyKey is joined instead.
 */
async function StartTrainingHub(realm: RealmSummary): Promise<P2PHuntSessionRecord> {
    try {
        const started = await CreateRealmHubSession(realm.hostAccountId, { hubKind: "TRAINING", maxPlayers: realm.hosting?.maxPlayers });
        const hub = await GetP2PRepositories().p2pHunts.findHunt(started.sessionId);
        if (hub == undefined) throw new LauncherApiError("REALM_HOST_OFFLINE", "The realm's Training hub could not be started.");
        await GetP2PRepositories().p2pHunts.enqueueControlMessage({
            accountId: realm.hostAccountId,
            messageType: "HUNT_BOOTSTRAP",
            sessionId: started.sessionId,
            generation: started.generation,
            payload: { sessionId: started.sessionId, generation: started.generation, role: "HOST", hubKind: "TRAINING" },
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + CONTROL_MESSAGE_LIFETIME_MS).toISOString()
        });
        logger.info({ event: "realm_training_started", sessionId: started.sessionId, realmId: realm.realmId },
            `[RealmRoute] Training hub ${started.sessionId} started on demand for realm ${realm.realmId}`);
        return hub;
    } catch (error) {
        if (error instanceof LauncherApiError && error.code === "REALM_HUB_EXISTS") {
            const existing = await LiveHub(realm.realmId, "TRAINING");
            if (existing != undefined) return existing;
        }
        throw error;
    }
}

/**
 * Places the requester's realm members in a hub (section 3.2). The host's own entry is ready at once on its loopback port
 * (a host has no join); a member gets a fresh entry (PENDING) and, when the hub is running, a JOIN_RENDEZVOUS. The host is told
 * once that peers are expected. A capacity refusal places nobody.
 */
async function PlaceInHub(Context: HuntRouteContext, hub: P2PHuntSessionRecord, members: string[]): Promise<void> {
    const repos = GetP2PRepositories();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const maxPeers = hub.maxPeers ?? 1;
    // [realms wave 2, capacity] The seats are taken in one repository step: the hub's live count and the members who are not live
    // yet are checked against maxPeers and written together, so concurrent requests cannot overshoot it, and a full hub places
    // nobody. A member already present never needs a seat (the host always holds one).
    const requests = members.filter((accountId) => accountId !== hub.hostAccountId)
        .map((accountId) => ({ accountId, peerId: DeriveIcePeerId(accountId), candidateId: crypto.randomUUID() }));
    const batch = requests.length > 0 ? await repos.realmHub.requestEntries({
        sessionId: hub.sessionId,
        generation: hub.generation,
        realmId: hub.realmId!,
        maxPeers,
        entries: requests,
        now: nowIso,
        expiresAt: EntryExpiresAt(now)
    }) : undefined;
    // The repository does not touch the one-second presence cache: this process forgets the hub's list after the entries.
    InvalidateHubPresence(hub.sessionId);
    if (batch !== undefined && !batch.placed) throw new LauncherApiError("REALM_HUB_FULL", "This realm's hub is full right now.");

    const running = hub.state === "RUNNING";
    const placed: Array<{ accountId: string; candidateId: string }> = [];
    for (const accountId of members) {
        if (accountId === hub.hostAccountId) {
            const port = hub.hostLocalBridgePort;
            Context.setCandidate(accountId, HubCandidate(hub, crypto.randomUUID(), running && port != undefined, port));
        }
    }
    for (const entry of batch?.placed ? batch.entries : []) {
        Context.setCandidate(entry.accountId, HubCandidate(hub, entry.record.candidateId, false));
        placed.push({ accountId: entry.accountId, candidateId: entry.record.candidateId });
    }
    if (placed.length > 0) {
        await repos.p2pHunts.enqueueControlMessage({
            accountId: hub.hostAccountId,
            messageType: "REALM_PEER_EXPECTED",
            sessionId: hub.sessionId,
            generation: hub.generation,
            payload: { sessionId: hub.sessionId, generation: hub.generation },
            createdAt: nowIso,
            expiresAt: new Date(now + CONTROL_MESSAGE_LIFETIME_MS).toISOString()
        });
    }
    if (running) {
        for (const member of placed) await EnqueueHubJoin(repos.p2pHunts, hub, member.accountId, member.candidateId);
    }
    logger.info({ event: "realm_hub_entry", sessionId: hub.sessionId, realmId: hub.realmId, hubKind: hub.hubKind, placed: placed.length,
        host: members.includes(hub.hostAccountId), running },
    `[RealmRoute] ${placed.length} member(s) placed in ${hub.hubKind} hub ${hub.sessionId} running=${running}`);
}

async function RouteRealmHub(Context: HuntRouteContext, realm: RealmSummary, members: string[], kind: RealmHubKind): Promise<HuntRouteOutcome> {
    // The member asks for a hub: it has left any realm hunt it was in (the last one out ends that hunt, as for any hub request).
    try {
        await NoteHubReturn(Context.playerId);
    } catch (error) {
        logger.warn(`[RealmRoute] hub return of ${Context.playerId} not recorded: ${error}`);
    }
    let hub: P2PHuntSessionRecord | undefined;
    if (kind === "RAMSGATE") {
        if (!realm.serving) throw new LauncherApiError("REALM_HOST_OFFLINE", "The realm's host is not online right now.");
        hub = await LiveHub(realm.realmId, "RAMSGATE");
        if (hub == undefined || hub.state !== "RUNNING") throw new LauncherApiError("REALM_HOST_OFFLINE", "The realm's Ramsgate is not running right now.");
    } else {
        // Training starts on demand, so the host need only be online (not serving).
        if (!realm.online) throw new LauncherApiError("REALM_HOST_OFFLINE", "The realm's host is not online right now.");
        hub = await LiveHub(realm.realmId, "TRAINING") ?? await StartTrainingHub(realm);
        if (hub.state === "SUSPECT") throw new LauncherApiError("REALM_HOST_OFFLINE", "The realm's Training hub is recovering.");
    }
    await PlaceInHub(Context, hub, members);
    return { handled: true, result: true };
}

async function RouteRealmHunt(Context: HuntRouteContext, realm: RealmSummary, members: string[], deps: RealmRouteDeps): Promise<HuntRouteOutcome> {
    if (!realm.serving) throw new LauncherApiError("REALM_HOST_OFFLINE", "The realm's host is not online right now.");
    if (IsKnownRuntimeIncompatible(Context.huntId)) {
        throw new LauncherApiError("REALM_HUNT_RUNTIME_INCOMPATIBLE", "This hunt does not run on the realm's server.");
    }
    // [2026-10-14 realms S5, design section 13] A request with no party state (the main Start Hunt sends none) is the requester's own
    // solo party, which POST /party would have created: the realm hunt is then a Private Hunt's with a one-member roster. Joining
    // another member's forming hunt inside the realm is not done (section 13 TODO).
    let partyId = Context.partyId;
    let partyRevision = Context.partyRevision;
    let huntMembers = members;
    if (partyId == undefined || partyRevision == undefined) {
        const solo = await deps.soloParty(Context.playerId, Context.buildId ?? "");
        partyId = solo.partyId;
        partyRevision = solo.revision;
        huntMembers = [Context.playerId];
    }
    // A recovering session of the party is closed first, as for any hunt request.
    const revision = (await CloseRecoveredSessionForParty(partyId)) ?? partyRevision;
    const started = await deps.createRealmHunt(Context, {
        gameMode: Context.gameMode,
        huntId: Context.huntId,
        partyId,
        partyRevision: revision,
        members: huntMembers,
        realmId: realm.realmId,
        hostAccountId: realm.hostAccountId
    });
    if (!started.created) return Refuse(Context, huntMembers, started.reason);
    return { handled: true, result: true };
}

async function RouteRealmRequestChecked(Context: HuntRouteContext, presence: { realmId: string }, deps: RealmRouteDeps,
    setMembers: (members: string[]) => void): Promise<HuntRouteOutcome> {
    const requester = Context.playerId;
    const realms = GetRealmsPort();
    const realm = await realms.findRealm(presence.realmId);
    if (realm == undefined) throw new LauncherApiError("REALM_NOT_FOUND", "This realm no longer exists.");
    if (await realms.isBanned(realm.realmId, requester)) throw new LauncherApiError("REALM_BANNED", "You cannot join this realm.");
    // [2026-10-16] A SOLO realm takes nobody but its host: a member already inside cannot start a hunt or move to Training there.
    if (realm.joinPolicy === "SOLO" && requester !== realm.hostAccountId) {
        throw new LauncherApiError("REALM_SOLO", "This realm is in solo mode: its host is playing alone right now.");
    }
    if (!(await realms.isMember(realm.realmId, requester))) throw new LauncherApiError("REALM_NOT_MEMBER", "You are not a member of this realm.");
    await RequireRealmHosting();
    const members = await MembersInRealm(Context, realm);
    setMembers(members);
    const kind: RealmRequestClass = ClassifyRealmRequest(Context.gameMode, Context.huntId);
    if (kind === "HUNT") return RouteRealmHunt(Context, realm, members, deps);
    return RouteRealmHub(Context, realm, members, kind);
}

/**
 * The route of one request by a member whose presence is bound to a realm (RouteP2PHunt calls this first, and only when realm
 * hosting is on). Always handled: a refusal cancels the requester's (and the in-realm party's) travel with a REALM_* reason and
 * never falls back to a dedicated server.
 */
export async function RouteRealmRequest(Context: HuntRouteContext, presence: { realmId: string }, deps: RealmRouteDeps): Promise<HuntRouteOutcome> {
    let members = [Context.playerId];
    try {
        return await RouteRealmRequestChecked(Context, presence, deps, (placed) => { members = placed; });
    } catch (error) {
        const reason = error instanceof LauncherApiError ? error.code : "REALM_UNAVAILABLE";
        if (!(error instanceof LauncherApiError)) logger.error(`[RealmRoute] request of ${Context.playerId} failed: ${error}`);
        logger.warn({ event: "realm_route_refused", realmId: presence.realmId, huntId: Context.huntId, reason },
            `[RealmRoute] request of ${Context.playerId} for ${Context.huntId} refused reason=${reason}`);
        return Refuse(Context, members, reason);
    }
}
