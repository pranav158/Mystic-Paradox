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

export async function DrainAndRegisterAPIKeys(){
    const APIKeysToRegister = await GetRepositories().apiKeys.findAllGameServerKeysToRegister();

    await GetRepositories().apiKeys.clearGameServerKeysToRegister();

    for(const APIKey of APIKeysToRegister){
        await GetRepositories().apiKeys.insertGameServerKeyHash(HashGameserverAPIKey(APIKey.key));
    }

    logger.info(`Registered ${APIKeysToRegister.length} new Gameserver API Key(s) on boot!`);
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