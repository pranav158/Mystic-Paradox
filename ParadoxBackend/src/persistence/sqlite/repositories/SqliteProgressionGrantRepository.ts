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

import { ClientSession } from "mongodb";
import { ProgressionGrantRepository } from "../../contracts/ProgressionGrantRepository";
import { ProgressionGrantRecord, ProgressionTrackRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { Tables } from "../tables";

// The stored result is the track as the game saw it right after the grant (no reforge/prestige fields), like MongoDB.
function MapTrack(Doc: Doc): ProgressionTrackRecord {
    return {
        userId: Doc.userId,
        progressionId: Doc.progressionId,
        progress: Doc.progress,
        confirmedFremiumRank: Doc.confirmedFremiumRank,
        confirmedPremiumRank: Doc.confirmedPremiumRank,
        updateVersion: Doc.updateVersion,
        createdAt: Doc.createdAt,
        updatedAt: Doc.updatedAt
    };
}

function MapDocument(Doc: Doc): ProgressionGrantRecord {
    return {
        grantId: Doc.grantId,
        userId: Doc.userId,
        progressionId: Doc.progressionId,
        amount: Doc.amount,
        requestHash: Doc.requestHash,
        status: Doc.status,
        result: MapTrack(Doc.result),
        createdAt: Doc.createdAt
    };
}

// The grant id is the document _id: a replay's insert fails with the E11000-equivalent error and the caller serves
// the stored result instead of granting twice.
export class SqliteProgressionGrantRepository implements ProgressionGrantRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByGrantId(grantId: string, session?: ClientSession): Promise<ProgressionGrantRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.progressionTransactions.get(c, grantId);
            return Doc === undefined ? undefined : MapDocument(Doc);
        });
    }

    async insertApplied(record: ProgressionGrantRecord, session: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            Tables.progressionTransactions.insert(c, record.grantId, {
                grantId: record.grantId,
                userId: record.userId,
                progressionId: record.progressionId,
                amount: record.amount,
                requestHash: record.requestHash,
                status: record.status,
                result: record.result,
                createdAt: record.createdAt
            });
        });
    }
    // [2026-10-14] The admin player timeline: the newest applied grants of one account.
    async listRecentForUser(userId: string, limit: number): Promise<ProgressionGrantRecord[]> {
        return this.db.read(undefined, (c) => Tables.progressionTransactions.find(c, "userId = ?", [userId],
            { orderBy: "createdAt DESC", limit }).map((Doc) => MapDocument(Doc)));
    }

}
