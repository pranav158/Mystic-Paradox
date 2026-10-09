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

import { GetRepositories } from "../persistence";
import { ApiKeyRepository } from "../persistence/contracts/ApiKeyRepository";
import { logger } from "../logger";
import {
    AcceptsLegacyApiKeyHashes,
    FindApiKeyRecord,
    HashApiKey,
    LegacySha256ApiKeyHash
} from "../security/apiKeyHash";

function HashGameserverAPIKey(GameserverAPIKeyToHash: string){
    return HashApiKey(GameserverAPIKeyToHash, "gameserver");
}

// GAMESERVER_API_KEYS: comma-separated raw keys the dedicated gameservers send (the Director's METAGAME_API_KEY).
export function ParseConfiguredGameserverAPIKeys(Value: string | undefined): string[] {
    return [...new Set(
        (Value ?? "")
            .split(",")
            .map((Key) => Key.trim())
            .filter((Key) => Key.length > 0)
    )];
}

// The configured list is the complete key set: every other stored hash is deleted (legacy SHA-256 records
// included), so removing a compromised key from the configuration revokes it at the next restart.
export async function SynchronizeConfiguredGameserverAPIKeys(
    Repository: Pick<ApiKeyRepository, "replaceGameServerKeyHashes" | "clearGameServerKeysToRegister">,
    Value: string
): Promise<number> {
    const ConfiguredHashes = ParseConfiguredGameserverAPIKeys(Value).map(HashGameserverAPIKey);
    await Repository.replaceGameServerKeyHashes(ConfiguredHashes);
    await Repository.clearGameServerKeysToRegister();
    return ConfiguredHashes.length;
}

export async function DrainAndRegisterAPIKeys(){
    // A non-empty GAMESERVER_API_KEYS is authoritative. Unset or empty keeps the keys already stored: a deployment
    // that registers keys another way, or shares its database with one, must not lose them to a blank template line.
    const ConfiguredValue = process.env.GAMESERVER_API_KEYS;
    if (ParseConfiguredGameserverAPIKeys(ConfiguredValue).length > 0) {
        const Count = await SynchronizeConfiguredGameserverAPIKeys(GetRepositories().apiKeys, ConfiguredValue ?? "");
        logger.info(`Synchronized ${Count} Gameserver API key hash(es) from GAMESERVER_API_KEYS`);
        return;
    }

    const APIKeysToRegister = await GetRepositories().apiKeys.findAllGameServerKeysToRegister();

    await GetRepositories().apiKeys.clearGameServerKeysToRegister();

    for(const APIKey of APIKeysToRegister){
        await GetRepositories().apiKeys.insertGameServerKeyHash(HashGameserverAPIKey(APIKey.key));
    }

    logger.info(`Registered ${APIKeysToRegister.length} new Gameserver API Key(s) on boot!`);
}

// HMAC hashes already written for keys that first matched a legacy SHA-256 record, so concurrent requests from
// the same hub do not each insert one.
const UpgradedGameserverKeyHashes = new Set<string>();

export async function IsValidGameserverAPIKey(GameserverAPIKey: string){
    const AllAPIKeyHashes = await GetRepositories().apiKeys.findAllGameServerKeyHashes();

    const HmacHash = HashGameserverAPIKey(GameserverAPIKey);
    if (FindApiKeyRecord(AllAPIKeyHashes, HmacHash)) {
        return true;
    }

    // Pre-HMAC record (plain SHA-256). Accepted during the migration; the HMAC form is stored alongside it so this
    // key matches by HMAC from now on. The legacy record is kept: another service on older code may still need it.
    if (!AcceptsLegacyApiKeyHashes() || !FindApiKeyRecord(AllAPIKeyHashes, LegacySha256ApiKeyHash(GameserverAPIKey))) {
        return false;
    }
    if (!UpgradedGameserverKeyHashes.has(HmacHash)) {
        UpgradedGameserverKeyHashes.add(HmacHash);
        try {
            await GetRepositories().apiKeys.insertGameServerKeyHash(HmacHash);
            logger.info("[API keys] A gameserver key matched a legacy SHA-256 record; stored its HMAC form.");
        } catch (error) {
            UpgradedGameserverKeyHashes.delete(HmacHash);
            logger.warn({ error }, "[API keys] Could not store the HMAC form of a legacy gameserver key");
        }
    }
    return true;
}
