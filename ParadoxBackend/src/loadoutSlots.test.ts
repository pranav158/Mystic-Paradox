import assert from "node:assert/strict";
import test from "node:test";
import {
    ResolveRequestedTotalLoadoutSlots,
    ResolveVisibleTotalLoadoutSlots
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
