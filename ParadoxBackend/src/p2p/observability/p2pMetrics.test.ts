import assert from "node:assert/strict";
import test from "node:test";
import { IncrementMetric, ObserveMetric, RegisterMetricsSection, RenderMetrics, ResetMetricsForTests, SetMetric } from "../../observability/metrics";
import { P2PMetricsSection } from "./p2pMetrics";

test("metrics render the module's reward state and Guard evidence age once", () => {
    ResetMetricsForTests();
    RegisterMetricsSection(P2PMetricsSection);
    SetMetric("mysticparadox_reward_rollout_enabled", 0);
    SetMetric("mysticparadox_guard_last_received_timestamp_seconds", Date.now() / 1000 - 2);
    IncrementMetric("mysticparadox_guard_batches_accepted_total", 2, { result: "new" });
    ObserveMetric("mysticparadox_http_request_duration_ms", 120, { class: "p2p" });
    const text = RenderMetrics();
    assert.match(text, /mysticparadox_reward_rollout_enabled 0/);
    assert.equal(text.match(/^mysticparadox_reward_rollout_enabled /gm)?.length, 1);
    assert.match(text, /mysticparadox_guard_evidence_age_seconds \d/);
    assert.doesNotMatch(text, /mysticparadox_guard_last_received_timestamp_seconds/);
    assert.match(text, /mysticparadox_guard_batches_accepted_total\{result="new"\} 2/);
    assert.match(text, /mysticparadox_http_request_duration_ms_bucket\{class="p2p",le="250"\} 1/);
});
