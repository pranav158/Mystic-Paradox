import assert from "node:assert/strict";
import test from "node:test";
import {
    GetInventoryStoragePolicy,
    MigrateInventoryStorageArrays,
    NormalizeInventoryGrantCollections,
} from "./inventoryStoragePolicy";

test("1.12 policy distinguishes transmog unlocks from functional gear", () => {
    assert.equal(GetInventoryStoragePolicy("WP_AC_TRIALS_00")?.storage, "stacked");
    assert.equal(GetInventoryStoragePolicy("WP_EB_HP09A_ASSASSINS_00")?.storage, "stacked");
    assert.equal(GetInventoryStoragePolicy("LT_TRIALS_01")?.storage, "stacked");
    assert.equal(GetInventoryStoragePolicy("LT_TRIALS_00")?.storage, "instanced");
    assert.equal(GetInventoryStoragePolicy("PART_CB_PASSIVE_TRIALS_02")?.storage, "instanced");
    assert.equal(GetInventoryStoragePolicy("WP_GA_BEGINNER")?.storage, "instanced");
    assert.equal(GetInventoryStoragePolicy("AC_BACK_HP06-1_00")?.storage, "instanced");
    assert.equal(GetInventoryStoragePolicy("AC_BACK_HP06-1_01")?.storage, "instanced");
});

test("authoritative grant normalization moves catalog-declared stackables out of instanced adds", () => {
    const Result = NormalizeInventoryGrantCollections(
        "TX-1",
        [
            { catalogId: "WP_AC_TRIALS_00", instanceId: "BAD-COSMETIC", itemData: null, updateVersion: 0 },
            { catalogId: "LT_TRIALS_00", instanceId: "REAL-LANTERN", itemData: null, updateVersion: 0 },
        ],
        []
    );

    assert.deepEqual(Result.instancedItemsToAdd, [
        { catalogId: "LT_TRIALS_00", instanceId: "REAL-LANTERN", itemData: null, updateVersion: 0 },
    ]);
    assert.deepEqual(Result.stackedItemsToAdd, [{ catalogId: "WP_AC_TRIALS_00", quantity: 1 }]);
    assert.deepEqual(Result.corrections, [
        { catalogId: "WP_AC_TRIALS_00", from: "instanced", to: "stacked", quantity: 1 },
    ]);
});

test("normalization creates deterministic instances for a known non-stackable sent as stacked", () => {
    const First = NormalizeInventoryGrantCollections("TX-2", [], [{ catalogId: "LT_TRIALS_00", quantity: 2 }]);
    const Second = NormalizeInventoryGrantCollections("TX-2", [], [{ catalogId: "LT_TRIALS_00", quantity: 2 }]);

    assert.equal(First.stackedItemsToAdd.length, 0);
    assert.equal(First.instancedItemsToAdd.length, 2);
    assert.deepEqual(First.instancedItemsToAdd, Second.instancedItemsToAdd);
    assert.notEqual(First.instancedItemsToAdd[0].instanceId, First.instancedItemsToAdd[1].instanceId);
});

test("migration removes malformed cosmetic instances and deduplicates ownership", () => {
    const Result = MigrateInventoryStorageArrays(
        [
            { catalogId: "WP_AC_TRIALS_00", instanceId: "A" },
            { catalogId: "WP_AC_TRIALS_00", instanceId: "B" },
            { catalogId: "LT_TRIALS_00", instanceId: "C" },
        ],
        [{ catalogId: "WP_AC_TRIALS_00", quantity: 1 }]
    );

    assert.deepEqual(Result.instancedItems, [{ catalogId: "LT_TRIALS_00", instanceId: "C" }]);
    assert.deepEqual(Result.stackedItems, [{ catalogId: "WP_AC_TRIALS_00", quantity: 1 }]);
    assert.equal(Result.changes[0].migratedInstances, 2);
    assert.equal(Result.changes[0].existingQuantity, 1);
    assert.equal(Result.changes[0].result, "deduplicated-to-one");
});

test("migration repairs Lady Luck cosmetics that the 1.12 parser expects as quantity records", () => {
    const Result = MigrateInventoryStorageArrays(
        [
            { catalogId: "AC_HEAD_TRIALS_00", instanceId: "HEAD" },
            { catalogId: "WP_AC_TRIALS_00", instanceId: "STRIKERS" },
            { catalogId: "AR_TRIALS_CHEST_00", instanceId: "CHEST" },
            { catalogId: "LT_TRIALS_00", instanceId: "FUNCTIONAL-LANTERN" },
        ],
        []
    );

    assert.deepEqual(Result.instancedItems, [
        { catalogId: "LT_TRIALS_00", instanceId: "FUNCTIONAL-LANTERN" },
    ]);
    assert.deepEqual(Result.stackedItems, [
        { catalogId: "AC_HEAD_TRIALS_00", quantity: 1 },
        { catalogId: "WP_AC_TRIALS_00", quantity: 1 },
        { catalogId: "AR_TRIALS_CHEST_00", quantity: 1 },
    ]);
    assert.deepEqual(Result.changes.map((Change) => Change.catalogId), [
        "AC_HEAD_TRIALS_00",
        "WP_AC_TRIALS_00",
        "AR_TRIALS_CHEST_00",
    ]);
});

test("migration catches old Hunt Pass cosmetic instances", () => {
    const Result = MigrateInventoryStorageArrays(
        [
            { catalogId: "WP_EB_HP09A_ASSASSINS_00", instanceId: "SWORD-SKIN" },
            { catalogId: "LT_HP09A_ASSASSINS_00", instanceId: "LANTERN-SKIN" },
        ],
        []
    );

    assert.equal(Result.instancedItems.length, 0);
    assert.deepEqual(Result.stackedItems, [
        { catalogId: "WP_EB_HP09A_ASSASSINS_00", quantity: 1 },
        { catalogId: "LT_HP09A_ASSASSINS_00", quantity: 1 },
    ]);
});

test("migration flags but does not invent identity for pre-existing non-stackables in stacked storage", () => {
    const Result = MigrateInventoryStorageArrays([], [{ catalogId: "WP_GA_BEGINNER", quantity: 1 }]);
    assert.deepEqual(Result.stackedItems, [{ catalogId: "WP_GA_BEGINNER", quantity: 1 }]);
    assert.deepEqual(Result.issues, [{
        catalogId: "WP_GA_BEGINNER",
        source: "stackedItems",
        expected: "instancedItems",
        quantity: 1,
        result: "manual-review",
    }]);
});