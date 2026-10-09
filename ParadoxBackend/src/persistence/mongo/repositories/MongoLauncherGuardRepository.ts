import { ClientSession } from "mongodb";
import { LauncherGuardRepository, LauncherGuardRole, LauncherGuardSessionRecord } from "../../contracts/LauncherGuardRepository";
import { Collections } from "../collections";
import { GetMongoDb } from "../client";

export class MongoLauncherGuardRepository implements LauncherGuardRepository {
    async create(record: LauncherGuardSessionRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { guardSessionId, ...document } = record;
        await db.collection(Collections.LauncherGuardSessions).insertOne({ _id: guardSessionId as any, ...document }, { session });
    }

    async find(guardSessionId: string, session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(Collections.LauncherGuardSessions).findOne({ _id: guardSessionId as any }, { session });
        return doc == undefined ? undefined : ({ ...doc, guardSessionId: String(doc._id), role: doc.role === "host" ? "host" : "client" } as unknown as LauncherGuardSessionRecord);
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
        return doc == undefined ? undefined : ({ ...doc, guardSessionId: String(doc._id), role: doc.role === "host" ? "host" : "client" } as unknown as LauncherGuardSessionRecord);
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
            { $set: {
                challenge: input.nextChallenge,
                lastSequence: input.sequence,
                status: input.status,
                riskScore: input.riskScore,
                lastHeartbeatAt: input.heartbeatAt,
                expiresAt: input.expiresAt,
                lastSignals: input.signals
            } },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, guardSessionId: String(doc._id), role: doc.role === "host" ? "host" : "client" } as unknown as LauncherGuardSessionRecord);
    }

    async revokeForAccount(accountId: string, role: LauncherGuardRole, revokedAt: string, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        await db.collection(Collections.LauncherGuardSessions).updateMany(
            {
                accountId,
                ...(role === "client" ? { $or: [{ role: "client" }, { role: { $exists: false } }] } : { role }),
                status: { $in: ["CHALLENGED", "HEALTHY", "DEGRADED"] }
            },
            { $set: { status: "REVOKED", expiresAt: revokedAt } },
            { session }
        );
    }
}
