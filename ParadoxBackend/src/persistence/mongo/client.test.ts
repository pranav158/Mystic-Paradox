import assert from "node:assert/strict";
import test from "node:test";
import { AssertMongoProductionTopology } from "./client";

test("non-production Mongo profiles may use a standalone local database", () => {
    assert.doesNotThrow(() => AssertMongoProductionTopology({ ok: 1 }, { NODE_ENV: "development" }));
});

test("production Mongo requires a named replica-set writable primary", () => {
    assert.doesNotThrow(() => AssertMongoProductionTopology(
        { setName: "guardit", isWritablePrimary: true },
        { NODE_ENV: "production" }
    ));
});

test("production Mongo rejects a standalone or secondary topology", () => {
    assert.throws(() => AssertMongoProductionTopology(
        { isWritablePrimary: true },
        { NODE_ENV: "production" }
    ), /MONGODB_PRODUCTION_REPLICA_SET_PRIMARY_REQUIRED/);
    assert.throws(() => AssertMongoProductionTopology(
        { setName: "guardit", isWritablePrimary: false },
        { NODE_ENV: "production" }
    ), /MONGODB_PRODUCTION_REPLICA_SET_PRIMARY_REQUIRED/);
});

test("production Mongo rejects missing hello data", () => {
    assert.throws(() => AssertMongoProductionTopology(undefined, { NODE_ENV: "production" }),
        /MONGODB_PRODUCTION_REPLICA_SET_PRIMARY_REQUIRED/);
});
