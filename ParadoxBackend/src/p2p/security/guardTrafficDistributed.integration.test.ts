import assert from "node:assert/strict";
import test from "node:test";
import { ConsumeDistributedGuardTrafficPair } from "./guardTrafficDistributed";
import { GetMongoDb, MongoPersistenceLifecycle } from "../../persistence/mongo/client";
import { P2PCollections } from "../persistence/mongo/collections";

const HOST_LIMIT = { maxRequests: 2, maxBytes: 10, windowMs: 60_000 };
const SESSION_LIMIT = { maxRequests: 1, maxBytes: 10, windowMs: 60_000 };

// Opt-in like the other Mongo integration checks: it clears its collection, so it runs only against
// an isolated database (npm run test:p2p-distributed-mongo with ALLOW_DB_INTEGRATION_TESTS=true).
const SKIP = process.env.ALLOW_DB_INTEGRATION_TESTS !== "true" && "set ALLOW_DB_INTEGRATION_TESTS=true with an isolated MONGODB_URI and MONGODB_DB";

test("actual distributed Guard implementation rolls back a rejected session reservation", { skip: SKIP }, async () => {
    assert.ok(process.env.MONGODB_URI, "MONGODB_URI is required for the isolated integration test");
    assert.ok(process.env.MONGODB_DB, "MONGODB_DB is required for the isolated integration test");
    const db = await GetMongoDb();
    const collection = db.collection(P2PCollections.GuardTrafficWindows);
    await collection.deleteMany({});
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const now = Date.now();

    assert.equal(await ConsumeDistributedGuardTrafficPair("host-a", "session-a", 1, HOST_LIMIT, SESSION_LIMIT, now), true);
    assert.equal(await ConsumeDistributedGuardTrafficPair("host-a", "session-a", 1, HOST_LIMIT, SESSION_LIMIT, now), false);
    assert.equal(await ConsumeDistributedGuardTrafficPair("host-a", "session-b", 1, HOST_LIMIT, SESSION_LIMIT, now), true);

    const host = await collection.findOne({ scope: "host" });
    assert.equal(host?.requests, 2);
    assert.equal(host?.bytes, 2);
    assert.equal(await collection.countDocuments({ scope: "session" }), 2);
    await collection.deleteMany({});
    await new MongoPersistenceLifecycle().stop();
});
