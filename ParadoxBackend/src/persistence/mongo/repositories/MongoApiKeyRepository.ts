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

// Maps to plan section 6.10's `gameServerApiKeys`/`userApiKeys` collections.
//
// The plaintext registration-queue tables (gameserverapikeystoregister,
// userapikeystoregister) are NOT migrated to Mongo collections — per plan
// section 6.10 ("Never create long-lived Mongo collections containing
// plaintext keys") and section 11.3 ("plaintext key queues: drain/hash before
// import or abort"). Any pending SQLite registration-queue rows must be drained
// (via the existing DrainAndRegisterAPIKeys/DrainAndRegisterUserAPIKeys flow,
// still running against SQLite) BEFORE cutover to DB_PROVIDER=mongodb, since
// this repository's findAll*KeysToRegister methods always return empty — there
// is no Mongo-side plaintext queue to drain from. This is documented, not
// silently handled, per the plan's "no secrets in logs or source" rule (queues
// simply do not exist on this provider).
//
// findAll*KeyHashes preserves the exact full-table-scan + timingSafeEqual
// comparison semantics from the SQLite adapter (plan section 6.10's explicit
// requirement) — no server-side hash-equality query is used.
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
        if (keyHashes.length === 0) {
            await Collection.deleteMany({});
            return;
        }
        await Collection.bulkWrite(keyHashes.map((keyHash) => ({
            updateOne: {
                filter: { keyHash: { $eq: keyHash } },
                update: { $set: { keyHash } },
                upsert: true
            }
        })));
        await Collection.deleteMany({ keyHash: { $nin: keyHashes } });
    }

    async findAllGameServerKeysToRegister(): Promise<GameServerApiKeyToRegisterRecord[]> {
        // No Mongo-side plaintext queue exists on this provider — see class note.
        return [];
    }

    async clearGameServerKeysToRegister(): Promise<void> {
        // No-op: nothing to clear on this provider — see class note.
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
        // No Mongo-side plaintext queue exists on this provider — see class note.
        return [];
    }

    async clearUserKeysToRegister(): Promise<void> {
        // No-op: nothing to clear on this provider — see class note.
    }
}
