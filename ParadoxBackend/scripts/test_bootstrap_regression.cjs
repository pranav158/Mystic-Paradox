
require("dotenv").config();
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");

const INSTANCE_ID = /^[A-Z0-9]{26}$/;
const TEST_PREFIX = /^test_/;
const EXPECTED_INSTANCED = [
    "WP_EB_BEGINNER", "WP_GA_BEGINNER", "WP_IH_BEGINNER", "WP_CB_BEGINNER",
    "WP_MS_BEGINNER", "WP_DP_BEGINNER", "WP_AC_BEGINNER",
    "PART_EB_SPECIAL_DEFAULT", "PART_IH_SPECIAL_DEFAULT", "PART_GA_SPECIAL_DEFAULT",
    "PART_CB_SPECIAL_DEFAULT", "PART_MS_SPECIAL_PROJECTILE", "PART_DP_RECEIVER_DEFAULT",
    "PART_DP_GRIP_DEFAULT", "PART_AC_SPECIAL_DEFAULT",
    "AR_UNEQUIPPED_HELM", "AR_BEGINNER_CHEST", "AR_BEGINNER_ARMS", "AR_BEGINNER_LEGS",
    "LT_BASIC", "FL_HEALING_DEFAULT", "GD_FRAME_STARTER_BASE", "BN_BEGINNER_00",
];
const EXPECTED_STACKED = [
    "QI_BASIC_FLARE_DURABLE", "EM_INTRO_BEGINNER_01", "EM_END_BEGINNER_01",
    "EM_PLAYER_BEGINNER_01", "EM_PLAYER_BEGINNER_02", "EM_PLAYER_BEGINNER_03", "EM_PLAYER_BEGINNER_04",
    "BNC_MESH_BEGINNER_00", "BNC_FABRIC_BEGINNER_00", "BNC_SIGIL_BEGINNER_00",
    "BNC_ANIMATION_BEGINNER_00", "BNC_VFX_BEGINNER_00", "DYE_GREEN04_DURABLE", "DYE_BROWN07_DURABLE",
];

const created = { userIds: new Set(), characterIds: new Set(), transactionIds: new Set() };
function freshUserId() { const id = `test_${crypto.randomBytes(6).toString("hex")}`; created.userIds.add(id); return id; }
function freshTransactionId() { const id = crypto.randomUUID(); created.transactionIds.add(id); return id; }

let passed = 0;
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
}

(async () => {
    
    if (process.env.ALLOW_DB_INTEGRATION_TESTS !== "true") {
        console.error("Refusing to run: set ALLOW_DB_INTEGRATION_TESTS=true to opt in to destructive integration tests.");
        process.exit(1);
    }
    if (!process.env.MONGODB_URI) {
        console.error("Refusing to run: MONGODB_URI is required.");
        process.exit(1);
    }
    if (!process.env.MONGODB_TEST_DB) {
        console.error("Refusing to run: MONGODB_TEST_DB (a dedicated test database name) is required.");
        process.exit(1);
    }
    if (process.env.MONGODB_TEST_DB === (process.env.MONGODB_DB ?? "mysticparadox")) {
        console.error("Refusing to run: MONGODB_TEST_DB must differ from the main MONGODB_DB.");
        process.exit(1);
    }
    
    
    process.env.MONGODB_DB = process.env.MONGODB_TEST_DB;

    
    const distStarterManifest = require("../dist/controllers/starterManifest");
    const distCharacter = require("../dist/controllers/character");
    const distInventory = require("../dist/controllers/inventory");
    const distLoadout = require("../dist/controllers/loadout");
    const distWallet = require("../dist/controllers/wallet");
    const distValidation = require("../dist/validation");
    const distWalletContract = require("../dist/persistence/contracts/WalletRepository");
    const distPersistence = require("../dist/persistence");

    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db(process.env.MONGODB_DB);

    let testError = null;
    try {
        await test("BuildStarterManifest produces exactly the 23 instanced and 14 stacked catalog IDs, no Frostfall/Terra", async () => {
            const manifest = distStarterManifest.BuildStarterManifest();
            assert.deepEqual(manifest.instancedItems.map((i) => i.catalogId).sort(), [...EXPECTED_INSTANCED].sort());
            assert.deepEqual(manifest.stackedItems.map((i) => i.catalogId).sort(), [...EXPECTED_STACKED].sort());
            assert.ok(!manifest.instancedItems.some((i) => i.catalogId === "WP_EB_FROSTFALL_L1" || i.catalogId === "WP_MS_TERRA_01"));
            for (const item of manifest.instancedItems) assert.equal(item.itemData, null, `${item.catalogId} itemData must be null`);
        });

        await test("Two manifests never collide and every ID matches the captured 26-char shape", async () => {
            const a = distStarterManifest.BuildStarterManifest();
            const b = distStarterManifest.BuildStarterManifest();
            const aIds = a.instancedItems.map((i) => i.instanceId);
            const bIds = b.instancedItems.map((i) => i.instanceId);
            assert.equal(new Set(aIds).size, aIds.length, "manifest A has duplicate instance IDs");
            assert.equal(new Set(bIds).size, bIds.length, "manifest B has duplicate instance IDs");
            assert.equal(aIds.filter((id) => bIds.includes(id)).length, 0, "manifests A and B share an instance ID");
            for (const id of [...aIds, ...bIds]) assert.match(id, INSTANCE_ID);
        });

        await test("CreateCharacterForUid seeds character + inventory + loadout + wallet atomically with matching IDs", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "RegressionTester");
            created.characterIds.add(character.id);

            const inventory = await distPersistence.GetRepositories().inventories.findByCharacterId(character.id);
            const loadout = await distPersistence.GetRepositories().loadouts.findByCharacterIdAndUserId(character.id, userId);
            const wallet = await distPersistence.GetRepositories().wallets.findByUserId(userId);
            assert.ok(inventory && loadout && wallet, "bootstrap did not create all three records");

            const instancedItems = JSON.parse(inventory.instancedItems);
            assert.deepEqual(instancedItems.map((i) => i.catalogId).sort(), [...EXPECTED_INSTANCED].sort());
            const byId = new Map(instancedItems.map((i) => [i.catalogId, i.instanceId]));

            const slot = JSON.parse(loadout.loadouts)[0];
            assert.equal(slot.weapon.item_id, "WP_EB_BEGINNER");
            assert.equal(slot.weapon.instance_id, byId.get("WP_EB_BEGINNER"));
            assert.equal(slot.helmet.instance_id, byId.get("AR_UNEQUIPPED_HELM"));
            assert.ok(wallet.balances.CURRENCY_NOTES > 0);
            assert.equal(wallet.bootstrapVersion, distStarterManifest.BOOTSTRAP_VERSION, "seeded wallet must be tagged");
        });

        await test("Character creation adopts a pre-existing wallet, preserving balances and adding the bootstrap tag", async () => {
            const userId = freshUserId();
            
            await distPersistence.GetRepositories().wallets.createIfMissing({ userId, balances: { CURRENCY_NOTES: 777 } });
            const before = await distPersistence.GetRepositories().wallets.findByUserId(userId);
            assert.equal(before.balances.CURRENCY_NOTES, 777);
            assert.equal(before.bootstrapVersion, undefined, "wallet should start untagged");

            const character = await distCharacter.CreateCharacterForUid(userId, "WalletFirst");
            created.characterIds.add(character.id);

            const after = await distPersistence.GetRepositories().wallets.findByUserId(userId);
            assert.equal(after.balances.CURRENCY_NOTES, 777, "pre-existing wallet balance must be preserved, not reset");
            assert.equal(after.bootstrapVersion, distStarterManifest.BOOTSTRAP_VERSION, "adopted wallet must receive the bootstrap tag");
        });

        await test("A forced transaction failure rolls back character, inventory, loadout, and wallet together", async () => {
            const userId = freshUserId();
            let threw = false;
            try {
                await distPersistence.GetUnitOfWork().withTransaction(async (repos, session) => {
                    const characterId = crypto.randomUUID();
                    created.characterIds.add(characterId);
                    await repos.characters.create({ characterId, userId, name: "RollbackTest", createdDate: "x", lastModifiedDate: "x", updateVersion: 0, data: "{}" }, session);
                    await distStarterManifest.SeedNewAccountAtomically(userId, characterId, session);
                    throw new Error("forced failure after seeding, before commit");
                });
            } catch (error) {
                threw = error.message.includes("forced failure");
            }
            assert.ok(threw, "expected the forced error to propagate");

            const anyCharacter = await db.collection("characters").findOne({ userId });
            const anyWallet = await db.collection("wallets").findOne({ _id: userId });
            assert.equal(anyCharacter, null, "character must not exist after rollback");
            assert.equal(anyWallet, null, "wallet must not exist after rollback");
        });

        await test("Repeated inventory and loadout GETs are byte-stable with no reset", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "StableReads");
            created.characterIds.add(character.id);

            const inv1 = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const inv2 = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const inv3 = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            assert.deepEqual(inv1.instancedItems, inv2.instancedItems);
            assert.deepEqual(inv2.instancedItems, inv3.instancedItems);

            const lo1 = await distLoadout.GetAllLoadoutsForUserIdAndCharacterId(userId, character.id);
            const lo2 = await distLoadout.GetAllLoadoutsForUserIdAndCharacterId(userId, character.id);
            assert.deepEqual(lo1, lo2, "repeated loadout GET must not mutate stored data");
        });

        await test("A v1 account receives missing default weapon parts once without changing loadout or other inventory", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "DefaultPartMigration");
            created.characterIds.add(character.id);

            const before = await distPersistence.GetRepositories().inventories.findByCharacterId(character.id);
            const loadoutBefore = await distPersistence.GetRepositories().loadouts.findByCharacterIdAndUserId(character.id, userId);
            const requiredDefaults = [...distStarterManifest.STARTER_DEFAULT_WEAPON_PART_CATALOG_IDS];
            const customItem = {
                catalogId: "PART_GA_SPECIAL_SKILLSHOT",
                instanceId: crypto.randomBytes(13).toString("hex").toUpperCase(),
                itemData: null,
                updateVersion: 0,
            };
            const legacyItems = JSON.parse(before.instancedItems)
                .filter((item) => item.catalogId === "PART_EB_SPECIAL_DEFAULT" || !requiredDefaults.includes(item.catalogId));
            legacyItems.push(customItem);
            await db.collection("inventories").updateOne(
                { _id: character.id },
                { $set: { instancedItems: JSON.stringify(legacyItems) }, $inc: { revision: 1 } }
            );

            const legacy = await distPersistence.GetRepositories().inventories.findByCharacterId(character.id);
            const firstRead = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const afterFirst = await distPersistence.GetRepositories().inventories.findByCharacterId(character.id);
            const firstIds = new Set(firstRead.instancedItems.map((item) => item.catalogId));
            for (const catalogId of requiredDefaults) assert.ok(firstIds.has(catalogId), "missing reconciled " + catalogId);
            assert.ok(firstRead.instancedItems.some((item) =>
                item.catalogId === customItem.catalogId && item.instanceId === customItem.instanceId
            ), "existing Grim item must be preserved verbatim");
            assert.equal(afterFirst.revision, legacy.revision + 1, "first reconciliation must perform exactly one write");

            await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const afterSecond = await distPersistence.GetRepositories().inventories.findByCharacterId(character.id);
            const loadoutAfter = await distPersistence.GetRepositories().loadouts.findByCharacterIdAndUserId(character.id, userId);
            assert.equal(afterSecond.revision, afterFirst.revision, "second reconciliation must be a no-op");
            assert.equal(loadoutAfter.loadouts, loadoutBefore.loadouts, "default-part reconciliation must not change loadout");
        });

        await test("Weapon switch via RunInventoryTransaction uses the existing axe inventory ID, not a shared constant", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "WeaponSwitch");
            created.characterIds.add(character.id);

            const inventoryBefore = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const axe = inventoryBefore.instancedItems.find((i) => i.catalogId === "WP_GA_BEGINNER");
            assert.ok(axe, "starter axe missing from freshly bootstrapped inventory");
            assert.match(axe.instanceId, INSTANCE_ID);

            const result = await distInventory.RunInventoryTransaction(userId, character.id, freshTransactionId(), [], [], [], [], [{ catalogId: "WP_GA_BEGINNER", instanceId: axe.instanceId, itemData: JSON.stringify({ switched: true }), updateVersion: 1 }]);
            assert.ok(result, "expected RunInventoryTransaction to succeed");

            const inventoryAfter = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const updatedAxe = inventoryAfter.instancedItems.find((i) => i.catalogId === "WP_GA_BEGINNER");
            assert.equal(updatedAxe.instanceId, axe.instanceId, "instance ID must be stable across the save");
            assert.equal(JSON.parse(updatedAxe.itemData).switched, true);
        });

        await test("Deleting the inventory document and re-reading recovers it transactionally with no shared-ID prefix", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "MissingInventory");
            created.characterIds.add(character.id);

            const before = await distPersistence.GetRepositories().loadouts.findByCharacterIdAndUserId(character.id, userId);
            await db.collection("inventories").deleteOne({ _id: character.id });

            const recovered = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            assert.equal(recovered.instancedItems.map((i) => i.catalogId).sort().join(","), [...EXPECTED_INSTANCED].sort().join(","));
            for (const item of recovered.instancedItems) {
                assert.ok(!item.instanceId.startsWith("MYSTPAX_STARTER_"), `${item.catalogId} recovered with a shared-ID prefix`);
            }

            const loadoutAfter = await distPersistence.GetRepositories().loadouts.findByCharacterIdAndUserId(character.id, userId);
            assert.equal(loadoutAfter.loadouts, before.loadouts, "surviving loadout must be untouched by inventory-only recovery");
        });

        await test("Deleting the loadout document and re-reading recovers it from the existing inventory IDs", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "MissingLoadout");
            created.characterIds.add(character.id);

            const inventoryBefore = await distPersistence.GetRepositories().inventories.findByCharacterId(character.id);
            await db.collection("loadouts").deleteOne({ _id: character.id });

            const recovered = await distLoadout.GetAllLoadoutsForUserIdAndCharacterId(userId, character.id);
            const byId = new Map(JSON.parse(inventoryBefore.instancedItems).map((i) => [i.catalogId, i.instanceId]));
            assert.equal(recovered[0].weapon.instance_id, byId.get("WP_EB_BEGINNER"));
            assert.equal(recovered[0].helmet.instance_id, byId.get("AR_UNEQUIPPED_HELM"));
            assert.ok(!recovered[0].weapon.instance_id.startsWith("MYSTPAX_STARTER_"));

            const inventoryAfter = await distPersistence.GetRepositories().inventories.findByCharacterId(character.id);
            assert.equal(inventoryAfter.instancedItems, inventoryBefore.instancedItems, "surviving inventory must be untouched by loadout-only recovery");
        });

        await test("Loadout recovery refuses a character the requesting user does not own (cross-user)", async () => {
            const ownerId = freshUserId();
            const otherId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(ownerId, "OwnerAccount");
            created.characterIds.add(character.id);

            let threw = null;
            try {
                await distLoadout.GetAllLoadoutsForUserIdAndCharacterId(otherId, character.id);
            } catch (error) { threw = error; }
            assert.ok(threw, "expected cross-user loadout GET to throw");
            assert.equal(threw.name, "CharacterOwnershipError", `expected CharacterOwnershipError, got ${threw && threw.name}`);

            const orphanLoadout = await db.collection("loadouts").findOne({ _id: character.id, userId: otherId });
            assert.equal(orphanLoadout, null, "cross-user recovery must not create an orphan loadout");
        });

        await test("Loadout recovery refuses a nonexistent character and creates no documents", async () => {
            const userId = freshUserId();
            const fakeCharacterId = crypto.randomUUID();
            created.characterIds.add(fakeCharacterId); 

            let threw = null;
            try {
                await distLoadout.GetAllLoadoutsForUserIdAndCharacterId(userId, fakeCharacterId);
            } catch (error) { threw = error; }
            assert.ok(threw, "expected nonexistent-character loadout GET to throw");
            assert.equal(threw.name, "CharacterOwnershipError");

            const anyInventory = await db.collection("inventories").findOne({ _id: fakeCharacterId });
            const anyLoadout = await db.collection("loadouts").findOne({ _id: fakeCharacterId });
            assert.equal(anyInventory, null, "no inventory may be created for a nonexistent character");
            assert.equal(anyLoadout, null, "no loadout may be created for a nonexistent character");
        });

        await test("Idempotency is bound to userId+characterId: same transactionId is independent across users and replay-safe within one", async () => {
            const userA = freshUserId();
            const userB = freshUserId();
            const charA = await distCharacter.CreateCharacterForUid(userA, "IdemA");
            const charB = await distCharacter.CreateCharacterForUid(userB, "IdemB");
            created.characterIds.add(charA.id);
            created.characterIds.add(charB.id);

            const sharedTxn = freshTransactionId();
            const grant = [{ catalogId: "TOKEN_REGRESSION", quantity: 1 }];

            const resA = await distInventory.RunInventoryTransaction(userA, charA.id, sharedTxn, [], grant, [], [], []);
            assert.ok(resA, "user A's grant should succeed");
            
            const resB = await distInventory.RunInventoryTransaction(userB, charB.id, sharedTxn, [], grant, [], [], []);
            assert.ok(resB, "user B's identical transactionId must succeed independently, not collide with A");

            const invB = await distInventory.GetInventoryForUserIdAndCharacterId(userB, charB.id);
            const tokenB = invB.stackedItems.find((i) => i.catalogId === "TOKEN_REGRESSION");
            assert.equal(tokenB && tokenB.quantity, 1, "user B must have received its own grant");

            
            const replayA = await distInventory.RunInventoryTransaction(userA, charA.id, sharedTxn, [], grant, [], [], []);
            assert.ok(replayA, "replay should return the stored result");
            const invA = await distInventory.GetInventoryForUserIdAndCharacterId(userA, charA.id);
            const tokenA = invA.stackedItems.find((i) => i.catalogId === "TOKEN_REGRESSION");
            assert.equal(tokenA && tokenA.quantity, 1, "replayed grant must not double-apply (quantity stays 1)");
        });

        await test("Wallet rejects unsafe balance field paths (dotted / operator-like catalogIds)", async () => {
            assert.equal(distWalletContract.IsValidBalanceCatalogId("CURRENCY_NOTES"), true);
            assert.equal(distWalletContract.IsValidBalanceCatalogId("CURRENCY_PJM_WEAPON"), true);
            for (const bad of ["a.b", "$set", "balances.x", "a b", "", "x".repeat(200)]) {
                assert.equal(distWalletContract.IsValidBalanceCatalogId(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
            }
            const userId = freshUserId();
            let threw = null;
            try {
                await distWallet.AddCurrency(userId, "evil.$inject", 5);
            } catch (error) { threw = error; }
            assert.ok(threw, "AddCurrency must throw on an unsafe balance field path");
            
            const wallet = await db.collection("wallets").findOne({ _id: userId });
            assert.equal(wallet, null, "no wallet should be created when the catalogId is rejected");
        });

        await test("Payload validators reject malformed inventory and loadout write bodies", async () => {
            assert.equal(distValidation.ValidateInventoryTransactionBody({ characterId: "c", transactionId: "t" }), null, "a minimal valid body should pass");
            assert.ok(distValidation.ValidateInventoryTransactionBody({ transactionId: "t" }), "missing characterId must be rejected");
            assert.ok(distValidation.ValidateInventoryTransactionBody({ characterId: "c" }), "missing transactionId must be rejected");
            assert.ok(distValidation.ValidateInventoryTransactionBody({ characterId: "c", transactionId: "t", addStackedItems: [{ catalogId: "X", quantity: -5 }] }), "negative quantity must be rejected");
            assert.ok(distValidation.ValidateInventoryTransactionBody({ characterId: "c", transactionId: "t", addInstancedItems: [{ catalogId: "X" }] }), "instanced item without instanceId must be rejected");
            assert.ok(distValidation.ValidateInventoryTransactionBody({ characterId: "c", transactionId: "t", addStackedItems: "nope" }), "non-array collection must be rejected");

            
            assert.equal(distValidation.InventoryBodyHasGrantOrSpend({ saveInstancedItems: [{ catalogId: "X", instanceId: "Y" }] }), false, "a pure save is not a grant/spend");
            assert.equal(distValidation.InventoryBodyHasGrantOrSpend({ addStackedItems: [{ catalogId: "X", quantity: 1 }] }), true, "an add is a grant");
            assert.equal(distValidation.InventoryBodyHasGrantOrSpend({ removeInstancedItems: [{ catalogId: "X", instanceId: "Y" }] }), true, "a remove is a spend");

            assert.equal(distValidation.ValidateLoadoutWriteData("0", JSON.stringify({ weapon: {} })), null, "a valid slot object should pass");
            assert.ok(distValidation.ValidateLoadoutWriteData("2", JSON.stringify({})), "an unsupported index must be rejected");
            assert.ok(distValidation.ValidateLoadoutWriteData("0", "not json"), "non-JSON data must be rejected");
            assert.ok(distValidation.ValidateLoadoutWriteData("0", JSON.stringify([1, 2])), "a JSON array (not object) must be rejected");
        });

        await test("A save cannot transmute an owned item's catalogId (no unauthorized grant via saveInstancedItems)", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "NoTransmute");
            created.characterIds.add(character.id);

            const before = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const helm = before.instancedItems.find((i) => i.catalogId === "AR_UNEQUIPPED_HELM");
            assert.ok(helm, "starter helm missing");

            
            await distInventory.RunInventoryTransaction(userId, character.id, freshTransactionId(), [], [], [], [], [
                { catalogId: "AR_LEGENDARY_BIS", instanceId: helm.instanceId, itemData: null, updateVersion: 1 }
            ]);

            const after = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const stillHelm = after.instancedItems.find((i) => i.instanceId === helm.instanceId);
            assert.equal(stillHelm.catalogId, "AR_UNEQUIPPED_HELM", "catalogId must be unchanged by a save");
            assert.ok(!after.instancedItems.some((i) => i.catalogId === "AR_LEGENDARY_BIS"), "the injected catalogId must not appear anywhere");
        });

        await test("Same transactionId reused with a DIFFERENT body is rejected without mutating (request-body binding)", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "BodyBind");
            created.characterIds.add(character.id);
            const txn = freshTransactionId();

            const first = await distInventory.RunInventoryTransaction(userId, character.id, txn, [], [{ catalogId: "TOKEN_BIND", quantity: 1 }], [], [], []);
            assert.ok(first, "first body should apply");

            
            let threw = null;
            try {
                await distInventory.RunInventoryTransaction(userId, character.id, txn, [], [{ catalogId: "TOKEN_BIND", quantity: 5 }], [], [], []);
            } catch (error) { threw = error; }
            assert.ok(threw, "a different body under the same transactionId must throw");
            assert.equal(threw.name, "InventoryTransactionMismatchError", `expected InventoryTransactionMismatchError, got ${threw && threw.name}`);

            
            const inv = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const token = inv.stackedItems.find((i) => i.catalogId === "TOKEN_BIND");
            assert.equal(token && token.quantity, 1, "the mismatched-body mutation must not have applied");

            
            const replay = await distInventory.RunInventoryTransaction(userId, character.id, txn, [], [{ catalogId: "TOKEN_BIND", quantity: 1 }], [], [], []);
            assert.ok(replay, "same-body replay should return the stored result");
            const invAfter = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const tokenAfter = invAfter.stackedItems.find((i) => i.catalogId === "TOKEN_BIND");
            assert.equal(tokenAfter && tokenAfter.quantity, 1, "same-body replay must not double-apply");
        });

        await test("Single-item update is revision-guarded, immutable in catalogId, and ignores a stale updateVersion", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "SingleItem");
            created.characterIds.add(character.id);

            const inv = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const sword = inv.instancedItems.find((i) => i.catalogId === "WP_EB_BEGINNER");
            assert.ok(sword, "starter sword missing");

            
            const updated = await distInventory.UpdateInstancedItem(character.id, userId, sword.instanceId, "WP_EB_BEGINNER", JSON.stringify({ tint: 1 }), 1);
            assert.ok(updated, "update should succeed");
            assert.equal(JSON.parse(updated.itemData).tint, 1);

            
            const transmute = await distInventory.UpdateInstancedItem(character.id, userId, sword.instanceId, "WP_LEGENDARY_BIS", JSON.stringify({ tint: 2 }), 2);
            assert.equal(transmute, undefined, "catalogId change via single-item update must be refused");

            
            await distInventory.UpdateInstancedItem(character.id, userId, sword.instanceId, "WP_EB_BEGINNER", JSON.stringify({ tint: 99 }), 0);

            const after = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const swordAfter = after.instancedItems.find((i) => i.instanceId === sword.instanceId);
            assert.equal(swordAfter.catalogId, "WP_EB_BEGINNER", "catalogId must be unchanged");
            assert.equal(JSON.parse(swordAfter.itemData).tint, 1, "stale update must not overwrite newer itemData");
            assert.equal(swordAfter.updateVersion, 1, "updateVersion must remain at the newer value");
            assert.ok(!after.instancedItems.some((i) => i.catalogId === "WP_LEGENDARY_BIS"), "the injected catalogId must not appear anywhere");
        });

        await test("saveInstancedItems reports only truly-applied updates (applied / stale / unknown / equal-identical / equal-divergent)", async () => {
            const userId = freshUserId();
            const character = await distCharacter.CreateCharacterForUid(userId, "SaveReport");
            created.characterIds.add(character.id);

            const inv = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const swordId = inv.instancedItems.find((i) => i.catalogId === "WP_EB_BEGINNER").instanceId;
            const save = (itemData, version) => [{ catalogId: "WP_EB_BEGINNER", instanceId: swordId, itemData, updateVersion: version }];
            const run = (items) => distInventory.RunInventoryTransaction(userId, character.id, freshTransactionId(), [], [], [], [], items);

            
            const r1 = await run(save(JSON.stringify({ tint: 1 }), 1));
            assert.equal(r1.updatedInstancedItems.length, 1, "higher-version save must be reported as updated");
            assert.equal(r1.updatedInstancedItems[0].instanceId, swordId);
            assert.equal(r1.updatedInstancedItems[0].updateVersion, 1);

            
            const r2 = await run(save(JSON.stringify({ tint: 1 }), 1));
            assert.equal(r2.updatedInstancedItems.length, 0, "equal-version identical save is a no-op and must not be reported");

            
            const r3 = await run(save(JSON.stringify({ tint: 2 }), 1));
            assert.equal(r3.updatedInstancedItems.length, 1, "equal-version divergent save must apply and be reported");
            assert.equal(JSON.parse(r3.updatedInstancedItems[0].itemData).tint, 2);

            
            const r4 = await run(save(JSON.stringify({ tint: 999 }), 0));
            assert.equal(r4.updatedInstancedItems.length, 0, "stale save must not be reported");

            
            const r5 = await run([{ catalogId: "WP_EB_BEGINNER", instanceId: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ", itemData: JSON.stringify({ tint: 5 }), updateVersion: 5 }]);
            assert.equal(r5.updatedInstancedItems.length, 0, "unknown-instance save must not be reported");

            
            const after = await distInventory.GetInventoryForUserIdAndCharacterId(userId, character.id);
            const swordAfter = after.instancedItems.find((i) => i.instanceId === swordId);
            assert.equal(swordAfter.updateVersion, 1, "updateVersion stays at the applied value");
            assert.equal(JSON.parse(swordAfter.itemData).tint, 2, "stored data reflects the last applied (divergent) save, not the stale/unknown ones");
            assert.ok(after.instancedItems.every((i) => i.instanceId !== "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"), "unknown-instance save must not create an item");
        });

        console.log(`\n${passed} passed.`);
    } catch (error) {
        testError = error;
        console.error(`  FAIL  ${error.message}`);
    } finally {
        
        try {
            for (const characterId of created.characterIds) {
                await db.collection("characters").deleteMany({ characterId });
                await db.collection("inventories").deleteMany({ _id: characterId });
                await db.collection("loadouts").deleteMany({ _id: characterId });
                await db.collection("inventoryTransactions").deleteMany({ characterId });
            }
            for (const userId of created.userIds) {
                await db.collection("wallets").deleteMany({ _id: userId });
                await db.collection("characters").deleteMany({ userId });
                await db.collection("inventories").deleteMany({ userId });
                await db.collection("loadouts").deleteMany({ userId });
                await db.collection("inventoryTransactions").deleteMany({ userId });
            }
            for (const transactionId of created.transactionIds) {
                await db.collection("inventoryTransactions").deleteMany({ _id: transactionId });
            }
        } catch (cleanupError) {
            console.error("cleanup error:", cleanupError.message);
        }

        
        const leftovers = {
            characters: await db.collection("characters").countDocuments({ userId: { $regex: TEST_PREFIX } }),
            inventories: await db.collection("inventories").countDocuments({ userId: { $regex: TEST_PREFIX } }),
            loadouts: await db.collection("loadouts").countDocuments({ userId: { $regex: TEST_PREFIX } }),
            wallets: await db.collection("wallets").countDocuments({ _id: { $regex: TEST_PREFIX } }),
            inventoryTransactions: await db.collection("inventoryTransactions").countDocuments({ userId: { $regex: TEST_PREFIX } }),
        };
        const totalLeftover = Object.values(leftovers).reduce((sum, count) => sum + count, 0);

        await client.close();
        
        
        await distPersistence.GetPersistenceLifecycle().stop();

        if (testError) {
            process.exit(1);
        }
        if (totalLeftover > 0) {
            console.error(`\nLEFTOVER TEST DOCUMENTS (must be zero): ${JSON.stringify(leftovers)}`);
            process.exit(1);
        }
        console.log("Zero leftover test documents across characters/inventories/loadouts/wallets/inventoryTransactions.");
    }
})().catch((error) => { console.error("REGRESSION SUITE FAILED:", error.message); process.exit(1); });
