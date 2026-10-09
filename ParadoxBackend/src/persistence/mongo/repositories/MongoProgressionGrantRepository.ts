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

import { ClientSession, Db } from "mongodb";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { ProgressionGrantRepository } from "../../contracts/ProgressionGrantRepository";
import { ProgressionGrantRecord, ProgressionTrackRecord } from "../../mapping/domainTypes";

function MapTrack(Doc: any): ProgressionTrackRecord {
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

function MapDocument(Doc: any): ProgressionGrantRecord {
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

export class MongoProgressionGrantRepository implements ProgressionGrantRepository {
    constructor(private readonly getDb: () => Promise<Db> = GetMongoDb) {}

    async findByGrantId(grantId: string, session?: ClientSession): Promise<ProgressionGrantRecord | undefined> {
        const Db = await this.getDb();
        const Doc = await Db.collection(Collections.ProgressionTransactions).findOne({ _id: grantId as any }, { session });
        return Doc == undefined ? undefined : MapDocument(Doc);
    }

    async insertApplied(record: ProgressionGrantRecord, session: ClientSession): Promise<void> {
        const Db = await this.getDb();
        await Db.collection(Collections.ProgressionTransactions).insertOne({
            _id: record.grantId as any,
            grantId: record.grantId,
            userId: record.userId,
            progressionId: record.progressionId,
            amount: record.amount,
            requestHash: record.requestHash,
            status: record.status,
            result: record.result,
            createdAt: record.createdAt
        }, { session });
    }
}
