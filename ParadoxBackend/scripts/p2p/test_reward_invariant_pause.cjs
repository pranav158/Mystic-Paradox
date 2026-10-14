"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");

async function main() {
    const uri = process.env.MONGODB_URI || "";
    const database = process.env.MONGODB_TEST_DB || "";
    if (process.env.ALLOW_DB_INTEGRATION_TESTS !== "true" ||
        !/^mongodb:\/\/(?:127\.0\.0\.1:\d+)(?:,127\.0\.0\.1:\d+)*(?:\/|\?)/.test(uri) ||
        !/^mysticparadox_guard_it_[a-z0-9_]+$/.test(database) || database === process.env.MONGODB_DB) {
        throw new Error("Explicit isolated loopback test target required");
    }

    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    const db = client.db(database);
    const suffix = crypto.randomBytes(8).toString("hex");
    const operationsCollection = `reward_pause_${suffix}_operations`;
    const auditCollection = `reward_pause_${suffix}_audit`;
    const alertCollection = `reward_pause_${suffix}_alerts`;

    // Redirect only this test process to unique collections in the isolated database. The
    // production singleton and configured database are rejected above and never fall back here.
    const mongoClientModule = require("../../build/persistence/mongo/client");
    mongoClientModule.GetMongoDb = async () => db;
    mongoClientModule.GetMongoClient = async () => client;
    const collections = require("../../build/persistence/mongo/collections").Collections;
    collections.OperationsPolicy = operationsCollection;
    collections.AdminAudit = auditCollection;
    require("../../build/p2p/persistence/mongo/collections").P2PCollections.OperationsAlerts = alertCollection;
    const { PauseTier1RewardsForInvariant } = require("../../build/p2p/services/p2pOperationsPolicy");

    try {
        await client.connect();
        assert.ok((await db.admin().command({ hello: 1 })).setName);
        await db.collection(operationsCollection).insertOne({
            _id: "global", guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION",
            version: 4,
            rewardRollout: { version: 1, tier0ShadowEnabled: true, tier1GrantsEnabled: true }
        });

        const first = await PauseTier1RewardsForInvariant({ reasonCode: "InventoryTransactionMismatchError" });
        assert.equal(first.rewardRollout.tier1GrantsEnabled, false);
        assert.equal(first.rewardRollout.version, 2);
        assert.equal((await db.collection(operationsCollection).findOne({ _id: "global" })).rewardRollout.tier1GrantsEnabled, false);
        assert.equal(await db.collection(auditCollection).countDocuments({ action: "operations.reward.auto_pause" }), 1);
        const firstAlert = await db.collection(alertCollection).findOne({ status: "OPEN" });
        assert.equal(firstAlert.code, "REWARD_INVARIANT");
        assert.equal(firstAlert.severity, "CRITICAL");
        assert.equal(firstAlert.details.reasonCode, "InventoryTransactionMismatchError");

        // A repeated invariant is idempotent on state but remains auditable.
        const second = await PauseTier1RewardsForInvariant({ reasonCode: "InventoryTransactionMismatchError" });
        assert.equal(second.rewardRollout.tier1GrantsEnabled, false);
        assert.equal((await db.collection(operationsCollection).findOne({ _id: "global" })).version, 5);
        assert.equal(await db.collection(auditCollection).countDocuments({ action: "operations.reward.auto_pause" }), 2);
        assert.equal(await db.collection(alertCollection).countDocuments({ status: "OPEN" }), 2);
        console.log("PASS: real three-member transaction atomically paused Tier 1 grants, recorded the automatic audit event, queued durable critical alerts, and remained idempotent");
    } finally {
        await db.collection(operationsCollection).drop().catch(error => { if (error.code !== 26) throw error; });
        await db.collection(auditCollection).drop().catch(error => { if (error.code !== 26) throw error; });
        await db.collection(alertCollection).drop().catch(error => { if (error.code !== 26) throw error; });
        await client.close();
    }
}

main().catch(error => { console.error(error.name, error.code || "", error.message || "", "reward invariant pause test failed"); process.exitCode = 1; });
