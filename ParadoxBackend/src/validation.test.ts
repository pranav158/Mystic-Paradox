/*
 * Regression coverage for the request-shape boundary used by POST /inventory.
 * These are pure checks: they do not start Mongo, an HTTP listener, a game or
 * any external process.  The route relies on this classification before it
 * reaches the transaction layer, so a future payload-field change must not
 * silently turn a player save into an authoritative grant or spend.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { InventoryBodyHasGrantOrSpend, ValidateInventoryTransactionBody } from "./validation";

const SaveOnly = {
    characterId: "character-1",
    transactionId: "save-1",
    saveInstancedItems: [{ catalogId: "Weapon_Sword", instanceId: "instance-1", updateVersion: 1 }],
};

test("save-only inventory writes are not classified as authoritative grants or spends", () => {
    assert.equal(InventoryBodyHasGrantOrSpend(SaveOnly), false);
    assert.equal(ValidateInventoryTransactionBody(SaveOnly), null);
});

test("every authoritative inventory delta is classified as a grant or spend", () => {
    for (const field of ["addInstancedItems", "addStackedItems", "removeInstancedItems", "removeStackedItems"]) {
        const body: any = { characterId: "character-1", transactionId: `tx-${field}`, [field]: [] };
        assert.equal(InventoryBodyHasGrantOrSpend(body), false, `${field} empty array should be inert`);
        body[field] = field.includes("Instanced")
            ? [{ catalogId: "Weapon_Sword", instanceId: "instance-1" }]
            : [{ catalogId: "CURRENCY_RAMS", quantity: 1 }];
        assert.equal(InventoryBodyHasGrantOrSpend(body), true, `${field} must require gameserver authority`);
    }
});

test("malformed mutation fields fail validation before transaction classification can be used", () => {
    const malformed = {
        characterId: "character-1",
        transactionId: "bad-1",
        addStackedItems: [{ catalogId: "CURRENCY_RAMS", quantity: -1 }],
    };
    assert.match(ValidateInventoryTransactionBody(malformed) ?? "", /invalid quantity/u);
    assert.equal(InventoryBodyHasGrantOrSpend(malformed), true);
});

