/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MatchmakingPartySnapshot, ResolveMatchmakingParty } from "./matchmakingParty";

const Party: MatchmakingPartySnapshot = {
    partyId: "party-live",
    members: ["leader", "online-member", "offline-member"],
    revision: 7
};

test("ISLAND travel excludes disconnected party members", () => {
    const Result = ResolveMatchmakingParty(
        "ISLAND",
        "leader",
        "party-live",
        Party,
        (AccountId) => AccountId === "online-member"
    );

    assert.equal(Result.partyId, "party-live");
    assert.deepEqual(Result.partyMembers, ["leader", "online-member"]);
    assert.equal(Result.partyRevision, 7);
    assert.deepEqual(Result.excludedMembers, ["offline-member"]);
    assert.equal(Result.partyIdMismatch, false);
});

test("ISLAND travel without the active party id falls back to solo", () => {
    const Result = ResolveMatchmakingParty(
        "ISLAND",
        "leader",
        undefined,
        Party,
        () => true
    );

    assert.equal(Result.partyId, undefined);
    assert.equal(Result.partyMembers, undefined);
    assert.equal(Result.partyRevision, undefined);
    assert.equal(Result.partyIdMismatch, true);
});

test("CITY travel keeps the authoritative party because 1.12 omits partyId", () => {
    const Result = ResolveMatchmakingParty(
        "CITY",
        "leader",
        undefined,
        Party,
        () => false
    );

    assert.equal(Result.partyId, "party-live");
    assert.deepEqual(Result.partyMembers, Party.members);
    assert.deepEqual(Result.excludedMembers, []);
});

test("a player without a party travels solo", () => {
    const Result = ResolveMatchmakingParty("ISLAND", "leader", "party-live", undefined, () => true);

    assert.equal(Result.partyId, undefined);
    assert.equal(Result.partyMembers, undefined);
    assert.equal(Result.partyIdMismatch, false);
});

test("SHARED keeps offline members unless a module asks for the online filter (P2P Training, 2026-10-11)", () => {
    const Online = (AccountId: string) => AccountId === "online-member";
    const Default = ResolveMatchmakingParty("SHARED", "leader", undefined, Party, Online);
    assert.deepEqual(Default.partyMembers, ["leader", "online-member", "offline-member"]);
    assert.deepEqual(Default.excludedMembers, []);

    const Filtered = ResolveMatchmakingParty("SHARED", "leader", undefined, Party, Online, true);
    assert.equal(Filtered.partyId, "party-live");
    assert.equal(Filtered.partyRevision, 7);
    assert.equal(Filtered.partyIdMismatch, false);
    assert.deepEqual(Filtered.partyMembers, ["leader", "online-member"]);
    assert.deepEqual(Filtered.excludedMembers, ["offline-member"]);

    // CITY is never filtered unless asked, and ISLAND keeps its partyId rule either way.
    assert.deepEqual(ResolveMatchmakingParty("CITY", "leader", undefined, Party, Online).partyMembers,
        ["leader", "online-member", "offline-member"]);
    assert.equal(ResolveMatchmakingParty("ISLAND", "leader", undefined, Party, Online, true).partyIdMismatch, true);
});
