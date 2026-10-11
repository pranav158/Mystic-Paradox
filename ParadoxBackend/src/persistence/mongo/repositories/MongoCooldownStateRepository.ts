/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { MongoServerError } from "mongodb";
import { CooldownStateRepository } from "../../contracts/CooldownStateRepository";
import { CooldownStateRecord } from "../../mapping/domainTypes";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";

// One document per account, _id = userId. Cooldown ids are stored as array entries, not field names, so ids with dots
// or a leading '$' need no escaping.
export class MongoCooldownStateRepository implements CooldownStateRepository {
    private MapDocument(Doc: any): CooldownStateRecord {
        return {
            userId: Doc.userId,
            entries: Array.isArray(Doc.entries) ? Doc.entries : [],
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async get(userId: string): Promise<CooldownStateRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.CooldownStates).findOne({ _id: userId as any });
        return Doc == undefined ? undefined : this.MapDocument(Doc);
    }

    async saveIfVersion(record: CooldownStateRecord, expectedVersion: number | undefined): Promise<CooldownStateRecord | undefined> {
        const Db = await GetMongoDb();
        const Document = {
            _id: record.userId as any,
            userId: record.userId,
            entries: record.entries,
            updateVersion: record.updateVersion,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
        };

        if (expectedVersion === undefined) {
            try {
                await Db.collection(Collections.CooldownStates).insertOne(Document);
                return record;
            }
            catch (Error) {
                if (Error instanceof MongoServerError && Error.code === 11000) {
                    return undefined;
                }
                throw Error;
            }
        }

        const Result = await Db.collection(Collections.CooldownStates).findOneAndReplace(
            { _id: record.userId as any, updateVersion: expectedVersion },
            Document,
            { returnDocument: "after" }
        );

        return Result == undefined ? undefined : this.MapDocument(Result);
    }
}
