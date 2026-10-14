import { OperationsAlertRecord } from "../persistence/contracts/OperationsAlertRepository";

const REASON_CODE = /^[A-Za-z0-9_]+$/;

export function NormalizeOperationsAlertReason(input: unknown): string {
    if (typeof input !== "string") return "UNKNOWN_REWARD_INVARIANT";
    const value = input.slice(0, 64);
    return REASON_CODE.test(value) ? value : "UNKNOWN_REWARD_INVARIANT";
}

/** Build the non-PII alert written in the same transaction as an automatic pause. */
export function BuildRewardInvariantAlert(alertId: string, reasonCode: unknown,
    createdAt: string): OperationsAlertRecord {
    const reason = NormalizeOperationsAlertReason(reasonCode);
    return {
        alertId,
        source: "central-guard",
        code: "REWARD_INVARIANT",
        severity: "CRITICAL",
        message: `Tier 1 grants paused after ${reason}`,
        details: { reasonCode: reason },
        status: "OPEN",
        createdAt
    };
}

export interface OperationsAlertSinkConfig {
    url: string;
    token: string;
    timeoutMs: number;
}

/**
 * Read the optional outbound alert sink without ever logging its URL or token.
 * Production requires HTTPS; loopback HTTP is available only for isolated local tests.
 */
export function ReadOperationsAlertSinkConfig(environment: NodeJS.ProcessEnv = process.env): OperationsAlertSinkConfig | undefined {
    const rawUrl = (environment.MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_URL ?? "").trim();
    const rawToken = (environment.MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_TOKEN ?? "").trim();
    if (rawUrl.length === 0 && rawToken.length === 0) return undefined;
    if (rawUrl.length === 0 || rawToken.length === 0) {
        throw new Error("MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_URL and MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_TOKEN must be configured together");
    }
    if (rawToken.length < 16 || rawToken.length > 4096) {
        throw new Error("MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_TOKEN must be between 16 and 4096 characters");
    }
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error("MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_URL must be a valid URL");
    }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error("MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_URL must be an http(s) URL without credentials, query or fragment");
    }
    const localHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    const localHttpAllowed = (environment.MYSTICPARADOX_ALLOW_LOCAL_ALERT_SINK ?? "").trim().toLowerCase() === "true";
    if (environment.NODE_ENV === "production" && parsed.protocol !== "https:") {
        throw new Error("Production operations alert sink must use HTTPS");
    }
    if (parsed.protocol === "http:" && (!localHost || !localHttpAllowed)) {
        throw new Error("HTTP operations alert sinks require a loopback URL and MYSTICPARADOX_ALLOW_LOCAL_ALERT_SINK=true");
    }
    const parsedTimeout = Number(environment.MYSTICPARADOX_OPERATIONS_ALERT_TIMEOUT_MS ?? "5000");
    const timeoutMs = Number.isSafeInteger(parsedTimeout) && parsedTimeout >= 100 && parsedTimeout <= 30_000
        ? parsedTimeout : 5000;
    return { url: parsed.toString(), token: rawToken, timeoutMs };
}

export interface OperationsAlertSink {
    deliver(record: OperationsAlertRecord): Promise<void>;
}

export function BuildOperationsAlertPayload(record: OperationsAlertRecord): Record<string, unknown> {
    return {
        schemaVersion: 1,
        event: "central_guard.alert",
        eventId: record.alertId,
        occurredAt: record.createdAt,
        source: record.source,
        code: record.code,
        severity: record.severity,
        message: record.message,
        details: record.details
    };
}

export class OperationsAlertSinkError extends Error {
    readonly statusCode: number | undefined;
    readonly retryable: boolean;

    constructor(message: string, statusCode: number | undefined, retryable: boolean) {
        super(message);
        this.name = "OperationsAlertSinkError";
        this.statusCode = statusCode;
        this.retryable = retryable;
    }
}

export class HttpOperationsAlertSink implements OperationsAlertSink {
    constructor(private readonly config: OperationsAlertSinkConfig,
        private readonly fetchImpl: typeof fetch = fetch) {}

    async deliver(record: OperationsAlertRecord): Promise<void> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        timeout.unref?.();
        try {
            const response = await this.fetchImpl(this.config.url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "authorization": `Bearer ${this.config.token}`,
                    "idempotency-key": record.alertId,
                    "x-mysticparadox-alert-schema": "1"
                },
                body: JSON.stringify(BuildOperationsAlertPayload(record)),
                signal: controller.signal
            });
            if (!response.ok) {
                const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
                throw new OperationsAlertSinkError(`alert sink returned HTTP ${response.status}`, response.status, retryable);
            }
        } catch (error) {
            if (error instanceof OperationsAlertSinkError) throw error;
            if (error instanceof Error && error.name === "AbortError") {
                throw new OperationsAlertSinkError("alert sink request timed out", undefined, true);
            }
            throw new OperationsAlertSinkError("alert sink request failed", undefined, true);
        } finally {
            clearTimeout(timeout);
        }
    }
}
