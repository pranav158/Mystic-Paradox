import assert from "node:assert/strict";
import test from "node:test";
import { GetStoreSkus, PurchaseStoreSku } from "./store";

// The store's call site of the economy ledger (diagnostics/economyLedgerMonitor.ts): a purchase priced in Platinum runs its
// transaction with the SKU as its economy scope, so the spend is logged as a STORE spend for that SKU. Uses the real platinum store
// data (game-data), through the store's own transaction seam.

test("a store purchase priced in Platinum runs its transaction as a STORE spend of its SKU", async () => {
    const Sku = GetStoreSkus("webstore").find((Candidate) =>
        Candidate.prices.some((Price) => /platinum/i.test(String(Price.currencyId)) && Price.price > 0));
    assert.ok(Sku, "the platinum store has a Platinum-priced SKU");

    let Captured: unknown[] | undefined;
    const Result = await PurchaseStoreSku("store-user-1", "store-character-1", "webstore", Sku.id, true, {
        nowMs: Date.now(),
        runTransaction: (async (...Args: unknown[]) => {
            Captured = Args;
            return { updatedStackedItems: [] };
        }) as any,
    });

    assert.equal(Result.ok, true);
    assert.ok(Captured, "the transaction ran");
    const Options = Captured[8] as { economy?: unknown };
    assert.deepEqual(Options.economy, { source: "STORE", storeSkuId: Sku.id });
    const Removes = Captured[6] as Array<{ catalogId: string; quantity: number }>;
    assert.ok(Removes.some((Remove) => Remove.catalogId === "CURRENCY_PLATINUM" && Remove.quantity > 0),
        "the price is a Platinum removal");
});
