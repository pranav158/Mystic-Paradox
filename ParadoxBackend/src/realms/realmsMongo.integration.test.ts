import assert from "node:assert/strict";
import test from "node:test";
import { GetMongoDb, MongoPersistenceLifecycle } from "../persistence/mongo/client";
import { MongoRealmPresenceRepository, MongoRealmsRepository, ResolveDisplayNamesFromMongo } from "./persistence/mongo/MongoRealmsRepository";
import { RealmsCollections } from "./persistence/mongo/collections";
import { BackfillHubRoomIds } from "./persistence/mongo/indexes";
import { HubRoomIdsOf } from "./realmRules";
import { RunRealmPresenceRepositoryContract } from "./realmPresenceRepositoryContract";
import { RunRealmsRepositoryContract } from "./realmsRepositoryContract";

// Opt-in like the other Mongo integration checks: it empties the realms collections, so it runs only against an isolated
// database (ALLOW_DB_INTEGRATION_TESTS=true with a scratch MONGODB_URI and MONGODB_DB, never the shared cluster):
//   node --import tsx --test src/realms/realmsMongo.integration.test.ts
const SKIP = process.env.ALLOW_DB_INTEGRATION_TESTS !== "true"
    && "set ALLOW_DB_INTEGRATION_TESTS=true with an isolated MONGODB_URI and MONGODB_DB";

RunRealmsRepositoryContract("MongoDB repository", async () => {
    assert.ok(process.env.MONGODB_URI, "MONGODB_URI is required for the isolated integration test");
    assert.ok(process.env.MONGODB_DB, "MONGODB_DB is required for the isolated integration test");
    const db = await GetMongoDb();
    const repo = new MongoRealmsRepository();
    return {
        repo,
        reset: async () => {
            await db.collection(RealmsCollections.Realms).deleteMany({});
            await db.collection(RealmsCollections.RealmInvites).deleteMany({});
        }
    };
}, { skip: SKIP });

RunRealmPresenceRepositoryContract("MongoDB presence repository", async () => {
    assert.ok(process.env.MONGODB_URI, "MONGODB_URI is required for the isolated integration test");
    assert.ok(process.env.MONGODB_DB, "MONGODB_DB is required for the isolated integration test");
    const db = await GetMongoDb();
    const repo = new MongoRealmPresenceRepository();
    return { repo, reset: async () => { await db.collection(RealmsCollections.RealmPresence).deleteMany({}); } };
}, { skip: SKIP });

test("MongoDB: presence is stored with a Date expiresAt under a TTL index, and old realms get their hub room ids backfilled", { skip: SKIP }, async () => {
    const db = await GetMongoDb();
    const presence = new MongoRealmPresenceRepository();
    await presence.findActive("anyone", "2026-10-13T12:00:00.000Z");
    const indexes = await db.collection(RealmsCollections.RealmPresence).indexes();
    const byKey = (key: string) => indexes.find((index) => JSON.stringify(index.key) === key);
    assert.equal(byKey('{"expiresAt":1}')?.expireAfterSeconds, 0);
    assert.ok(byKey('{"realmId":1,"expiresAt":1}'));
    const realmIndexes = await db.collection(RealmsCollections.Realms).indexes();
    assert.ok(realmIndexes.find((index) => JSON.stringify(index.key) === '{"hubRoomIds":1}'));
    assert.ok(realmIndexes.find((index) => JSON.stringify(index.key) === '{"onlineUntil":1}')?.sparse);

    await db.collection(RealmsCollections.RealmPresence).deleteMany({});
    await presence.bind({ accountId: "a", realmId: "r", boundAt: "2026-10-13T12:00:00.000Z", lastSeenAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T12:02:00.000Z" });
    const raw = await db.collection(RealmsCollections.RealmPresence).findOne({ _id: "a" as any });
    assert.ok(raw?.expiresAt instanceof Date, "the TTL index needs a Date");
    await db.collection(RealmsCollections.RealmPresence).deleteMany({});

    await db.collection(RealmsCollections.Realms).deleteMany({});
    await db.collection(RealmsCollections.Realms).insertOne({ _id: "old-realm" as any, name: "old", hostAccountId: "h", members: [], bans: [] });
    assert.equal(await BackfillHubRoomIds(db), 1);
    assert.equal(await BackfillHubRoomIds(db), 0, "idempotent");
    const backfilled = await db.collection(RealmsCollections.Realms).findOne({ _id: "old-realm" as any });
    assert.deepEqual(backfilled?.hubRoomIds, HubRoomIdsOf("old-realm"));
    await db.collection(RealmsCollections.Realms).deleteMany({});
});

test("MongoDB: the indexes exist after first use, and invite documents carry a purge date", { skip: SKIP }, async () => {
    const db = await GetMongoDb();
    const repo = new MongoRealmsRepository();
    await repo.findByName("anything");
    const realmIndexes = await db.collection(RealmsCollections.Realms).indexes();
    const byKey = (indexes: any[], key: string) => indexes.find((index) => JSON.stringify(index.key) === key);
    assert.equal(byKey(realmIndexes, '{"name":1}')?.unique, true);
    assert.equal(byKey(realmIndexes, '{"hostAccountId":1}')?.unique, true);
    assert.ok(byKey(realmIndexes, '{"members.accountId":1}'));
    assert.ok(byKey(realmIndexes, '{"onlineUntil":-1,"name":1}')?.partialFilterExpression);
    const inviteIndexes = await db.collection(RealmsCollections.RealmInvites).indexes();
    assert.equal(byKey(inviteIndexes, '{"purgeAt":1}')?.expireAfterSeconds, 0);
    assert.ok(byKey(inviteIndexes, '{"realmId":1,"createdAt":-1}'));

    await db.collection(RealmsCollections.RealmInvites).deleteMany({});
    await repo.insertInvite({
        code: "ABCDEFGHJK", realmId: "r", createdBy: "h", createdAt: "2026-10-13T12:00:00.000Z",
        expiresAt: "2026-10-14T12:00:00.000Z", maxUses: 1, uses: 0
    });
    const raw = await db.collection(RealmsCollections.RealmInvites).findOne({ _id: "ABCDEFGHJK" as any });
    assert.equal(raw?.purgeAt.toISOString(), "2026-10-21T12:00:00.000Z");
    assert.equal("purgeAt" in ((await repo.findInvite("ABCDEFGHJK")) as object), false, "the purge date stays inside the database layer");
    await db.collection(RealmsCollections.RealmInvites).deleteMany({});
});

test("MongoDB: display names come from the shared accounts collection in one query", { skip: SKIP }, async () => {
    const db = await GetMongoDb();
    const accounts = db.collection("accounts");
    await accounts.deleteMany({});
    await accounts.insertMany([
        { _id: "acc-1" as any, displayName: "Hosty" },
        { _id: "acc-2" as any, displayName: "Pal" },
        { _id: "acc-3" as any }
    ]);
    const names = await ResolveDisplayNamesFromMongo(["acc-1", "acc-2", "acc-3", "acc-missing", "acc-1"]);
    assert.deepEqual([...names.entries()].sort(), [["acc-1", "Hosty"], ["acc-2", "Pal"]]);
    assert.equal((await ResolveDisplayNamesFromMongo([])).size, 0);
    await accounts.deleteMany({});
});

test("MongoDB: close the connection", { skip: SKIP }, async () => {
    await new MongoPersistenceLifecycle().stop();
});
