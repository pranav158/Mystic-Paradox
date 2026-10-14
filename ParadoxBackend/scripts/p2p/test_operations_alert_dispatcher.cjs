"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { MongoClient } = require("mongodb");

function assertLoopbackTarget() {
    const uri = process.env.MONGODB_URI || "";
    const database = process.env.MONGODB_TEST_DB || "";
    if (process.env.ALLOW_DB_INTEGRATION_TESTS !== "true" ||
        !/^mongodb:\/\/(?:127\.0\.0\.1:\d+)(?:,127\.0\.0\.1:\d+)*(?:\/|\?)/.test(uri) ||
        !/^mysticparadox_guard_it_[a-z0-9_]+$/.test(database) || database === process.env.MONGODB_DB) {
        throw new Error("Explicit isolated loopback test target required");
    }
    return { uri, database };
}

async function main() {
    const { uri, database } = assertLoopbackTarget();
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    const db = client.db(database);
    const collectionName = `alert_dispatch_${crypto.randomBytes(8).toString("hex")}`;
    const received = [];
    let failNext = false;
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on("data", chunk => chunks.push(chunk));
        request.on("end", () => {
            received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
            if (failNext) {
                failNext = false;
                response.writeHead(503).end();
            } else {
                response.writeHead(204).end();
            }
        });
    });

    await client.connect();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const mongoClientModule = require("../../build/persistence/mongo/client");
    mongoClientModule.GetMongoDb = async () => db;
    mongoClientModule.GetMongoClient = async () => client;
    const collections = require("../../build/p2p/persistence/mongo/collections").P2PCollections;
    collections.OperationsAlerts = collectionName;
    const { MongoOperationsAlertRepository } = require("../../build/p2p/persistence/mongo/MongoOperationsAlertRepository");
    const { OperationsAlertDispatcher } = require("../../build/p2p/services/operationsAlertDispatcher");
    const { HttpOperationsAlertSink } = require("../../build/p2p/services/operationsAlerts");
    const repository = new MongoOperationsAlertRepository();
    const sink = new HttpOperationsAlertSink({
        url: `http://127.0.0.1:${address.port}/guard-alert`,
        token: "0123456789012345",
        timeoutMs: 2000
    });
    const now = new Date("2026-09-08T00:00:00.000Z");
    const dispatcher = new OperationsAlertDispatcher({
        getRepository: () => repository,
        sink,
        now: () => now,
        workerId: "mongo-alert-dispatch-test",
        baseRetryMs: 100,
        maxRetryMs: 500,
        logError: () => undefined
    });
    const makeAlert = alertId => ({
        alertId,
        source: "central-guard",
        code: "REWARD_INVARIANT",
        severity: "CRITICAL",
        message: "Tier 1 grants paused after TEST_INVARIANT",
        details: { reasonCode: "TEST_INVARIANT" },
        status: "OPEN",
        createdAt: "2026-09-08T00:00:00.000Z"
    });

    try {
        const deliveredId = `delivered-${crypto.randomUUID()}`;
        await repository.enqueue(makeAlert(deliveredId));
        await dispatcher.tick();
        const delivered = await db.collection(collectionName).findOne({ _id: deliveredId });
        assert.equal(delivered.deliveryState, "DELIVERED");
        assert.equal(delivered.deliveryAttemptCount, 1);
        assert.equal(received[0].headers["idempotency-key"], deliveredId);
        assert.equal(JSON.parse(received[0].body).eventId, deliveredId);

        failNext = true;
        const retryId = `retry-${crypto.randomUUID()}`;
        await repository.enqueue(makeAlert(retryId));
        await dispatcher.tick();
        const retry = await db.collection(collectionName).findOne({ _id: retryId });
        assert.equal(retry.deliveryState, "RETRY");
        assert.equal(retry.deliveryAttemptCount, 1);
        assert.equal(retry.deliveryLastError, "OperationsAlertSinkError");
        assert.ok(typeof retry.deliveryNextAttemptAt === "string");
        console.log("PASS: Mongo alert delivery claim, success state, idempotency header and retry state verified");
    } finally {
        await db.collection(collectionName).drop().catch(error => { if (error.code !== 26) throw error; });
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await client.close();
    }
}

main().catch(error => {
    console.error(error.name, error.code || "", error.message || "", "operations alert dispatcher test failed");
    process.exitCode = 1;
});
