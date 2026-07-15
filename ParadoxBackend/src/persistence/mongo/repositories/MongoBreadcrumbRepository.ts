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

import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { BreadcrumbRepository } from "../../contracts/BreadcrumbRepository";
import { BreadcrumbsRecord } from "../../mapping/domainTypes";


export class MongoBreadcrumbRepository implements BreadcrumbRepository {
    async findByCharacterIdAndUserId(characterId: string, userId: string): Promise<BreadcrumbsRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Breadcrumbs).findOne({ _id: characterId as any, userId });

        if (Doc == undefined) {
            return undefined;
        }

        return { characterId: Doc.characterId, userId: Doc.userId, breadcrumbs: Doc.breadcrumbs, updateVersion: Doc.updateVersion };
    }

    async create(record: BreadcrumbsRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Breadcrumbs).insertOne({
            _id: record.characterId as any,
            characterId: record.characterId,
            userId: record.userId,
            breadcrumbs: record.breadcrumbs,
            updateVersion: record.updateVersion
        });
    }

    async update(characterId: string, userId: string, breadcrumbsJson: string, updateVersion: number): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Breadcrumbs).updateOne(
            { _id: characterId as any, userId },
            { $set: { breadcrumbs: breadcrumbsJson, updateVersion } }
        );
    }
}
