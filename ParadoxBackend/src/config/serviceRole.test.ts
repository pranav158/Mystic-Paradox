import assert from "node:assert/strict";
import test from "node:test";
import { ReadMetagameServiceRole } from "./serviceRole";

test("service role defaults to the backwards-compatible combined process", () => {
    assert.equal(ReadMetagameServiceRole({}), "combined");
    assert.equal(ReadMetagameServiceRole({ MYSTICPARADOX_SERVICE_ROLE: "" }), "combined");
    assert.equal(ReadMetagameServiceRole({ MYSTICPARADOX_SERVICE_ROLE: " API " }), "api");
});

test("unknown service roles fail closed", () => {
    assert.throws(() => ReadMetagameServiceRole({ MYSTICPARADOX_SERVICE_ROLE: "worker" }), /must be combined, api/);
});
