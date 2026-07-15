/*
 * Copyright (C) 2026 Mystic Paradox (pranav158/MysticParadox)
 * Licensed under the GNU Affero General Public License v3.0.
 */

import { AdminAuditRecord, AdminRepository, AdminSessionRecord, PlayerDeletionResult } from "../../contracts/AdminRepository";
import { GetMongoClient, GetMongoDb } from "../client";
import { Collections } from "../collections";

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

    async appendAudit(record: AdminAuditRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.AdminAudit).insertOne({ ...record, _id: record.id as any });
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
                const Characters = await Db.collection(Collections.Characters)
                    .find({ userId }, { session: Session })
                    .project({ _id: 1, characterId: 1 })
                    .toArray();
                const CharacterIds = Characters.map((Character) => String(Character.characterId ?? Character._id));
                CharacterCount = CharacterIds.length;

                const Remove = async (collection: string, filter: any): Promise<void> => {
                    const Result = await Db.collection(collection).deleteMany(filter, { session: Session });
                    DeletedCounts[collection] = Result.deletedCount;
                };
                const UserOwned = { $or: [{ userId }, { _id: userId as any }] };
                const CharacterOwned = {
                    $or: [
                        { userId },
                        { characterId: { $in: CharacterIds } },
                        { _id: { $in: CharacterIds } }
                    ]
                };

                
                
                await Remove(Collections.RefreshSessions, { userId });
                await Remove(Collections.GameExchangeCodes, { userId });
                await Remove(Collections.AdminSessions, { userId });
                await Remove(Collections.AuthIdentities, { userId });
                await Remove(Collections.DiscordOAuthTransactions, { userId });
                await Remove(Collections.UserApiKeys, UserOwned);
                await Remove(Collections.Friendships, { $or: [{ ownerId: userId }, { otherId: userId }] });

                await Remove(Collections.InventoryTransactions, CharacterOwned);
                await Remove(Collections.Inventories, CharacterOwned);
                await Remove(Collections.Loadouts, CharacterOwned);
                await Remove(Collections.Breadcrumbs, CharacterOwned);
                await Remove(Collections.EncounteredContent, CharacterOwned);
                await Remove(Collections.ProgressionTracks, { userId });
                await Remove(Collections.ProgressionObjectives, { userId });
                await Remove(Collections.ProgressionObjectiveEvents, { userId });
                await Remove(Collections.PlayerJourney, UserOwned);
                await Remove(Collections.Wallets, UserOwned);
                await Remove(Collections.Characters, { userId });

                const AccountResult = await Db.collection(Collections.Accounts)
                    .deleteOne({ _id: userId as any, displayNameNormalized: { $exists: true } }, { session: Session });
                if (AccountResult.deletedCount !== 1) {
                    throw new Error("Player account disappeared before deletion completed.");
                }
                DeletedCounts[Collections.Accounts] = AccountResult.deletedCount;

                
                
                
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
