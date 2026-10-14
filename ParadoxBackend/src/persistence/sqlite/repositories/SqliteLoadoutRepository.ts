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
import { LoadoutRepository } from "../../contracts/LoadoutRepository";
import { LoadoutRecord } from "../../mapping/domainTypes";
import {
    DEFAULT_ACCOUNT_LOADOUT_SLOTS,
    MAX_TOTAL_LOADOUT_SLOTS,
    ResolveVisibleTotalLoadoutSlots
} from "../../../loadoutSlots";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { Tables } from "../tables";

/** A row without `revision` counts as revision 0, so old rows stay writable. */
function RevisionMatches(Row: Doc, expectedRevision: number): boolean {
    const Revision = Row.revision;
    return expectedRevision === 0 ? (Revision === 0 || Revision === undefined) : Revision === expectedRevision;
}

// _id = characterId. loadouts / persistent are raw JSON strings, as in the MongoDB repository. Every writer is
// revision-guarded: the row is read and re-written in one transaction, and the UPDATE is fenced on the text that was
// read, so a stale caller gets `false` and must re-read.
export class SqliteLoadoutRepository implements LoadoutRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByCharacterIdAndUserId(characterId: string, userId: string, session?: ClientSession): Promise<LoadoutRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.loadouts.findOne(c, "_id = ? AND userId = ?", [characterId, userId]);
            if (Doc === undefined) return undefined;
            return {
                characterId: Doc.characterId,
                userId: Doc.userId,
                loadouts: Doc.loadouts,
                persistent: Doc.persistent,
                activeIndex: Doc.activeIndex ?? 0,
                unlockedTotalSlots: Doc.unlockedTotalSlots,
                revision: Doc.revision ?? 0
            };
        });
    }

    async create(loadout: LoadoutRecord, session?: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            Tables.loadouts.insert(c, loadout.characterId, {
                characterId: loadout.characterId,
                userId: loadout.userId,
                loadouts: loadout.loadouts,
                persistent: loadout.persistent,
                activeIndex: loadout.activeIndex ?? 0,
                unlockedTotalSlots: loadout.unlockedTotalSlots ?? DEFAULT_ACCOUNT_LOADOUT_SLOTS,
                revision: loadout.revision ?? 0,
                bootstrapVersion: loadout.bootstrapVersion
            });
        });
    }

    async replaceSlotIfRevisionMatches(characterId: string, userId: string, slotIndex: number, dataJson: string, expectedRevision: number): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.loadouts.findOneRow(c, "_id = ? AND userId = ?", [characterId, userId]);
            if (Row === undefined) return false;

            let LoadoutsArray: any[];
            try {
                LoadoutsArray = JSON.parse(Row.doc.loadouts);
            } catch {
                return false;
            }
            if (!Array.isArray(LoadoutsArray) || !Number.isSafeInteger(slotIndex) || slotIndex < 0) return false;

            let VisibleTotalSlots: number;
            try {
                VisibleTotalSlots = ResolveVisibleTotalLoadoutSlots(LoadoutsArray.length, Row.doc.unlockedTotalSlots);
            } catch {
                return false;
            }
            if (slotIndex >= VisibleTotalSlots) return false;

            let NewSlot: any;
            try {
                NewSlot = JSON.parse(dataJson);
            } catch {
                return false;
            }
            LoadoutsArray[slotIndex] = NewSlot;

            if (!RevisionMatches(Row.doc, expectedRevision)) return false;
            Tables.loadouts.patch(c, Row, { loadouts: JSON.stringify(LoadoutsArray), revision: expectedRevision + 1 });
            return true;
        });
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

        return this.db.write(undefined, (c) => {
            const Row = Tables.loadouts.findOneRow(c, "_id = ? AND userId = ?", [characterId, userId]);
            if (Row === undefined || !RevisionMatches(Row.doc, expectedRevision)) return false;
            Tables.loadouts.patch(c, Row, {
                loadouts: JSON.stringify(LoadoutsArray),
                unlockedTotalSlots,
                revision: expectedRevision + 1
            });
            return true;
        });
    }

    async updatePersistentIfRevisionMatches(characterId: string, userId: string, persistentJson: string, expectedRevision: number): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.loadouts.findOneRow(c, "_id = ? AND userId = ?", [characterId, userId]);
            if (Row === undefined || !RevisionMatches(Row.doc, expectedRevision)) return false;
            Tables.loadouts.patch(c, Row, { persistent: persistentJson, revision: expectedRevision + 1 });
            return true;
        });
    }

    async updateActiveIndexIfRevisionMatches(characterId: string, userId: string, activeIndex: number, expectedRevision: number): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.loadouts.findOneRow(c, "_id = ? AND userId = ?", [characterId, userId]);
            if (Row === undefined || !Number.isSafeInteger(activeIndex) || activeIndex < 0) return false;

            let LoadoutsArray: any[];
            try {
                LoadoutsArray = JSON.parse(Row.doc.loadouts);
            } catch {
                return false;
            }
            if (!Array.isArray(LoadoutsArray)) return false;

            let VisibleTotalSlots: number;
            try {
                VisibleTotalSlots = ResolveVisibleTotalLoadoutSlots(LoadoutsArray.length, Row.doc.unlockedTotalSlots);
            } catch {
                return false;
            }
            if (activeIndex >= VisibleTotalSlots) return false;

            // Legacy rows implicitly select zero; an idempotent re-apply does not churn the revision.
            if ((Row.doc.activeIndex ?? 0) === activeIndex) return true;

            if (!RevisionMatches(Row.doc, expectedRevision)) return false;
            Tables.loadouts.patch(c, Row, { activeIndex, revision: expectedRevision + 1 });
            return true;
        });
    }
}
