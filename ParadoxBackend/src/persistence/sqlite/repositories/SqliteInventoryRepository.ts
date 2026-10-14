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
import { InventoryRepository } from "../../contracts/InventoryRepository";
import { InventoryRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { Tables } from "../tables";

function ToRecord(Doc: Doc): InventoryRecord {
    return {
        characterId: Doc.characterId,
        userId: Doc.userId,
        instancedItems: Doc.instancedItems,
        stackedItems: Doc.stackedItems,
        revision: Doc.revision ?? 0
    };
}

// _id = characterId. instancedItems / stackedItems are raw JSON strings, as in the MongoDB repository.
export class SqliteInventoryRepository implements InventoryRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByCharacterId(characterId: string, session?: ClientSession): Promise<InventoryRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.inventories.get(c, characterId);
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async create(record: InventoryRecord, session?: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            Tables.inventories.insert(c, record.characterId, {
                characterId: record.characterId,
                userId: record.userId,
                instancedItems: record.instancedItems,
                stackedItems: record.stackedItems,
                revision: record.revision ?? 0,
                bootstrapVersion: record.bootstrapVersion
            });
        });
    }

    /**
     * The only mutation path: applies only if the CURRENT revision equals `expectedRevision` (a row without a revision
     * counts as 0), and stores `expectedRevision + 1`. undefined = missing row or a concurrent write got there first.
     */
    async updateBothIfRevisionMatches(
        characterId: string,
        instancedItemsJson: string,
        stackedItemsJson: string,
        expectedRevision: number,
        session?: ClientSession
    ): Promise<InventoryRecord | undefined> {
        return this.db.write(session, (c) => {
            const Row = Tables.inventories.row(c, characterId);
            if (Row === undefined) return undefined;
            const Revision = Row.doc.revision;
            const Matches = expectedRevision === 0 ? (Revision === 0 || Revision === undefined) : Revision === expectedRevision;
            if (!Matches) return undefined;
            return ToRecord(Tables.inventories.patch(c, Row, {
                instancedItems: instancedItemsJson,
                stackedItems: stackedItemsJson,
                revision: expectedRevision + 1
            }));
        });
    }
}
