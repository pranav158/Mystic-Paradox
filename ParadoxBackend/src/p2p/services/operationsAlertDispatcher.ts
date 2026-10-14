import crypto from "node:crypto";

import { logger } from "../../logger";
import { GetP2PRepositories, OperationsAlertRepository } from "../persistence";
import { IncrementMetric, SetMetric } from "../../observability/metrics";
import { HttpOperationsAlertSink, OperationsAlertSink, ReadOperationsAlertSinkConfig } from "./operationsAlerts";

const POLL_MS = 1_000;
const CLAIM_LEASE_MS = 30_000;
const MAX_BATCH = 16;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

type AlertRepository = Pick<OperationsAlertRepository, "claimForDelivery" | "markDeliverySucceeded" | "markDeliveryRetry">;

export interface OperationsAlertDispatcherDependencies {
    getRepository?: () => AlertRepository;
    sink?: OperationsAlertSink;
    now?: () => Date;
    workerId?: string;
    pollMs?: number;
    claimLeaseMs?: number;
    maxBatch?: number;
    baseRetryMs?: number;
    maxRetryMs?: number;
    logError?: (message: string) => void;
}

function ErrorCode(error: unknown): string {
    if (error instanceof Error && /^[A-Za-z0-9_]+$/.test(error.name)) return error.name.slice(0, 64);
    return "ALERT_SINK_DELIVERY_FAILED";
}

function RetryDelay(attempt: number, baseMs: number, maxMs: number): number {
    const exponent = Math.max(0, Math.min(16, attempt - 1));
    return Math.min(maxMs, baseMs * (2 ** exponent));
}

export class OperationsAlertDispatcher {
    private readonly getRepository: () => AlertRepository;
    private readonly sink: OperationsAlertSink | undefined;
    private readonly now: () => Date;
    private readonly workerId: string;
    private readonly pollMs: number;
    private readonly claimLeaseMs: number;
    private readonly maxBatch: number;
    private readonly baseRetryMs: number;
    private readonly maxRetryMs: number;
    private readonly logError: (message: string) => void;
    private timer: NodeJS.Timeout | undefined;
    private activeTick: Promise<void> | undefined;
    private running = false;
    private stopping = false;

    constructor(dependencies: OperationsAlertDispatcherDependencies = {}) {
        this.getRepository = dependencies.getRepository ?? (() => GetP2PRepositories().operationsAlerts);
        this.sink = dependencies.sink ?? (() => {
            const config = ReadOperationsAlertSinkConfig();
            return config == undefined ? undefined : new HttpOperationsAlertSink(config);
        })();
        this.now = dependencies.now ?? (() => new Date());
        this.workerId = dependencies.workerId ?? crypto.randomUUID();
        this.pollMs = Number.isSafeInteger(dependencies.pollMs) && (dependencies.pollMs ?? 0) >= 100
            ? dependencies.pollMs! : POLL_MS;
        this.claimLeaseMs = Number.isSafeInteger(dependencies.claimLeaseMs) && (dependencies.claimLeaseMs ?? 0) >= 1_000
            ? dependencies.claimLeaseMs! : CLAIM_LEASE_MS;
        this.maxBatch = Number.isSafeInteger(dependencies.maxBatch) && (dependencies.maxBatch ?? 0) >= 1
            ? Math.min(100, dependencies.maxBatch!) : MAX_BATCH;
        this.baseRetryMs = Number.isSafeInteger(dependencies.baseRetryMs) && (dependencies.baseRetryMs ?? 0) >= 1
            ? dependencies.baseRetryMs! : BASE_RETRY_MS;
        this.maxRetryMs = Number.isSafeInteger(dependencies.maxRetryMs) && (dependencies.maxRetryMs ?? 0) >= this.baseRetryMs
            ? dependencies.maxRetryMs! : MAX_RETRY_MS;
        this.logError = dependencies.logError ?? ((message) => logger.error(message));
    }

    start(): void {
        if (this.timer != undefined || this.sink == undefined) {
            SetMetric("mysticparadox_operations_alert_dispatcher_enabled", this.sink == undefined ? 0 : 1);
            return;
        }
        this.stopping = false;
        SetMetric("mysticparadox_operations_alert_dispatcher_enabled", 1);
        const run = () => {
            if (this.stopping || this.activeTick != undefined) return;
            const pending = this.tick();
            this.activeTick = pending;
            void pending.then(() => undefined, () => undefined).finally(() => {
                if (this.activeTick === pending) this.activeTick = undefined;
            });
        };
        this.timer = setInterval(run, this.pollMs);
        this.timer.unref();
        run();
    }

    async stop(drainTimeoutMs = 10_000): Promise<void> {
        this.stopping = true;
        if (this.timer != undefined) clearInterval(this.timer);
        this.timer = undefined;
        const pending = this.activeTick;
        if (pending == undefined) return;
        let timeout: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                pending,
                new Promise<void>((resolve) => { timeout = setTimeout(resolve, drainTimeoutMs); })
            ]);
        } finally {
            if (timeout != undefined) clearTimeout(timeout);
            if (this.activeTick != undefined) this.logError("[OperationsAlert] dispatcher drain deadline reached; delivery leases will recover after expiry");
        }
    }

    async tick(): Promise<void> {
        if (this.running || this.stopping || this.sink == undefined) return;
        this.running = true;
        try {
            for (let count = 0; count < this.maxBatch; count += 1) {
                const now = this.now();
                const claim = await this.getRepository().claimForDelivery(this.workerId,
                    now.toISOString(), new Date(now.getTime() + this.claimLeaseMs).toISOString());
                if (claim == undefined) break;
                IncrementMetric("mysticparadox_operations_alert_delivery_attempts_total");
                try {
                    await this.sink.deliver(claim.record);
                    await this.getRepository().markDeliverySucceeded(claim.record.alertId, claim.leaseId,
                        this.now().toISOString());
                    IncrementMetric("mysticparadox_operations_alert_delivery_success_total");
                } catch (error) {
                    const delay = RetryDelay(claim.attempt, this.baseRetryMs, this.maxRetryMs);
                    await this.getRepository().markDeliveryRetry(claim.record.alertId, claim.leaseId,
                        this.now().toISOString(), new Date(this.now().getTime() + delay).toISOString(), ErrorCode(error));
                    IncrementMetric("mysticparadox_operations_alert_delivery_retry_total");
                    this.logError(`[OperationsAlert] sink delivery failed alert=${claim.record.alertId} attempt=${claim.attempt} retryMs=${delay} code=${ErrorCode(error)}`);
                }
            }
        } catch (error) {
            this.logError(`[OperationsAlert] dispatcher database poll failed code=${ErrorCode(error)}`);
        } finally {
            this.running = false;
        }
    }
}

export const operationsAlertDispatcher = new OperationsAlertDispatcher();

export const OperationsAlertDispatcherInternals = { ErrorCode, RetryDelay };
