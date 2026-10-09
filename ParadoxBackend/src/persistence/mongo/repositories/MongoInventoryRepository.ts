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
import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { InventoryRepository } from "../../contracts/InventoryRepository";
import { InventoryRecord } from "../../mapping/domainTypes";

// Maps to plan section 6.4's `inventories` collection. _id = characterId.
// instancedItems/stackedItems are stored as raw JSON STRINGS (not parsed BSON
// arrays) for this phase — matching the exact current SQLite wire contract.
// Converting to BSON arrays is deferred; it changes nothing observable today
// since every read/write already goes through JSON.stringify/JSON.parse in the
// controller, but doing that conversion is a separate, testable change (plan
// section 6.4's inventory hazards apply once we actually store structured
// arrays: multikey index behavior, BSON size limits, etc.).
export class MongoInventoryRepository implements InventoryRepository {
    async findByCharacterId(characterId: string, session?: ClientSession): Promise<InventoryRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Inventories).findOne({ _id: { $eq: characterId as any } }, { session });

        if (Doc == undefined) {
            return undefined;
        }

        return { characterId: Doc.characterId, userId: Doc.userId, instancedItems: Doc.instancedItems, stackedItems: Doc.stackedItems, revision: Doc.revision ?? 0 };
    }

    async create(record: InventoryRecord, session?: ClientSession): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Inventories).insertOne(
            {
                _id: record.characterId as any,
                characterId: record.characterId,
                userId: record.userId,
                instancedItems: record.instancedItems,
                stackedItems: record.stackedItems,
                revision: record.revision ?? 0,
                bootstrapVersion: record.bootstrapVersion
            },
            { session }
        );
    }

    async updateBothIfRevisionMatches(
        characterId: string,
        instancedItemsJson: string,
        stackedItemsJson: string,
        expectedRevision: number,
        session?: ClientSession
    ): Promise<InventoryRecord | undefined> {
        const Db = await GetMongoDb();
        // $exists:false covers rows created before `revision` existed (treated as revision 0,
        // matching findByCharacterId's `?? 0` default) — so old rows aren't permanently un-writable.
        const RevisionFilter = expectedRevision === 0
            ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
            : { revision: { $eq: expectedRevision } };

        const Result = await Db.collection(Collections.Inventories).findOneAndUpdate(
            { _id: { $eq: characterId as any }, ...RevisionFilter },
            { $set: { instancedItems: instancedItemsJson, stackedItems: stackedItemsJson, revision: expectedRevision + 1 } },
            { returnDocument: "after", session }
        );

        if (Result == undefined) {
            return undefined;
        }

        const Doc = Result as any;
        return { characterId: Doc.characterId, userId: Doc.userId, instancedItems: Doc.instancedItems, stackedItems: Doc.stackedItems, revision: Doc.revision };
    }
}
