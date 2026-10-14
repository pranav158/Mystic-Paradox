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

import { BreadcrumbRepository } from "../../contracts/BreadcrumbRepository";
import { BreadcrumbsRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { Tables } from "../tables";

// _id = characterId.
export class SqliteBreadcrumbRepository implements BreadcrumbRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByCharacterIdAndUserId(characterId: string, userId: string): Promise<BreadcrumbsRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.breadcrumbs.findOne(c, "_id = ? AND userId = ?", [characterId, userId]);
            return Doc === undefined
                ? undefined
                : { characterId: Doc.characterId, userId: Doc.userId, breadcrumbs: Doc.breadcrumbs, updateVersion: Doc.updateVersion };
        });
    }

    async create(record: BreadcrumbsRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.breadcrumbs.insert(c, record.characterId, {
                characterId: record.characterId,
                userId: record.userId,
                breadcrumbs: record.breadcrumbs,
                updateVersion: record.updateVersion
            });
        });
    }

    async update(characterId: string, userId: string, breadcrumbsJson: string, updateVersion: number): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.breadcrumbs.findOneRow(c, "_id = ? AND userId = ?", [characterId, userId]);
            if (Row !== undefined) Tables.breadcrumbs.patch(c, Row, { breadcrumbs: breadcrumbsJson, updateVersion });
        });
    }
}
