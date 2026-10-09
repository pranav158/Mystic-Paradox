import assert from "node:assert/strict";
import test from "node:test";
import {
    AssertMongoSchemaVersionSupported,
    CURRENT_MONGO_SCHEMA_VERSION,
    EnsureMongoSchemaMigrationIndex,
    RecordMongoSchemaMigration
} from "./schemaMigrations";

function fakeDb(options: { duplicate?: boolean; existingVersion?: number | null; raceVersion?: number } = {}) {
    const calls: any[] = [];
    let existingVersion = options.existingVersion;
    const collection = {
        createIndex: async (...args: any[]) => { calls.push(["createIndex", ...args]); return "version_1"; },
        findOne: async (...args: any[]) => {
            calls.push(["findOne", ...args]);
            const version = options.raceVersion !== undefined ? options.raceVersion : existingVersion;
            return version === undefined ? null : { version };
        },
        updateOne: async (...args: any[]) => {
            calls.push(["updateOne", ...args]);
            if (options.duplicate) {
                const error: any = new Error("duplicate");
                error.code = 11000;
                throw error;
            }
            if (existingVersion !== undefined && args[0]?.version === existingVersion) {
                existingVersion = args[1]?.$set?.version ?? existingVersion;
                return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
            }
            return { acknowledged: true, upsertedCount: 1 };
        }
    };
    return { db: { collection: () => collection } as any, calls };
}

test("schema migration index is unique and retry-safe", async () => {
    const { db, calls } = fakeDb();
    await EnsureMongoSchemaMigrationIndex(db);
    await RecordMongoSchemaMigration(db);
    assert.equal(calls[0][0], "createIndex");
    assert.deepEqual(calls[0][1], { version: 1 });
    assert.deepEqual(calls[0][2], { unique: true });
    const update = calls.find((call) => call[0] === "updateOne");
    assert.ok(update);
    assert.equal(update[3].upsert, true);
});

test("a concurrent duplicate migration marker is treated as already applied", async () => {
    await assert.doesNotReject(() => RecordMongoSchemaMigration(fakeDb({ duplicate: true }).db));
});

test("an older marker is advanced after the current migration sequence", async () => {
    const { db, calls } = fakeDb({ existingVersion: CURRENT_MONGO_SCHEMA_VERSION - 1 });
    await RecordMongoSchemaMigration(db);
    const update = calls.find((call) => call[0] === "updateOne");
    assert.deepEqual(update[1], { _id: "central-guard-schema-v1", version: 0 });
    assert.equal(update[2].$set.version, CURRENT_MONGO_SCHEMA_VERSION);
});

test("a malformed persisted marker is rejected instead of treated as absent", async () => {
    await assert.rejects(
        () => RecordMongoSchemaMigration(fakeDb({ existingVersion: null }).db),
        /MONGODB_SCHEMA_VERSION_UNSUPPORTED/
    );
});

test("newer database schema is rejected while older and absent markers remain compatible", () => {
    assert.doesNotThrow(() => AssertMongoSchemaVersionSupported(undefined));
    assert.doesNotThrow(() => AssertMongoSchemaVersionSupported(null));
    assert.doesNotThrow(() => AssertMongoSchemaVersionSupported(CURRENT_MONGO_SCHEMA_VERSION));
    assert.doesNotThrow(() => AssertMongoSchemaVersionSupported(CURRENT_MONGO_SCHEMA_VERSION - 1));
    assert.throws(() => AssertMongoSchemaVersionSupported(undefined, true), /MONGODB_SCHEMA_VERSION_UNSUPPORTED/);
    assert.throws(() => AssertMongoSchemaVersionSupported(null, true), /MONGODB_SCHEMA_VERSION_UNSUPPORTED/);
    assert.throws(() => AssertMongoSchemaVersionSupported(CURRENT_MONGO_SCHEMA_VERSION + 1), /MONGODB_SCHEMA_VERSION_UNSUPPORTED/);
    assert.throws(() => AssertMongoSchemaVersionSupported("1"), /MONGODB_SCHEMA_VERSION_UNSUPPORTED/);
});
