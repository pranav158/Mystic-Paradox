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
import test, { after, before } from "node:test";
import type { JwtPayload } from "jsonwebtoken";
import type { MatchmakingResult } from "../../controllers/matchmaking";
import type { HuntRouteContext } from "../../extensions/p2p";
import { LauncherApiError } from "../security/p2pErrors";
import { P2PControlMessageRecord, P2PHostCapabilityRecord } from "../persistence";
import {
    CreateHubKit, FRIEND, HOST, HubKit, InstallHubTestEnvironment, LOCAL_BRIDGE_PORT, MEMBER, REALM_ID, RunningHub, StartRunningHub, STRANGER
} from "../realm/realmHubTestKit";
import { ConsumeAdmissionTicket, MarkHostReady } from "./p2pAdmission";
import { CreateHostBootstrap, CreateJoinBootstrap, MarkLocalRouteReady } from "./p2pLauncher";
import { P2PCandidateStatus, RouteP2PHunt, SetHuntManifestResolverForTest } from "./p2pMatchmaking";
import { SYNTHETIC_HUNT_ID, WithEnvironment, WriteSyntheticHuntTables } from "../huntManifest/huntTablesTestKit";
import { ParseGuardRequiredRoles, PrepareRecovery, RespondToHostOffer, SubmitHostPresence } from "./p2pHostLifecycle";
import { HashHostCapabilitySecret, BuildPlayerHostRuntimeAuthData, ResolveActiveHostRuntimeContext } from "../security/hostCapabilities";
import { HostWriteDenialReason } from "../security/hostWrites";
import { DeriveIcePeerId } from "../security/transportPeerIds";

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

test("a realm hunt is refused by the host's own capacity when the host has no memory to spare, and no candidate is offered", async () => {
    await WithKit(async (kit) => {
        const presence = kit.hunts.hostPresences.get(HOST)!;
        kit.hunts.hostPresences.set(HOST, { ...presence, freePhysicalMemoryMiB: 512, observedAt: iso(), expiresAt: iso(25_000) });
        const { hunt } = await RealmHunt(kit, "party-memory", [MEMBER, FRIEND]);
        assert.equal(hunt?.state, "ABORTED");
        assert.equal(hunt?.failureReason, "REALM_FULL");
        assert.equal(Messages(kit, HOST, "HOST_OFFERED").length, 0);
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

test("return: a realm hunt's member who asks for Ramsgate ends its hunt (PARTY_RETURNED_TO_HUB) and is placed in the running hub", async () => {
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
