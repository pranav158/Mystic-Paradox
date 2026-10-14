import assert from "node:assert/strict";
import test from "node:test";
import { GuardRequestBudget, GuardTrafficLimiter } from "./guardTraffic";

test("Guard traffic limiter bounds requests and bytes, then resets its window", () => {
    let now = 1_000;
    const limiter = new GuardTrafficLimiter(2, () => now);
    const limit = { maxRequests: 2, maxBytes: 10, windowMs: 1_000 };
    assert.equal(limiter.consume("host:a", 6, limit), true);
    assert.equal(limiter.consume("host:a", 5, limit), false);
    assert.equal(limiter.consume("host:a", 4, limit), true);
    assert.equal(limiter.consume("host:a", 1, limit), false);
    now += 1_000;
    assert.equal(limiter.consume("host:a", 10, limit), true);
});

test("Guard traffic limiter evicts old keys at its configured bound", () => {
    const limiter = new GuardTrafficLimiter(2, () => 1);
    const limit = { maxRequests: 10, maxBytes: 100, windowMs: 60_000 };
    assert.equal(limiter.consume("a", 1, limit), true);
    assert.equal(limiter.consume("b", 1, limit), true);
    assert.equal(limiter.consume("c", 1, limit), true);
    assert.equal(limiter.size(), 2);
});

test("Guard request budget rejects aggregate in-flight bytes and releases exactly once", () => {
    const budget = new GuardRequestBudget({ maxInFlightRequests: 2, maxInFlightBytes: 10 });
    const first = budget.tryAcquire(6);
    assert.ok(first);
    assert.equal(budget.tryAcquire(5), undefined);
    assert.ok(budget.tryAcquire(4));
    assert.equal(budget.tryAcquire(1), undefined);
    assert.deepEqual(budget.snapshot(), { inFlightRequests: 2, inFlightBytes: 10 });
    first!(); first!();
    assert.deepEqual(budget.snapshot(), { inFlightRequests: 1, inFlightBytes: 4 });
    budget.reset();
    assert.deepEqual(budget.snapshot(), { inFlightRequests: 0, inFlightBytes: 0 });
});
