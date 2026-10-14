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

import crypto from "node:crypto";
import { ApiKeyRepository } from "../../contracts/ApiKeyRepository";
import {
    GameServerApiKeyRecord,
    GameServerApiKeyToRegisterRecord,
    UserApiKeyRecord,
    UserApiKeyToRegisterRecord
} from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { Placeholders } from "../docTable";
import { Tables } from "../tables";

// Like MongoApiKeyRepository: only hashes are ever stored, the lookup stays a full scan with a constant-time
// comparison in the caller, and there is no plaintext registration queue (the findAll...ToRegister methods return
// nothing and the clear methods do nothing). The gameserver keyHash index is non-unique, as in MongoDB.
export class SqliteApiKeyRepository implements ApiKeyRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findAllGameServerKeyHashes(): Promise<GameServerApiKeyRecord[]> {
        return this.db.read(undefined, (c) =>
            Tables.gameServerApiKeys.find(c, "").map((Doc, Index) => ({ id: Index, keyHash: Doc.keyHash ?? null })));
    }

    async insertGameServerKeyHash(keyHash: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.gameServerApiKeys.insert(c, crypto.randomUUID(), { keyHash });
        });
    }

    /** Makes `keyHashes` the complete gameserver key set: upserts them, deletes the rest. */
    async replaceGameServerKeyHashes(keyHashes: string[]): Promise<void> {
        await this.db.write(undefined, (c) => {
            if (keyHashes.length === 0) {
                Tables.gameServerApiKeys.delete(c, "");
                return;
            }
            for (const keyHash of keyHashes) {
                if (Tables.gameServerApiKeys.findOneRow(c, "keyHash = ?", [keyHash]) === undefined) {
                    Tables.gameServerApiKeys.insert(c, crypto.randomUUID(), { keyHash });
                }
            }
            // `$nin` also removes rows with no keyHash at all.
            Tables.gameServerApiKeys.delete(c, `keyHash IS NULL OR keyHash NOT IN (${Placeholders(keyHashes.length)})`, keyHashes);
        });
    }

    async findAllGameServerKeysToRegister(): Promise<GameServerApiKeyToRegisterRecord[]> {
        return [];
    }

    async clearGameServerKeysToRegister(): Promise<void> {
        // Nothing to clear: there is no plaintext queue on this provider.
    }

    async findAllUserKeyHashes(): Promise<UserApiKeyRecord[]> {
        return this.db.read(undefined, (c) =>
            Tables.userApiKeys.find(c, "").map((Doc) => ({ userId: Doc.userId, keyHash: Doc.keyHash })));
    }

    async insertUserKeyHash(userId: string, keyHash: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.userApiKeys.insert(c, userId, { userId, keyHash });
        });
    }

    async findAllUserKeysToRegister(): Promise<UserApiKeyToRegisterRecord[]> {
        return [];
    }

    async clearUserKeysToRegister(): Promise<void> {
        // Nothing to clear: there is no plaintext queue on this provider.
    }
}
