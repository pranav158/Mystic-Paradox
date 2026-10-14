/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import type { LeavePartyLookup } from "./matchmaking";

// [2026-10-14 cancel] The client's Cancel of a search (DELETE /candidate/leave) on the dedicated path, in the dedicated-only build (the
// P2P module off). The realm and player-hosted cancels are in src/p2p/controllers/p2pCandidateLeave.test.ts.
// The module constants (MATCHMAKING_MODE, DEPLOYSERVER_URL) are read at import, so the modules load after the environment is set.
process.env.MYSTICPARADOX_P2P_MODULE = "off";
process.env.MATCHMAKING_MODE = "DEPLOYSERVER";
process.env.DEPLOYSERVER_URL = "deployserver.invalid:8080";

let Matchmaking: typeof import("./matchmaking");
let Candidates: typeof import("./candidateStatus");
let Extensions: typeof import("../extensions/p2p");

before(async () => {
    Matchmaking = await import("./matchmaking");
    Candidates = await import("./candidateStatus");
    Extensions = await import("../extensions/p2p");
});

const USER = "leader-account-0001";
const MEMBER_B = "member-account-0002";
const MEMBER_C = "member-account-0003";
const HUB_USER = "hub-account-0001";
const ISLAND = "ShatteredIsles_IslandA";
const PARTY_ID = "party-cancel-0001";
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const SOLO: LeavePartyLookup = async () => undefined;

/** A DeployServer that answers every hunt launch with one host and port. */
function StubDeployServer(t: TestContext) {
    return t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ host: "203.0.113.10", port: 7777 }),
        { status: 200, headers: { "content-type": "application/json" } }));
}

/** Time the Go Now release is measured against: advance it to tell a search it may travel. */
function Clock(t: TestContext) {
    let now = NOW;
    t.mock.method(Date, "now", () => now);
    return { advance: (ms: number) => { now += ms; } };
}

/** GET /candidate/status: the body the route answers for this account (undefined: no candidate, the route answers empty). */
async function StatusBody(userId: string, liveRamsgate = false): Promise<Record<string, any> | undefined> {
    const result = await Matchmaking.CheckAndUpdateQueueStatus(userId);
    const answer = await Candidates.CandidateStatusAnswerFor(userId, result, {
        clientIp: undefined,
        fetchLiveHub: async () => liveRamsgate
            ? { ramsgate: { ready: true, host: "203.0.113.10", port: 7777, processId: 1 } }
            : undefined
    });
    return answer.body;
}

test("a solo search cancelled before its travel: CANCELED with PLAYER_CANCELED, a second press is a no-op, a re-join searches again", async (t) => {
    Clock(t);
    const deployServer = StubDeployServer(t);
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", ISLAND, USER), true);
    const matching = await StatusBody(USER);
    assert.equal(matching?.status, "MATCHING");

    const first = await Matchmaking.CancelMatchmakingForLeave(USER, SOLO);
    assert.deepEqual(first, { outcome: "canceled", state: "go-now", candidateId: matching?.candidateId });

    const canceled = await StatusBody(USER);
    assert.equal(canceled?.status, "CANCELED");
    assert.equal(canceled?.statusReason, "PLAYER_CANCELED");
    assert.equal(canceled?.candidateId, matching?.candidateId, "the candidate keeps its id");

    const second = await Matchmaking.CancelMatchmakingForLeave(USER, SOLO);
    assert.deepEqual(second, { outcome: "already-canceled", state: "canceled", candidateId: matching?.candidateId });
    assert.equal((await StatusBody(USER))?.statusReason, "PLAYER_CANCELED");

    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", ISLAND, USER), true, "a join after the cancel is accepted");
    assert.equal((await StatusBody(USER))?.status, "MATCHING");
    assert.equal(deployServer.mock.callCount(), 2, "the re-join launches a fresh hunt");
});

test("a party's forming hunt is cancelled for every member: the leader PLAYER_CANCELED, the others PARTY_MEMBER_CANCELED, the party instance is dropped", async (t) => {
    Clock(t);
    const deployServer = StubDeployServer(t);
    const members = [USER, MEMBER_B, MEMBER_C];
    const partyOf: LeavePartyLookup = async () => ({ partyId: PARTY_ID, members });
    for (const member of members) {
        assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", ISLAND, member, PARTY_ID, members, 1, "build"), true);
    }
    assert.equal(deployServer.mock.callCount(), 1, "the party shares one hunt server");
    assert.equal((await StatusBody(MEMBER_B))?.status, "MATCHING");

    assert.deepEqual(await Matchmaking.CancelMatchmakingForLeave(USER, partyOf), {
        outcome: "canceled", state: "go-now", candidateId: (await StatusBody(USER))?.candidateId
    });
    assert.equal((await StatusBody(USER))?.statusReason, "PLAYER_CANCELED");
    for (const member of [MEMBER_B, MEMBER_C]) {
        const body = await StatusBody(member);
        assert.equal(body?.status, "CANCELED");
        assert.equal(body?.statusReason, "PARTY_MEMBER_CANCELED");
    }
    assert.equal(await Matchmaking.GetPartyInstance(PARTY_ID), undefined, "the party no longer shows a hunt");

    // The leader searches again: a new shared instance, and the members who were cancelled follow it in.
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", ISLAND, USER, PARTY_ID, members, 1, "build"), true);
    assert.equal(deployServer.mock.callCount(), 2, "a fresh hunt server, not the cancelled one");
    assert.equal((await StatusBody(USER))?.status, "MATCHING");
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", ISLAND, MEMBER_B, PARTY_ID, members, 1, "build"), true);
    assert.equal((await StatusBody(MEMBER_B))?.status, "MATCHING", "a follower of the new hunt is not still cancelled");
    assert.equal(deployServer.mock.callCount(), 2);
});

test("a search already told to travel is left alone: too-late, and it still travels", async (t) => {
    const clock = Clock(t);
    StubDeployServer(t);
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", ISLAND, USER), true);
    clock.advance(60_000);
    assert.equal((await StatusBody(USER))?.status, "IN_PROGRESS");

    const outcome = await Matchmaking.CancelMatchmakingForLeave(USER, SOLO);
    assert.equal(outcome.outcome, "too-late");
    assert.equal(outcome.state, "ready");
    assert.equal((await StatusBody(USER))?.status, "IN_PROGRESS");
});

test("a hub destination is never cancelled: Ramsgate's search keeps its status and the leave is logged as hub-not-cancelled", async (t) => {
    const clock = Clock(t);
    StubDeployServer(t);
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("CITY", "", "", HUB_USER), true);
    const matching = await StatusBody(HUB_USER, true);
    assert.equal(matching?.status, "MATCHING");

    const outcome = await Matchmaking.CancelMatchmakingForLeave(HUB_USER, SOLO);
    assert.deepEqual(outcome, { outcome: "hub-not-cancelled", state: "hub", candidateId: matching?.candidateId });
    assert.equal((await StatusBody(HUB_USER, true))?.status, "MATCHING");

    clock.advance(60_000);
    assert.equal((await StatusBody(HUB_USER, true))?.status, "IN_PROGRESS");
    assert.equal((await Matchmaking.CancelMatchmakingForLeave(HUB_USER, SOLO)).outcome, "hub-not-cancelled");
    assert.equal((await StatusBody(HUB_USER, true))?.status, "IN_PROGRESS", "still travelling to Ramsgate");
});

test("a queued search leaves its queue on cancel, and a join after it queues again", async (t) => {
    Clock(t);
    const deployServer = StubDeployServer(t);
    const queuedHunt = "CR19_PlayerHunt_Cancel_Test";
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", queuedHunt, USER), true);
    assert.equal((await StatusBody(USER))?.status, "MATCHING");

    const outcome = await Matchmaking.CancelMatchmakingForLeave(USER, SOLO);
    assert.equal(outcome.outcome, "canceled");
    assert.equal(outcome.state, "queued");
    assert.equal((await StatusBody(USER))?.statusReason, "PLAYER_CANCELED");
    assert.equal(deployServer.mock.callCount(), 0, "nothing was launched for the queue");

    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", queuedHunt, USER), true);
    assert.equal((await StatusBody(USER))?.status, "MATCHING");
});

test("a leave by a player with no search answers no-candidate", async () => {
    assert.deepEqual(await Matchmaking.CancelMatchmakingForLeave("nobody-account-0001", SOLO), { outcome: "no-candidate", state: "none" });
});

test("the dedicated-only build (no P2P module) leaves a search to the shared cancel: the module's hook is inert", async () => {
    const extension = Extensions.GetP2PExtension();
    assert.equal(extension.loaded, false);
    const search = {
        Ready: false, HuntId: ISLAND, CandidateId: "candidate-1", GameSessionId: "game-session-1", Host: "", Port: 0, ReadyAt: 0
    };
    assert.deepEqual(await extension.matchmaking.cancelCandidate(USER, search), { handled: false });
});
