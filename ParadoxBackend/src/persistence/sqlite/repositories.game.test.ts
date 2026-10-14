import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MongoServerError } from "mongodb";
import { InventoryTransactionAlreadyExistsError } from "../mongo/repositories/MongoInventoryTransactionRepository";
import { NOW, OpenTestRealm } from "./testSupport";
import { SqliteFindInventoryLedgerClaim } from "./directAccess";
import { Tables } from "./tables";

// Characters and what belongs to them: inventory, the idempotency ledger, loadouts, wallet, Slayer's Path, breadcrumbs,
// encountered content and entitlements.

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });
function Realm(label: string) {
    const Opened = OpenTestRealm(label);
    Cleanups.push(Opened.cleanup);
    return Opened;
}

const IsDuplicate = (error: unknown) => error instanceof MongoServerError && error.code === 11000;

const Character = (id: string, user: string, version = 1) => ({
    characterId: id, userId: user, createdDate: NOW, lastModifiedDate: NOW, name: `char-${id}`, updateVersion: version, data: `{"id":"${id}"}`
});

test("characters: insertion order is kept, other accounts cannot read them, the conditional update needs a newer version", async () => {
    const { repos } = Realm("game-characters");
    await repos.characters.create(Character("c-b", "u1"));
    await repos.characters.create(Character("c-a", "u1"));
    await repos.characters.create(Character("c-x", "u2"));
    await assert.rejects(repos.characters.create(Character("c-a", "u1")), IsDuplicate);

    assert.deepEqual((await repos.characters.findManyByUserId("u1")).map((Entry) => Entry.characterId), ["c-b", "c-a"]);
    assert.equal((await repos.characters.findByCharacterIdAndUserId("c-x", "u1")), undefined, "wrong owner");
    assert.equal((await repos.characters.findByCharacterIdAndUserId("c-x", "u2"))?.name, "char-c-x");

    await repos.characters.updateDataConditional("c-a", "u1", "{\"v\":1}", 1); // equal: refused
    assert.equal((await repos.characters.findByCharacterIdAndUserId("c-a", "u1"))?.data, "{\"id\":\"c-a\"}");
    await repos.characters.updateDataConditional("c-a", "u1", "{\"v\":3}", 3);
    const Updated = await repos.characters.findByCharacterIdAndUserId("c-a", "u1");
    assert.equal(Updated?.data, "{\"v\":3}");
    assert.equal(Updated?.updateVersion, 3);
    await repos.characters.updateDataConditional("c-a", "u1", "{\"v\":2}", 2); // older: refused
    assert.equal((await repos.characters.findByCharacterIdAndUserId("c-a", "u1"))?.updateVersion, 3);
    await repos.characters.updateDataConditional("c-a", "u2", "{\"stolen\":1}", 9); // wrong owner
    assert.equal((await repos.characters.findByCharacterIdAndUserId("c-a", "u1"))?.updateVersion, 3);
    await repos.characters.updateDataConditional("ghost", "u1", "{}", 9);
});

test("inventory: the revision guard accepts exactly one of two racing writers, and legacy rows without a revision count as 0", async () => {
    const { repos, db } = Realm("game-inventory");
    await repos.inventories.create({ characterId: "c1", userId: "u1", instancedItems: "[1]", stackedItems: "[2]", bootstrapVersion: "starter-1" });
    await assert.rejects(repos.inventories.create({ characterId: "c1", userId: "u1", instancedItems: "[]", stackedItems: "[]" }), IsDuplicate);
    const Read = await repos.inventories.findByCharacterId("c1");
    assert.deepEqual(Read, { characterId: "c1", userId: "u1", instancedItems: "[1]", stackedItems: "[2]", revision: 0 });

    const Racers = await Promise.all([
        repos.inventories.updateBothIfRevisionMatches("c1", "[10]", "[20]", 0),
        repos.inventories.updateBothIfRevisionMatches("c1", "[11]", "[21]", 0)
    ]);
    assert.equal(Racers.filter((Entry) => Entry !== undefined).length, 1);
    const Winner = Racers.find((Entry) => Entry !== undefined)!;
    assert.equal(Winner.revision, 1);
    assert.equal((await repos.inventories.findByCharacterId("c1"))?.instancedItems, Winner.instancedItems);

    assert.equal(await repos.inventories.updateBothIfRevisionMatches("c1", "[]", "[]", 0), undefined, "stale revision");
    assert.equal(await repos.inventories.updateBothIfRevisionMatches("ghost", "[]", "[]", 0), undefined, "missing row");
    assert.equal((await repos.inventories.updateBothIfRevisionMatches("c1", "[3]", "[4]", 1))?.revision, 2);

    // A row written before `revision` existed (no field at all).
    await db.write(undefined, (c) => Tables.inventories.insert(c, "legacy", { characterId: "legacy", userId: "u1", instancedItems: "[]", stackedItems: "[]" }));
    assert.equal((await repos.inventories.findByCharacterId("legacy"))?.revision, 0);
    assert.equal((await repos.inventories.updateBothIfRevisionMatches("legacy", "[9]", "[9]", 0))?.revision, 1);
});

test("inventory writes inside a unit of work are atomic with the wallet", async () => {
    const { repos, uow } = Realm("game-inventory-tx");
    await repos.inventories.create({ characterId: "c1", userId: "u1", instancedItems: "[]", stackedItems: "[]" });
    await repos.wallets.create({ userId: "u1", balances: { GOLD: 10 } });
    await assert.rejects(uow.withTransaction(async (r, session) => {
        assert.ok(await r.wallets.incrementBalance("u1", "GOLD", -4, session));
        assert.ok(await r.inventories.updateBothIfRevisionMatches("c1", "[\"sword\"]", "[]", 0, session));
        throw new Error("crash before commit");
    }), /crash/);
    assert.equal((await repos.wallets.findByUserId("u1"))?.balances.GOLD, 10);
    assert.equal((await repos.inventories.findByCharacterId("c1"))?.revision, 0);
});

test("the inventory ledger: a repeat is refused with the stored row, a reused id with another body is distinguishable, users never collide", async () => {
    const { repos, uow, db } = Realm("game-ledger");

    await uow.withTransaction(async (r, session) => {
        assert.equal(await r.inventoryTransactions.tryBegin("t1", "u1", "c1", "hash-A", session), undefined);
        await r.inventoryTransactions.complete("t1", "u1", "c1", { granted: ["x"] }, session, { claimKind: "daily" });
    });

    const Replay = await uow.withTransaction(async (r, session) => {
        await r.inventoryTransactions.tryBegin("t1", "u1", "c1", "hash-A", session);
    }).then(() => undefined, (error) => error);
    assert.ok(Replay instanceof InventoryTransactionAlreadyExistsError);
    assert.equal(Replay.existing.status, "completed");
    assert.equal(Replay.existing.requestHash, "hash-A");
    assert.deepEqual(Replay.existing.result, { granted: ["x"] });
    assert.ok(Replay.existing.completedAt);

    const Mismatch = await uow.withTransaction(async (r, session) => {
        await r.inventoryTransactions.tryBegin("t1", "u1", "c1", "hash-B", session);
    }).then(() => undefined, (error) => error);
    assert.ok(Mismatch instanceof InventoryTransactionAlreadyExistsError);
    assert.notEqual(Mismatch.existing.requestHash, "hash-B", "the stored hash is the original, so the caller can tell the body changed");

    await uow.withTransaction(async (r, session) => {
        assert.equal(await r.inventoryTransactions.tryBegin("t1", "u2", "c1", "hash-A", session), undefined, "another user, same id");
        assert.equal(await r.inventoryTransactions.tryBegin("t1", "u1", "c2", "hash-A", session), undefined, "another character, same id");
    });

    // Extra fields live on the row (the daily claim lookup reads the claiming character).
    const Claim = await SqliteFindInventoryLedgerClaim(db, "u1", "t1");
    assert.ok(Claim);
    assert.equal(await SqliteFindInventoryLedgerClaim(db, "u9", "t1"), undefined);

    // The ledger row of an attempt that never committed is gone: the same id can be claimed again.
    await assert.rejects(uow.withTransaction(async (r, session) => {
        await r.inventoryTransactions.tryBegin("t-lost", "u1", "c1", "hash-L", session);
        throw new Error("crash");
    }), /crash/);
    await uow.withTransaction(async (r, session) => {
        assert.equal(await r.inventoryTransactions.tryBegin("t-lost", "u1", "c1", "hash-L", session), undefined);
    });
    void repos;
});

const Slots = (n: number) => JSON.stringify(Array.from({ length: n }, (_, Index) => ({ slot: Index })));

test("loadouts: every writer is revision-guarded and respects the visible slots", async () => {
    const { repos } = Realm("game-loadouts");
    await repos.loadouts.create({ characterId: "c1", userId: "u1", loadouts: Slots(3), persistent: "{\"p\":1}", unlockedTotalSlots: 3 });
    await assert.rejects(repos.loadouts.create({ characterId: "c1", userId: "u1", loadouts: "[]", persistent: "{}" }), IsDuplicate);
    const Initial = await repos.loadouts.findByCharacterIdAndUserId("c1", "u1");
    assert.deepEqual(Initial, { characterId: "c1", userId: "u1", loadouts: Slots(3), persistent: "{\"p\":1}", activeIndex: 0, unlockedTotalSlots: 3, revision: 0 });
    assert.equal(await repos.loadouts.findByCharacterIdAndUserId("c1", "u2"), undefined);

    // slot replace
    assert.equal(await repos.loadouts.replaceSlotIfRevisionMatches("c1", "u1", 1, "{\"slot\":\"new\"}", 0), true);
    let Row = (await repos.loadouts.findByCharacterIdAndUserId("c1", "u1"))!;
    assert.deepEqual(JSON.parse(Row.loadouts)[1], { slot: "new" });
    assert.equal(Row.revision, 1);
    assert.equal(await repos.loadouts.replaceSlotIfRevisionMatches("c1", "u1", 1, "{}", 0), false, "stale revision");
    assert.equal(await repos.loadouts.replaceSlotIfRevisionMatches("c1", "u1", 3, "{}", 1), false, "a slot beyond the unlocked total");
    assert.equal(await repos.loadouts.replaceSlotIfRevisionMatches("c1", "u1", -1, "{}", 1), false);
    assert.equal(await repos.loadouts.replaceSlotIfRevisionMatches("c1", "u1", 0, "not json", 1), false);
    assert.equal(await repos.loadouts.replaceSlotIfRevisionMatches("ghost", "u1", 0, "{}", 0), false);
    assert.equal(await repos.loadouts.replaceSlotIfRevisionMatches("c1", "u2", 0, "{}", 1), false, "wrong owner");

    // persistent
    assert.equal(await repos.loadouts.updatePersistentIfRevisionMatches("c1", "u1", "{\"p\":2}", 1), true);
    assert.equal(await repos.loadouts.updatePersistentIfRevisionMatches("c1", "u1", "{\"p\":3}", 1), false);
    Row = (await repos.loadouts.findByCharacterIdAndUserId("c1", "u1"))!;
    assert.equal(Row.persistent, "{\"p\":2}");
    assert.equal(Row.revision, 2);

    // active index
    assert.equal(await repos.loadouts.updateActiveIndexIfRevisionMatches("c1", "u1", 2, 2), true);
    assert.equal((await repos.loadouts.findByCharacterIdAndUserId("c1", "u1"))?.activeIndex, 2);
    assert.equal((await repos.loadouts.findByCharacterIdAndUserId("c1", "u1"))?.revision, 3);
    assert.equal(await repos.loadouts.updateActiveIndexIfRevisionMatches("c1", "u1", 2, 99), true, "re-applying the current slot is a success without revision churn");
    assert.equal((await repos.loadouts.findByCharacterIdAndUserId("c1", "u1"))?.revision, 3);
    assert.equal(await repos.loadouts.updateActiveIndexIfRevisionMatches("c1", "u1", 5, 3), false, "locked slot");
    assert.equal(await repos.loadouts.updateActiveIndexIfRevisionMatches("c1", "u1", 1, 2), false, "stale revision");

    // replace all + entitlement
    assert.equal(await repos.loadouts.replaceAllAndEntitlementIfRevisionMatches("c1", "u1", Slots(5), 4, 3), true);
    Row = (await repos.loadouts.findByCharacterIdAndUserId("c1", "u1"))!;
    assert.equal(JSON.parse(Row.loadouts).length, 5);
    assert.equal(Row.unlockedTotalSlots, 4);
    assert.equal(Row.revision, 4);
    assert.equal(await repos.loadouts.replaceAllAndEntitlementIfRevisionMatches("c1", "u1", Slots(5), 6, 4), false, "more than the maximum");
    assert.equal(await repos.loadouts.replaceAllAndEntitlementIfRevisionMatches("c1", "u1", Slots(2), 3, 4), false, "total above the stored slots");
    assert.equal(await repos.loadouts.replaceAllAndEntitlementIfRevisionMatches("c1", "u1", "[]", 1, 4), false);
    assert.equal(await repos.loadouts.replaceAllAndEntitlementIfRevisionMatches("c1", "u1", "nope", 1, 4), false);
    assert.equal(await repos.loadouts.replaceAllAndEntitlementIfRevisionMatches("c1", "u1", Slots(5), 4, 3), false, "stale revision");
});

test("loadouts: a row without revision or unlockedTotalSlots (legacy) stays writable at revision 0", async () => {
    const { repos, db } = Realm("game-loadouts-legacy");
    await db.write(undefined, (c) => Tables.loadouts.insert(c, "old", { characterId: "old", userId: "u1", loadouts: Slots(2), persistent: "{}" }));
    const Row = (await repos.loadouts.findByCharacterIdAndUserId("old", "u1"))!;
    assert.equal(Row.revision, 0);
    assert.equal(Row.activeIndex, 0);
    // Two stored slots and no persisted total: one is visible (the legacy interpretation), so slot 1 is locked.
    assert.equal(await repos.loadouts.replaceSlotIfRevisionMatches("old", "u1", 1, "{}", 0), false);
    assert.equal(await repos.loadouts.replaceSlotIfRevisionMatches("old", "u1", 0, "{\"slot\":\"x\"}", 0), true);
    assert.equal((await repos.loadouts.findByCharacterIdAndUserId("old", "u1"))?.revision, 1);
});

test("wallet: create, adopt-if-missing, atomic increments that never overspend, and the unsafe-key guard", async () => {
    const { repos, db } = Realm("game-wallet");
    assert.equal(await repos.wallets.findByUserId("u1"), undefined);
    assert.equal(await repos.wallets.incrementBalance("u1", "GOLD", 5), undefined, "no wallet, nothing to increment");

    const Created = await repos.wallets.createIfMissing({ userId: "u1", balances: { GOLD: 100 } });
    assert.deepEqual(Created, { userId: "u1", balances: { GOLD: 100 }, bootstrapVersion: undefined });
    const Adopted = await repos.wallets.createIfMissing({ userId: "u1", balances: { GOLD: 0, GEMS: 9 }, bootstrapVersion: "starter-1" });
    assert.deepEqual(Adopted.balances, { GOLD: 100 }, "an existing wallet is never reset");
    assert.equal(Adopted.bootstrapVersion, "starter-1", "but the audit tag is applied");
    assert.equal((await repos.wallets.createIfMissing({ userId: "u1", balances: {} })).bootstrapVersion, "starter-1");

    assert.deepEqual((await repos.wallets.incrementBalance("u1", "GOLD", 50))?.balances, { GOLD: 150 });
    assert.deepEqual((await repos.wallets.incrementBalance("u1", "GEMS", 3))?.balances, { GOLD: 150, GEMS: 3 }, "a positive grant creates the balance");
    assert.equal(await repos.wallets.incrementBalance("u1", "GOLD", -151), undefined, "insufficient");
    assert.equal(await repos.wallets.incrementBalance("u1", "SILVER", -1), undefined, "no such balance");
    assert.deepEqual((await repos.wallets.incrementBalance("u1", "GOLD", -150))?.balances, { GOLD: 0, GEMS: 3 });
    assert.deepEqual((await repos.wallets.incrementBalance("u1", "GOLD", 0))?.balances.GOLD, 0);

    for (const Bad of ["a.b", "$gt", "", "a b", "x".repeat(129)]) {
        await assert.rejects(repos.wallets.incrementBalance("u1", Bad, 1), /unsafe balance field path/);
    }
    await assert.rejects(repos.wallets.createIfMissing({ userId: "u2", balances: { "a.b": 1 } }), /unsafe balance field path/);
    assert.equal(await repos.wallets.findByUserId("u2"), undefined);

    await assert.rejects(repos.wallets.create({ userId: "u1", balances: {} }), IsDuplicate);

    // A pre-hardening wallet stored `balances` as a JSON string.
    await db.write(undefined, (c) => Tables.wallets.insert(c, "legacy", { userId: "legacy", balances: "{\"GOLD\":7}" }));
    await repos.wallets.migrateLegacyStringBalances("legacy");
    assert.deepEqual((await repos.wallets.findByUserId("legacy"))?.balances, { GOLD: 7 });
    await repos.wallets.migrateLegacyStringBalances("legacy"); // idempotent
    await repos.wallets.migrateLegacyStringBalances("ghost");
    await db.write(undefined, (c) => Tables.wallets.insert(c, "broken", { userId: "broken", balances: "{not json" }));
    await repos.wallets.migrateLegacyStringBalances("broken");
    assert.deepEqual((await repos.wallets.findByUserId("broken"))?.balances, {});
});

test("Slayer's Path: the journey is created once and replaced only by the writer that holds the current revision", async () => {
    const { repos } = Realm("game-journey");
    assert.equal(await repos.playerJourney.findByUserId("u1"), undefined);
    assert.equal(await repos.playerJourney.createIfAbsent({ userId: "u1", nodes: "{\"a\":1}", updateVersion: 1, revision: 0 }), true);
    assert.equal(await repos.playerJourney.createIfAbsent({ userId: "u1", nodes: "{}", updateVersion: 9, revision: 5 }), false);
    assert.deepEqual(await repos.playerJourney.findByUserId("u1"), { userId: "u1", nodes: "{\"a\":1}", updateVersion: 1, revision: 0 });

    const Racers = await Promise.all([
        repos.playerJourney.updateIfRevision("u1", "{\"b\":1}", 2, 0),
        repos.playerJourney.updateIfRevision("u1", "{\"c\":1}", 2, 0)
    ]);
    assert.deepEqual(Racers.slice().sort(), [false, true]);
    const After = await repos.playerJourney.findByUserId("u1");
    assert.equal(After?.revision, 1);
    assert.equal(After?.updateVersion, 2);
    assert.equal(await repos.playerJourney.updateIfRevision("u1", "{}", 3, 0), false);
    assert.equal(await repos.playerJourney.updateIfRevision("ghost", "{}", 1, 0), false);
});

test("breadcrumbs and encountered content: per character and owner", async () => {
    const { repos } = Realm("game-crumbs");
    await repos.breadcrumbs.create({ characterId: "c1", userId: "u1", breadcrumbs: "[1]", updateVersion: 1 });
    await assert.rejects(repos.breadcrumbs.create({ characterId: "c1", userId: "u1", breadcrumbs: "[]", updateVersion: 1 }), IsDuplicate);
    assert.equal(await repos.breadcrumbs.findByCharacterIdAndUserId("c1", "u2"), undefined);
    await repos.breadcrumbs.update("c1", "u2", "[666]", 9); // wrong owner: nothing
    await repos.breadcrumbs.update("c1", "u1", "[1,2]", 2);
    assert.deepEqual(await repos.breadcrumbs.findByCharacterIdAndUserId("c1", "u1"), { characterId: "c1", userId: "u1", breadcrumbs: "[1,2]", updateVersion: 2 });

    await repos.encounteredContent.create({ characterId: "c1", userId: "u1", encounteredcontent: "[\"a\"]" });
    await assert.rejects(repos.encounteredContent.create({ characterId: "c1", userId: "u1", encounteredcontent: "[]" }), IsDuplicate);
    await repos.encounteredContent.updateContent("c1", "u2", "[\"stolen\"]");
    await repos.encounteredContent.updateContent("c1", "u1", "[\"a\",\"b\"]");
    assert.deepEqual(await repos.encounteredContent.findByCharacterIdAndUserId("c1", "u1"), { characterId: "c1", userId: "u1", encounteredcontent: "[\"a\",\"b\"]" });
    assert.equal(await repos.encounteredContent.findByCharacterIdAndUserId("c1", "u2"), undefined);
});

test("entitlements: created once, granted once per name, replay-safe, rolled back with the purchase", async () => {
    const { repos, uow } = Realm("game-entitlements");
    assert.equal(await repos.entitlements.findByUserId("u1"), undefined);
    assert.deepEqual(await repos.entitlements.createIfMissing("u1"), { userId: "u1", entitlements: [] });

    assert.deepEqual(await repos.entitlements.grantIfMissing("u1", "exchange_slot_2", 0, null, "single_exchange_slot_2"), { granted: true });
    assert.deepEqual(await repos.entitlements.grantIfMissing("u1", "exchange_slot_2", 0, null, "single_exchange_slot_2"), { granted: false });
    assert.deepEqual(await repos.entitlements.grantIfMissing("u2", "gauntlet-season01_top_100", 2400000.9, "2026-10-13T00:00:00.000Z", undefined), { granted: true }, "creates the document itself");

    const Held = (await repos.entitlements.findByUserId("u1"))!;
    assert.equal(Held.entitlements.length, 1);
    assert.equal(Held.entitlements[0].name, "exchange_slot_2");
    assert.equal(Held.entitlements[0].duration, 0);
    assert.equal(Held.entitlements[0].activatedDate, null);
    assert.equal(Held.entitlements[0].sourceSkuId, "single_exchange_slot_2");
    assert.ok(Held.entitlements[0].grantedAt);
    const Timed = (await repos.entitlements.findByUserId("u2"))!.entitlements[0];
    assert.equal(Timed.duration, 2400000, "duration is truncated to a whole number");
    assert.equal(Timed.activatedDate, "2026-10-13T00:00:00.000Z");
    assert.equal("sourceSkuId" in Timed, false);

    for (const Bad of ["", "a b", "x".repeat(129), "$bad", "a/b"]) {
        await assert.rejects(repos.entitlements.grantIfMissing("u1", Bad, 0, null, undefined), /unsafe entitlement name/);
    }

    await assert.rejects(uow.withTransaction(async (r, session) => {
        assert.deepEqual(await r.entitlements.grantIfMissing("u1", "bundle_a", 0, null, "sku", session), { granted: true });
        throw new Error("payment failed");
    }), /payment failed/);
    assert.deepEqual((await repos.entitlements.findByUserId("u1"))!.entitlements.map((Entry) => Entry.name), ["exchange_slot_2"]);
});
