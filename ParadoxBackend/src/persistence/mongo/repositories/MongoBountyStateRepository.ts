/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession, MongoServerError } from "mongodb";
import { BountyStateRepository } from "../../contracts/BountyStateRepository";
import { BountyStateRecord } from "../../mapping/domainTypes";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";

// One document per account, _id = userId.
export class MongoBountyStateRepository implements BountyStateRepository {
    private MapDocument(Doc: any): BountyStateRecord {
        return {
            userId: Doc.userId,
            bounties: Array.isArray(Doc.bounties) ? Doc.bounties : [],
            draftData: Doc.draftData ?? {},
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async get(userId: string, session?: ClientSession): Promise<BountyStateRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.BountyStates).findOne({ _id: userId as any }, { session });
        return Doc == undefined ? undefined : this.MapDocument(Doc);
    }

    async saveIfVersion(record: BountyStateRecord, expectedVersion: number | undefined, session?: ClientSession): Promise<BountyStateRecord | undefined> {
        const Db = await GetMongoDb();
        const Document = {
            _id: record.userId as any,
            userId: record.userId,
            bounties: record.bounties,
            draftData: record.draftData,
            updateVersion: record.updateVersion,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
        };

        if (expectedVersion === undefined) {
            try {
                await Db.collection(Collections.BountyStates).insertOne(Document, { session });
                return record;
            }
            catch (Error) {
                if (Error instanceof MongoServerError && Error.code === 11000) {
                    return undefined;
                }
                throw Error;
            }
        }

        const Result = await Db.collection(Collections.BountyStates).findOneAndReplace(
            { _id: record.userId as any, updateVersion: expectedVersion },
            Document,
            { returnDocument: "after", session }
        );

        return Result == undefined ? undefined : this.MapDocument(Result);
    }
}
