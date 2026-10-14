import assert from "node:assert/strict";
import test from "node:test";
import { AssertRuntimeSafety } from "../../config/runtimeSafety";

// Runs with the module loaded (GetP2PExtension finds src/p2p).
test("P2P cannot silently run under a development deployment profile", () => {
    assert.throws(() => AssertRuntimeSafety({ NODE_ENV: "development", P2P_HUNTS_ENABLED: "true" }),
        /requires NODE_ENV=production/);
    assert.doesNotThrow(() => AssertRuntimeSafety({ NODE_ENV: "development", P2P_HUNTS_ENABLED: "true",
        MYSTICPARADOX_ALLOW_LOCAL_P2P_DEV: "true" }));
});

test("production P2P requires the distributed Guard traffic limiter", () => {
    const base = { NODE_ENV: "production", AUTH_MODE: "APIKEY", REALTIME_XMPP_DEV_CITY_MUC: "false",
        MYSTICPARADOX_SERVICE_ROLE: "api", MYSTICPARADOX_METRICS_TOKEN: "metrics-test-token",
        MONGODB_URI: "mongodb://guardit.example.test/?replicaSet=guardit", P2P_HUNTS_ENABLED: "true" };
    assert.throws(() => AssertRuntimeSafety(base), /P2P_DISTRIBUTED_TRAFFIC_LIMITER/);
    assert.doesNotThrow(() => AssertRuntimeSafety({ ...base, P2P_DISTRIBUTED_TRAFFIC_LIMITER: "true" }));
});
