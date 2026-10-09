import assert from "node:assert/strict";
import test from "node:test";
import { IncrementMetric, MetricsInternals, ObserveMetric, RenderMetrics, ResetMetricsForTests } from "./metrics";

test("metrics reject unbounded label names and values", () => {
    const labels = MetricsInternals.safeLabels({ method: "POST", sessionId: "user-secret-that-must-not-be-a-label", bad: "x".repeat(100) });
    assert.deepEqual(labels, { method: "POST" });
});

test("metrics render readiness, counters, and bounded latency buckets", () => {
    ResetMetricsForTests();
    IncrementMetric("mysticparadox_launcher_guard_reports_total", 2, { result: "new" });
    ObserveMetric("mysticparadox_http_request_duration_ms", 120, { class: "game" });
    const text = RenderMetrics();
    assert.match(text, /mysticparadox_service_ready [01]/);
    assert.match(text, /mysticparadox_launcher_guard_reports_total\{result="new"\} 2/);
    assert.match(text, /mysticparadox_http_request_duration_ms_bucket\{class="game",le="250"\} 1/);
    assert.doesNotMatch(text, /sessionId|user-secret/);
});
