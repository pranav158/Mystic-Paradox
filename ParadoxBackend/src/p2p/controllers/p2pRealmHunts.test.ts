/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test, { after, before, mock } from "node:test";
import type { JwtPayload } from "jsonwebtoken";
import type { MatchmakingResult } from "../../controllers/matchmaking";
import type { HuntRouteContext } from "../../extensions/p2p";
import { LauncherApiError } from "../security/p2pErrors";
import { P2PControlMessageRecord, P2PHostCapabilityRecord, P2PHuntSessionRecord } from "../persistence";
import {
    CreateHubKit, FRIEND, HOST, HubKit, InstallHubTestEnvironment, LOCAL_BRIDGE_PORT, MEMBER, REALM_ID, RunningHub, StartRunningHub, STRANGER
} from "../realm/realmHubTestKit";
import { ConsumeAdmissionTicket, MarkHostReady } from "./p2pAdmission";
import { CreateHostBootstrap, CreateJoinBootstrap, MarkLocalRouteReady } from "./p2pLauncher";
import { DedicatedFallbackAction, P2PCandidateStatus, RouteP2PHunt, SetHuntManifestResolverForTest } from "./p2pMatchmaking";
import { ReadP2PPolicy } from "../config/p2pPolicy";
import { SYNTHETIC_HUNT_ID, WithEnvironment, WriteSyntheticHuntTables } from "../huntManifest/huntTablesTestKit";
import {
    BeginDrainPartySession, ParseGuardRequiredRoles, P2PHuntLifecycleMonitor, PrepareRecovery, RankHosts, RankRealmHost,
    RecordParticipantObservation, RenewHostLease, RespondToHostOffer, SubmitHostPresence
} from "./p2pHostLifecycle";
import { AbortHunt, EndHunt } from "./p2pHuntStatus";
import { HashHostCapabilitySecret, BuildPlayerHostRuntimeAuthData, ResolveActiveHostRuntimeContext } from "../security/hostCapabilities";
import { HostWriteDenialReason } from "../security/hostWrites";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { UseP2POperationsPolicyForTest } from "../services/p2pOperationsPolicy";

/*
 * Realm hunts (a realm's host runs a hunt for its members) on the in-memory repositories: the host's selection (the realm's host, its
 * presence and the realm's capacity), the bootstrap of a host that does not play the hunt, the transitions to ADMITTING and RUNNING,
 * the host's identity and writes, the travel of a member out of the realm's hub, a hunt's return to the hub, the recovery of a failed
 * realm hunt (no RECOVERING state), and the Guard's host-only rule for a realm host.
 */

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => { restoreEnvironment(); });

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

async function WithKit(body: (kit: HubKit) => Promise<void>): Promise<void> {
    const kit = CreateHubKit();
    try { await body(kit); } finally { kit.dispose(); }
}

interface Harness {
    context: HuntRouteContext;
    candidates: Map<string, MatchmakingResult>;
    cancels: Array<{ huntId: string; accountIds: string[]; reason: string }>;
}

function Harness(playerId: string, overrides: Partial<HuntRouteContext> = {}): Harness {
    const candidates = new Map<string, MatchmakingResult>();
    const cancels: Harness["cancels"] = [];
    const context: HuntRouteContext = {
        gameMode: "ISLAND",
        huntId: "ShatteredIsles_IslandA",
        playerId,
        isHub: false,
        setCandidate: (accountId, result) => { candidates.set(accountId, result); },
        cancel: (huntId, accountIds, reason) => {
            cancels.push({ huntId, accountIds: [...accountIds], reason });
            return true;
        },
        ...overrides
    };
    return { context, candidates, cancels };
}

function Messages(kit: HubKit, accountId: string, messageType: string): P2PControlMessageRecord[] {
    return kit.hunts.controlMessages.filter((message) => message.accountId === accountId && message.messageType === messageType);
}

/** A realm hunt of the party (the requester first). The realm's host is not in the party unless `members` names it. */
async function RealmHunt(kit: HubKit, partyId: string, members: string[], huntId = "ShatteredIsles_IslandA") {
    kit.addParty(partyId, members);
    for (const member of members) {
        kit.linkAccount(member);
        kit.realms.bindPresence(member, REALM_ID);
    }
    const h = Harness(members[0], { partyId, partyMembers: members, partyRevision: 1, huntId });
    const outcome = await RouteP2PHunt(h.context);
    const hunt = [...kit.hunts.hunts.values()].find((entry) => entry.realmId === REALM_ID && entry.partyId === partyId);
    return { outcome, harness: h, hunt };
}

/** The host accepts the offer and bootstraps its server (the launcher's calls, in order). */
async function HostBootstraps(kit: HubKit, sessionId: string, offerId: string) {
    await RespondToHostOffer(HOST, offerId, { accept: true });
    const bootstrap = await CreateHostBootstrap(HOST, sessionId);
    const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
    return { bootstrap, capability };
}

/** A member's join and the host's consume of its ticket: the first consumed ticket takes an ADMITTING hunt to RUNNING. */
async function MemberJoins(sessionId: string, accountId: string, bridgeInstanceId: string, capability: P2PHostCapabilityRecord) {
    const join = await CreateJoinBootstrap(accountId, sessionId);
    await ConsumeAdmissionTicket({
        sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(accountId), bridgeInstanceId,
        connectionHandle: "handle-member", requestId: crypto.randomUUID(), capability
    });
}

/** A member's whole entry into a running hub, as its launcher drives it (presence row, join ticket, the host's consume). */
async function Admit(kit: HubKit, hub: RunningHub, accountId: string) {
    kit.linkAccount(accountId);
    await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: REALM_ID, accountId,
        peerId: DeriveIcePeerId(accountId), candidateId: crypto.randomUUID(), now: iso(), expiresAt: iso(90_000) });
    const join = await CreateJoinBootstrap(accountId, hub.sessionId);
    await ConsumeAdmissionTicket({
        sessionId: hub.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(accountId),
        bridgeInstanceId: hub.bridgeInstanceId, connectionHandle: "handle-hub", requestId: crypto.randomUUID(),
        capability: kit.hunts.capabilities.get(hub.capabilityId)!
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Selection and capacity
// ---------------------------------------------------------------------------------------------------------------

test("a realm hunt is refused by the host's own capacity when the host has no commit headroom to spare, and no candidate is offered", async () => {
    await WithKit(async (kit) => {
        const presence = kit.hunts.hostPresences.get(HOST)!;
        kit.hunts.hostPresences.set(HOST, { ...presence, commitHeadroomMiB: 1024, observedAt: iso(), expiresAt: iso(25_000) });
        const { hunt } = await RealmHunt(kit, "party-memory", [MEMBER, FRIEND]);
        assert.equal(hunt?.state, "ABORTED");
        assert.equal(hunt?.failureReason, "REALM_FULL");
        assert.equal(Messages(kit, HOST, "HOST_OFFERED").length, 0);
    });
});

// [2026-10-16] Low free physical memory alone no longer refuses a realm hunt (a PC with little free memory and plenty of commit headroom).
test("a realm hunt on a host short of free physical memory but with commit headroom is offered to the host", async () => {
    await WithKit(async (kit) => {
        const presence = kit.hunts.hostPresences.get(HOST)!;
        kit.hunts.hostPresences.set(HOST, { ...presence, freePhysicalMemoryMiB: 512, observedAt: iso(), expiresAt: iso(25_000) });
        const { hunt } = await RealmHunt(kit, "party-low-free", [MEMBER, FRIEND]);
        assert.notEqual(hunt?.failureReason, "REALM_FULL");
        assert.equal(Messages(kit, HOST, "HOST_OFFERED").length, 1, "the host is asked to start it");
    });
});

test("a realm hunt with no fresh presence from its host ends with NO_ELIGIBLE_HOST (the realm's host is the only candidate)", async () => {
    await WithKit(async (kit) => {
        kit.hunts.hostPresences.delete(HOST);
        const { hunt } = await RealmHunt(kit, "party-absent", [MEMBER, FRIEND]);
        assert.equal(hunt?.state, "ABORTED");
        assert.equal(hunt?.failureReason, "NO_ELIGIBLE_HOST");
        assert.equal(hunt?.activePartyKey, undefined, "the party is free again");
    });
});

// ---------------------------------------------------------------------------------------------------------------
// A host that does not play its realm hunt
// ---------------------------------------------------------------------------------------------------------------

test("a non-playing realm host: no host ticket, hostLocalClient false, and the hunt goes to ADMITTING at its ready with a join to every member", async () => {
    await WithKit(async (kit) => {
        const { hunt } = await RealmHunt(kit, "party-np", [MEMBER, FRIEND]);
        const { bootstrap } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
        assert.equal(bootstrap.hostTicket, undefined, "a non-playing host has no admission ticket");
        assert.equal(bootstrap.hostLocalClient, false);
        assert.equal(bootstrap.hostParticipates, false);
        assert.equal(bootstrap.realmId, REALM_ID);
        assert.equal(bootstrap.matchmakerHuntId, hunt!.matchmakerHuntId);
        assert.equal(kit.hunts.hunts.get(hunt!.sessionId)?.state, "STARTING");

        const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
        await MarkHostReady({ sessionId: hunt!.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        assert.equal(kit.hunts.hunts.get(hunt!.sessionId)?.state, "ADMITTING");
        assert.equal(Messages(kit, MEMBER, "JOIN_RENDEZVOUS").length, 1);
        assert.equal(Messages(kit, FRIEND, "JOIN_RENDEZVOUS").length, 1);
        assert.equal(Messages(kit, HOST, "JOIN_RENDEZVOUS").length, 0, "the host is no roster member");

        // The first member's join takes the hunt to RUNNING (the host's own route is not needed).
        await MemberJoins(hunt!.sessionId, MEMBER, bootstrap.bridgeInstanceId, capability);
        const running = kit.hunts.hunts.get(hunt!.sessionId)!;
        assert.equal(running.state, "RUNNING");
        assert.equal(running.roster.find((entry) => entry.accountId === MEMBER)?.admissionState, "ADMITTED");
        assert.equal(running.roster.find((entry) => entry.accountId === FRIEND)?.admissionState, "PENDING");
    });
});

test("a realm hunt's server gets its own UDP port beside the running Ramsgate hub (14 Oct repro: both listened on 8791)", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        assert.equal(hub.bootstrap.serverUdpPort, 8791, "the realm's Ramsgate takes the base port");
        assert.equal(kit.hunts.hunts.get(hub.sessionId)?.serverUdpPort, 8791, "and keeps it on its session");
        const { hunt } = await RealmHunt(kit, "party-port", [MEMBER, FRIEND]);
        const { bootstrap } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
        assert.equal(bootstrap.serverUdpPort, 8792, "the hunt's server must not share the hub's port");
        assert.equal(kit.hunts.hunts.get(hunt!.sessionId)?.serverUdpPort, 8792);
    });
});

test("a non-playing realm host's runtime identity resolves to the host, its writes are refused as a non-member; no stranger resolves", async () => {
    await WithKit(async (kit) => {
        const { hunt } = await RealmHunt(kit, "party-identity", [MEMBER, FRIEND]);
        const { bootstrap, capability } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
        await MarkHostReady({ sessionId: hunt!.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        await MemberJoins(hunt!.sessionId, MEMBER, bootstrap.bridgeInstanceId, capability);

        const context = await ResolveActiveHostRuntimeContext(bootstrap.capability);
        assert.ok(context, "the host's capability resolves to the running hunt");
        const requestAsHost = BuildPlayerHostRuntimeAuthData(context!, undefined);
        assert.equal(requestAsHost?.userId, HOST);
        assert.ok(requestAsHost?.RuntimeRosterAccountIds.includes(HOST));
        assert.equal(BuildPlayerHostRuntimeAuthData(context!, undefined, { requestedUserId: STRANGER }), undefined);
        assert.equal(BuildPlayerHostRuntimeAuthData(context!, { userId: STRANGER } as JwtPayload), undefined);
        assert.ok(BuildPlayerHostRuntimeAuthData(context!, { userId: MEMBER } as JwtPayload), "an admitted member resolves");
        assert.equal(BuildPlayerHostRuntimeAuthData(context!, { userId: FRIEND } as JwtPayload), undefined, "a member not yet admitted does not");

        const running = kit.hunts.hunts.get(hunt!.sessionId)!;
        assert.equal(HostWriteDenialReason(requestAsHost, running, HOST, "BOUNTY"), "NOT_A_MEMBER");
    });
});

test("a participating realm host plays its hunt through its own route (HOST_READY, ADMITTING, RUNNING) and carries a ticket and a local client", async () => {
    await WithKit(async (kit) => {
        kit.realms.bindPresence(HOST, REALM_ID);
        const { hunt, harness } = await RealmHunt(kit, "party-play", [HOST, MEMBER]);
        assert.deepEqual(harness.cancels, []);
        assert.equal(hunt?.hostParticipates, true);
        const { bootstrap, capability } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
        assert.ok(bootstrap.hostTicket, "a participating host has its ticket");
        assert.equal(bootstrap.hostLocalClient, true);
        await MarkHostReady({ sessionId: hunt!.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        assert.equal(kit.hunts.hunts.get(hunt!.sessionId)?.state, "HOST_READY", "a participating host waits for its own route");
        await MarkLocalRouteReady(HOST, hunt!.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId, localHost: "127.0.0.1", localPort: LOCAL_BRIDGE_PORT });
        const running = kit.hunts.hunts.get(hunt!.sessionId)!;
        assert.equal(running.state, "RUNNING");
        assert.equal(running.roster.find((entry) => entry.accountId === HOST)?.admissionState, "ADMITTED");
        assert.equal(Messages(kit, MEMBER, "JOIN_RENDEZVOUS").length, 1);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// Travel and return
// ---------------------------------------------------------------------------------------------------------------

test("travel: a member admitted into a realm hunt leaves the realm's hub (TRAVEL), its launcher stops the hub join and the host drops the link", async () => {
    await WithKit(async (kit) => {
        const hub: RunningHub = await StartRunningHub(kit);
        await Admit(kit, hub, MEMBER);
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))?.state, "ADMITTED");

        const { hunt } = await RealmHunt(kit, "party-travel", [MEMBER]);
        const { bootstrap, capability } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
        await MarkHostReady({ sessionId: hunt!.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        await MemberJoins(hunt!.sessionId, MEMBER, bootstrap.bridgeInstanceId, capability);

        const left = await kit.presence.findPresence(hub.sessionId, MEMBER);
        assert.equal(left?.state, "LEFT");
        assert.equal(left?.leftReason, "TRAVEL");
        const leave = Messages(kit, MEMBER, "REALM_SESSION_LEAVE");
        assert.equal(leave.length, 1);
        assert.equal(leave[0].payload.sessionId, hub.sessionId);
        assert.equal(leave[0].payload.reason, "TRAVEL");
        assert.equal(Messages(kit, HOST, "REALM_PEER_EXPECTED").some((message) => message.sessionId === hub.sessionId), true);
    });
});

// [2026-10-15] The hub request comes while the player still sees the hunt's results (Escalation: 1.4 s after its end), so the hunt
// drains: its credential and lease stay alive until its server empties and stops. Ending it at once revoked the credential and
// the host fenced its own server under the player.
test("return: a realm hunt's member who asks for Ramsgate drains its hunt (PARTY_RETURNED_TO_HUB, credential kept) and is placed in the running hub", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const { hunt } = await RealmHunt(kit, "party-return", [MEMBER]);
        const { bootstrap, capability } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
        await MarkHostReady({ sessionId: hunt!.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        await MemberJoins(hunt!.sessionId, MEMBER, bootstrap.bridgeInstanceId, capability);
        assert.equal(kit.hunts.hunts.get(hunt!.sessionId)?.state, "RUNNING");

        const back = Harness(MEMBER, { gameMode: "CITY", huntId: "ShatteredIsles_ReturnToRamsgate", isHub: true });
        assert.deepEqual(await RouteP2PHunt(back.context), { handled: true, result: true });
        const drained = kit.hunts.hunts.get(hunt!.sessionId)!;
        assert.equal(drained.state, "DRAINING");
        assert.equal(drained.completionReason, "PARTY_RETURNED_TO_HUB");
        assert.equal(drained.activePartyKey, undefined, "the party is free for its next request");
        assert.equal(kit.hunts.capabilities.get(capability.capabilityId)!.revokedAt, undefined, "the host's credential stays valid");
        assert.equal(Messages(kit, MEMBER, "FENCE_NOW").length + Messages(kit, HOST, "FENCE_NOW").length, 0, "nothing is fenced");
        // The lease keeps renewing while the player is still on the hunt server.
        assert.equal((await RenewHostLease(capability, { leaseSequence: 1, bridgeAlive: true, serverReady: true, admittedPeerCount: 1,
            queuePressure: 0 })).state, "DRAINING");
        // The server empties and stops: its lease lapses past the suspect window and the drain ends COMPLETED.
        kit.hunts.hunts.get(hunt!.sessionId)!.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
        await new P2PHuntLifecycleMonitor().tick();
        const ended = kit.hunts.hunts.get(hunt!.sessionId)!;
        assert.equal(ended.state, "COMPLETED");
        assert.equal(ended.completionReason, "PARTY_RETURNED_TO_HUB");
        const candidate = back.candidates.get(MEMBER)!;
        assert.equal(candidate.Source, "REALM_HUB");
        assert.equal(candidate.SourceSessionId, hub.sessionId);
        assert.equal(Messages(kit, MEMBER, "JOIN_RENDEZVOUS").some((message) => message.payload.entryId === candidate.CandidateId), true);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// Recovery of a failed realm hunt
// ---------------------------------------------------------------------------------------------------------------

test("a realm hunt that fails before it is active is cancelled with no fallback: ABORTED, the offer cancelled for the members and the host", async () => {
    await WithKit(async (kit) => {
        const { hunt } = await RealmHunt(kit, "party-pre", [MEMBER, FRIEND]);
        assert.equal(hunt?.state, "HOST_OFFERED");
        await PrepareRecovery(hunt!.sessionId, hunt!.generation, "HOST_STARTUP_TIMEOUT", true);
        const ended = kit.hunts.hunts.get(hunt!.sessionId)!;
        assert.equal(ended.state, "ABORTED");
        assert.equal(ended.failureReason, "HOST_STARTUP_TIMEOUT");
        assert.equal(kit.hunts.transitions.some((entry) => entry.sessionId === hunt!.sessionId && entry.toState === "RECOVERING"), false);
        for (const accountId of [MEMBER, FRIEND, HOST]) {
            assert.equal(Messages(kit, accountId, "HOST_OFFER_CANCELLED").length, 1, `${accountId} is told`);
        }
    });
});

test("an active realm hunt that fails ends at once: ABORTED, no RECOVERING, FENCE_NOW to every member and the host, the party freed", async () => {
    await WithKit(async (kit) => {
        const { hunt, harness } = await RealmHunt(kit, "party-active", [MEMBER, FRIEND]);
        const { bootstrap, capability } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
        await MarkHostReady({ sessionId: hunt!.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        await MemberJoins(hunt!.sessionId, MEMBER, bootstrap.bridgeInstanceId, capability);
        assert.equal(kit.hunts.hunts.get(hunt!.sessionId)?.state, "RUNNING");
        assert.equal(kit.parties.get("party-active")?.activeHuntSessionId, hunt!.sessionId);

        await PrepareRecovery(hunt!.sessionId, hunt!.generation, "HOST_PROCESS_UNHEALTHY", false);

        const ended = kit.hunts.hunts.get(hunt!.sessionId)!;
        assert.equal(ended.state, "ABORTED");
        assert.equal(ended.failureReason, "HOST_PROCESS_UNHEALTHY");
        assert.equal(ended.recoveryBeforeActive, undefined);
        assert.equal(kit.hunts.transitions.some((entry) => entry.sessionId === hunt!.sessionId && entry.toState === "RECOVERING"), false);
        assert.equal(kit.hunts.transitions.some((entry) => entry.sessionId === hunt!.sessionId && entry.toState === "ABORTING"), false);
        for (const accountId of [MEMBER, FRIEND, HOST]) {
            assert.equal(Messages(kit, accountId, "FENCE_NOW").length, 1, `${accountId} is fenced`);
            assert.equal(Messages(kit, accountId, "RETURN_TO_RAMSGATE").length, 0, `${accountId} is not sent back to a dedicated server`);
        }
        assert.equal(kit.parties.get("party-active")?.activeHuntSessionId, undefined, "the party is free");
        // The member's candidate, read after the failure, is cancelled with the reason.
        const status = await P2PCandidateStatus(MEMBER, harness.candidates.get(MEMBER)!);
        assert.equal(status?.Canceled, true);
        assert.equal(status?.StatusReason, "HOST_PROCESS_UNHEALTHY");
    });
});

// ---------------------------------------------------------------------------------------------------------------
// The Guard's host-only rule (section 6.4)
// ---------------------------------------------------------------------------------------------------------------

test("the host role alone is accepted only when the server confirmed a realm host (the flag); otherwise the client role is still required", async () => {
    // The rule itself: the host role stands alone only with the server's confirmation; the client and host pair is always fine.
    assert.deepEqual(ParseGuardRequiredRoles({ guardRequiredRoles: ["host"] }, [], { realmHostOnly: true }), ["host"]);
    assert.deepEqual(ParseGuardRequiredRoles({ guardRequiredRoles: ["host", "client"] }, [], { realmHostOnly: true }), ["host", "client"]);
    assert.throws(() => ParseGuardRequiredRoles({ guardRequiredRoles: ["host"] }, []), (error: unknown) =>
        error instanceof LauncherApiError && error.code === "GUARD_REQUIRED");
});

function PresenceBody(overrides: Record<string, unknown> = {}) {
    const hash = "a".repeat(64);
    return {
        consentToHost: true,
        powerSaver: false,
        runtimeSupported: true,
        transportReady: false,
        observedAt: new Date().toISOString(),
        freePhysicalMemoryMiB: 16384,
        commitHeadroomMiB: 16384,
        logicalCpuCount: 8,
        cpuLoadPercent: 12,
        backendRttMs: 30,
        worstPeerRttMs: 30,
        jitterMs: 4,
        packetLossPercent: 0,
        launcherVersion: "0.1.55",
        artifacts: { gameExe: hash, internalServer: hash, winmmProxy: hash, transportModule: hash, transportRuntime: hash, admissionPublicKey: hash },
        guardRequiredRoles: ["host"],
        ...overrides
    };
}

test("a realm host with no client submits host-only presence: accepted only with its host Guard healthy AND a live realm session", async () => {
    await WithKit(async (kit) => {
        const hostGuard = crypto.randomUUID();
        const hostOnly = (extra: Record<string, unknown> = {}) => PresenceBody({
            realmHostSessions: 1, guardRequiredRoles: ["host"], guardSessions: [{ role: "host", guardSessionId: hostGuard }], ...extra
        });

        // The host's Guard is healthy, but no realm session runs: the reported count alone does not stand the client role down.
        kit.healthyGuard(HOST, hostGuard, "host");
        await assert.rejects(() => SubmitHostPresence(HOST, hostOnly()), (error: unknown) =>
            error instanceof LauncherApiError && error.code === "GUARD_REQUIRED");

        // A live Ramsgate hub of the realm (the server's own record) and the healthy host Guard: accepted.
        await StartRunningHub(kit);
        const accepted = await SubmitHostPresence(HOST, hostOnly());
        assert.equal(accepted.accepted, true);
        assert.equal(accepted.guardVerified, true);
        assert.equal(kit.hunts.hostPresences.get(HOST)?.realmHostSessions, 1);
    });

    await WithKit(async (kit) => {
        // A live session but no healthy host Guard. In enforce mode: still refused (the Guard is never waived).
        await StartRunningHub(kit);
        const hostGuard = crypto.randomUUID();
        const Body = PresenceBody({
            realmHostSessions: 1, guardRequiredRoles: ["host"], guardSessions: [{ role: "host", guardSessionId: hostGuard }]
        });
        const Previous = process.env.MYSTICPARADOX_GUARD_MODE;
        process.env.MYSTICPARADOX_GUARD_MODE = "enforce";
        try {
            await assert.rejects(() => SubmitHostPresence(HOST, Body), (error: unknown) =>
                error instanceof LauncherApiError && error.code === "GUARD_REQUIRED");
        } finally {
            if (Previous === undefined) delete process.env.MYSTICPARADOX_GUARD_MODE;
            else process.env.MYSTICPARADOX_GUARD_MODE = Previous;
        }
        // The default (observe): the same report is accepted; the refusal it would make is logged, not applied.
        const observed = await SubmitHostPresence(HOST, Body);
        assert.equal(observed.accepted, true);
        assert.equal(observed.guardVerified, false);
    });
});

// [2026-10-14 M1] A realm hunt takes its launch manifest from the Metagame's own hunt tables: the real request path, with the
// DeployServer address pointing at nothing. No manifest request may leave the process.
test("a realm hunt is created with its manifest from the local hunt tables, and DeployServer is never asked", async () => {
    const Dir = WriteSyntheticHuntTables();
    const RealFetch = globalThis.fetch;
    const ManifestRequests: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes("resolve-hunt-launch-manifest")) ManifestRequests.push(String(url));
        throw new Error("DeployServer is unreachable in this test");
    }) as typeof fetch;
    try {
        await WithEnvironment({ PARADOX_HUNT_DATA_DIR: Dir, DEPLOYSERVER_URL: "127.0.0.1:9", MYSTICPARADOX_HUNT_MANIFEST_SOURCE: undefined }, async () => {
            await WithKit(async (kit) => {
                SetHuntManifestResolverForTest(undefined); // the kit installs a stub; this is the real request path
                const { hunt } = await RealmHunt(kit, "party-local-manifest", [MEMBER, FRIEND], SYNTHETIC_HUNT_ID);
                assert.ok(hunt, "the realm hunt was created");
                assert.notEqual(hunt.state, "ABORTED");
                assert.equal(hunt.matchmakerHuntId, "Adventure_IslandA_Synthetic");
                assert.equal(hunt.mapPath, "/Game/Maps/synthetic/island_a");
                assert.equal(hunt.behemothPath, "NO_BEHEMOTH");
                assert.equal(hunt.guardCompletionMode, "END_OF_HUNT");
                assert.ok(hunt.hostOfferId, "the realm's host was offered the hunt");
            });
        });
        assert.deepEqual(ManifestRequests, []);
    } finally {
        globalThis.fetch = RealFetch;
        fs.rmSync(Dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------------------------------------------
// Draining (2026-10-15): a running hunt the requester left keeps its server until that server ends
// ---------------------------------------------------------------------------------------------------------------

/** A realm hunt of the party run to RUNNING: the host plays it (its route-ready) and MEMBER is admitted. */
async function RunningHunt(kit: HubKit, partyId: string): Promise<{ hunt: P2PHuntSessionRecord; capability: P2PHostCapabilityRecord }> {
    kit.realms.bindPresence(HOST, REALM_ID);
    const { hunt } = await RealmHunt(kit, partyId, [HOST, MEMBER]);
    const { bootstrap, capability } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
    await MarkHostReady({ sessionId: hunt!.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
        bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
    await MarkLocalRouteReady(HOST, hunt!.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId,
        localHost: "127.0.0.1", localPort: LOCAL_BRIDGE_PORT });
    await MemberJoins(hunt!.sessionId, MEMBER, bootstrap.bridgeInstanceId, capability);
    const running = kit.hunts.hunts.get(hunt!.sessionId)!;
    assert.equal(running.state, "RUNNING");
    assert.equal(running.roster.find((entry) => entry.accountId === MEMBER)?.admissionState, "ADMITTED");
    return { hunt: running, capability };
}

/** The member asks its party for a new realm hunt while the running one goes on (the party's current revision). */
function RequestNewHunt(kit: HubKit, partyId: string) {
    const party = kit.parties.get(partyId)!;
    const harness = Harness(MEMBER, { partyId, partyMembers: [HOST, MEMBER], partyRevision: party.revision, huntId: "ShatteredIsles_IslandA" });
    return RouteP2PHunt(harness.context);
}

function FenceMessages(kit: HubKit, sessionId: string): P2PControlMessageRecord[] {
    return kit.hunts.controlMessages.filter((message) => message.sessionId === sessionId && message.messageType === "FENCE_NOW");
}

/** A host lease heartbeat: the server is up (or not) and the bridge is alive. */
const Lease = (leaseSequence: number, serverReady = true) => ({ leaseSequence, bridgeAlive: true, serverReady, admittedPeerCount: 1, queuePressure: 0 });

test("draining: a member who asks for a new hunt drains the running one - nothing fenced, the host keeps its capability, the party moves on", async () => {
    await WithKit(async (kit) => {
        const { hunt, capability } = await RunningHunt(kit, "party-drain");
        // An unconsumed ticket of the running hunt: nobody new may join it once it drains.
        await kit.hunts.createAdmissionTicket({ jtiDigest: "e".repeat(64), keyId: "test-key-1", sessionId: hunt.sessionId,
            generation: hunt.generation, accountId: MEMBER, joinerSteamId: DeriveIcePeerId(MEMBER), hostSteamId: hunt.hostSteamId,
            bridgeProtocol: 1, virtualPort: 1, issuedAt: iso(), expiresAt: iso(60_000), status: "ISSUED" });
        await RequestNewHunt(kit, "party-drain");
        const drained = kit.hunts.hunts.get(hunt.sessionId)!;
        assert.equal(drained.state, "DRAINING");
        assert.equal(drained.activePartyKey, undefined, "the party's new request no longer sees the drained session");
        assert.equal(drained.drainDeadline, undefined, "no cap is configured, so the drain has no deadline");
        assert.equal(kit.hunts.capabilities.get(capability.capabilityId)!.revokedAt, undefined, "the server's capability is not revoked");
        assert.equal(FenceMessages(kit, hunt.sessionId).length, 0, "nobody is fenced");
        assert.equal(kit.hunts.tickets.get("e".repeat(64))!.status, "REVOKED", "no new admission to the drained hunt");
        assert.ok(kit.hunts.transitions.some((entry) => entry.sessionId === hunt.sessionId && entry.toState === "DRAINING" &&
            entry.reason === "DRAIN_REQUESTER_LEFT_HUNT" && entry.actorAccountId === MEMBER));
        const next = [...kit.hunts.hunts.values()].find((entry) => entry.sessionId !== hunt.sessionId && entry.partyId === "party-drain");
        assert.ok(next, "the new hunt was created");
        assert.equal(kit.parties.get("party-drain")!.activeHuntSessionId, next!.sessionId, "the party is on the new hunt");
    });
});

test("draining: the host's lease keeps renewing; once the server's heartbeats stop the drain ends COMPLETED with no fence", async () => {
    await WithKit(async (kit) => {
        const { hunt, capability } = await RunningHunt(kit, "party-lapse");
        await RequestNewHunt(kit, "party-lapse");
        const renewed = await RenewHostLease(capability, Lease(1));
        assert.equal(renewed.state, "DRAINING", "the lease renews while the drained server serves its members");
        // A short gap (a network blip) inside the suspect window is waited out, and the lease renews from DRAINING.
        kit.hunts.hunts.get(hunt.sessionId)!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
        await new P2PHuntLifecycleMonitor().tick();
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "DRAINING", "a lease lapsed inside the suspect window holds the drain");
        assert.equal((await RenewHostLease(capability, Lease(2))).state, "DRAINING", "the host renews after the blip");
        // The server exits by itself (its empty-server reap): the heartbeats stop and the lease stays lapsed past the window.
        kit.hunts.hunts.get(hunt.sessionId)!.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
        await new P2PHuntLifecycleMonitor().tick();
        const ended = kit.hunts.hunts.get(hunt.sessionId)!;
        assert.equal(ended.state, "COMPLETED");
        assert.equal(ended.completionReason, "SUPERSEDED_REQUESTER_LEFT_HUNT");
        assert.equal(ended.drainDeadline, undefined, "the drain deadline is cleared by the clean end");
        assert.equal(FenceMessages(kit, hunt.sessionId).length, 0, "no server is left to fence");
        assert.notEqual(kit.hunts.capabilities.get(capability.capabilityId)!.revokedAt, undefined, "the generation is revoked at its end");
    });
});

test("draining: inside the deadline the monitor holds the drain; at the deadline the server is fenced; it is never SUSPECT or recovered", async () => {
    // [2026-10-15] A cap is set explicitly: with none (the default) a drain has no deadline at all.
    await WithEnvironment({ P2P_HUNT_DRAIN_GRACE_MS: "180000" }, () => WithKit(async (kit) => {
        const { hunt, capability } = await RunningHunt(kit, "party-deadline");
        await RequestNewHunt(kit, "party-deadline");
        assert.ok(Date.parse(kit.hunts.hunts.get(hunt.sessionId)!.drainDeadline!) > Date.now(), "a configured cap sets the deadline");
        await RenewHostLease(capability, Lease(1));
        await new P2PHuntLifecycleMonitor().tick();
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "DRAINING", "still draining inside the deadline");
        assert.equal(FenceMessages(kit, hunt.sessionId).length, 0);
        // The deadline passes while the server still runs: it is fenced and the drain ends.
        kit.hunts.hunts.get(hunt.sessionId)!.drainDeadline = new Date(Date.now() - 1_000).toISOString();
        await new P2PHuntLifecycleMonitor().tick();
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "COMPLETED");
        assert.ok(FenceMessages(kit, hunt.sessionId).length > 0, "fenced at the deadline");
        const states = kit.hunts.transitions.filter((entry) => entry.sessionId === hunt.sessionId).map((entry) => entry.toState);
        assert.equal(states.some((state) => ["SUSPECT", "FENCED", "ABORTING", "RECOVERING"].includes(state)), false, "never suspect, never recovered");
    }));
});

test("draining: the host reporting its server gone ends the drain COMPLETED and fenced, never a recovery", async () => {
    await WithKit(async (kit) => {
        const { hunt, capability } = await RunningHunt(kit, "party-gone");
        await RequestNewHunt(kit, "party-gone");
        await assert.rejects(() => RenewHostLease(capability, Lease(1, false)), (error: any) => error?.code === "P2P_GENERATION_FENCED");
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "COMPLETED");
        assert.ok(FenceMessages(kit, hunt.sessionId).length > 0, "the players are told the session is over");
        const states = kit.hunts.transitions.filter((entry) => entry.sessionId === hunt.sessionId).map((entry) => entry.toState);
        assert.equal(states.some((state) => ["SUSPECT", "FENCED", "ABORTING", "RECOVERING"].includes(state)), false);
    });
});

test("draining: the host's own abort ends the drain without a recovery", async () => {
    await WithKit(async (kit) => {
        const { hunt, capability } = await RunningHunt(kit, "party-abort");
        await RequestNewHunt(kit, "party-abort");
        const aborted = await AbortHunt(capability, { reason: "GUARD_TEST" });
        assert.deepEqual(aborted, { accepted: true, recoveryStarted: false, ended: true, progressionApplied: false, rewardsApplied: false });
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "COMPLETED");
        const states = kit.hunts.transitions.filter((entry) => entry.sessionId === hunt.sessionId).map((entry) => entry.toState);
        assert.equal(states.some((state) => ["SUSPECT", "FENCED", "ABORTING", "RECOVERING"].includes(state)), false);
    });
});

test("draining: the host's clean shutdown ends the drain COMPLETED, without a recovery", async () => {
    await WithKit(async (kit) => {
        const { hunt, capability } = await RunningHunt(kit, "party-end");
        await RequestNewHunt(kit, "party-end");
        const ended = await EndHunt(capability, { reason: "HOST_CLEAN_SHUTDOWN" });
        assert.deepEqual([ended.cleanEnd, ended.state, ended.recoveryStarted], [true, "COMPLETED", false]);
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.completionReason, "DRAIN_HOST_END_HOST_CLEAN_SHUTDOWN");
    });
});

test("[2026-10-16] an ended hunt's observation is accepted but not stored, and the answer names the state (the launcher stops)", async () => {
    await WithKit(async (kit) => {
        const { hunt, capability } = await RunningHunt(kit, "party-ended-observe");
        const body = { generation: hunt.generation, observedAt: new Date().toISOString(), hostReachable: false, localBridgeAlive: false,
            metricsAvailable: false, routeKind: "UNKNOWN" };
        // While it runs, the observation is stored and the answer says RUNNING.
        assert.deepEqual(await RecordParticipantObservation(MEMBER, hunt.sessionId, body),
            { accepted: true, sessionId: hunt.sessionId, generation: hunt.generation, state: "RUNNING" });
        const storedBefore = kit.hunts.observations.filter((entry) => entry.sessionId === hunt.sessionId).length;
        assert.equal(storedBefore, 1);
        // A host ending a running (undrained) hunt leaves it ABORTED; COMPLETED is answered the same way.
        await EndHunt(capability, { reason: "HOST_CLEAN_SHUTDOWN" });
        const endedState = kit.hunts.hunts.get(hunt.sessionId)!.state;
        assert.ok(endedState === "COMPLETED" || endedState === "ABORTED", endedState);
        assert.deepEqual(await RecordParticipantObservation(MEMBER, hunt.sessionId, body),
            { accepted: true, sessionId: hunt.sessionId, generation: hunt.generation, stored: false, state: endedState });
        assert.equal(kit.hunts.observations.filter((entry) => entry.sessionId === hunt.sessionId).length, storedBefore, "nothing more stored");
        // Still bound to the roster and the generation: anyone else is told the session is not theirs.
        await assert.rejects(() => RecordParticipantObservation("stranger-account", hunt.sessionId, body),
            (error: unknown) => error instanceof LauncherApiError && error.code === "P2P_GENERATION_FENCED");
        await assert.rejects(() => RecordParticipantObservation(MEMBER, hunt.sessionId, { ...body, generation: hunt.generation + 1 }),
            (error: unknown) => error instanceof LauncherApiError && error.code === "P2P_GENERATION_FENCED");
    });
});

test("draining: an operator stop fences a draining server at once and never recovers it; the party is freed by the drain", async () => {
    await WithKit(async (kit) => {
        const { hunt } = await RunningHunt(kit, "party-stop");
        const drained = await BeginDrainPartySession(hunt, "REQUESTER_LEFT_HUNT", MEMBER);
        assert.equal(drained?.record.state, "DRAINING");
        assert.equal(kit.parties.get("party-stop")!.activeHuntSessionId, undefined, "the drain frees the party");
        // A recovery requested for a draining hunt is ignored: nothing is recovered, the drain stands.
        assert.equal(await PrepareRecovery(hunt.sessionId, hunt.generation, "TEST_RECOVERY", false), false);
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "DRAINING");
        UseP2POperationsPolicyForTest({ p2pEmergencyStop: true, coopTransport: "ICE" });
        try {
            await new P2PHuntLifecycleMonitor().tick();
        } finally {
            UseP2POperationsPolicyForTest({ p2pEmergencyStop: false, coopTransport: "ICE" });
        }
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "COMPLETED");
        assert.ok(FenceMessages(kit, hunt.sessionId).length > 0, "an operator stop fences the server");
        const states = kit.hunts.transitions.filter((entry) => entry.sessionId === hunt.sessionId).map((entry) => entry.toState);
        assert.equal(states.some((state) => ["FENCED", "ABORTING", "RECOVERING"].includes(state)), false);
    });
});

test("draining: a member's observation is accepted and dropped; the drained server counts against neither its host nor its realm, but still runs", async () => {
    await WithKit(async (kit) => {
        const { hunt } = await RunningHunt(kit, "party-observe");
        await RequestNewHunt(kit, "party-observe");
        const observation = await RecordParticipantObservation(MEMBER, hunt.sessionId, { generation: hunt.generation,
            observedAt: new Date().toISOString(), hostReachable: false, localBridgeAlive: false, metricsAvailable: false, routeKind: "UNKNOWN" });
        assert.deepEqual(observation, { accepted: true, sessionId: hunt.sessionId, generation: hunt.generation, stored: false, state: "DRAINING" });
        assert.equal(kit.hunts.observations.filter((entry) => entry.sessionId === hunt.sessionId).length, 0, "no quorum is kept");
        // The drained server is inactive: only the new hunt counts against its host and its realm (the limits use these).
        assert.equal(await kit.hunts.countActiveHostSessions(HOST), 1);
        assert.equal(await kit.hunts.countActiveRealmServers(REALM_ID), 1);
        assert.deepEqual((await kit.hunts.listLiveRealmHunts(REALM_ID, HOST)).map((entry) => entry.sessionId),
            [...kit.hunts.hunts.values()].filter((entry) => entry.partyId === "party-observe" && entry.sessionId !== hunt.sessionId)
                .map((entry) => entry.sessionId), "a drained realm hunt is not listed");
        // It still runs on the host's PC: ConfirmsRealmHost's count keeps it, so the host's presence needs no client while it runs.
        assert.equal(await kit.hunts.countRunningRealmServers(REALM_ID), 2);
    });
});

// [2026-10-15] A draining server is inactive for its host and its realm, and the host may be offered its party's new hunt at once.
/** The host alone in its party runs its own realm hunt to RUNNING (its route ready; no member joins). */
async function HostRunningHunt(kit: HubKit, partyId: string): Promise<{ hunt: P2PHuntSessionRecord; capability: P2PHostCapabilityRecord }> {
    kit.realms.bindPresence(HOST, REALM_ID);
    const { hunt } = await RealmHunt(kit, partyId, [HOST]);
    const { bootstrap, capability } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
    await MarkHostReady({ sessionId: hunt!.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
        bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
    await MarkLocalRouteReady(HOST, hunt!.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId,
        localHost: "127.0.0.1", localPort: LOCAL_BRIDGE_PORT });
    const running = kit.hunts.hunts.get(hunt!.sessionId)!;
    assert.equal(running.state, "RUNNING", "the host alone runs its hunt");
    return { hunt: running, capability };
}

/** The host asks its own party for a new hunt while its running one goes on (the host is the party's only member). */
function HostRequestsNewHunt(kit: HubKit, partyId: string) {
    const party = kit.parties.get(partyId)!;
    const harness = Harness(HOST, { partyId, partyMembers: [HOST], partyRevision: party.revision, huntId: "ShatteredIsles_IslandA" });
    return RouteP2PHunt(harness.context);
}

test("draining: a solo host whose old hunt drains is offered its party's new hunt at once, through the realm capacity and the official ranking", async () => {
    await WithKit(async (kit) => {
        // A one-server realm: the drained server would fill it if it still counted.
        kit.realms.realms.get(REALM_ID)!.hosting = { maxServers: 1 };
        const { hunt: old } = await HostRunningHunt(kit, "party-solo");
        // Control, before the drain: while its own hunt runs, the official ranking skips the host (one live hunt per host).
        const officialRoster = { roster: [{ accountId: HOST, steamId: DeriveIcePeerId(HOST) }] } as unknown as P2PHuntSessionRecord;
        assert.deepEqual((await RankHosts(officialRoster)).map((entry) => entry.accountId), [], "a running hunt makes the host ineligible");

        await HostRequestsNewHunt(kit, "party-solo");
        assert.equal(kit.hunts.hunts.get(old.sessionId)!.state, "DRAINING", "the old hunt drains");
        const next = [...kit.hunts.hunts.values()].find((entry) => entry.sessionId !== old.sessionId && entry.partyId === "party-solo");
        assert.ok(next, "the party's new hunt was created");
        assert.equal(next!.state, "HOST_OFFERED", "the host is offered the new hunt while the drained server still runs");
        assert.equal(next!.hostAccountId, HOST);
        assert.equal(kit.parties.get("party-solo")!.activeHuntSessionId, next!.sessionId, "the party is on the new hunt");
        assert.equal(await kit.hunts.countActiveHostSessions(HOST), 1, "only the new hunt counts against the host");
        assert.equal(await kit.hunts.countActiveRealmServers(REALM_ID), 1, "only the new hunt counts against the realm");

        // The realm capacity: with the drained server not counted, the host has room for its one server. The record is read as it
        // stood before its offer, which adds the host to triedHostAccountIds.
        const realmSelection = await RankRealmHost({ ...next!, triedHostAccountIds: undefined });
        assert.equal(realmSelection.refusal, undefined, "the realm has room on its host");
        assert.deepEqual(realmSelection.ranked.map((entry) => entry.accountId), [HOST]);

        // The official ranking counts the new hunt as the host's one live hunt, so the host is busy with it, as with any hunt of its own.
        assert.deepEqual((await RankHosts(officialRoster)).map((entry) => entry.accountId), [], "the new hunt is live, so the host is busy");
    });
});

test("draining: with the drained server gone from the count, the host is ranked by the official ranking while the drain runs", async () => {
    await WithKit(async (kit) => {
        const { hunt: old } = await HostRunningHunt(kit, "party-rank");
        const officialRoster = { roster: [{ accountId: HOST, steamId: DeriveIcePeerId(HOST) }] } as unknown as P2PHuntSessionRecord;
        assert.deepEqual((await RankHosts(officialRoster)).map((entry) => entry.accountId), []);
        const drained = await BeginDrainPartySession(old, "REQUESTER_LEFT_HUNT", HOST);
        assert.equal(drained?.record.state, "DRAINING");
        assert.deepEqual((await RankHosts(officialRoster)).map((entry) => entry.accountId), [HOST],
            "a draining server is not a live hunt: the host is ranked for an official hunt");
        assert.equal(await kit.hunts.countActiveHostSessions(HOST), 0);
    });
});

test("draining with no cap: the drain holds while its server's lease renews, however long that takes, and ends with no fence when it lapses", async () => {
    await WithKit(async (kit) => {
        const { hunt, capability } = await RunningHunt(kit, "party-nocap");
        await RequestNewHunt(kit, "party-nocap");
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.drainDeadline, undefined, "no cap: no deadline is set");
        const start = Date.now();
        mock.timers.enable({ apis: ["Date"], now: start });
        try {
            // Two hours on, the server still runs and renews its lease: the drain holds and nobody is fenced.
            mock.timers.setTime(start + 2 * 60 * 60 * 1000);
            await RenewHostLease(capability, Lease(1));
            await new P2PHuntLifecycleMonitor().tick();
            assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "DRAINING", "no cap: still draining two hours later");
            assert.equal(FenceMessages(kit, hunt.sessionId).length, 0, "nobody is fenced while the server runs");
            // Its last player has left and the server exited: the heartbeats stop and the lease lapses past the suspect window.
            kit.hunts.hunts.get(hunt.sessionId)!.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
            await new P2PHuntLifecycleMonitor().tick();
        } finally {
            mock.timers.reset();
        }
        const ended = kit.hunts.hunts.get(hunt.sessionId)!;
        assert.equal(ended.state, "COMPLETED");
        assert.equal(ended.completionReason, "SUPERSEDED_REQUESTER_LEFT_HUNT");
        assert.equal(FenceMessages(kit, hunt.sessionId).length, 0, "no server is left to fence");
        const states = kit.hunts.transitions.filter((entry) => entry.sessionId === hunt.sessionId).map((entry) => entry.toState);
        assert.equal(states.some((state) => ["SUSPECT", "FENCED", "ABORTING", "RECOVERING"].includes(state)), false, "never suspect, never recovered");
    });
});

// [2026-10-15] No DeployServer (DEPLOYSERVER_URL unset, as on the VPS): a hunt that cannot be player-hosted is cancelled, never sent to a
// dedicated server that does not exist.
test("no DeployServer: a hunt that cannot be player-hosted is cancelled through the route's cancel, and no dedicated server is asked", async () => {
    await WithKit(async (kit) => {
        await WithEnvironment({ DEPLOYSERVER_URL: undefined }, async () => {
            kit.addParty("party-no-deployserver", [MEMBER]);
            // No account is on the P2P allowlist, so the hunt is not player-hosted.
            const harness = Harness(MEMBER, { partyId: "party-no-deployserver", partyMembers: [MEMBER], partyRevision: 1,
                huntId: "ShatteredIsles_IslandA" });
            const realFetch = globalThis.fetch;
            let requests = 0;
            globalThis.fetch = (async () => {
                requests += 1;
                throw new Error("no dedicated server may be asked");
            }) as typeof fetch;
            try {
                assert.deepEqual(await RouteP2PHunt(harness.context), { handled: true, result: true });
                assert.deepEqual(harness.cancels, [{ huntId: "ShatteredIsles_IslandA", accountIds: [MEMBER],
                    reason: "P2P_REQUIRED_ACCOUNT_ALLOWLIST_EMPTY" }]);
                assert.equal(requests, 0);
            } finally {
                globalThis.fetch = realFetch;
            }
        });
    });
});

test("the fallback of a failed player-hosted setup is a cancel with no DeployServer, and the dedicated route with one (2026-10-15)", () => {
    assert.equal(DedicatedFallbackAction(false, ReadP2PPolicy({}).dedicatedHuntsDisabled), "CANCEL");
    assert.equal(DedicatedFallbackAction(false, ReadP2PPolicy({ DEPLOYSERVER_URL: "deployserver.invalid:8080" }).dedicatedHuntsDisabled),
        "DEDICATED");
    // A hub is never cancelled for it (Ramsgate and the Training hub keep their dedicated server).
    assert.equal(DedicatedFallbackAction(true, ReadP2PPolicy({}).dedicatedHuntsDisabled), "DEDICATED");
});
