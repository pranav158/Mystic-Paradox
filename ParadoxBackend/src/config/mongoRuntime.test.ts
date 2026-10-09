import assert from "node:assert/strict";
import test from "node:test";
import { ReadMongoRuntimeConfig } from "./mongoRuntime";

test("Mongo runtime settings use bounded production-safe defaults", () => {
    assert.deepEqual(ReadMongoRuntimeConfig({}), {
        appName: "paradox-backend",
        connectTimeoutMS: 5_000,
        serverSelectionTimeoutMS: 5_000,
        maxPoolSize: 20,
        maxIdleTimeMS: 60_000,
        transactionMaxCommitTimeMS: 2_000
    });
});

test("Mongo runtime settings parse the supported overrides", () => {
    assert.deepEqual(ReadMongoRuntimeConfig({
        MONGODB_APP_NAME: "central-guard-worker",
        MONGODB_CONNECT_TIMEOUT_MS: "750",
        MONGODB_SERVER_SELECTION_TIMEOUT_MS: "12000",
        MONGODB_MAX_POOL_SIZE: "64",
        MONGODB_MAX_IDLE_TIME_MS: "0",
        MONGODB_TRANSACTION_MAX_COMMIT_TIME_MS: "5000"
    }), {
        appName: "central-guard-worker",
        connectTimeoutMS: 750,
        serverSelectionTimeoutMS: 12_000,
        maxPoolSize: 64,
        maxIdleTimeMS: 0,
        transactionMaxCommitTimeMS: 5_000
    });
});

test("Mongo runtime settings reject malformed and unsafe numeric values", () => {
    for (const [name, value] of [
        ["MONGODB_CONNECT_TIMEOUT_MS", "NaN"],
        ["MONGODB_SERVER_SELECTION_TIMEOUT_MS", "100"],
        ["MONGODB_MAX_POOL_SIZE", "0"],
        ["MONGODB_MAX_IDLE_TIME_MS", "300001"],
        ["MONGODB_TRANSACTION_MAX_COMMIT_TIME_MS", "30001"]
    ] as const) {
        assert.throws(() => ReadMongoRuntimeConfig({ [name]: value }), new RegExp(name));
    }
});

test("Mongo runtime settings reject empty or control-character app names", () => {
    assert.throws(() => ReadMongoRuntimeConfig({ MONGODB_APP_NAME: "   " }), /MONGODB_APP_NAME/);
    assert.throws(() => ReadMongoRuntimeConfig({ MONGODB_APP_NAME: "guard\nworker" }), /MONGODB_APP_NAME/);
});
