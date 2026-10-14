import assert from "node:assert/strict";
import test from "node:test";
import { EnforceP2PGuardTraffic } from "./p2pHunts";
import { LauncherApiError } from "../security/p2pErrors";

const LIMIT = { maxRequests: 1, maxBytes: 1024, windowMs: 60_000 };

test("distributed traffic rejection preserves the bounded rate-limit error", async () => {
    await assert.rejects(
        EnforceP2PGuardTraffic("host", "session", 1, {
            distributedEnabled: true,
            distributedConsume: async () => false,
            localConsume: () => { throw new Error("local fallback must not run"); }
        }),
        (error: unknown) => error instanceof LauncherApiError && error.code === "GUARD_TRAFFIC_RATE_LIMITED"
    );
});

test("distributed storage failure maps to bounded unavailability without local fallback", async () => {
    await assert.rejects(
        EnforceP2PGuardTraffic("host", "session", 1, {
            distributedEnabled: true,
            distributedConsume: async () => { throw new Error("mongo unavailable"); },
            localConsume: () => { throw new Error("local fallback must not run"); }
        }),
        (error: unknown) => error instanceof LauncherApiError &&
            error.code === "GUARD_TRAFFIC_UNAVAILABLE"
    );
});

test("local development fallback checks host and session independently", async () => {
    const seen: string[] = [];
    await EnforceP2PGuardTraffic("host", "session", 1, {
        distributedEnabled: false,
        distributedConsume: async () => { throw new Error("distributed path must not run"); },
        localConsume: (key, bytes, limit) => {
            seen.push(`${key}:${bytes}:${limit === LIMIT ? "custom" : "configured"}`);
            return true;
        }
    });
    assert.deepEqual(seen, ["host:1:configured", "session:1:configured"]);
});
