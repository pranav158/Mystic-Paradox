import assert from "node:assert/strict";
import test from "node:test";
import { GetServiceReadiness, SetServiceReadiness } from "./serviceReadiness";

test("service readiness exposes only bounded role state and transitions", () => {
    const before = GetServiceReadiness();
    try {
        SetServiceReadiness({ ready: true, reason: "a".repeat(300), role: "api" });
        const after = GetServiceReadiness();
        assert.equal(after.ready, true);
        assert.equal(after.role, "api");
        assert.equal(after.reason.length, 96);
        assert.match(after.changedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
        SetServiceReadiness(before);
    }
});
