import { ReadMetagameServiceRole } from "../config/serviceRole";
import { GetServiceReadiness } from "./serviceReadiness";

type Labels = Record<string, string>;

const LABEL_NAME = /^[a-z_][a-z0-9_]{0,31}$/;
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{1,48}$/;
const MAX_LABELS = 4;
const HISTOGRAM_BUCKETS = [5, 25, 100, 250, 500, 1_000, 5_000, Number.POSITIVE_INFINITY] as const;
const ALLOWED_LABEL_NAMES = new Set(["class", "code", "le", "method", "operation", "result", "role", "service", "status"]);

interface MetricKey { name: string; labels: Labels; encoded: string; }
interface HistogramValue { buckets: number[]; sum: number; count: number; }

const counters = new Map<string, { key: MetricKey; value: number }>();
const gauges = new Map<string, { key: MetricKey; value: number }>();
const histograms = new Map<string, { key: MetricKey; value: HistogramValue }>();

function safeName(name: string): string {
    return /^[a-z_:][a-z0-9_:]{0,127}$/.test(name) ? name : "mysticparadox_invalid_metric";
}

function safeLabels(labels: Labels): Labels {
    return Object.fromEntries(Object.entries(labels)
        .filter(([name, value]) => ALLOWED_LABEL_NAMES.has(name) && LABEL_NAME.test(name) && LABEL_VALUE.test(value))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, MAX_LABELS));
}

function key(name: string, labels: Labels): MetricKey {
    const normalizedName = safeName(name);
    const normalizedLabels = safeLabels(labels);
    const encoded = `${normalizedName}|${JSON.stringify(normalizedLabels)}`;
    return { name: normalizedName, labels: normalizedLabels, encoded };
}

function escaped(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("\"", '\\"').replaceAll("\n", "\\n");
}

function labelsText(labels: Labels): string {
    const entries = Object.entries(labels);
    return entries.length === 0 ? "" : `{${entries.map(([name, value]) => `${name}="${escaped(value)}"`).join(",")}}`;
}

export function IncrementMetric(name: string, amount = 1, labels: Labels = {}): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const metric = key(name, labels);
    const current = counters.get(metric.encoded);
    if (current == undefined) counters.set(metric.encoded, { key: metric, value: amount });
    else current.value = Math.min(Number.MAX_SAFE_INTEGER, current.value + amount);
}

export function SetMetric(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    const metric = key(name, labels);
    gauges.set(metric.encoded, { key: metric, value });
}

export function AdjustMetric(name: string, delta: number, labels: Labels = {}): void {
    if (!Number.isFinite(delta)) return;
    const metric = key(name, labels);
    const current = gauges.get(metric.encoded);
    const next = (current?.value ?? 0) + delta;
    gauges.set(metric.encoded, { key: metric, value: Math.max(0, next) });
}

export function ObserveMetric(name: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const metric = key(name, labels);
    let current = histograms.get(metric.encoded);
    if (current == undefined) {
        current = { key: metric, value: { buckets: HISTOGRAM_BUCKETS.map(() => 0), sum: 0, count: 0 } };
        histograms.set(metric.encoded, current);
    }
    current.value.count = Math.min(Number.MAX_SAFE_INTEGER, current.value.count + 1);
    current.value.sum = Math.min(Number.MAX_SAFE_INTEGER, current.value.sum + value);
    for (let index = 0; index < HISTOGRAM_BUCKETS.length; index++) {
        if (value <= HISTOGRAM_BUCKETS[index]) current.value.buckets[index] += 1;
    }
}

export interface MetricsSection {
    /** Always-present gauges derived from raw gauges at render time. */
    render(now: number, readGauge: (name: string) => number | undefined): Array<{ name: string; help: string; value: number }>;
    /** Raw gauges the section renders itself (omitted from the generic gauge list). */
    hiddenGauges: readonly string[];
}

const sections: MetricsSection[] = [];

/** Adds a section of an optional module (src/extensions) to the metrics page. */
export function RegisterMetricsSection(section: MetricsSection): void {
    sections.push(section);
}

function metricLine(name: string, labels: Labels, value: number): string {
    return `${name}${labelsText(labels)} ${Number.isFinite(value) ? value : 0}`;
}

export function RenderMetrics(now = Date.now()): string {
    const lines: string[] = [];
    const readiness = GetServiceReadiness();
    const role = ReadMetagameServiceRole();
    const lastChanged = Date.parse(readiness.changedAt);
    lines.push("# HELP mysticparadox_info Process identity and configured role.");
    lines.push("# TYPE mysticparadox_info gauge");
    lines.push(metricLine("mysticparadox_info", { service: "metagame", role }, 1));
    lines.push("# HELP mysticparadox_service_ready Whether the service has completed its role startup.");
    lines.push("# TYPE mysticparadox_service_ready gauge");
    lines.push(metricLine("mysticparadox_service_ready", {}, readiness.ready ? 1 : 0));
    lines.push("# HELP mysticparadox_service_readiness_changed_timestamp_seconds Unix time of the last readiness transition.");
    lines.push("# TYPE mysticparadox_service_readiness_changed_timestamp_seconds gauge");
    lines.push(metricLine("mysticparadox_service_readiness_changed_timestamp_seconds", {}, Number.isFinite(lastChanged) ? lastChanged / 1000 : 0));
    const readGauge = (name: string) => gauges.get(key(name, {}).encoded)?.value;
    for (const section of sections) {
        for (const metric of section.render(now, readGauge)) {
            lines.push(`# HELP ${metric.name} ${metric.help}`);
            lines.push(`# TYPE ${metric.name} gauge`);
            lines.push(metricLine(metric.name, {}, metric.value));
        }
    }

    const counterNames = new Set<string>();
    for (const { key: metric } of counters.values()) counterNames.add(metric.name);
    for (const name of [...counterNames].sort()) {
        lines.push(`# HELP ${name} Mystic Paradox counter.`);
        lines.push(`# TYPE ${name} counter`);
    }
    for (const { key: metric, value } of [...counters.values()].sort((a, b) => a.key.encoded.localeCompare(b.key.encoded))) {
        lines.push(metricLine(metric.name, metric.labels, value));
    }
    for (const { key: metric, value } of [...gauges.values()].sort((a, b) => a.key.encoded.localeCompare(b.key.encoded))) {
        if (sections.some((section) => section.hiddenGauges.includes(metric.name))) continue;
        lines.push(`# HELP ${metric.name} Mystic Paradox gauge.`);
        lines.push(`# TYPE ${metric.name} gauge`);
        lines.push(metricLine(metric.name, metric.labels, value));
    }
    for (const { key: metric, value } of [...histograms.values()].sort((a, b) => a.key.encoded.localeCompare(b.key.encoded))) {
        lines.push(`# HELP ${metric.name} Mystic Paradox request latency histogram.`);
        lines.push(`# TYPE ${metric.name} histogram`);
        for (let index = 0; index < HISTOGRAM_BUCKETS.length; index++) {
            const upperBound = HISTOGRAM_BUCKETS[index] === Number.POSITIVE_INFINITY ? "+Inf" : String(HISTOGRAM_BUCKETS[index]);
            lines.push(`${metric.name}_bucket${labelsText({ ...metric.labels, le: upperBound })} ${value.buckets[index]}`);
        }
        lines.push(metricLine(`${metric.name}_sum`, metric.labels, value.sum));
        lines.push(metricLine(`${metric.name}_count`, metric.labels, value.count));
    }
    return `${lines.join("\n")}\n`;
}

export function ResetMetricsForTests(): void {
    counters.clear(); gauges.clear(); histograms.clear();
}

export const MetricsInternals = { safeLabels, labelsText, ResetMetricsForTests };
