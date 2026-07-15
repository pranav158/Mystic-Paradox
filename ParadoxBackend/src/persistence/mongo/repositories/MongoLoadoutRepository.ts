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
import { LoadoutRepository } from "../../contracts/LoadoutRepository";
import { LoadoutRecord } from "../../mapping/domainTypes";
import {
    DEFAULT_ACCOUNT_LOADOUT_SLOTS,
    MAX_TOTAL_LOADOUT_SLOTS,
    ResolveVisibleTotalLoadoutSlots
} from "../../../loadoutSlots";




export class MongoLoadoutRepository implements LoadoutRepository {
    async findByCharacterIdAndUserId(characterId: string, userId: string, session?: ClientSession): Promise<LoadoutRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Loadouts).findOne({ _id: characterId as any, userId }, { session });

        if (Doc == undefined) {
            return undefined;
        }

        return {
            characterId: Doc.characterId,
            userId: Doc.userId,
            loadouts: Doc.loadouts,
            persistent: Doc.persistent,
            unlockedTotalSlots: Doc.unlockedTotalSlots,
            revision: Doc.revision ?? 0
        };
    }

    async create(loadout: LoadoutRecord, session?: ClientSession): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Loadouts).insertOne({
            _id: loadout.characterId as any,
            characterId: loadout.characterId,
            userId: loadout.userId,
            loadouts: loadout.loadouts,
            persistent: loadout.persistent,
            unlockedTotalSlots: loadout.unlockedTotalSlots ?? DEFAULT_ACCOUNT_LOADOUT_SLOTS,
            revision: loadout.revision ?? 0,
            bootstrapVersion: loadout.bootstrapVersion
        }, { session });
    }

    async replaceSlotIfRevisionMatches(characterId: string, userId: string, slotIndex: number, dataJson: string, expectedRevision: number): Promise<boolean> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Loadouts).findOne({ _id: characterId as any, userId });

        if (Doc == undefined) {
            return false;
        }

        let LoadoutsArray: any[];
        try {
            LoadoutsArray = JSON.parse(Doc.loadouts);
        } catch {
            return false;
        }

        if (!Array.isArray(LoadoutsArray) || !Number.isSafeInteger(slotIndex) || slotIndex < 0) {
            return false;
        }

        let VisibleTotalSlots: number;
        try {
            VisibleTotalSlots = ResolveVisibleTotalLoadoutSlots(LoadoutsArray.length, Doc.unlockedTotalSlots);
        } catch {
            return false;
        }
        if (slotIndex >= VisibleTotalSlots) {
            return false;
        }

        let NewSlot: any;
        try {
            NewSlot = JSON.parse(dataJson);
        } catch {
            return false;
        }

        LoadoutsArray[slotIndex] = NewSlot;

        
        
        const RevisionFilter = expectedRevision === 0
            ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
            : { revision: expectedRevision };

        const Result = await Db.collection(Collections.Loadouts).updateOne(
            { _id: characterId as any, userId, ...RevisionFilter },
            { $set: { loadouts: JSON.stringify(LoadoutsArray), revision: expectedRevision + 1 } }
        );

        return Result.matchedCount > 0;
    }

    async replaceAllAndEntitlementIfRevisionMatches(characterId: string, userId: string, loadoutsJson: string, unlockedTotalSlots: number, expectedRevision: number): Promise<boolean> {
        let LoadoutsArray: any;
        try {
            LoadoutsArray = JSON.parse(loadoutsJson);
        } catch {
            return false;
        }
        if (!Array.isArray(LoadoutsArray)
            || LoadoutsArray.length < DEFAULT_ACCOUNT_LOADOUT_SLOTS
            || LoadoutsArray.length > MAX_TOTAL_LOADOUT_SLOTS
            || !Number.isSafeInteger(unlockedTotalSlots)
            || unlockedTotalSlots < DEFAULT_ACCOUNT_LOADOUT_SLOTS
            || unlockedTotalSlots > MAX_TOTAL_LOADOUT_SLOTS
            || unlockedTotalSlots > LoadoutsArray.length) {
            return false;
        }

        const Db = await GetMongoDb();
        const RevisionFilter = expectedRevision === 0
            ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
            : { revision: expectedRevision };
        const Result = await Db.collection(Collections.Loadouts).updateOne(
            { _id: characterId as any, userId, ...RevisionFilter },
            { $set: {
                loadouts: JSON.stringify(LoadoutsArray),
                unlockedTotalSlots,
                revision: expectedRevision + 1
            } }
        );
        return Result.matchedCount > 0;
    }

    async updatePersistentIfRevisionMatches(characterId: string, userId: string, persistentJson: string, expectedRevision: number): Promise<boolean> {
        const Db = await GetMongoDb();
        const RevisionFilter = expectedRevision === 0
            ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
            : { revision: expectedRevision };

        const Result = await Db.collection(Collections.Loadouts).updateOne(
            { _id: characterId as any, userId, ...RevisionFilter },
            { $set: { persistent: persistentJson, revision: expectedRevision + 1 } }
        );

        return Result.matchedCount > 0;
    }
}
