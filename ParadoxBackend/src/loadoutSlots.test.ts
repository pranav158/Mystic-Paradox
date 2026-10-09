import assert from "node:assert/strict";
import test from "node:test";
import {
    PLAYER_JOURNEY_LOADOUT_NODE_IDS,
    ResolveActiveLoadoutIndex,
    ResolvePlayerJourneyTotalLoadoutSlots,
    ResolveRequestedTotalLoadoutSlots,
    ResolveVisibleTotalLoadoutSlots,
    ResolveWireLoadoutSlotCounts
} from "./loadoutSlots";

test("legacy /unlock/2 row exposes two total slots instead of three", () => {
    assert.equal(ResolveVisibleTotalLoadoutSlots(3, undefined), 2);
});

test("legacy /unlock/1 row exposes only the default slot", () => {
    assert.equal(ResolveVisibleTotalLoadoutSlots(2, undefined), 1);
});

test("pre-multi-slot row still exposes its single default slot", () => {
    assert.equal(ResolveVisibleTotalLoadoutSlots(1, undefined), 1);
});

test("persisted entitlement hides dormant excess slot contents", () => {
    assert.equal(ResolveVisibleTotalLoadoutSlots(3, 2), 2);
});

test("first corrected unlock request replaces the legacy inferred entitlement", () => {
    assert.equal(ResolveRequestedTotalLoadoutSlots(undefined, 2), 2);
});

test("later stale lower-count requests do not relock legitimate slots", () => {
    assert.equal(ResolveRequestedTotalLoadoutSlots(3, 2), 3);
});

test("full capacity is six total slots", () => {
    assert.equal(ResolveRequestedTotalLoadoutSlots(5, 6), 6);
});

test("invalid zero-based total is rejected", () => {
    assert.throws(() => ResolveRequestedTotalLoadoutSlots(undefined, 0), RangeError);
});

test("persisted entitlement cannot exceed stored content", () => {
    assert.throws(() => ResolveVisibleTotalLoadoutSlots(2, 3), RangeError);
});

test("persisted active loadout survives travel", () => {
    assert.equal(ResolveActiveLoadoutIndex(3, 4), 3);
});

test("legacy loadout defaults to slot zero", () => {
    assert.equal(ResolveActiveLoadoutIndex(undefined, 4), 0);
});

test("invalid active loadout falls back to slot zero", () => {
    assert.equal(ResolveActiveLoadoutIndex(4, 4), 0);
    assert.equal(ResolveActiveLoadoutIndex(-1, 4), 0);
});

test("five unlocked Slayer's Path nodes grant one default plus five character slots", () => {
    assert.equal(ResolvePlayerJourneyTotalLoadoutSlots({
        LoadoutSlot_01: { node_status: 2 },
        LoadoutSlot_02: { node_status: 2 },
        LoadoutSlot_03: { node_status: 2 },
        LoadoutSlot_04: { node_status: 2 },
        LoadoutSlot_05: { node_status: 2 }
    }), 6);
});

test("locked-but-claimable Slayer's Path nodes do not grant a loadout slot yet", () => {
    assert.equal(ResolvePlayerJourneyTotalLoadoutSlots({
        LoadoutSlot_01: { node_status: 2 },
        LoadoutSlot_02: { node_status: 1 },
        LoadoutSlot_03: { node_status: 0 }
    }), 2);
});

test("missing Player Journey data keeps only the default loadout", () => {
    assert.equal(ResolvePlayerJourneyTotalLoadoutSlots(undefined), 1);
});

// [2026-10-08] Wire split: the default slot is a CHARACTER slot (AArchonLoadout::ResolveProgressionLoadoutSlotUnlocks,
// 1.14.7 RVA 0x01BB2E20, requests (1 + unlocked conditions) - NumCharacterLoadoutSlots whenever > 0).
test("wire counts put every entitled slot in the character bucket", () => {
    assert.deepEqual(ResolveWireLoadoutSlotCounts(6), { num_account_slots: 0, max_account_slots: 0, num_character_slots: 6, max_character_slots: 6 });
    assert.deepEqual(ResolveWireLoadoutSlotCounts(1), { num_account_slots: 0, max_account_slots: 0, num_character_slots: 1, max_character_slots: 6 });
});

test("native unlock delta is zero and every total, cap and tile count is unchanged for U = 0..5", () => {
    for (let U = 0; U <= 5; U++) {
        const Nodes = Object.fromEntries(PLAYER_JOURNEY_LOADOUT_NODE_IDS.slice(0, U).map((Id) => [Id, { node_status: 2 }]));
        const Total = ResolvePlayerJourneyTotalLoadoutSlots(Nodes);
        const Wire = ResolveWireLoadoutSlotCounts(Total);
        assert.equal((1 + U) - Wire.num_character_slots, 0, `resolve delta at U=${U}`);
        assert.equal(Wire.num_account_slots + Wire.num_character_slots, Total, `SetNumLoadoutSlots total at U=${U}`);
        assert.equal(Wire.max_account_slots + Wire.max_character_slots, 6, `MaxNumLoadoutSlots at U=${U}`);
        assert.equal(Wire.max_character_slots - Wire.num_character_slots, 5 - U, `locked tiles at U=${U}`);
        assert.equal(Wire.max_account_slots - Wire.num_account_slots, 0, `More Slots tile at U=${U}`);
        assert.equal((1 + U) - Math.max(0, Total - 1), 1, `old split always looped at U=${U}`);
    }
});

test("wire counts clamp invalid inputs to the 1..6 entitlement range", () => {
    for (const Bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(ResolveWireLoadoutSlotCounts(Bad).num_character_slots, 1, `input ${Bad}`);
    }
    assert.equal(ResolveWireLoadoutSlotCounts(7).num_character_slots, 6);
    assert.equal(ResolveWireLoadoutSlotCounts(6.9).num_character_slots, 6);
});
