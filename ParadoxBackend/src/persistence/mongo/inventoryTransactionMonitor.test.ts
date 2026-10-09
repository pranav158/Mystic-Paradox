import assert from "node:assert/strict";
import test from "node:test";
import { MongoInventoryTransactionRepository } from "./repositories/MongoInventoryTransactionRepository";

test("annotator fields are stored by the existing ledger completion update", async () => {
    let update: any;
    let options: any;
    const session = {} as any;
    const annotation = {
        sessionId: "session-1", createdAt: "2026-09-30T12:00:00.000Z",
        items: [{ itemId: "PART_SAMPLE", quantity: 4 }]
    };
    const repository = new MongoInventoryTransactionRepository(async () => ({
        collection: (name: string) => {
            assert.equal(name, "inventoryTransactions");
            return { updateOne: async (filter: any, next: any, queryOptions: any) => {
                update = { filter, next };
                options = queryOptions;
            } } as any;
        }
    } as any));

    await repository.complete("tx-1", "user-1", "character-1", { createdInstancedItems: [] }, session,
        { grantAnnotation: annotation });

    assert.equal(typeof update.filter._id, "string");
    assert.equal(update.next.$set.status, "completed");
    assert.deepEqual(update.next.$set.grantAnnotation, annotation);
    assert.deepEqual(update.next.$set.result, { createdInstancedItems: [] });
    assert.equal(options.session, session);
});

test("extra fields never replace the core ledger fields", async () => {
    let update: any;
    const repository = new MongoInventoryTransactionRepository(async () => ({
        collection: () => ({ updateOne: async (_filter: any, next: any) => { update = next; } })
    } as any));

    await repository.complete("tx-2", "user-1", "character-1", { ok: true }, {} as any,
        { status: "pending", result: "forged" });

    assert.equal(update.$set.status, "completed");
    assert.deepEqual(update.$set.result, { ok: true });
});

test("completion without extra fields stores only the ledger fields", async () => {
    let update: any;
    const repository = new MongoInventoryTransactionRepository(async () => ({
        collection: () => ({ updateOne: async (_filter: any, next: any) => { update = next; } })
    } as any));

    await repository.complete("tx-3", "user-1", "character-1", {}, {} as any);

    assert.deepEqual(Object.keys(update.$set).sort(), ["completedAt", "result", "status"]);
});
