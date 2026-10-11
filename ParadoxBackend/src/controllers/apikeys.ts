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
import { FindApiKeyRecord, HashApiKey } from "../security/apiKeyHash";

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

    // Count the stored hashes rather than reading the key list's size into the log line.
    let Registered = 0;
    for(const APIKey of APIKeysToRegister){
        await GetRepositories().apiKeys.insertGameServerKeyHash(HashGameserverAPIKey(APIKey.key));
        Registered++;
    }

    logger.info(`Registered ${Registered} new Gameserver API Key(s) on boot!`);
}

// Only HMAC records match (security/apiKeyHash.ts); a pre-HMAC SHA-256 record must be registered again.
export async function IsValidGameserverAPIKey(GameserverAPIKey: string){
    const AllAPIKeyHashes = await GetRepositories().apiKeys.findAllGameServerKeyHashes();
    return FindApiKeyRecord(AllAPIKeyHashes, HashGameserverAPIKey(GameserverAPIKey)) !== undefined;
}
