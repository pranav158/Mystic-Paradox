/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { MongoServerError } from "mongodb";
import { EscalationProgressRepository } from "../../contracts/EscalationProgressRepository";
import { EscalationProgressRecord } from "../../mapping/domainTypes";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";

export class MongoEscalationProgressRepository implements EscalationProgressRepository {
    private RecordId(userId: string, seasonId: string): string {
        return `${userId}::${seasonId}`;
    }

    private MapDocument(Doc: any): EscalationProgressRecord {
        return {
            userId: Doc.userId,
            seasonId: Doc.seasonId,
            escalationLevel: Doc.escalationLevel,
            nextLevelXp: Doc.nextLevelXp,
            talentsProgress: Doc.talentsProgress ?? [],
            unlockProgress: Doc.unlockProgress ?? [],
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async get(userId: string, seasonId: string): Promise<EscalationProgressRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.EscalationProgress)
            .findOne({ _id: this.RecordId(userId, seasonId) as any });

        return Doc == undefined ? undefined : this.MapDocument(Doc);
    }

    async saveIfVersion(
        record: EscalationProgressRecord,
        expectedVersion: number | undefined
    ): Promise<EscalationProgressRecord | undefined> {
        const Db = await GetMongoDb();
        const Id = this.RecordId(record.userId, record.seasonId);
        const Document = {
            _id: Id as any,
            userId: record.userId,
            seasonId: record.seasonId,
            escalationLevel: record.escalationLevel,
            nextLevelXp: record.nextLevelXp,
            talentsProgress: record.talentsProgress,
            unlockProgress: record.unlockProgress,
            updateVersion: record.updateVersion,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
        };

        if (expectedVersion === undefined) {
            try {
                await Db.collection(Collections.EscalationProgress).insertOne(Document);
                return record;
            }
            catch (Error) {
                if (Error instanceof MongoServerError && Error.code === 11000) {
                    return undefined;
                }
                throw Error;
            }
        }

        const Result = await Db.collection(Collections.EscalationProgress).findOneAndReplace(
            { _id: Id as any, updateVersion: expectedVersion },
            Document,
            { returnDocument: "after" }
        );

        return Result == undefined ? undefined : this.MapDocument(Result);
    }
}
