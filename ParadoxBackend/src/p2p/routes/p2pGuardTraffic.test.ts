import assert from "node:assert/strict";
import test from "node:test";
import { CountsAgainstGuardTraffic, EnforceP2PGuardTraffic, P2PHuntOperationOf } from "./p2pHunts";
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

// [2026-10-17] A busy hunt's event batches used up the Guard traffic windows and its lease renewals got 429 with them: the hunt went
// SUSPECT 10 s later and was fenced under its players. Only Guard traffic counts now.
test("only Guard traffic counts against the Guard traffic windows; the lease and the other lifecycle calls do not", () => {
    const Session = "/mystic/v1/hunts/11111111-1111-4111-8111-111111111111";
    assert.equal(P2PHuntOperationOf(`${Session}/event-batches`), "event-batch");
    assert.equal(P2PHuntOperationOf(`${Session}/completion`), "completion");
    assert.equal(P2PHuntOperationOf("/internal/v1/hunt-guard/shadow-comparisons"), "shadow");
    for (const lifecycle of ["lease", "host-ready", "tickets/consume", "abort", "end", "peers/abc/disconnect"]) {
        const operation = P2PHuntOperationOf(`${Session}/${lifecycle}`);
        assert.equal(operation, "lifecycle", lifecycle);
        assert.equal(CountsAgainstGuardTraffic(operation), false, lifecycle);
    }
    for (const operation of ["event-batch", "completion", "shadow"] as const) {
        assert.equal(CountsAgainstGuardTraffic(operation), true, operation);
    }
});
