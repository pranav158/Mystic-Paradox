import assert from "node:assert/strict";
import test from "node:test";
import { DistributedGuardTrafficInternals, IsDistributedGuardTrafficEnabled } from "./guardTrafficDistributed";

const LIMIT = { maxRequests: 10, maxBytes: 100, windowMs: 60_000 };

test("distributed Guard limiter configuration is literal-true only", () => {
    assert.equal(IsDistributedGuardTrafficEnabled({}), false);
    assert.equal(IsDistributedGuardTrafficEnabled({ P2P_DISTRIBUTED_TRAFFIC_LIMITER: "1" }), false);
    assert.equal(IsDistributedGuardTrafficEnabled({ P2P_DISTRIBUTED_TRAFFIC_LIMITER: " TRUE " }), true);
});

test("distributed Guard windows are stable, bounded and key-hashed", () => {
    const start = DistributedGuardTrafficInternals.WindowStart(61_234, LIMIT.windowMs);
    assert.equal(start, 60_000);
    const id = DistributedGuardTrafficInternals.WindowId("host", "account-secret", start);
    assert.match(id, /^host:60000:[0-9a-f]{64}$/);
    assert.equal(id.includes("account-secret"), false);
    assert.equal(DistributedGuardTrafficInternals.ValidateReservation({ scope: "host", key: "a", bytes: 100, limit: LIMIT }), true);
    assert.equal(DistributedGuardTrafficInternals.ValidateReservation({ scope: "host", key: "a", bytes: 101, limit: LIMIT }), false);
    assert.equal(DistributedGuardTrafficInternals.ValidateReservation({ scope: "host", key: "", bytes: 1, limit: LIMIT }), false);
});