/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { before } from "node:test";

// [2026-10-15] No DeployServer (DEPLOYSERVER_URL unset, as on the VPS): the matchmaker asks for no dedicated hub or hunt, reports the hubs
// as unavailable, and cancels what needs a dedicated server with NO_DEDICATED_SERVERS. The module constants are read at import, so the
// environment is set first (as matchmakingLeave.test.ts does), with the P2P module off so only the dedicated path is in play.
process.env.MYSTICPARADOX_P2P_MODULE = "off";
process.env.MATCHMAKING_MODE = "DEPLOYSERVER";
delete process.env.DEPLOYSERVER_URL;

let Matchmaking: typeof import("./matchmaking");

before(async () => {
    Matchmaking = await import("./matchmaking");
});

const PLAYER = "solo-account-0001";
const LEADER = "party-leader-0001";
const FOLLOWER = "party-follower-0001";
const RAMSGATE = "ShatteredIsles_ReturnToRamsgate";
const ISLAND = "ShatteredIsles_IslandA";

/** Replaces fetch with one that records every request and fails it: no request may be made without a DeployServer. */
function ForbidRequests(): { requests: string[]; restore: () => void } {
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
        requests.push(String(input));
        throw new Error("no request may be made without a DeployServer");
    }) as typeof fetch;
    return { requests, restore: () => { globalThis.fetch = original; } };
}

test("the hub status is not asked for, and the hubs are reported unavailable, when DEPLOYSERVER_URL is unset (2026-10-15)", async () => {
    const forbidden = ForbidRequests();
    try {
        assert.equal(await Matchmaking.FetchLiveHubStatus(), undefined);
        assert.equal(await Matchmaking.FetchLiveHubStatus(), undefined, "polled again: still unavailable, still no request");
        assert.deepEqual(forbidden.requests, []);
    } finally {
        forbidden.restore();
    }
});

test("a Ramsgate request with no DeployServer is cancelled with NO_DEDICATED_SERVERS, and no dedicated server is fetched (2026-10-15)", async () => {
    const forbidden = ForbidRequests();
    try {
        assert.equal(await Matchmaking.HandlePlayerMatchmaking("CITY", "", RAMSGATE, PLAYER), true);
        const candidate = await Matchmaking.GetPlayerCandidate(PLAYER);
        assert.equal(candidate?.Canceled, true, "the candidate is cancelled, not left waiting");
        assert.equal(candidate?.StatusReason, "NO_DEDICATED_SERVERS");
        assert.deepEqual(forbidden.requests, []);
    } finally {
        forbidden.restore();
    }
});

test("a party's dedicated hunt with no DeployServer cancels every member with NO_DEDICATED_SERVERS (2026-10-15)", async () => {
    const forbidden = ForbidRequests();
    try {
        assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", ISLAND, LEADER, "party-no-deployserver-1", [LEADER, FOLLOWER], 1), true);
        for (const member of [LEADER, FOLLOWER]) {
            const candidate = await Matchmaking.GetPlayerCandidate(member);
            assert.equal(candidate?.Canceled, true, `${member} is cancelled`);
            assert.equal(candidate?.StatusReason, "NO_DEDICATED_SERVERS", member);
        }
        assert.deepEqual(forbidden.requests, []);
    } finally {
        forbidden.restore();
    }
});
