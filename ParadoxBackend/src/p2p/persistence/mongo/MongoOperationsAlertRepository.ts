import { ClientSession } from "mongodb";
import { OperationsAlertDeliveryClaim, OperationsAlertRecord, OperationsAlertRepository } from "../contracts/OperationsAlertRepository";
import { P2PCollections } from "./collections";
import { GetMongoDb } from "../../../persistence/mongo/client";

function FromDocument(document: any): OperationsAlertRecord {
    const deliveryAttemptCount = Number(document.deliveryAttemptCount);
    return {
        ...document,
        alertId: String(document._id),
        details: document.details && typeof document.details === "object" ? document.details : {},
        deliveryState: document.deliveryState === "DELIVERED" || document.deliveryState === "RETRY"
            ? document.deliveryState : "PENDING",
        deliveryAttemptCount: Number.isSafeInteger(deliveryAttemptCount) && deliveryAttemptCount >= 0
            ? deliveryAttemptCount : 0
    } as OperationsAlertRecord;
}

export class MongoOperationsAlertRepository implements OperationsAlertRepository {
    async enqueue(record: OperationsAlertRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { alertId, ...document } = record;
        const insertDocument = {
            ...document,
            deliveryState: "PENDING",
            deliveryAttemptCount: 0
        };
        // `$setOnInsert` makes the write safe when the Mongo transaction callback is
        // retried. The caller's alert ID is stable for the logical invariant event.
        await db.collection(P2PCollections.OperationsAlerts).updateOne(
            { _id: alertId as any },
            { $setOnInsert: insertDocument },
            { upsert: true, session }
        );
    }

    async listOpen(limit: number, session?: ClientSession): Promise<OperationsAlertRecord[]> {
        const db = await GetMongoDb();
        const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
        const documents = await db.collection(P2PCollections.OperationsAlerts)
            .find({ status: "OPEN" }, { session })
            .sort({ createdAt: -1 })
            .limit(bounded)
            .toArray();
        return documents.map(FromDocument);
    }

    async acknowledge(alertId: string, actorUserId: string, acknowledgedAt: string,
        session?: ClientSession): Promise<boolean> {
        const db = await GetMongoDb();
        const result = await db.collection(P2PCollections.OperationsAlerts).updateOne(
            { _id: alertId as any, status: "OPEN" },
            { $set: { status: "ACKNOWLEDGED", acknowledgedAt, acknowledgedBy: actorUserId } },
            { session }
        );
        return result.modifiedCount === 1;
    }

    async claimForDelivery(leaseId: string, now: string, leaseUntil: string): Promise<OperationsAlertDeliveryClaim | undefined> {
        const db = await GetMongoDb();
        const result = await db.collection(P2PCollections.OperationsAlerts).findOneAndUpdate(
            {
                status: { $in: ["OPEN", "ACKNOWLEDGED"] },
                deliveryState: { $ne: "DELIVERED" },
                $and: [
                    { $or: [{ deliveryNextAttemptAt: { $exists: false } }, { deliveryNextAttemptAt: { $lte: now } }] },
                    { $or: [{ deliveryLeaseUntil: { $exists: false } }, { deliveryLeaseUntil: { $lte: now } }] }
                ]
            },
            {
                $set: { deliveryState: "PENDING", deliveryLeaseId: leaseId, deliveryLeaseUntil: leaseUntil },
                $inc: { deliveryAttemptCount: 1 }
            },
            { sort: { createdAt: 1 }, returnDocument: "after" }
        );
        const document = (result as any)?.value ?? result;
        if (document == undefined || document === null) return undefined;
        const record = FromDocument(document);
        return {
            record,
            leaseId,
            attempt: record.deliveryAttemptCount ?? 1
        };
    }

    async markDeliverySucceeded(alertId: string, leaseId: string, deliveredAt: string): Promise<boolean> {
        const db = await GetMongoDb();
        const result = await db.collection(P2PCollections.OperationsAlerts).updateOne(
            { _id: alertId as any, deliveryLeaseId: leaseId },
            {
                $set: { deliveryState: "DELIVERED", deliveryDeliveredAt: deliveredAt },
                $unset: { deliveryLeaseId: "", deliveryLeaseUntil: "", deliveryNextAttemptAt: "", deliveryLastError: "" }
            }
        );
        return result.modifiedCount === 1;
    }

    async markDeliveryRetry(alertId: string, leaseId: string, failedAt: string,
        nextAttemptAt: string, errorCode: string): Promise<boolean> {
        const db = await GetMongoDb();
        const result = await db.collection(P2PCollections.OperationsAlerts).updateOne(
            { _id: alertId as any, deliveryLeaseId: leaseId },
            {
                $set: {
                    deliveryState: "RETRY",
                    deliveryLastError: errorCode.slice(0, 160),
                    deliveryNextAttemptAt: nextAttemptAt,
                    deliveryFailedAt: failedAt
                },
                $unset: { deliveryLeaseId: "", deliveryLeaseUntil: "" }
            }
        );
        return result.modifiedCount === 1;
    }
}
