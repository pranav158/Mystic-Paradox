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

import { MongoServerError, Db } from "mongodb";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { PlayerJourneyRepository } from "../../contracts/PlayerJourneyRepository";
import { PlayerJourneyRecord } from "../../mapping/domainTypes";

// Maps to plan section 6.7's `playerJourney` collection. _id = userId. `nodes`
// stored as a raw JSON STRING — the plan's "stores the existing full node map
// unchanged" instruction applies literally here; validation/replacement of the
// client-authoritative full-map write is separate progression work per the
// plan's own text in section 6.7.
export class MongoPlayerJourneyRepository implements PlayerJourneyRepository {
    constructor(private readonly getDb: () => Promise<Db> = GetMongoDb) {}

    async findByUserId(userId: string): Promise<PlayerJourneyRecord | undefined> {
        const Db = await this.getDb();
        const Doc = await Db.collection(Collections.PlayerJourney).findOne({ _id: userId as any });

        if (Doc == undefined) {
            return undefined;
        }

        return { userId: Doc.userId, nodes: Doc.nodes, updateVersion: Doc.updateVersion, revision: Doc.revision ?? 0 };
    }

    async createIfAbsent(record: PlayerJourneyRecord): Promise<boolean> {
        try {
            const Db = await this.getDb();
            await Db.collection(Collections.PlayerJourney).insertOne({
                _id: record.userId as any,
                userId: record.userId,
                nodes: record.nodes,
                updateVersion: record.updateVersion,
                revision: record.revision
            });
            return true;
        } catch (Error) {
            if (Error instanceof MongoServerError && Error.code === 11000) return false;
            throw Error;
        }
    }

    async updateIfRevision(userId: string, nodesJson: string, updateVersion: number, expectedRevision: number): Promise<boolean> {
        const Db = await this.getDb();
        const Filter = expectedRevision === 0
            ? { _id: userId as any, $or: [{ revision: 0 }, { revision: { $exists: false } }] }
            : { _id: userId as any, revision: expectedRevision };
        const Result = await Db.collection(Collections.PlayerJourney).updateOne(
            Filter,
            { $set: { nodes: nodesJson, updateVersion }, $inc: { revision: 1 } }
        );
        return Result.matchedCount === 1;
    }
}
