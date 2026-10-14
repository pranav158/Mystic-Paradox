import { ClientSession } from "mongodb";

export type OperationsAlertSeverity = "CRITICAL" | "WARNING";
export type OperationsAlertStatus = "OPEN" | "ACKNOWLEDGED";
export type OperationsAlertDeliveryState = "PENDING" | "RETRY" | "DELIVERED";

/**
 * Durable, non-PII operational alert emitted by the central Guard/economy plane.
 * Alerts are intentionally separate from admin audit rows: audit is the immutable
 * record of an action, while this record is the operator-facing work item that
 * remains visible until it is acknowledged.
 */
export interface OperationsAlertRecord {
    alertId: string;
    source: "central-guard";
    code: string;
    severity: OperationsAlertSeverity;
    message: string;
    details: Record<string, string>;
    status: OperationsAlertStatus;
    createdAt: string;
    deliveryState?: OperationsAlertDeliveryState;
    deliveryAttemptCount?: number;
    deliveryNextAttemptAt?: string;
    deliveryLeaseId?: string;
    deliveryLeaseUntil?: string;
    deliveryFailedAt?: string;
    deliveryDeliveredAt?: string;
    deliveryLastError?: string;
    acknowledgedAt?: string;
    acknowledgedBy?: string;
}

export interface OperationsAlertDeliveryClaim {
    record: OperationsAlertRecord;
    leaseId: string;
    attempt: number;
}

export interface OperationsAlertRepository {
    /** Idempotent inside a retried Mongo transaction. */
    enqueue(record: OperationsAlertRecord, session?: ClientSession): Promise<void>;
    listOpen(limit: number, session?: ClientSession): Promise<OperationsAlertRecord[]>;
    acknowledge(alertId: string, actorUserId: string, acknowledgedAt: string,
        session?: ClientSession): Promise<boolean>;
    claimForDelivery(leaseId: string, now: string, leaseUntil: string): Promise<OperationsAlertDeliveryClaim | undefined>;
    markDeliverySucceeded(alertId: string, leaseId: string, deliveredAt: string): Promise<boolean>;
    markDeliveryRetry(alertId: string, leaseId: string, failedAt: string,
        nextAttemptAt: string, errorCode: string): Promise<boolean>;
}
