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
import crypto from "crypto";
import { logger } from "../logger";

function HashGameserverAPIKey(GameserverAPIKeyToHash: string){
    return crypto.createHash("sha256").update(GameserverAPIKeyToHash, "utf8").digest("hex");
}

export function ParseConfiguredGameserverAPIKeys(Value: string | undefined): string[] {
    return [...new Set(
        (Value ?? "")
            .split(",")
            .map((Key) => Key.trim())
            .filter((Key) => Key.length > 0)
    )];
}

export async function SynchronizeConfiguredGameserverAPIKeys(
    Repository: Pick<ApiKeyRepository, "replaceGameServerKeyHashes" | "clearGameServerKeysToRegister">,
    Value: string
): Promise<number> {
    const ConfiguredKeys = ParseConfiguredGameserverAPIKeys(Value);
    const ConfiguredHashes = ConfiguredKeys.map(HashGameserverAPIKey);
    await Repository.replaceGameServerKeyHashes(ConfiguredHashes);
    await Repository.clearGameServerKeysToRegister();
    return ConfiguredHashes.length;
}
export async function DrainAndRegisterAPIKeys(){
    const Repositories = GetRepositories();
    const ConfiguredValue = process.env.GAMESERVER_API_KEYS;

    // When the environment variable exists, it is the authoritative key set.
    // This makes removing a compromised key from configuration revoke it on
    // the next backend restart instead of leaving its hash valid forever.
    if(ConfiguredValue !== undefined){
        const ConfiguredCount = await SynchronizeConfiguredGameserverAPIKeys(
            Repositories.apiKeys,
            ConfiguredValue
        );

        logger.info(
            "Synchronized " + ConfiguredCount +
            " Gameserver API key hash(es) from GAMESERVER_API_KEYS"
        );
        return;
    }

    // Legacy providers may still expose one-time plaintext keys to drain.
    const PendingKeys = await Repositories.apiKeys.findAllGameServerKeysToRegister();
    const ExistingHashes = new Set(
        (await Repositories.apiKeys.findAllGameServerKeyHashes())
            .map((Record) => Record.keyHash)
            .filter((Hash): Hash is string => typeof Hash === "string")
    );

    let Registered = 0;
    for(const Record of PendingKeys){
        const Hash = HashGameserverAPIKey(Record.key);
        if(ExistingHashes.has(Hash)){
            continue;
        }
        await Repositories.apiKeys.insertGameServerKeyHash(Hash);
        ExistingHashes.add(Hash);
        Registered++;
    }

    await Repositories.apiKeys.clearGameServerKeysToRegister();
    logger.info("Registered " + Registered + " new Gameserver API key(s) from the legacy provider");
}

export async function IsValidGameserverAPIKey(GameserverAPIKey: string){
    const AllAPIKeyHashes = await GetRepositories().apiKeys.findAllGameServerKeyHashes();

    const IncomingGameserverAPIKeyHashBuffer = Buffer.from(HashGameserverAPIKey(GameserverAPIKey), "hex");

    let Match: boolean = false;

    for(const CmpAPIKeyHash of AllAPIKeyHashes){
        const CmpAPIKeyHashBuffer = Buffer.from(CmpAPIKeyHash.keyHash!, "hex");

        if(CmpAPIKeyHashBuffer.length !== IncomingGameserverAPIKeyHashBuffer.length){
            continue;
        }

        if(crypto.timingSafeEqual(IncomingGameserverAPIKeyHashBuffer, CmpAPIKeyHashBuffer)){
            Match = true;
        }
    }

    return Match;
}