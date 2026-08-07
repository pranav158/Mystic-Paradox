import assert from "node:assert/strict";
import test from "node:test";

import { ResolveMatchmakingParty } from "./matchmakingParty";

const Party = {
    partyId: "party-live",
    members: ["leader", "offline-member", "online-member"]
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