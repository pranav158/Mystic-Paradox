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

import { RefreshSessionRecord, RefreshSessionRepository } from "../../contracts/RefreshSessionRepository";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { IsNullOrMissing, Tables } from "../tables";

function ToRecord(Doc: Doc): RefreshSessionRecord {
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

// `ttlAt` is the storage-only expiry mirror (ISO text here, a BSON Date in MongoDB); SqliteDatabase.purgeExpired
// deletes rows once it is past. Business-logic expiry checks still compare `expiresAt`, never `ttlAt`.
export class SqliteRefreshSessionRepository implements RefreshSessionRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async create(session: RefreshSessionRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.refreshSessions.insert(c, session.id, {
                tokenHash: session.tokenHash,
                userId: session.userId,
                familyId: session.familyId,
                deviceId: session.deviceId,
                deviceName: session.deviceName,
                createdAt: session.createdAt,
                expiresAt: session.expiresAt,
                // Absent (not null) while the session is fresh, as in the MongoDB repository.
                ...(session.revokedAt != undefined ? { revokedAt: session.revokedAt } : {}),
                ttlAt: new Date(session.expiresAt)
            });
        });
    }

    async findByTokenHash(tokenHash: string): Promise<RefreshSessionRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.refreshSessions.findOne(c, "tokenHash = ?", [tokenHash]);
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async revokeById(id: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.refreshSessions.row(c, id);
            if (Row !== undefined) Tables.refreshSessions.patch(c, Row, { revokedAt: new Date().toISOString() });
        });
    }

    async revokeFamily(familyId: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Now = new Date().toISOString();
            for (const Row of Tables.refreshSessions.rows(c, `familyId = ? AND ${IsNullOrMissing("revokedAt")}`, [familyId])) {
                Tables.refreshSessions.patch(c, Row, { revokedAt: Now });
            }
        });
    }

    async revokeAllForUser(userId: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Now = new Date().toISOString();
            for (const Row of Tables.refreshSessions.rows(c, `userId = ? AND ${IsNullOrMissing("revokedAt")}`, [userId])) {
                Tables.refreshSessions.patch(c, Row, { revokedAt: Now });
            }
        });
    }

    // [2026-10-15] The registration sweep removes an unverified registration's rows (accounts that never got a session have none).
    async deleteAllForUser(userId: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.refreshSessions.delete(c, "userId = ?", [userId]);
        });
    }

    async isFamilyActive(familyId: string, userId: string): Promise<boolean> {
        return this.db.read(undefined, (c) => Tables.refreshSessions.count(
            c,
            `familyId = ? AND userId = ? AND ${IsNullOrMissing("revokedAt")} AND json_extract(doc, '$.expiresAt') > ?`,
            [familyId, userId, new Date().toISOString()]
        ) > 0);
    }
}
