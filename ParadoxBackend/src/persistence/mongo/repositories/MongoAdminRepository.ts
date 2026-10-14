/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession } from "mongodb";
import { AdminAuditRecord, AdminRepository, AdminSessionRecord, PlayerDeletionResult } from "../../contracts/AdminRepository";
import { GetMongoClient, GetMongoDb } from "../client";
import { Collections } from "../collections";
import { AccountDeletionSteps, ApplyAccountDeletionSteps, BuildAccountDeletionContext } from "../accountDeletionPlan";
import { PseudonymousAccountId } from "../../../security/apiKeyHash";

function ToSession(Doc: any): AdminSessionRecord {
    return {
        id: String(Doc._id),
        tokenHash: Doc.tokenHash,
        userId: Doc.userId,
        csrfToken: Doc.csrfToken,
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt,
        ip: Doc.ip,
        userAgent: Doc.userAgent,
        revokedAt: Doc.revokedAt ?? undefined
    };
}

function ToAudit(Doc: any): AdminAuditRecord {
    return {
        id: String(Doc._id),
        actorUserId: Doc.actorUserId,
        targetUserId: Doc.targetUserId ?? undefined,
        action: Doc.action,
        oldState: Doc.oldState,
        newState: Doc.newState,
        reason: Doc.reason ?? undefined,
        ip: Doc.ip,
        requestId: Doc.requestId,
        createdAt: Doc.createdAt
    };
}

export class MongoAdminRepository implements AdminRepository {
    async createSession(session: AdminSessionRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.AdminSessions).insertOne({
            ...session,
            _id: session.id as any,
            ttlAt: new Date(session.expiresAt)
        });
    }

    async findActiveSessionByTokenHash(tokenHash: string): Promise<AdminSessionRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.AdminSessions).findOne({
            tokenHash,
            revokedAt: null,
            expiresAt: { $gt: new Date().toISOString() }
        });
        return Doc == null ? undefined : ToSession(Doc);
    }

    async revokeSession(id: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.AdminSessions).updateOne(
            { _id: id as any },
            { $set: { revokedAt: new Date().toISOString() } }
        );
    }

    async appendAudit(record: AdminAuditRecord, session?: ClientSession): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.AdminAudit).insertOne({ ...record, _id: record.id as any }, { session });
    }

    async listAudit(targetUserId: string | undefined, skip: number, limit: number): Promise<{ records: AdminAuditRecord[]; total: number }> {
        const Db = await GetMongoDb();
        const Query = targetUserId ? { targetUserId } : {};
        const Collection = Db.collection(Collections.AdminAudit);
        const [Docs, Total] = await Promise.all([
            Collection.find(Query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
            Collection.countDocuments(Query)
        ]);
        return { records: Docs.map(ToAudit), total: Total };
    }

    async deletePlayerData(userId: string, audit: AdminAuditRecord): Promise<PlayerDeletionResult> {
        const Client = await GetMongoClient();
        const Session = Client.startSession();
        const DeletedCounts: Record<string, number> = {};
        let CharacterCount = 0;

        try {
            await Session.withTransaction(async () => {
                const Db = await GetMongoDb();
                const Context = await BuildAccountDeletionContext(Db, userId, new Date().toISOString(), PseudonymousAccountId(userId), Session);
                CharacterCount = Context.characterIds.length;

                // [2026-10-14] The shared plan (persistence/mongo/accountDeletionPlan.ts) covers every collection that keys the account,
                // including the P2P, realm and anti-cheat ones this delete used to miss. The admin delete does not wait for live activity
                // (guards are skipped, as before) and keeps its audit trail (AdminAudit is not touched). The transaction means none of
                // these removals become visible unless the full cascade commits.
                const Steps = AccountDeletionSteps().filter((step) => step.kind !== "guard" && step.collection !== Collections.AdminAudit);
                const Changed = await ApplyAccountDeletionSteps(Db, Session, Context, Steps);
                for (const [Collection, Count] of Object.entries(Changed)) DeletedCounts[Collection] = Count;

                const AccountResult = await Db.collection(Collections.Accounts)
                    .deleteOne({ _id: userId as any, displayNameNormalized: { $exists: true } }, { session: Session });
                if (AccountResult.deletedCount !== 1) {
                    throw new Error("Player account disappeared before deletion completed.");
                }
                DeletedCounts[Collections.Accounts] = AccountResult.deletedCount;

                // Retain one minimal operational tombstone. It contains opaque IDs
                // and state only—never the deleted email, username, password hash,
                // identity details, inventory, or progression.
                await Db.collection(Collections.AdminAudit).insertOne(
                    { ...audit, _id: audit.id as any },
                    { session: Session }
                );
            });
        } finally {
            await Session.endSession();
        }

        return { deletedCounts: DeletedCounts, characterCount: CharacterCount };
    }
}
