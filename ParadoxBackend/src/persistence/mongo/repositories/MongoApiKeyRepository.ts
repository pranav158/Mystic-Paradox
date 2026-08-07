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
import { ApiKeyRepository } from "../../contracts/ApiKeyRepository";
import {
    GameServerApiKeyRecord,
    GameServerApiKeyToRegisterRecord,
    UserApiKeyRecord,
    UserApiKeyToRegisterRecord
} from "../../mapping/domainTypes";

export class MongoApiKeyRepository implements ApiKeyRepository {
    async findAllGameServerKeyHashes(): Promise<GameServerApiKeyRecord[]> {
        const Db = await GetMongoDb();
        const Docs = await Db.collection(Collections.GameServerApiKeys).find({}).toArray();
        return Docs.map((Doc, Index) => ({ id: Index, keyHash: Doc.keyHash ?? null }));
    }

    async insertGameServerKeyHash(keyHash: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.GameServerApiKeys).insertOne({ keyHash });
    }

    async replaceGameServerKeyHashes(keyHashes: string[]): Promise<void> {
        const Db = await GetMongoDb();
        const Collection = Db.collection(Collections.GameServerApiKeys);
        if(keyHashes.length === 0){
            await Collection.deleteMany({});
            return;
        }

        await Collection.bulkWrite(keyHashes.map((keyHash) => ({
            updateOne: {
                filter: { keyHash },
                update: { $set: { keyHash } },
                upsert: true
            }
        })));
        await Collection.deleteMany({ keyHash: { $nin: keyHashes } });
    }

    async findAllGameServerKeysToRegister(): Promise<GameServerApiKeyToRegisterRecord[]> {
        return [];
    }

    async clearGameServerKeysToRegister(): Promise<void> {
        // No-op: nothing to clear on this provider.
    }

    async findAllUserKeyHashes(): Promise<UserApiKeyRecord[]> {
        const Db = await GetMongoDb();
        const Docs = await Db.collection(Collections.UserApiKeys).find({}).toArray();
        return Docs.map((Doc) => ({ userId: Doc.userId, keyHash: Doc.keyHash }));
    }

    async insertUserKeyHash(userId: string, keyHash: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.UserApiKeys).insertOne({ _id: userId as any, userId, keyHash });
    }

    async findAllUserKeysToRegister(): Promise<UserApiKeyToRegisterRecord[]> {
        return [];
    }

    async clearUserKeysToRegister(): Promise<void> {
        // No-op: nothing to clear on this provider.
    }
}
