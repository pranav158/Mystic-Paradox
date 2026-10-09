"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "test_mongo_schema_migration_rehearsal.cjs"), "utf8");

async function run(mode) {
    let drops = 0, seeds = 0, closed = 0;
    const names = [], output = [];
    const db = {
        command: async () => ({ setName: "guard", isWritablePrimary: true }),
        listCollections: () => ({ toArray: async () => mode === "occupied" ? [{ name: "sentinel" }] : [] }),
        collection: () => ({ insertOne: async () => { seeds++; throw Error("seed failure"); } }),
        dropDatabase: async () => { drops++; },
    };
    class MongoClient {
        db(name) { names.push(name); return db; }
        async connect() { if (mode === "connection") throw Error("connection failure"); }
        async close() { closed++; }
    }
    const processMock = { env: { ALLOW_DB_INTEGRATION_TESTS: "true", MONGODB_URI: "mongodb://fixture",
        MONGODB_DB: "mystpax", MONGODB_TEST_DB: "mysticparadox_guard_migration_it_20260912" } };
    const context = { process: processMock, console: { log: x => output.push(x), error: () => {} }, require(name) {
        if (name === "mongodb") return { MongoClient };
        if (name.includes("/client.js")) return { MongoPersistenceLifecycle: class { async stop() {} } };
        if (name.includes("/indexes.js")) return { EnsureMongoIndexes: async () => {} };
        if (name.includes("/collections.js")) return { Collections: { SchemaMigrations: "schemaMigrations" } };
        if (name.includes("/schemaMigrations.js")) return { CURRENT_MONGO_SCHEMA_VERSION: 1, MONGO_SCHEMA_MIGRATION_ID: "v1" };
        return require(name);
    } };
    await vm.runInNewContext(source, context);
    return { drops, seeds, closed, names, output, processMock };
}

test("connection failure never drops a database", async () => {
    const r = await run("connection");
    assert.equal(r.drops, 0); assert.equal(r.seeds, 0); assert.equal(r.closed, 1);
    assert.equal(r.processMock.exitCode, 1); assert.equal(r.output.length, 0);
});
test("existing collections are preserved without seeding or cleanup", async () => {
    const r = await run("occupied");
    assert.equal(r.drops, 0); assert.equal(r.seeds, 0); assert.equal(r.processMock.exitCode, 1);
});
test("seed failure cleans only the unique database after an empty check", async () => {
    const r = await run("empty");
    assert.equal(r.drops, 1); assert.equal(r.seeds, 1); assert.equal(r.output.length, 0);
    assert.notEqual(r.names[0], r.processMock.env.MONGODB_TEST_DB);
    assert.equal(r.names[0], r.processMock.env.MONGODB_DB);
    assert.ok(Buffer.byteLength(r.names[0]) <= 63);
    assert.match(r.names[0], /_[a-f0-9]{24}$/);
});