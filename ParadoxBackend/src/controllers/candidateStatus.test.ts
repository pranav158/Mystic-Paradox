/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { LiveHubStatus, MatchmakingResult } from "./matchmaking";
import { CandidateStatusAnswerFor, REALM_FULL_RETRY_AFTER_SECONDS } from "./candidateStatus";
import { GetCandidateStatusPeriodMillis } from "./matchmaking";

// [2026-10-14 realms S2] GET /candidate/status: the answer built from the candidate. The non-realm answers are the ones the route gave
// before the move (a dedicated or hunt candidate, the Ramsgate's live check); a realm hub candidate is answered from its own loopback
// port, as CITY with a null huntId for Ramsgate and SHARED with the Training hunt id for the Training hub.

const USER = "member-account-0001";
const RAMSGATE_ID = "ShatteredIsles_ReturnToRamsgate";
const TRAINING_ID = "ShatteredIsles_TrainingDojo";

function Candidate(overrides: Partial<MatchmakingResult> = {}): MatchmakingResult {
    return {
        Ready: false,
        CandidateId: "candidate-1",
        GameSessionId: "game-session-1",
        HuntId: "ShatteredIsles_IslandA",
        Host: "",
        Port: 0,
        ReadyAt: 0,
        ...overrides
    };
}

function Options(live?: LiveHubStatus, clientIp: string | undefined = "203.0.113.7") {
    let fetches = 0;
    return {
        options: {
            clientIp,
            fetchLiveHub: async () => { fetches += 1; return live; }
        },
        fetches: () => fetches
    };
}

test("a missing candidate is a 404 with no body", async () => {
    const { options } = Options();
    assert.deepEqual(await CandidateStatusAnswerFor(USER, undefined, options), { status: 404 });
});

test("a dedicated hunt candidate that is still matching keeps its hunt id and ISLAND, and polls once per second (16 Oct)", async () => {
    const { options, fetches } = Options();
    const answer = await CandidateStatusAnswerFor(USER, Candidate(), options);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, {
        candidateId: "candidate-1",
        candidateStatusPeriodMillis: 1000,
        gameMode: "ISLAND",
        huntId: "ShatteredIsles_IslandA",
        playerStates: { [USER]: {} },
        status: "MATCHING",
        statusDuration: 0.0,
        statusReason: null
    });
    assert.equal(fetches(), 0);
});

test("a cancelled hunt candidate answers CANCELED with its reason and no retry hint (unchanged)", async () => {
    const { options } = Options();
    const answer = await CandidateStatusAnswerFor(USER, Candidate({ Canceled: true, StatusReason: "P2P_REQUIRED_ACCOUNT_NOT_ALLOWLISTED" }), options);
    assert.equal(answer.body?.status, "CANCELED");
    assert.equal(answer.body?.statusReason, "P2P_REQUIRED_ACCOUNT_NOT_ALLOWLISTED");
    assert.equal("retryAfterSeconds" in (answer.body ?? {}), false);
});

test("a hunt cancelled for its realm's capacity carries the 30 s retry hint", async () => {
    const { options } = Options();
    const answer = await CandidateStatusAnswerFor(USER, Candidate({ Canceled: true, StatusReason: "REALM_FULL" }), options);
    assert.equal(answer.body?.statusReason, "REALM_FULL");
    assert.equal(answer.body?.retryAfterSeconds, REALM_FULL_RETRY_AFTER_SECONDS);
    assert.equal(REALM_FULL_RETRY_AFTER_SECONDS, 30);
});

test("a dedicated Ramsgate travel is verified against the live hub: a stale hub holds the client in MATCHING, a live one gives its port", async () => {
    const stale = Options({ ramsgate: { ready: false, host: "", port: 0, processId: 1 } });
    const holding = await CandidateStatusAnswerFor(USER, Candidate({ HuntId: RAMSGATE_ID, Ready: true, Host: "198.51.100.9", Port: 8790 }), stale.options);
    assert.equal(holding.body?.status, "MATCHING");
    assert.equal(holding.body?.candidateStatusPeriodMillis, 1000);
    assert.equal(stale.fetches(), 1);

    const live = Options({ ramsgate: { ready: true, host: "198.51.100.9", port: 8791, processId: 2 } });
    const answer = await CandidateStatusAnswerFor(USER, Candidate({ HuntId: RAMSGATE_ID, Ready: true, Host: "198.51.100.9", Port: 8790, GameSessionId: "hub-room" }), live.options);
    assert.equal(answer.body?.status, "IN_PROGRESS");
    assert.equal(answer.body?.gameMode, "CITY");
    assert.equal(answer.body?.huntId, null);
    assert.deepEqual(answer.body?.serverInfo, {
        buildId: `${process.env.TARGET_CHANGELIST}_1.14.7_shipping`,
        gameSessionId: "hub-room",
        host: "198.51.100.9",
        port: 8791
    });
});

test("a realm's Ramsgate candidate is never checked against the DeployServer, answers CITY with a null huntId and the hub room id", async () => {
    const realm = Options(undefined);
    const answer = await CandidateStatusAnswerFor(USER, Candidate({
        Source: "REALM_HUB",
        SourceSessionId: "hub-session",
        HuntId: RAMSGATE_ID,
        GameSessionId: "5f1c0e7a-3d2b-4a6c-9e8f-0123456789ab",
        Ready: true,
        Host: "127.0.0.1",
        Port: 56000
    }), realm.options);
    assert.equal(realm.fetches(), 0, "the hub's live check is not asked for a realm hub");
    assert.equal(answer.body?.status, "IN_PROGRESS");
    assert.equal(answer.body?.gameMode, "CITY");
    assert.equal(answer.body?.huntId, null);
    const serverInfo = answer.body?.serverInfo as { gameSessionId: string; host: string; port: number };
    assert.equal(serverInfo.gameSessionId, "5f1c0e7a-3d2b-4a6c-9e8f-0123456789ab");
    assert.equal(serverInfo.host, "127.0.0.1");
    assert.equal(serverInfo.port, 56000);
});

test("a realm's Ramsgate still waiting is MATCHING with a null huntId (as it will be when it runs)", async () => {
    const { options } = Options();
    const answer = await CandidateStatusAnswerFor(USER, Candidate({ Source: "REALM_HUB", SourceSessionId: "hub-session", HuntId: RAMSGATE_ID }), options);
    assert.equal(answer.body?.status, "MATCHING");
    assert.equal(answer.body?.gameMode, "CITY");
    assert.equal(answer.body?.huntId, null);
});

test("a realm's Training hub is SHARED with the Training hunt id, waiting or running", async () => {
    const { options } = Options();
    const waiting = await CandidateStatusAnswerFor(USER, Candidate({ Source: "REALM_HUB", SourceSessionId: "t", HuntId: TRAINING_ID }), options);
    assert.equal(waiting.body?.status, "MATCHING");
    assert.equal(waiting.body?.gameMode, "SHARED");
    assert.equal(waiting.body?.huntId, TRAINING_ID);

    const running = await CandidateStatusAnswerFor(USER, Candidate({ Source: "REALM_HUB", SourceSessionId: "t", HuntId: TRAINING_ID,
        Ready: true, Host: "127.0.0.1", Port: 56001, GameSessionId: "training-room" }), options);
    assert.equal(running.body?.status, "IN_PROGRESS");
    assert.equal(running.body?.gameMode, "SHARED");
    assert.equal(running.body?.huntId, TRAINING_ID);
});

test("a realm hub candidate cancelled with its reason says so, and a Training hub's start timeout carries no retry hint", async () => {
    const { options } = Options();
    const cancelled = await CandidateStatusAnswerFor(USER, Candidate({ Source: "REALM_HUB", SourceSessionId: "t", HuntId: TRAINING_ID,
        Canceled: true, StatusReason: "REALM_HUB_START_TIMEOUT" }), options);
    assert.equal(cancelled.body?.status, "CANCELED");
    assert.equal(cancelled.body?.statusReason, "REALM_HUB_START_TIMEOUT");
    assert.equal(cancelled.body?.gameMode, "SHARED");
    assert.equal(cancelled.body?.huntId, null);
    assert.equal("retryAfterSeconds" in (cancelled.body ?? {}), false);
});

test("[2026-10-16] the poll period: once per second while matching and in the release window, 10 s once the server is given", () => {
    // A realm's Ramsgate is ready ~2-3 s after the join; at 10 s the game's next poll made every Play take 10-12 s.
    assert.equal(GetCandidateStatusPeriodMillis(Candidate({ Ready: false })), 1000);
    assert.equal(GetCandidateStatusPeriodMillis(Candidate({ Ready: true, ReadyAt: Date.now() + 5000 })), 1000);
    assert.equal(GetCandidateStatusPeriodMillis(Candidate({ Ready: true, ReadyAt: 0 })), 10000);
});