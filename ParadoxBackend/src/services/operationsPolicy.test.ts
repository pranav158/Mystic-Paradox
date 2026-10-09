import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_OPERATIONS_POLICY, NormalizeOperationsPolicyRecord,
    OperationsPolicyWeakeningCodes, ResolveDiagnosticsExpiry } from "./operationsPolicy";

test("missing operations policy defaults to enforce and production logs", () => {
    assert.equal(DEFAULT_OPERATIONS_POLICY.guardEnforcement, "ENFORCE");
    assert.equal(DEFAULT_OPERATIONS_POLICY.diagnosticsProfile, "PRODUCTION");
    assert.equal(DEFAULT_OPERATIONS_POLICY.version, 0);
});

test("malformed central operations policy fails closed", () => {
    const normalized = NormalizeOperationsPolicyRecord({
        guardEnforcement: "BROKEN",
        diagnosticsProfile: "BROKEN",
        version: -1
    });
    assert.equal(normalized.malformed, true);
    assert.equal(normalized.policy.guardEnforcement, "ENFORCE");
    assert.equal(normalized.policy.diagnosticsProfile, "PRODUCTION");
});

test("development diagnostics expire back to production", () => {
    const now = Date.parse("2026-08-29T00:00:00.000Z");
    const active = NormalizeOperationsPolicyRecord({
        guardEnforcement: "OBSERVE", diagnosticsProfile: "DEVELOPMENT",
        version: 1, diagnosticsExpiresAt: "2026-08-29T01:00:00.000Z"
    }, now);
    const expired = NormalizeOperationsPolicyRecord({
        guardEnforcement: "OBSERVE", diagnosticsProfile: "DEVELOPMENT",
        version: 1, diagnosticsExpiresAt: "2026-08-28T23:00:00.000Z"
    }, now);
    assert.equal(active.policy.diagnosticsProfile, "DEVELOPMENT");
    assert.equal(expired.policy.diagnosticsProfile, "PRODUCTION");
});

test("any malformed security field forces production diagnostics", () => {
    const normalized = NormalizeOperationsPolicyRecord({
        guardEnforcement: "BROKEN",
        diagnosticsProfile: "DEVELOPMENT",
        diagnosticsExpiresAt: "2026-08-29T02:00:00.000Z",
        version: 1
    }, Date.parse("2026-08-29T00:00:00.000Z"));
    assert.equal(normalized.malformed, true);
    assert.equal(normalized.policy.guardEnforcement, "ENFORCE");
    assert.equal(normalized.policy.diagnosticsProfile, "PRODUCTION");
    assert.equal(normalized.policy.diagnosticsExpiresAt, undefined);
});

test("malformed module fields of the same document fail the whole policy closed", () => {
    const normalized = NormalizeOperationsPolicyRecord({
        guardEnforcement: "OBSERVE", diagnosticsProfile: "DEVELOPMENT",
        diagnosticsExpiresAt: "2026-08-29T02:00:00.000Z", version: 1
    }, Date.parse("2026-08-29T00:00:00.000Z"), false);
    assert.equal(normalized.malformed, true);
    assert.equal(normalized.policy.guardEnforcement, "ENFORCE");
    assert.equal(normalized.policy.diagnosticsProfile, "PRODUCTION");
});

test("unrelated policy edits do not renew an active diagnostics lease", () => {
    const current = {
        guardEnforcement: "OBSERVE" as const,
        diagnosticsProfile: "DEVELOPMENT" as const,
        version: 1,
        diagnosticsExpiresAt: "2026-08-29T01:00:00.000Z"
    };
    assert.equal(ResolveDiagnosticsExpiry(current, "DEVELOPMENT",
        Date.parse("2026-08-29T00:30:00.000Z")), current.diagnosticsExpiresAt);
});

test("an explicit transition from production starts one bounded diagnostics lease", () => {
    const current = {
        guardEnforcement: "ENFORCE" as const,
        diagnosticsProfile: "PRODUCTION" as const,
        version: 2
    };
    assert.equal(ResolveDiagnosticsExpiry(current, "DEVELOPMENT",
        Date.parse("2026-08-29T00:00:00.000Z")), "2026-08-29T02:00:00.000Z");
    assert.equal(ResolveDiagnosticsExpiry(current, "PRODUCTION",
        Date.parse("2026-08-29T00:00:00.000Z")), undefined);
});

test("policy weakening detection covers Guard and diagnostics boundaries", () => {
    const before = {
        guardEnforcement: "ENFORCE" as const,
        diagnosticsProfile: "PRODUCTION" as const,
        version: 5
    };
    assert.deepEqual(OperationsPolicyWeakeningCodes(before, {
        guardEnforcement: "OBSERVE", diagnosticsProfile: "DEVELOPMENT"
    }), ["GUARD_DOWNGRADE", "DEVELOPMENT_DIAGNOSTICS"]);
    assert.deepEqual(OperationsPolicyWeakeningCodes(before, {
        guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION"
    }), []);
});
