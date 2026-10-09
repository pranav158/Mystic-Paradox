"use strict";

/*
 * W4 migration rehearsal against an explicitly named, disposable Mongo database.
 *
 * This is intentionally separate from the normal integration suite: it seeds a small
 * sanitized pre-migration state, runs the exact compiled startup index/migration path,
 * and proves that completed inventory ledger rows (the idempotency record) survive.
 * It refuses the configured application database and requires an unmistakable test name.
 *
 * Example:
 *   $env:ALLOW_DB_INTEGRATION_TESTS="true"
 *   $env:MONGODB_URI="mongodb://127.0.0.1:27017/?replicaSet=guard"
 *   $env:MONGODB_DB="mystpax"
 *   $env:MONGODB_TEST_DB="mysticparadox_guard_migration_it_20260911"
 *   node scripts/test_mongo_schema_migration_rehearsal.cjs
 */

const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { MongoClient } = require("mongodb");

const MAIN_DB = String(process.env.MONGODB_DB || "mystpax").trim();
const TEST_DB = String(process.env.MONGODB_TEST_DB || "").trim();
const URI = String(process.env.MONGODB_URI || "").trim();
const SAFE_TEST_DB = /^mysticparadox_guard_migration_it_[a-z0-9_-]{8,63}$/u;

function refuse(message) {
    console.error(`NOT RUN: ${message}`);
    process.exitCode = 1;
}

function safeError(error) {
    const message = error && error.message ? String(error.message) : String(error);
    return message.replace(/mongodb(?:\+srv)?:\/\/[^\s/]+/giu, "mongodb://[redacted]");
}

async function main() {
    if (process.env.ALLOW_DB_INTEGRATION_TESTS !== "true") {
        refuse("set ALLOW_DB_INTEGRATION_TESTS=true for the disposable migration rehearsal");
        return;
    }
    if (!URI) {
        refuse("MONGODB_URI is required");
        return;
    }
    if (!SAFE_TEST_DB.test(TEST_DB)) {
        refuse("MONGODB_TEST_DB must match mysticparadox_guard_migration_it_<run-id>");
        return;
    }
    if (TEST_DB === MAIN_DB) {
        refuse("MONGODB_TEST_DB must differ from MONGODB_DB");
        return;
    }

    // The compiled repository migration imports GetMongoDb(), which resolves its database
    // from MONGODB_DB. Bind that lookup to this disposable database before requiring it.
    // Use a fresh short suffix within MongoDB's 63-byte database-name limit.
    const runDatabase = `${TEST_DB.slice(0, 38)}_${randomBytes(12).toString("hex")}`;
    if (runDatabase === MAIN_DB) throw new Error("generated database matches application database");
    process.env.MONGODB_DB = runDatabase;
    const { EnsureMongoIndexes } = require("../build/persistence/mongo/indexes.js");
    const { MongoPersistenceLifecycle } = require("../build/persistence/mongo/client.js");
    const { Collections } = require("../build/persistence/mongo/collections.js");
    const {
        CURRENT_MONGO_SCHEMA_VERSION,
        MONGO_SCHEMA_MIGRATION_ID
    } = require("../build/persistence/mongo/schemaMigrations.js");

    const client = new MongoClient(URI, {
        appName: "mysticparadox-central-guard-migration-rehearsal",
        serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
        retryWrites: true,
    });
    const db = client.db(runDatabase);
    let ownsDatabase = false;
    let result;
    try {
        await client.connect();
        const hello = await client.db("admin").command({ hello: 1 });
        if (typeof hello.setName !== "string" || hello.setName.length === 0 || hello.isWritablePrimary !== true) {
            throw new Error("test target is not a writable MongoDB replica-set primary");
        }

        if ((await db.listCollections({}, { nameOnly: true }).toArray()).length !== 0) {
            throw new Error("refusing a non-empty rehearsal database");
        }
        ownsDatabase = true;

        const oldMarker = {
            _id: MONGO_SCHEMA_MIGRATION_ID,
            version: CURRENT_MONGO_SCHEMA_VERSION - 1,
            status: "APPLIED",
            appliedAt: new Date("2026-01-01T00:00:00.000Z")
        };
        const completedLedger = {
            _id: "migration-ledger-row",
            transactionId: "migration-transaction",
            userId: "migration-account",
            characterId: "migration-character",
            requestHash: "a".repeat(64),
            status: "completed",
            result: { createdInstancedItems: [] },
            createdAt: "2026-09-11T00:00:00.000Z",
            completedAt: "2026-09-11T00:00:01.000Z"
        };

        await db.collection(Collections.SchemaMigrations).insertOne(oldMarker);
        await db.collection(Collections.Wallets).insertOne({
            _id: "migration-account",
            userId: "migration-account",
            balances: JSON.stringify({ PLATINUM: 17 }),
            bootstrapVersion: "legacy"
        });
        await db.collection(Collections.Accounts).insertOne({
            _id: "migration-account",
            userId: "migration-account",
            displayName: "Migration Slayer",
            displayNameNormalized: "migration slayer"
        });
        await db.collection(Collections.PlayerJourney).insertOne({
            _id: "migration-account",
            userId: "migration-account",
            state: "LEGACY"
        });
        await db.collection(Collections.InventoryTransactions).insertOne(completedLedger);

        await EnsureMongoIndexes(db);
        // A second startup must be idempotent and leave the migrated state intact.
        await EnsureMongoIndexes(db);

        const marker = await db.collection(Collections.SchemaMigrations).findOne({ _id: MONGO_SCHEMA_MIGRATION_ID });
        assert.equal(marker.version, CURRENT_MONGO_SCHEMA_VERSION);
        const wallet = await db.collection(Collections.Wallets).findOne({ _id: "migration-account" });
        assert.deepEqual(wallet.balances, { PLATINUM: 17 });
        assert.equal(typeof wallet.balances, "object");
        const account = await db.collection(Collections.Accounts).findOne({ _id: "migration-account" });
        assert.equal(account.name, "Migration Slayer");
        assert.equal(account.notes, 0);
        const journey = await db.collection(Collections.PlayerJourney).findOne({ _id: "migration-account" });
        assert.equal(journey.revision, 0);
        assert.deepEqual(await db.collection(Collections.InventoryTransactions).findOne({ _id: completedLedger._id }), completedLedger);

        result = {
            status: "PASS_MIGRATION_REHEARSAL",
            database: runDatabase,
            oldSchemaVersion: oldMarker.version,
            finalSchemaVersion: marker.version,
            inventoryLedgerPreserved: true,
            walletStringMigrated: true,
            playerJourneyRevisionBackfilled: true,
            accountNameBackfilled: true,
            rerunIdempotent: true,
            topology: { setName: hello.setName, writablePrimary: hello.isWritablePrimary }
        };
    } catch (error) {
        console.error(`Mongo schema migration rehearsal FAIL: ${safeError(error)}`);
        process.exitCode = 1;
    } finally {
        // EnsureMongoIndexes delegates the legacy-wallet conversion to the repository, which
        // uses the process-wide Mongo client singleton. Close that client before dropping the
        // disposable database so the child exits cleanly instead of retaining an idle socket.
        try { await new MongoPersistenceLifecycle().stop(); } catch (error) {
            console.error(`Mongo schema migration lifecycle cleanup FAIL: ${safeError(error)}`);
            process.exitCode = 1;
        }
        try { if (ownsDatabase) await db.dropDatabase(); } catch (error) {
            console.error(`Mongo schema migration rehearsal cleanup FAIL: ${safeError(error)}`);
            process.exitCode = 1;
        }
        await client.close();
    }
    if (result && !process.exitCode) console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(`Mongo schema migration rehearsal FAIL: ${safeError(error)}`);
    process.exitCode = 1;
});
