/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import type { MatchmakingResult } from "../../controllers/matchmaking";
import type { HuntRouteContext } from "../../extensions/p2p";
import { P2PControlMessageRecord, P2PHostCapabilityRecord, P2PHuntParticipantRecord } from "../persistence";
import {
    CreateHubKit, FRIEND, HOST, HubKit, InstallHubTestEnvironment, LOCAL_BRIDGE_PORT, MEMBER, REALM_ID, StartRunningHub, STRANGER
} from "../realm/realmHubTestKit";
import { ConsumeAdmissionTicket, MarkHostReady } from "./p2pAdmission";
import { CreateHostBootstrap, CreateJoinBootstrap, MarkLocalRouteReady } from "./p2pLauncher";
import { P2PCancelCandidate, P2PCandidateStatus, RouteP2PHunt } from "./p2pMatchmaking";
import { CancelFormingHunt, IsCancellableForming, RespondToHostOffer } from "./p2pHostLifecycle";
import { HubCandidate } from "./p2pRealmRouting";
import { HashHostCapabilitySecret } from "../security/hostCapabilities";
import { DeriveIcePeerId } from "../security/transportPeerIds";

// [2026-10-14 cancel] A player's Cancel of a forming player-hosted or realm hunt (the P2P hook of DELETE /candidate/leave), on the
// in-memory repositories. The shared (dedicated) cancel is in src/controllers/matchmakingLeave.test.ts.

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
}

function Harness(playerId: string, overrides: Partial<HuntRouteContext> = {}): Harness {
    const candidates = new Map<string, MatchmakingResult>();
    const context: HuntRouteContext = {
        gameMode: "ISLAND",
        huntId: "ShatteredIsles_IslandA",
        playerId,
        isHub: false,
        setCandidate: (accountId, result) => { candidates.set(accountId, result); },
        cancel: () => true,
        ...overrides
    };
    return { context, candidates };
}

function Messages(kit: HubKit, accountId: string, messageType: string): P2PControlMessageRecord[] {
    return kit.hunts.controlMessages.filter((message) => message.accountId === accountId && message.messageType === messageType);
}

/** A realm hunt of the party (the requester first); the members are bound to the realm. */
async function RealmHunt(kit: HubKit, partyId: string, members: string[]) {
    kit.addParty(partyId, members);
    for (const member of members) {
        kit.linkAccount(member);
        kit.realms.bindPresence(member, REALM_ID);
    }
    const harness = Harness(members[0], { partyId, partyMembers: members, partyRevision: 1 });
    await RouteP2PHunt(harness.context);
    const hunt = [...kit.hunts.hunts.values()].find((entry) => entry.realmId === REALM_ID && entry.partyId === partyId);
    return { harness, hunt };
}

/** The host accepts the offer and bootstraps its server (the launcher's calls, in order). */
async function HostBootstraps(kit: HubKit, sessionId: string, offerId: string) {
    await RespondToHostOffer(HOST, offerId, { accept: true });
    const bootstrap = await CreateHostBootstrap(HOST, sessionId);
    const capability: P2PHostCapabilityRecord = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
    return { bootstrap, capability };
}

/** A participating host's own route and a member's join: the hunt goes to RUNNING (as the realm hunt tests drive it). */
async function RunningRealmHunt(kit: HubKit, partyId: string, members: string[]) {
    const { hunt, harness } = await RealmHunt(kit, partyId, members);
    const { bootstrap, capability } = await HostBootstraps(kit, hunt!.sessionId, hunt!.hostOfferId!);
    await MarkHostReady({ sessionId: hunt!.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
        bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
    const join = await CreateJoinBootstrap(MEMBER, hunt!.sessionId);
    await ConsumeAdmissionTicket({
        sessionId: hunt!.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(MEMBER), bridgeInstanceId: bootstrap.bridgeInstanceId,
        connectionHandle: "handle-member", requestId: crypto.randomUUID(), capability
    });
    return { hunt: hunt!, harness };
}

function Entry(overrides: Partial<P2PHuntParticipantRecord> = {}): P2PHuntParticipantRecord {
    return { accountId: MEMBER, steamId: "steam-member", candidateId: "candidate-member", reconnectEpoch: 0, admissionState: "PENDING", ...overrides };
}

test("a realm hunt cancelled by its member before RUNNING is ABORTED with PLAYER_CANCELED: the offer withdrawn, the party freed, no dedicated fallback", async (t) => {
    await WithKit(async (kit) => {
        const { hunt, harness } = await RealmHunt(kit, "party-cancel", [MEMBER, FRIEND]);
        assert.equal(hunt?.state, "HOST_OFFERED");
        const reliability = t.mock.method(kit.hunts, "incrementHostReliability");

        const outcome = await P2PCancelCandidate(MEMBER, harness.candidates.get(MEMBER)!);
        assert.deepEqual(outcome, { handled: true, outcome: "canceled", state: "p2p:HOST_OFFERED" });

        const ended = kit.hunts.hunts.get(hunt!.sessionId)!;
        assert.equal(ended.state, "ABORTED");
        assert.equal(ended.failureReason, "PLAYER_CANCELED");
        assert.equal(ended.cancelledByAccountId, MEMBER);
        assert.equal(ended.fallbackHost, undefined, "no dedicated server is handed the hunt");
        assert.equal(kit.hunts.transitions.some((entry) => entry.sessionId === hunt!.sessionId
            && (entry.toState === "ABORTING" || entry.toState === "RECOVERING")), false);
        for (const accountId of [MEMBER, FRIEND, HOST]) {
            assert.equal(Messages(kit, accountId, "HOST_OFFER_CANCELLED").length, 1, `${accountId} is told the offer is withdrawn`);
        }
        assert.equal(reliability.mock.callCount(), 0, "the host is not charged with a start failure for a player's cancel");
        assert.equal(kit.parties.get("party-cancel")?.activeHuntSessionId, undefined, "the party is free");

        const canceller = await P2PCandidateStatus(MEMBER, harness.candidates.get(MEMBER)!);
        assert.equal(canceller?.Canceled, true);
        assert.equal(canceller?.StatusReason, "PLAYER_CANCELED");
        const other = await P2PCandidateStatus(FRIEND, harness.candidates.get(FRIEND)!);
        assert.equal(other?.Canceled, true);
        assert.equal(other?.StatusReason, "PARTY_MEMBER_CANCELED");
    });
});

test("a second cancel of the same realm hunt is a no-op: already-canceled for the canceller and for the others", async () => {
    await WithKit(async (kit) => {
        const { harness } = await RealmHunt(kit, "party-twice", [MEMBER, FRIEND]);
        assert.equal((await P2PCancelCandidate(MEMBER, harness.candidates.get(MEMBER)!)).handled, true);
        assert.deepEqual(await P2PCancelCandidate(MEMBER, harness.candidates.get(MEMBER)!),
            { handled: true, outcome: "already-canceled", state: "p2p:ABORTED" });
        assert.deepEqual(await P2PCancelCandidate(FRIEND, harness.candidates.get(FRIEND)!),
            { handled: true, outcome: "already-canceled", state: "p2p:ABORTED" });
    });
});

test("after RUNNING the cancel is too late: the hunt keeps running and no member is fenced", async () => {
    await WithKit(async (kit) => {
        const { hunt, harness } = await RunningRealmHunt(kit, "party-running", [MEMBER, FRIEND]);
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)?.state, "RUNNING");

        const outcome = await P2PCancelCandidate(MEMBER, harness.candidates.get(MEMBER)!);
        assert.deepEqual(outcome, { handled: true, outcome: "too-late", state: "p2p:RUNNING" });

        const running = kit.hunts.hunts.get(hunt.sessionId)!;
        assert.equal(running.state, "RUNNING");
        assert.equal(running.failureReason, undefined);
        assert.equal(Messages(kit, MEMBER, "FENCE_NOW").length, 0);
        assert.equal(Messages(kit, MEMBER, "HOST_OFFER_CANCELLED").length, 0);
        assert.equal(kit.parties.get("party-running")?.activeHuntSessionId, hunt.sessionId, "the party stays in the hunt");
    });
});

test("a re-join after the cancel forms a fresh realm hunt; the cancelled one stays ABORTED", async () => {
    await WithKit(async (kit) => {
        const first = await RealmHunt(kit, "party-rejoin", [MEMBER, FRIEND]);
        assert.equal((await P2PCancelCandidate(MEMBER, first.harness.candidates.get(MEMBER)!)).handled, true);

        const party = kit.parties.get("party-rejoin")!;
        const again = Harness(MEMBER, { partyId: "party-rejoin", partyMembers: [MEMBER, FRIEND], partyRevision: party.revision });
        assert.deepEqual(await RouteP2PHunt(again.context), { handled: true, result: true });

        const hunts = [...kit.hunts.hunts.values()].filter((entry) => entry.partyId === "party-rejoin");
        assert.equal(hunts.length, 2);
        const fresh = hunts.find((entry) => entry.sessionId !== first.hunt!.sessionId)!;
        assert.equal(fresh.state, "HOST_OFFERED");
        assert.equal(kit.hunts.hunts.get(first.hunt!.sessionId)?.state, "ABORTED");
        const status = await P2PCandidateStatus(MEMBER, again.candidates.get(MEMBER)!);
        assert.equal(status?.Canceled, undefined, "the fresh search is not cancelled");
    });
});

test("a realm hub entry is never cancelled: the hub is left running and the leave answers hub-not-cancelled", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const record = kit.hunts.hunts.get(hub.sessionId)!;
        const candidate = HubCandidate(record, crypto.randomUUID(), true, LOCAL_BRIDGE_PORT);
        assert.deepEqual(await P2PCancelCandidate(MEMBER, candidate), { handled: true, outcome: "hub-not-cancelled", state: "realm-hub" });
        assert.equal(kit.hunts.hunts.get(hub.sessionId)?.state, "RUNNING");
    });
});

test("a player who is not in the hunt cancels nothing of it: the shared cancel takes the request", async () => {
    await WithKit(async (kit) => {
        const { hunt, harness } = await RealmHunt(kit, "party-outsider", [MEMBER, FRIEND]);
        assert.deepEqual(await P2PCancelCandidate(STRANGER, harness.candidates.get(MEMBER)!), { handled: false });
        assert.equal(kit.hunts.hunts.get(hunt!.sessionId)?.state, "HOST_OFFERED");
    });
});

test("a player-hosted hunt that is not a realm's is cancelled with no dedicated fallback, even with dedicated hunts enabled", async (t) => {
    await WithKit(async (kit) => {
        const { hunt } = await RealmHunt(kit, "party-plain", [MEMBER, FRIEND]);
        // The official player-hosted route: the same hunt without the realm's fields.
        kit.hunts.hunts.get(hunt!.sessionId)!.realmId = undefined;
        const dedicated = t.mock.method(globalThis, "fetch", async () => { throw new Error("no DeployServer in this test"); });

        assert.equal(await CancelFormingHunt(hunt!.sessionId, hunt!.generation, MEMBER), "CANCELED");

        const ended = kit.hunts.hunts.get(hunt!.sessionId)!;
        assert.equal(ended.state, "ABORTED");
        assert.equal(ended.failureReason, "PLAYER_CANCELED");
        assert.equal(kit.hunts.transitions.some((entry) => entry.sessionId === hunt!.sessionId && entry.toState === "ABORTING"), false);
        assert.equal(dedicated.mock.callCount(), 0, "no dedicated server is asked for the hunt");
    });
});

test("a forming hunt is cancellable only before RUNNING, with no member admitted and no route released", () => {
    for (const state of ["HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING"] as const) {
        assert.equal(IsCancellableForming({ state, roster: [Entry()] }), true, `${state} with a pending member`);
    }
    for (const state of ["RUNNING", "SUSPECT", "FENCED", "ABORTING", "RECOVERING", "COMPLETED", "ABORTED"] as const) {
        assert.equal(IsCancellableForming({ state, roster: [Entry()] }), false, `${state} is not forming`);
    }
    assert.equal(IsCancellableForming({ state: "HOST_READY", roster: [Entry({ admissionState: "ADMITTED" })] }), false);
    assert.equal(IsCancellableForming({ state: "HOST_READY", roster: [Entry({ localBridgePort: LOCAL_BRIDGE_PORT })] }), false);
    assert.equal(IsCancellableForming({ state: "HOST_READY", roster: [Entry({ localBridgeReadyAt: iso() })] }), false);
});
