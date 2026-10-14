import crypto from "node:crypto";
import type { ClientSession, Collection } from "mongodb";
import { GetMongoClient, GetMongoDb } from "../../persistence/mongo/client";
import { P2PCollections } from "../persistence/mongo/collections";
import { ReadMongoRuntimeConfig } from "../../config/mongoRuntime";
import type { GuardTrafficLimit } from "./guardTraffic";

interface GuardTrafficWindowDocument {
    _id: string;
    scope: "host" | "session";
    windowStart: number;
    expiresAt: Date;
    requests: number;
    bytes: number;
    lastDecisionId: string;
    lastDecisionAccepted: boolean;
}

interface ReservationInput {
    scope: "host" | "session";
    key: string;
    bytes: number;
    limit: GuardTrafficLimit;
}

/** A private sentinel used to abort a transaction without treating a rejected request as a fault. */
class ReservationRejected extends Error {
    constructor() { super("GUARD_TRAFFIC_RESERVATION_REJECTED"); }
}

function WindowStart(now: number, windowMs: number): number {
    return Math.floor(now / windowMs) * windowMs;
}

function WindowId(scope: "host" | "session", key: string, windowStart: number): string {
    const digest = crypto.createHash("sha256")
        .update(`${scope}\0${key}\0${windowStart}`)
        .digest("hex");
    return `${scope}:${windowStart}:${digest}`;
}

function ValidateReservation(input: ReservationInput): boolean {
    return input.key.length > 0 && input.key.length <= 256 &&
        Number.isSafeInteger(input.bytes) && input.bytes >= 0 &&
        Number.isSafeInteger(input.limit.maxRequests) && input.limit.maxRequests > 0 &&
        Number.isSafeInteger(input.limit.maxBytes) && input.limit.maxBytes > 0 &&
        Number.isSafeInteger(input.limit.windowMs) && input.limit.windowMs > 0 &&
        input.bytes <= input.limit.maxBytes;
}

/**
 * Atomically reserves one fixed-window bucket in Mongo. The decision marker is included in the
 * returned post-image so concurrent callers never need a read-then-write decision race.
 */
async function ReserveWindow(
    collection: Collection<GuardTrafficWindowDocument>,
    input: ReservationInput,
    now: number,
    decisionId: string,
    session: ClientSession
): Promise<boolean> {
    if (!ValidateReservation(input)) return false;
    const windowStart = WindowStart(now, input.limit.windowMs);
    const id = WindowId(input.scope, input.key, windowStart);
    const result = await collection.findOneAndUpdate(
        { _id: id },
        [
            {
                $set: {
                    scope: input.scope,
                    windowStart,
                    expiresAt: new Date(windowStart + (input.limit.windowMs * 2)),
                    requests: { $ifNull: ["$requests", 0] },
                    bytes: { $ifNull: ["$bytes", 0] }
                }
            },
            {
                $set: {
                    lastDecisionId: decisionId,
                    lastDecisionAccepted: {
                        $and: [
                            { $lt: ["$requests", input.limit.maxRequests] },
                            { $lte: [{ $add: ["$bytes", input.bytes] }, input.limit.maxBytes] }
                        ]
                    }
                }
            },
            {
                $set: {
                    requests: {
                        $cond: ["$lastDecisionAccepted", { $add: ["$requests", 1] }, "$requests"]
                    },
                    bytes: {
                        $cond: ["$lastDecisionAccepted", { $add: ["$bytes", input.bytes] }, "$bytes"]
                    }
                }
            }
        ],
        { upsert: true, returnDocument: "after", session }
    );
    return result?.lastDecisionId === decisionId && result.lastDecisionAccepted === true;
}

/**
 * Mongo-backed host+session reservation. Both dimensions are committed in one transaction, so a
 * session rejection cannot consume host capacity. Any database/transaction failure is propagated
 * to the caller, which must return a bounded 503 rather than silently falling back to local state.
 */
export async function ConsumeDistributedGuardTrafficPair(
    hostKey: string,
    sessionKey: string,
    bytes: number,
    hostLimit: GuardTrafficLimit,
    sessionLimit: GuardTrafficLimit,
    now = Date.now()
): Promise<boolean> {
    const [db, client] = await Promise.all([GetMongoDb(), GetMongoClient()]);
    const session = client.startSession();
    const decisionId = crypto.randomUUID();
    let accepted = false;
    try {
        await session.withTransaction(async () => {
            const collection = db.collection<GuardTrafficWindowDocument>(P2PCollections.GuardTrafficWindows);
            const hostAccepted = await ReserveWindow(collection,
                { scope: "host", key: hostKey, bytes, limit: hostLimit }, now, decisionId, session);
            const sessionAccepted = hostAccepted && await ReserveWindow(collection,
                { scope: "session", key: sessionKey, bytes, limit: sessionLimit }, now, decisionId, session);
            if (!hostAccepted || !sessionAccepted) throw new ReservationRejected();
            accepted = true;
        }, {
            readPreference: "primary",
            readConcern: { level: "majority" },
            writeConcern: { w: "majority" },
            maxCommitTimeMS: ReadMongoRuntimeConfig().transactionMaxCommitTimeMS
        });
        return accepted;
    } catch (error) {
        if (error instanceof ReservationRejected) return false;
        throw error;
    } finally {
        await session.endSession();
    }
}

export function IsDistributedGuardTrafficEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    return environment.P2P_DISTRIBUTED_TRAFFIC_LIMITER?.trim().toLowerCase() === "true";
}

/** Exposed for unit tests and schema review without requiring a Mongo server. */
export const DistributedGuardTrafficInternals = { WindowStart, WindowId, ValidateReservation };