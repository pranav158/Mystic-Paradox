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

import { EncounteredContentRepository } from "../../contracts/EncounteredContentRepository";
import { EncounteredContentRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { Tables } from "../tables";

// _id = characterId. The field stays `encounteredcontent` (lowercase) like the MongoDB document.
export class SqliteEncounteredContentRepository implements EncounteredContentRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByCharacterIdAndUserId(characterId: string, userId: string): Promise<EncounteredContentRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.encounteredContent.findOne(c, "_id = ? AND userId = ?", [characterId, userId]);
            return Doc === undefined
                ? undefined
                : { characterId: Doc.characterId, userId: Doc.userId, encounteredcontent: Doc.encounteredcontent };
        });
    }

    async create(record: EncounteredContentRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.encounteredContent.insert(c, record.characterId, {
                characterId: record.characterId,
                userId: record.userId,
                encounteredcontent: record.encounteredcontent
            });
        });
    }

    async updateContent(characterId: string, userId: string, encounteredContentJson: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.encounteredContent.findOneRow(c, "_id = ? AND userId = ?", [characterId, userId]);
            if (Row !== undefined) Tables.encounteredContent.patch(c, Row, { encounteredcontent: encounteredContentJson });
        });
    }
}
