/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// The Ramsgate fountain's daily free bundle (controllers/store.ts, store tag fountain_daily_free_bundle). A game-data
// test because importing the store controller loads the real store files. The clock, the inventory transaction and the
// ledger lookup are injected: no database is touched.

import assert from "node:assert/strict";
import test from "node:test";
import {
    DailyClaimTransactionId,
    DailyResetWindow,
    FindStoreSkuByIdOrCatalogId,
    FOUNTAIN_DAILY_BUNDLE_TAG,
    GetStoreSkus,
    GetStoreSkusForPlayer,
    LoadFountainDailyBundleSkus,
    ParseFountainDailyBundle,
    PurchaseStoreSku,
} from "./store";
import { InventoryTransactionMismatchError, RunInventoryTransaction } from "./inventory";
import { ApplyCurrencyDeltas } from "./wallet";

const TAG = FOUNTAIN_DAILY_BUNDLE_TAG;
const OFFER = GetStoreSkus(TAG)[0];
const NO_OFFER = OFFER === undefined ? "game-data/fountain_daily_bundle.json is not present (optional file)" : false;

const BEFORE_RESET = Date.parse("2026-10-10T16:30:00.000Z");          // window opened 2026-10-09 17:00 UTC
const JUST_BEFORE_RESET = Date.parse("2026-10-10T16:59:59.999Z");     // same window
const AT_RESET = Date.parse("2026-10-10T17:00:00.000Z");              // next window
const AFTER_RESET = Date.parse("2026-10-10T18:00:00.000Z");           // still the next window

// Mirrors RunInventoryTransaction's ledger contract: a new (user, character, transaction) applies once, the same id
// with the same body returns the stored result without applying anything, and a different body is a mismatch.
function FakeEconomy() {
    const Ledger = new Map<string, { userId: string; characterId: string; transactionId: string; requestHash: string; result: any }>();
    const Wallet: Record<string, number> = {};
    const WalletMoves: string[] = [];
    const Calls: { transactionId: string; stackedAdds: any[]; stackedRemoves: any[] }[] = [];

    const RunTransaction = (async (UserId: string, CharacterId: string, TransactionId: string, InstancedAdd: any[], StackedAdd: any[],
        InstancedRemove: any[], StackedRemove: any[], InstancedSave: any[]) => {
        Calls.push({ transactionId: TransactionId, stackedAdds: StackedAdd, stackedRemoves: StackedRemove });
        const Key = JSON.stringify([UserId, CharacterId, TransactionId]);
        const RequestHash = JSON.stringify([InstancedAdd, StackedAdd, InstancedRemove, StackedRemove, InstancedSave]);
        const Existing = Ledger.get(Key);
        if (Existing) {
            if (Existing.requestHash !== RequestHash) throw new InventoryTransactionMismatchError(TransactionId);
            return Existing.result;
        }
        for (const Item of StackedAdd) {
            Wallet[Item.catalogId] = (Wallet[Item.catalogId] ?? 0) + Item.quantity;
            WalletMoves.push(`+${Item.catalogId} x${Item.quantity}`);
        }
        for (const Item of StackedRemove) {
            Wallet[Item.catalogId] = (Wallet[Item.catalogId] ?? 0) - Item.quantity;
            WalletMoves.push(`-${Item.catalogId} x${Item.quantity}`);
        }
        const Result = { createdInstancedItems: [], updatedInstancedItems: [], updatedStackedItems: StackedAdd, removedInstancedItems: [] };
        Ledger.set(Key, { userId: UserId, characterId: CharacterId, transactionId: TransactionId, requestHash: RequestHash, result: Result });
        return Result;
    }) as unknown as typeof RunInventoryTransaction;

    const HasClaim = async (UserId: string, TransactionId: string) => {
        const Row = [...Ledger.values()].find((Row) => Row.userId === UserId && Row.transactionId === TransactionId);
        return Row === undefined ? undefined : { characterId: Row.characterId };
    };

    return { Ledger, Wallet, WalletMoves, Calls, RunTransaction, HasClaim };
}

function ExpectedGrant(): Record<string, number> {
    const Grant: Record<string, number> = {};
    for (const Item of OFFER!.items) Grant[Item.catalogId] = (Grant[Item.catalogId] ?? 0) + Item.quantity;
    return Grant;
}

function Claim(Economy: ReturnType<typeof FakeEconomy>, UserId: string, NowMs: number) {
    return PurchaseStoreSku(UserId, `${UserId}-character`, TAG, OFFER!.id, true,
        { nowMs: NowMs, runTransaction: Economy.RunTransaction, hasClaim: Economy.HasClaim });
}

function Listing(Economy: ReturnType<typeof FakeEconomy>, UserId: string | undefined, NowMs: number) {
    return GetStoreSkusForPlayer(TAG, UserId, { nowMs: NowMs, hasClaim: Economy.HasClaim });
}

test("the daily window resets at 17:00 UTC and keys the claim transaction", () => {
    assert.equal(DailyResetWindow(BEFORE_RESET).key, "2026-10-09T17:00:00.000Z");
    assert.equal(DailyResetWindow(JUST_BEFORE_RESET).key, "2026-10-09T17:00:00.000Z");
    assert.equal(DailyResetWindow(AT_RESET).key, "2026-10-10T17:00:00.000Z");
    assert.equal(DailyResetWindow(Date.parse("2026-10-11T00:00:00.000Z")).key, "2026-10-10T17:00:00.000Z");
    const Window = DailyResetWindow(AFTER_RESET);
    assert.equal(Window.endMs - Window.startMs, 24 * 60 * 60 * 1000);
    assert.throws(() => DailyResetWindow(Number.NaN));

    const Id = DailyClaimTransactionId(TAG, "user-a", "sku", "2026-10-09T17:00:00.000Z");
    assert.match(Id, /^[0-9A-F]{32}$/);
    assert.equal(DailyClaimTransactionId(TAG, "user-a", "sku", "2026-10-09T17:00:00.000Z"), Id);
    assert.notEqual(DailyClaimTransactionId(TAG, "user-b", "sku", "2026-10-09T17:00:00.000Z"), Id);
    assert.notEqual(DailyClaimTransactionId(TAG, "user-a", "sku", "2026-10-10T17:00:00.000Z"), Id);
    assert.notEqual(DailyClaimTransactionId(TAG, "user-a", "sku-2", "2026-10-09T17:00:00.000Z"), Id);
});

test("the served offer is free, stacked-only and reachable only by its own SKU id", { skip: NO_OFFER }, () => {
    assert.equal(GetStoreSkus(TAG).length, 1);
    assert.deepEqual(OFFER!.prices, [{ currencyId: "id_currency_platinum", price: 0 }]);
    assert.ok(OFFER!.tags.includes(TAG));
    assert.ok(OFFER!.items.length > 0);
    assert.ok(OFFER!.items.every((Item) => Item.instanced === false && Number.isSafeInteger(Item.quantity) && Item.quantity > 0));
    assert.deepEqual(OFFER!.entitlements ?? [], []);
    assert.equal(OFFER!.skuProgression ?? null, null);
    assert.deepEqual(OFFER!.duplicateInstancedItems, []);

    assert.equal(FindStoreSkuByIdOrCatalogId(OFFER!.id)?.storeTag, TAG);
    for (const Item of OFFER!.items) {
        assert.notEqual(FindStoreSkuByIdOrCatalogId(Item.catalogId)?.storeTag, TAG, `${Item.catalogId} must not resolve to the fountain`);
    }
});

test("first claim grants; a second claim in the same window replays and grants nothing", { skip: NO_OFFER }, async () => {
    const Economy = FakeEconomy();

    const First = await Claim(Economy, "user-a", BEFORE_RESET);
    assert.equal(First.ok, true);
    assert.deepEqual(Economy.Wallet, ExpectedGrant());

    const Second = await Claim(Economy, "user-a", JUST_BEFORE_RESET);
    assert.equal(Second.ok, true);
    assert.deepEqual(Economy.Wallet, ExpectedGrant(), "the replay must not grant again");
    assert.equal(Economy.Ledger.size, 1);
    assert.equal(Economy.Calls.length, 2);
    assert.equal(Economy.Calls[1].transactionId, Economy.Calls[0].transactionId);
    assert.deepEqual((Second as any).result, (First as any).result);
    assert.equal(Economy.Calls[0].transactionId,
        DailyClaimTransactionId(TAG, "user-a", OFFER!.id, DailyResetWindow(BEFORE_RESET).key));
});

test("the listing is empty after the claim and returns after the next 17:00 UTC", { skip: NO_OFFER }, async () => {
    const Economy = FakeEconomy();

    assert.deepEqual((await Listing(Economy, "user-a", BEFORE_RESET)).map((Sku) => Sku.id), [OFFER!.id]);
    assert.equal((await Claim(Economy, "user-a", BEFORE_RESET)).ok, true);
    assert.deepEqual(await Listing(Economy, "user-a", JUST_BEFORE_RESET), [], "claimed: absent until the reset");
    assert.deepEqual((await Listing(Economy, "user-b", JUST_BEFORE_RESET)).map((Sku) => Sku.id), [OFFER!.id], "per player");

    assert.deepEqual((await Listing(Economy, "user-a", AT_RESET)).map((Sku) => Sku.id), [OFFER!.id], "a new window reopens it");
    assert.equal((await Claim(Economy, "user-a", AFTER_RESET)).ok, true);
    assert.equal(Economy.Ledger.size, 2);
    assert.notEqual(Economy.Calls[1].transactionId, Economy.Calls[0].transactionId);
    const Twice = Object.fromEntries(Object.entries(ExpectedGrant()).map(([CatalogId, Quantity]) => [CatalogId, Quantity * 2]));
    assert.deepEqual(Economy.Wallet, Twice, "one grant per window");
    assert.deepEqual(await Listing(Economy, "user-a", AFTER_RESET), []);
});

test("a claim this window already holds under another character is refused (the wallet is account-wide)", { skip: NO_OFFER }, async () => {
    const Economy = FakeEconomy();
    assert.equal((await Claim(Economy, "user-a", BEFORE_RESET)).ok, true);

    const Other = await PurchaseStoreSku("user-a", "user-a-second-character", TAG, OFFER!.id, true,
        { nowMs: JUST_BEFORE_RESET, runTransaction: Economy.RunTransaction, hasClaim: Economy.HasClaim });
    assert.deepEqual(Other, { ok: false, reason: "already_purchased_different_request" });
    assert.deepEqual(Economy.Wallet, ExpectedGrant(), "one grant per account per window");
    assert.equal(Economy.Calls.length, 1, "refused before the transaction");

    // A failed lookup refuses the claim instead of skipping the check.
    const Failing = await PurchaseStoreSku("user-b", "user-b-character", TAG, OFFER!.id, true,
        { nowMs: BEFORE_RESET, runTransaction: Economy.RunTransaction, hasClaim: async () => { throw new Error("ledger unavailable"); } });
    assert.deepEqual(Failing, { ok: false, reason: "transaction_failed" });
});

test("a changed offer in the same window is refused, not granted again", { skip: NO_OFFER }, async () => {
    const Economy = FakeEconomy();
    // Stands in for a claim made before the operator edited the file: same transaction id, different body.
    const TransactionId = DailyClaimTransactionId(TAG, "user-a", OFFER!.id, DailyResetWindow(BEFORE_RESET).key);
    await Economy.RunTransaction("user-a", "user-a-character", TransactionId, [], [{ catalogId: "CURRENCY_NOTES", quantity: 1 }], [], [], []);

    const Result = await Claim(Economy, "user-a", BEFORE_RESET);
    assert.deepEqual(Result, { ok: false, reason: "already_purchased_different_request" });
    assert.deepEqual(Economy.Wallet, { CURRENCY_NOTES: 1 });
    assert.deepEqual(await Listing(Economy, "user-a", BEFORE_RESET), []);
});

test("a zero price never reaches the wallet; paid offers still debit", { skip: NO_OFFER }, async () => {
    const Economy = FakeEconomy();
    await Claim(Economy, "user-a", BEFORE_RESET);
    assert.deepEqual(Economy.Calls[0].stackedRemoves, []);
    assert.ok(Economy.WalletMoves.every((Move) => Move.startsWith("+")), Economy.WalletMoves.join(", "));
    assert.equal("CURRENCY_PLATINUM" in Economy.Wallet, false);

    // Defence in depth: even a 0 platinum removal that got through is a no-op in the wallet layer, before any read.
    assert.deepEqual(await ApplyCurrencyDeltas("user-a", [], [{ catalogId: "CURRENCY_PLATINUM", quantity: 0 }]), {});

    // A paid one-time SKU keeps its debit and its window-less transaction id.
    const Paid = FakeEconomy();
    await PurchaseStoreSku("user-a", "user-a-character", "exchange_vendor_slot_2", "single_exchange_slot_2", true,
        { nowMs: BEFORE_RESET, runTransaction: Paid.RunTransaction });
    await PurchaseStoreSku("user-a", "user-a-character", "exchange_vendor_slot_2", "single_exchange_slot_2", true,
        { nowMs: AFTER_RESET + 7 * 24 * 60 * 60 * 1000, runTransaction: Paid.RunTransaction });
    assert.deepEqual(Paid.Calls[0].stackedRemoves, [{ catalogId: "CURRENCY_PLATINUM", quantity: 1000 }]);
    assert.equal(Paid.Calls[1].transactionId, Paid.Calls[0].transactionId);
    assert.deepEqual(Paid.Wallet, { CURRENCY_PLATINUM: -1000 }, "charged once (the fake wallet has no balance check)");
});

test("the listing fails closed", { skip: NO_OFFER }, async () => {
    const Economy = FakeEconomy();
    assert.deepEqual(await Listing(Economy, undefined, BEFORE_RESET), []);
    assert.deepEqual(await Listing(Economy, "INVALID", BEFORE_RESET), []);
    assert.deepEqual(await GetStoreSkusForPlayer(TAG, "user-a", {
        nowMs: BEFORE_RESET,
        hasClaim: async () => { throw new Error("ledger unavailable"); },
    }), []);
    // Every other section is served as before, without a lookup.
    assert.equal(await GetStoreSkusForPlayer("exchange_vendor_slot_2", undefined, {
        hasClaim: async () => { throw new Error("must not be called"); },
    }), GetStoreSkus("exchange_vendor_slot_2"));
});

test("a missing data file leaves the section empty", () => {
    assert.deepEqual(LoadFountainDailyBundleSkus("__no_such_fountain_daily_bundle__.json"), []);
    assert.deepEqual(ParseFountainDailyBundle(undefined).skus, []);
});

test("the data file is validated fail-closed", () => {
    const Base = {
        id: "test_fountain_bundle",
        displayName: "Test",
        displayDescription: "Test",
        displayPriority: 0,
        prices: [{ currencyId: "id_currency_platinum", price: 0 }],
        maxAllowed: 1,
        images: {},
        tags: [TAG],
        items: [{ catalogId: "CURRENCY_NOTES", quantity: 500, instanced: false }],
        duplicateInstancedItems: [],
    };
    const Problems = (Sku: any, Wrap = true) => ParseFountainDailyBundle(Wrap ? { comment: "x", skus: [Sku] } : Sku).problems;

    assert.deepEqual(Problems(Base), []);
    assert.equal(ParseFountainDailyBundle([Base]).skus.length, 1, "a bare array is accepted too");
    assert.equal(ParseFountainDailyBundle({ skus: [Base] }).skus[0].maxAllowed, 1);

    assert.ok(ParseFountainDailyBundle({ skus: [Base, { ...Base, id: "second" }] }).problems.length > 0, "one offer only");
    assert.ok(ParseFountainDailyBundle({ skus: [] }).problems.length > 0);
    assert.ok(ParseFountainDailyBundle({}).problems.length > 0);
    assert.ok(Problems({ ...Base, id: "bad/id" }).length > 0);
    assert.ok(Problems({ ...Base, tags: ["webstore"] }).length > 0);
    assert.ok(Problems({ ...Base, prices: [{ currencyId: "id_currency_platinum", price: 1 }] }).length > 0);
    assert.ok(Problems({ ...Base, prices: [{ currencyId: "id_currency_marks_steel", price: 0 }] }).length > 0);
    assert.ok(Problems({ ...Base, prices: [] }).length > 0);
    assert.ok(Problems({ ...Base, entitlements: [{ name: "exchange_slot_2", duration: 0 }] }).length > 0);
    assert.ok(Problems({ ...Base, skuProgression: { progressionId: "selected_huntpass", xp: null, ranks: 1 } }).length > 0);
    assert.ok(Problems({ ...Base, items: [] }).length > 0);
    assert.ok(Problems({ ...Base, items: [{ catalogId: "CURRENCY_NOTES", quantity: 500, instanced: true }] }).length > 0);
    assert.ok(Problems({ ...Base, items: [{ catalogId: "CURRENCY_NOTES", quantity: 500 }] }).length > 0, "instanced must be explicitly false");
    assert.ok(Problems({ ...Base, items: [{ catalogId: "CURRENCY_NOTES", quantity: 0, instanced: false }] }).length > 0);
    assert.ok(Problems({ ...Base, items: [{ catalogId: "CURRENCY_NOTES", quantity: 1.5, instanced: false }] }).length > 0);
    assert.ok(Problems({ ...Base, items: [{ catalogId: "NOT_A_REAL_CATALOG_ID", quantity: 1, instanced: false }] }).length > 0,
        "an id the storage policy does not know is refused");
    assert.ok(Problems({ ...Base, items: [{ catalogId: "AC_BACK_HP06-1_00", quantity: 1, instanced: false }] }).length > 0,
        "an instanced-policy item is refused even when the file says stacked");
    assert.ok(Problems({ ...Base, items: [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity: 5, instanced: false }] })
        .some((Problem) => /prestige-gated/.test(Problem)));
});
