import assert from "node:assert/strict";
import test from "node:test";
import { ResolveOperationalLogLevel } from "./loggingPolicy";

test("production logging clamps verbose, silent, and malformed environment values", () => {
    for (const value of ["trace", "debug", "silent", "invalid", ""]) {
        assert.equal(ResolveOperationalLogLevel("PRODUCTION", { LOG_LEVEL: value }), "info");
    }
    assert.equal(ResolveOperationalLogLevel("PRODUCTION", { LOG_LEVEL: "warn" }), "warn");
    assert.equal(ResolveOperationalLogLevel("PRODUCTION", { LOG_LEVEL: "ERROR" }), "error");
});

test("development diagnostics default to debug and permit an explicit trace level", () => {
    assert.equal(ResolveOperationalLogLevel("DEVELOPMENT", {}), "debug");
    assert.equal(ResolveOperationalLogLevel("DEVELOPMENT",
        { MYSTICPARADOX_DEVELOPMENT_LOG_LEVEL: "trace" }), "trace");
});
