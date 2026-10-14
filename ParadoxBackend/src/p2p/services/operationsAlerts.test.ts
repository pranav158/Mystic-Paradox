import assert from "node:assert/strict";
import test from "node:test";
import { BuildRewardInvariantAlert, NormalizeOperationsAlertReason } from "./operationsAlerts";

test("reward invariant alerts are deterministic, critical, and non-PII", () => {
    const alert = BuildRewardInvariantAlert("alert-1", "InventoryTransactionMismatchError",
        "2026-09-07T12:00:00.000Z");
    assert.deepEqual(alert, {
        alertId: "alert-1",
        source: "central-guard",
        code: "REWARD_INVARIANT",
        severity: "CRITICAL",
        message: "Tier 1 grants paused after InventoryTransactionMismatchError",
        details: { reasonCode: "InventoryTransactionMismatchError" },
        status: "OPEN",
        createdAt: "2026-09-07T12:00:00.000Z"
    });
    assert.equal(JSON.stringify(alert).includes("account"), false);
});

test("invalid alert reason codes fail closed to a stable code", () => {
    assert.equal(NormalizeOperationsAlertReason("bad reason"), "UNKNOWN_REWARD_INVARIANT");
    assert.equal(NormalizeOperationsAlertReason("<script>alert(1)</script>"), "UNKNOWN_REWARD_INVARIANT");
    assert.equal(NormalizeOperationsAlertReason(undefined), "UNKNOWN_REWARD_INVARIANT");
});
