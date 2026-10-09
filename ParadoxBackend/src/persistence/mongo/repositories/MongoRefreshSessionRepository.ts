/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { RefreshSessionRepository, RefreshSessionRecord } from "../../contracts/RefreshSessionRepository";

function ToRecord(Doc: any): RefreshSessionRecord {
    return {
        id: Doc._id,
        tokenHash: Doc.tokenHash,
        userId: Doc.userId,
        familyId: Doc.familyId,
        deviceId: Doc.deviceId,
        deviceName: Doc.deviceName,
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt,
        revokedAt: Doc.revokedAt ?? undefined
    };
}

export class MongoRefreshSessionRepository implements RefreshSessionRepository {
    async create(session: RefreshSessionRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.RefreshSessions).insertOne({
            _id: session.id as any,
            tokenHash: session.tokenHash,
            userId: session.userId,
            familyId: session.familyId,
            deviceId: session.deviceId,
            deviceName: session.deviceName,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
            // Deliberately NOT setting revokedAt here at all when the session is fresh
            // (rather than `revokedAt: session.revokedAt`) — the driver stores an
            // explicit `undefined` value as BSON null, which then IS a field that
            // exists, breaking any `{ revokedAt: { $exists: false } }` query below.
            ...(session.revokedAt != undefined ? { revokedAt: session.revokedAt } : {}),
            // Storage-only field for the TTL index (indexes.ts) — expiresAt above stays an
            // ISO string like every other timestamp in this codebase; Mongo's TTL mechanism
            // needs an actual BSON Date, so this mirrors it purely for auto-cleanup.
            ttlAt: new Date(session.expiresAt)
        });
    }

    async findByTokenHash(tokenHash: string): Promise<RefreshSessionRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.RefreshSessions).findOne({ tokenHash });

        return Doc == undefined ? undefined : ToRecord(Doc);
    }

    async revokeById(id: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.RefreshSessions).updateOne({ _id: id as any }, { $set: { revokedAt: new Date().toISOString() } });
    }

    async revokeFamily(familyId: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.RefreshSessions).updateMany(
            // `revokedAt: null` matches BOTH a genuinely absent field and one explicitly
            // stored as null — robust regardless of how create() serialized it, unlike
            // `{ $exists: false }` alone (see the comment on create() above).
            { familyId, revokedAt: null },
            { $set: { revokedAt: new Date().toISOString() } }
        );
    }

    async revokeAllForUser(userId: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.RefreshSessions).updateMany(
            { userId, revokedAt: null },
            { $set: { revokedAt: new Date().toISOString() } }
        );
    }

    async isFamilyActive(familyId: string, userId: string): Promise<boolean> {
        const Db = await GetMongoDb();
        const Count = await Db.collection(Collections.RefreshSessions).countDocuments({
            familyId,
            userId,
            revokedAt: null,
            expiresAt: { $gt: new Date().toISOString() }
        }, { limit: 1 });
        return Count > 0;
    }
}
