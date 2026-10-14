import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
    BuildOperationsAlertPayload,
    HttpOperationsAlertSink,
    OperationsAlertSinkError,
    ReadOperationsAlertSinkConfig
} from "./operationsAlerts";
import { OperationsAlertDeliveryClaim, OperationsAlertRecord, OperationsAlertRepository } from "../persistence/contracts/OperationsAlertRepository";
import { OperationsAlertDispatcher, OperationsAlertDispatcherInternals } from "./operationsAlertDispatcher";

function Alert(): OperationsAlertRecord {
    return {
        alertId: "alert-123",
        source: "central-guard",
        code: "REWARD_INVARIANT",
        severity: "CRITICAL",
        message: "Tier 1 grants paused after TEST_INVARIANT",
        details: { reasonCode: "TEST_INVARIANT" },
        status: "OPEN",
        createdAt: "2026-09-08T00:00:00.000Z",
        deliveryState: "PENDING",
        deliveryAttemptCount: 0
    };
}

test("alert sink configuration fails closed for unsafe production URLs", () => {
    assert.equal(ReadOperationsAlertSinkConfig({}), undefined);
    assert.throws(() => ReadOperationsAlertSinkConfig({
        NODE_ENV: "production",
        MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_URL: "http://alerts.example.test/hook",
        MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_TOKEN: "0123456789012345"
    }), /must use HTTPS/);
    assert.doesNotThrow(() => ReadOperationsAlertSinkConfig({
        NODE_ENV: "development",
        MYSTICPARADOX_ALLOW_LOCAL_ALERT_SINK: "true",
        MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_URL: "http://127.0.0.1:39001/hook",
        MYSTICPARADOX_OPERATIONS_ALERT_WEBHOOK_TOKEN: "0123456789012345"
    }));
});

test("HTTP alert sink sends bounded payload and idempotency key", async () => {
    const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
            response.writeHead(204).end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
        const sink = new HttpOperationsAlertSink({
            url: `http://127.0.0.1:${address.port}/hook`, token: "0123456789012345", timeoutMs: 2_000
        });
        await sink.deliver(Alert());
        assert.equal(received.length, 1);
        assert.equal(received[0].headers["idempotency-key"], "alert-123");
        assert.equal(received[0].headers.authorization, "Bearer 0123456789012345");
        const payload = JSON.parse(received[0].body);
        assert.deepEqual(payload, BuildOperationsAlertPayload(Alert()));
        assert.equal(JSON.stringify(payload).includes("account"), false);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test("alert dispatcher retries a failed delivery with a bounded lease", async () => {
    class FakeRepository implements Pick<OperationsAlertRepository,
        "claimForDelivery" | "markDeliverySucceeded" | "markDeliveryRetry"> {
        record = Alert();
        now = 0;

        async claimForDelivery(leaseId: string, now: string, leaseUntil: string): Promise<OperationsAlertDeliveryClaim | undefined> {
            if (this.record.deliveryState === "DELIVERED" || this.record.deliveryNextAttemptAt !== undefined && this.record.deliveryNextAttemptAt > now) return undefined;
            if (this.record.deliveryLeaseUntil !== undefined && this.record.deliveryLeaseUntil > now) return undefined;
            this.record.deliveryState = "PENDING";
            this.record.deliveryLeaseId = leaseId;
            this.record.deliveryLeaseUntil = leaseUntil;
            this.record.deliveryAttemptCount = (this.record.deliveryAttemptCount ?? 0) + 1;
            return { record: { ...this.record }, leaseId, attempt: this.record.deliveryAttemptCount };
        }

        async markDeliverySucceeded(alertId: string, leaseId: string, deliveredAt: string): Promise<boolean> {
            if (this.record.alertId !== alertId || this.record.deliveryLeaseId !== leaseId) return false;
            this.record.deliveryState = "DELIVERED";
            this.record.deliveryDeliveredAt = deliveredAt;
            delete this.record.deliveryLeaseId;
            delete this.record.deliveryLeaseUntil;
            return true;
        }

        async markDeliveryRetry(alertId: string, leaseId: string, failedAt: string,
            nextAttemptAt: string, errorCode: string): Promise<boolean> {
            if (this.record.alertId !== alertId || this.record.deliveryLeaseId !== leaseId) return false;
            this.record.deliveryState = "RETRY";
            this.record.deliveryLastError = errorCode;
            this.record.deliveryNextAttemptAt = nextAttemptAt;
            delete this.record.deliveryLeaseId;
            delete this.record.deliveryLeaseUntil;
            return true;
        }
    }

    const repository = new FakeRepository();
    let now = new Date("2026-09-08T00:00:00.000Z");
    let attempts = 0;
    const dispatcher = new OperationsAlertDispatcher({
        getRepository: () => repository,
        now: () => now,
        workerId: "dispatcher-test",
        baseRetryMs: 100,
        maxRetryMs: 500,
        sink: {
            deliver: async () => {
                attempts += 1;
                if (attempts === 1) throw new OperationsAlertSinkError("temporary", 503, true);
            }
        },
        logError: () => undefined
    });
    await dispatcher.tick();
    assert.equal(attempts, 1);
    assert.equal(repository.record.deliveryState, "RETRY");
    now = new Date("2026-09-08T00:00:00.101Z");
    await dispatcher.tick();
    assert.equal(attempts, 2);
    assert.equal(repository.record.deliveryState, "DELIVERED");
    assert.equal(OperationsAlertDispatcherInternals.RetryDelay(20, 100, 500), 500);
});
