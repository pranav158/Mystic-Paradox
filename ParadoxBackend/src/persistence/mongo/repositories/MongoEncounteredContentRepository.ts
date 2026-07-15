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
import { EncounteredContentRepository } from "../../contracts/EncounteredContentRepository";
import { EncounteredContentRecord } from "../../mapping/domainTypes";






export class MongoEncounteredContentRepository implements EncounteredContentRepository {
    async findByCharacterIdAndUserId(characterId: string, userId: string): Promise<EncounteredContentRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.EncounteredContent).findOne({ _id: characterId as any, userId });

        if (Doc == undefined) {
            return undefined;
        }

        return { characterId: Doc.characterId, userId: Doc.userId, encounteredcontent: Doc.encounteredcontent };
    }

    async create(record: EncounteredContentRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.EncounteredContent).insertOne({
            _id: record.characterId as any,
            characterId: record.characterId,
            userId: record.userId,
            encounteredcontent: record.encounteredcontent
        });
    }

    async updateContent(characterId: string, userId: string, encounteredContentJson: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.EncounteredContent).updateOne(
            { _id: characterId as any, userId },
            { $set: { encounteredcontent: encounteredContentJson } }
        );
    }
}
