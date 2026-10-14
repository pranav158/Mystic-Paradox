/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { EconomyRollupKey, EconomyRollupRepository } from "../../contracts/EconomyRollupRepository";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";

// One upsert per key: $inc creates missing counters, $setOnInsert fixes the identity fields on creation, and the returned
// document is the one after this write (findOneAndUpdate is atomic per document).
export class MongoEconomyRollupRepository implements EconomyRollupRepository {
    async addToRollup(key: EconomyRollupKey, increments: Record<string, number>, ttlAt: Date): Promise<Record<string, any>> {
        const Db = await GetMongoDb();
        const Id = `${key.userId}:${key.day}:${key.currency}`;
        const Result = await Db.collection(Collections.EconomyDaily).findOneAndUpdate(
            { _id: { $eq: Id as any } },
            {
                $inc: increments as any,
                $set: { ttlAt },
                $setOnInsert: { userId: key.userId, day: key.day, currency: key.currency }
            },
            { upsert: true, returnDocument: "after" }
        );
        return (Result ?? {}) as Record<string, any>;
    }
}
