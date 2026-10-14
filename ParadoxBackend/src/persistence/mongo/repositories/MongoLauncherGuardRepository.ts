import { ClientSession } from "mongodb";
import {
    GUARD_FINDING_ACCOUNT_LIMIT,
    GUARD_HISTORY_LIMIT,
    GuardFindingSighting,
    GuardFindingSummary,
    LauncherGuardRepository,
    LauncherGuardRole,
    LauncherGuardSessionFilter,
    LauncherGuardSessionRecord
} from "../../contracts/LauncherGuardRepository";
import { Collections } from "../collections";
import { GetMongoDb } from "../client";
import { GUARD_FINDING_RETENTION_DAYS, GUARD_SESSION_RETENTION_DAYS, RetentionDateAfter } from "../../../legal/retentionPolicy";

// Sessions are read back with their _id turned into guardSessionId and the role normalised.
function ToSessionRecord(doc: any): LauncherGuardSessionRecord {
    return { ...doc, guardSessionId: String(doc._id), role: doc.role === "host" ? "host" : "client" } as unknown as LauncherGuardSessionRecord;
}

function EscapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class MongoLauncherGuardRepository implements LauncherGuardRepository {
    async create(record: LauncherGuardSessionRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { guardSessionId, ...document } = record;
        // [2026-10-14] ttlAt: the TTL index deletes the session 90 days after its last update (retentionPolicy.ts).
        await db.collection(Collections.LauncherGuardSessions).insertOne({
            _id: guardSessionId as any,
            ...document,
            ttlAt: RetentionDateAfter(record.createdAt, GUARD_SESSION_RETENTION_DAYS)
        }, { session });
    }

    async find(guardSessionId: string, session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(Collections.LauncherGuardSessions).findOne({ _id: guardSessionId as any }, { session });
        return doc == undefined ? undefined : ToSessionRecord(doc);
    }

    async findHealthyForAccount(accountId: string, guardSessionId: string, role: LauncherGuardRole, now: string, session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(Collections.LauncherGuardSessions).findOne({
            _id: guardSessionId as any,
            accountId,
            // Records written before role binding shipped are client sessions. Keep that
            // migration path explicit while host sessions always require an exact role field.
            ...(role === "client" ? { $or: [{ role: "client" }, { role: { $exists: false } }] } : { role }),
            status: "HEALTHY",
            expiresAt: { $gt: now },
            lastHeartbeatAt: { $gt: new Date(Date.parse(now) - 45_000).toISOString() }
        }, { session });
        return doc == undefined ? undefined : ToSessionRecord(doc);
    }

    async advance(input: Parameters<LauncherGuardRepository["advance"]>[0], session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(Collections.LauncherGuardSessions).findOneAndUpdate(
            {
                _id: input.guardSessionId as any,
                accountId: input.accountId,
                challenge: input.expectedChallenge,
                lastSequence: { $lt: input.sequence },
                status: { $in: ["CHALLENGED", "HEALTHY", "DEGRADED"] },
                expiresAt: { $gt: input.heartbeatAt }
            },
            {
                $set: {
                    challenge: input.nextChallenge,
                    lastSequence: input.sequence,
                    status: input.status,
                    riskScore: input.riskScore,
                    lastHeartbeatAt: input.heartbeatAt,
                    expiresAt: input.expiresAt,
                    lastSignals: input.signals,
                    reasons: input.reasons,
                    ttlAt: RetentionDateAfter(input.heartbeatAt, GUARD_SESSION_RETENTION_DAYS)
                },
                // [2026-10-14] The last GUARD_HISTORY_LIMIT heartbeats, newest first (the driver's push typing does not know $each).
                $push: { history: { $each: [input.historyEntry], $position: 0, $slice: GUARD_HISTORY_LIMIT } } as any
            },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ToSessionRecord(doc);
    }

    async revokeForAccount(accountId: string, role: LauncherGuardRole, revokedAt: string, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        await db.collection(Collections.LauncherGuardSessions).updateMany(
            {
                accountId,
                ...(role === "client" ? { $or: [{ role: "client" }, { role: { $exists: false } }] } : { role }),
                status: { $in: ["CHALLENGED", "HEALTHY", "DEGRADED"] }
            },
            { $set: { status: "REVOKED", expiresAt: revokedAt, ttlAt: RetentionDateAfter(revokedAt, GUARD_SESSION_RETENTION_DAYS) } },
            { session }
        );
    }

    async listSessions(filter: LauncherGuardSessionFilter, skip: number, limit: number): Promise<{ records: LauncherGuardSessionRecord[]; total: number }> {
        const db = await GetMongoDb();
        const Collection = db.collection(Collections.LauncherGuardSessions);
        const Query: Record<string, unknown> = {};
        if (filter.status !== undefined) Query.status = filter.status;
        if (filter.minRisk !== undefined) Query.riskScore = { $gte: filter.minRisk };
        const [docs, total] = await Promise.all([
            // The history is read per session, so the list leaves it out.
            Collection.find(Query).project({ history: 0 }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
            Collection.countDocuments(Query)
        ]);
        return { records: docs.map(ToSessionRecord), total };
    }

    async listFindings(filter: { signer?: string }, skip: number, limit: number): Promise<{ records: GuardFindingSummary[]; total: number }> {
        const db = await GetMongoDb();
        const Collection = db.collection(Collections.GuardFindings);
        const Query: Record<string, unknown> = filter.signer === undefined || filter.signer === ""
            ? {}
            : { signer: { $regex: EscapeRegex(filter.signer), $options: "i" } };
        const [docs, total] = await Promise.all([
            Collection.find(Query).project({ _id: 0, accountIds: 0, ttlAt: 0 })
                .sort({ sessionCount: -1, lastSeenAt: -1 }).skip(skip).limit(limit).toArray(),
            Collection.countDocuments(Query)
        ]);
        return { records: docs as unknown as GuardFindingSummary[], total };
    }

    /**
     * Three steps. The first creates or refreshes the finding (sessionCount rises for each new-in-session sighting). The second adds
     * the account when it is not yet listed and the list is below GUARD_FINDING_ACCOUNT_LIMIT: the positional test keeps the array
     * within the cap under concurrent heartbeats. accountCount rises only with an added account.
     */
    async recordFindingSighting(input: GuardFindingSighting): Promise<void> {
        const db = await GetMongoDb();
        const Collection = db.collection(Collections.GuardFindings);
        const Key = { fileName: input.fileName, sha256: input.sha256 };
        await Collection.updateOne(Key, {
            $setOnInsert: { firstSeenAt: input.seenAt, accountIds: [], accountCount: 0 },
            $set: {
                signer: input.signer,
                size: input.size,
                lastSeenAt: input.seenAt,
                ttlAt: RetentionDateAfter(input.seenAt, GUARD_FINDING_RETENTION_DAYS)
            },
            $inc: { sessionCount: input.newInSession ? 1 : 0 }
        }, { upsert: true });
        const CapPosition = `accountIds.${GUARD_FINDING_ACCOUNT_LIMIT - 1}`;
        await Collection.updateOne({
            ...Key,
            accountIds: { $ne: input.accountId },
            [CapPosition]: { $exists: false }
        }, {
            $push: { accountIds: input.accountId } as any,
            $inc: { accountCount: 1 }
        });
    }
}
