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

import { logger } from "../logger";
import { GetRamsgateConnectionDetails, GetTrainingDojoConnectionDetails, StartupGameserverWithArgs, StartupGameserverWithHuntIdAndPlayers, TryReuseSharedHuntServer } from "./gameservers";

export async function HandleMatchmakingRequest(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined){
    logger.info(`Handling matchmaking with GameMode: ${GameMode} HuntId: ${HuntId} and GameArgs: ${GameArgs}`);

    if(GameMode === "CITY"){
        return GetRamsgateConnectionDetails();
    }
    else if(GameMode === "SHARED"){
        if (HuntId != undefined && HuntId.trim().length > 0){
            if(HuntId == "ShatteredIsles_TrainingDojo"){
                return GetTrainingDojoConnectionDetails();
            }

            
            
            
            
            
            if(ExpectedPlayers != undefined && ExpectedPlayers.length > 0){
                try {
                    
                    
                    
                    const Reused = TryReuseSharedHuntServer(HuntId, ExpectedPlayers);
                    if(Reused != undefined){
                        return Reused;
                    }
                    return await StartupGameserverWithHuntIdAndPlayers(HuntId, ExpectedPlayers);
                }
                catch(Err: any){
                    logger.error(`SHARED hunt '${HuntId}' failed to resolve/start: ${Err?.message ?? Err}`);
                    throw Err;
                }
            }

            logger.error(`SHARED hunt '${HuntId}' had no ExpectedPlayers; cannot start a hunt server`);
            throw new Error(`SHARED hunt '${HuntId}' had no ExpectedPlayers`);
        }
    }
    else if(GameMode === "ISLAND"){
        try {
            if(GameArgs != undefined && GameArgs.trim().length > 0){
                return await StartupGameserverWithArgs(GameArgs, HuntId, ExpectedPlayers);
            }

            if(HuntId != undefined && HuntId.trim().length > 0 && ExpectedPlayers != undefined){
                return await StartupGameserverWithHuntIdAndPlayers(HuntId, ExpectedPlayers!);
            }
        } catch(Err: any) {
            
            
            logger.error(`ISLAND hunt (huntId='${HuntId}') could not start: ${Err?.message ?? Err}`);
            throw Err;
        }
    }

    logger.error(`Matchmaking failed: unsupported request GameMode='${GameMode}' HuntId='${HuntId}'`);
    throw new Error(`Unsupported matchmaking request GameMode='${GameMode}' HuntId='${HuntId}'`);
}
