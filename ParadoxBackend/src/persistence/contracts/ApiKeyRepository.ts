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

import {
    GameServerApiKeyRecord,
    GameServerApiKeyToRegisterRecord,
    UserApiKeyRecord,
    UserApiKeyToRegisterRecord
} from "../mapping/domainTypes";

// Repository contract for the four API-key tables: gameserverapikeys,
// gameserverapikeystoregister, userapikeys, userapikeystoregister.
//
// Covers every current call site in controllers/apikeys.ts (DrainAndRegisterAPIKeys,
// IsValidGameserverAPIKey) and controllers/auth.ts (DrainAndRegisterUserAPIKeys,
// GetUserIDForAPIKey).
//
// The current lookup is a full-table scan with a constant-time hash comparison
// per row (crypto.timingSafeEqual). Plan section 6.10 flags this as an eventual
// optimization target (direct lookup by hash) for the Mongo adapter — Phase M1/M2
// deliberately preserve the scan-based semantics exactly (same accepted
// credentials, same timing-safe comparison), matching plan section 6.10's
// requirement that "this optimization must retain the same accepted credentials."
export interface ApiKeyRepository {
    findAllGameServerKeyHashes(): Promise<GameServerApiKeyRecord[]>;
    insertGameServerKeyHash(keyHash: string): Promise<void>;
    // Makes `keyHashes` the complete gameserver key set (GAMESERVER_API_KEYS): upserts them, deletes the rest.
    replaceGameServerKeyHashes(keyHashes: string[]): Promise<void>;
    findAllGameServerKeysToRegister(): Promise<GameServerApiKeyToRegisterRecord[]>;
    clearGameServerKeysToRegister(): Promise<void>;

    findAllUserKeyHashes(): Promise<UserApiKeyRecord[]>;
    insertUserKeyHash(userId: string, keyHash: string): Promise<void>;
    findAllUserKeysToRegister(): Promise<UserApiKeyToRegisterRecord[]>;
    clearUserKeysToRegister(): Promise<void>;
}
