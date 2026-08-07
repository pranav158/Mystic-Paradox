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

export async function DrainAndRegisterAPIKeys(){
    const PendingKeys = await GetRepositories().apiKeys.findAllGameServerKeysToRegister();
    const ConfiguredKeys = ParseConfiguredGameserverAPIKeys(process.env.GAMESERVER_API_KEYS);
    const CandidateKeys = [...new Set([
        ...PendingKeys.map((Record) => Record.key),
        ...ConfiguredKeys
    ])];

    await GetRepositories().apiKeys.clearGameServerKeysToRegister();

    const ExistingHashes = new Set(
        (await GetRepositories().apiKeys.findAllGameServerKeyHashes())
            .map((Record) => Record.keyHash)
            .filter((Hash): Hash is string => typeof Hash === "string")
    );

    let Registered = 0;
    for(const APIKey of CandidateKeys){
        const Hash = HashGameserverAPIKey(APIKey);
        if(ExistingHashes.has(Hash)){
            continue;
        }
        await GetRepositories().apiKeys.insertGameServerKeyHash(Hash);
        ExistingHashes.add(Hash);
        Registered++;
    }

    logger.info(
        "Registered " + Registered + " new Gameserver API key(s); " +
        ConfiguredKeys.length + " configured through GAMESERVER_API_KEYS"
    );
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