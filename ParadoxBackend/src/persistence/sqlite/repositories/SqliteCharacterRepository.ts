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
import { CharacterRepository } from "../../contracts/CharacterRepository";
import { CharacterRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { Tables } from "../tables";

// `data` is the raw JSON string exactly as persisted, like the MongoDB repository: controllers parse it themselves.
function ToRecord(Doc: Doc): CharacterRecord {
    return {
        characterId: Doc.characterId,
        userId: Doc.userId,
        createdDate: Doc.createdDate,
        lastModifiedDate: Doc.lastModifiedDate,
        name: Doc.name,
        updateVersion: Doc.updateVersion,
        data: Doc.data
    };
}

export class SqliteCharacterRepository implements CharacterRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findManyByUserId(userId: string, session?: ClientSession): Promise<CharacterRecord[]> {
        return this.db.read(session, (c) => Tables.characters.find(c, "userId = ?", [userId]).map(ToRecord));
    }

    async findByCharacterIdAndUserId(characterId: string, userId: string, session?: ClientSession): Promise<CharacterRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.characters.findOne(c, "_id = ? AND userId = ?", [characterId, userId]);
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async create(character: CharacterRecord, session?: ClientSession): Promise<CharacterRecord> {
        await this.db.write(session, (c) => {
            Tables.characters.insert(c, character.characterId, {
                characterId: character.characterId,
                userId: character.userId,
                createdDate: character.createdDate,
                lastModifiedDate: character.lastModifiedDate,
                name: character.name,
                updateVersion: character.updateVersion,
                data: character.data
            });
        });
        return character;
    }

    /** Writes only if the stored updateVersion is strictly below `effectiveVersion` (no matched-row report, as in MongoDB). */
    async updateDataConditional(characterId: string, userId: string, data: string, effectiveVersion: number): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.characters.findOneRow(c, "_id = ? AND userId = ?", [characterId, userId]);
            // MongoDB's $lt only compares numbers: a missing or null stored version never matches.
            if (Row === undefined || typeof Row.doc.updateVersion !== "number" || !(Row.doc.updateVersion < effectiveVersion)) return;
            Tables.characters.patch(c, Row, { data, updateVersion: effectiveVersion });
        });
    }
}
