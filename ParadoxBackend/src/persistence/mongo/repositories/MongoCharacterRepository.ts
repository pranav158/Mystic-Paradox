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
import { CharacterRepository } from "../../contracts/CharacterRepository";
import { CharacterRecord } from "../../mapping/domainTypes";






function ToRecord(Doc: any): CharacterRecord {
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

export class MongoCharacterRepository implements CharacterRepository {
    async findManyByUserId(userId: string): Promise<CharacterRecord[]> {
        const Db = await GetMongoDb();
        const Docs = await Db.collection(Collections.Characters).find({ userId }).toArray();
        return Docs.map(ToRecord);
    }

    async findByCharacterIdAndUserId(characterId: string, userId: string, session?: ClientSession): Promise<CharacterRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Characters).findOne({ _id: characterId as any, userId }, { session });

        if (Doc == undefined) {
            return undefined;
        }

        return ToRecord(Doc);
    }

    async create(character: CharacterRecord, session?: ClientSession): Promise<CharacterRecord> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Characters).insertOne({
            _id: character.characterId as any,
            characterId: character.characterId,
            userId: character.userId,
            createdDate: character.createdDate,
            lastModifiedDate: character.lastModifiedDate,
            name: character.name,
            updateVersion: character.updateVersion,
            data: character.data
        }, { session });

        return character;
    }

    async updateDataConditional(characterId: string, userId: string, data: string, effectiveVersion: number): Promise<void> {
        const Db = await GetMongoDb();
        
        
        
        
        
        await Db.collection(Collections.Characters).updateOne(
            { _id: characterId as any, userId, updateVersion: { $lt: effectiveVersion } },
            { $set: { data, updateVersion: effectiveVersion } }
        );
    }
}
