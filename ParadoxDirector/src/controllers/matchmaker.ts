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

            // [2026-07-13] Normal Hunting Grounds also arrive via GameMode=SHARED (e.g.
            // ShatteredIsles_IslandA -> Adventure_IslandA -> adventure_moss_triforce). Previously only the
            // Training Dojo was handled under SHARED, so every real hunt fell through to Ramsgate. Route any
            // other valid HuntId through the normal player-hunt resolver (which also picks the map + passes
            // no MonsterClass when the row's Behemoth is "None", and preserves the player HuntId per player).
            if(ExpectedPlayers != undefined && ExpectedPlayers.length > 0){
                try {
                    // [2026-07-19] Public Hunt Server Reuse (Part B, flag-gated): if a live public server is
                    // already running this player hunt id with room, send the player there instead of
                    // spawning a new one. No-op (undefined) unless ENABLE_PUBLIC_HUNT_REUSE=1.
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
            // A missing 1.12 row, capacity failure or failed readiness check must remain
            // visible to Metagame. Redirecting to Ramsgate makes the UI claim a hunt was found.
            logger.error(`ISLAND hunt (huntId='${HuntId}') could not start: ${Err?.message ?? Err}`);
            throw Err;
        }
    }

    logger.error(`Matchmaking failed: unsupported request GameMode='${GameMode}' HuntId='${HuntId}'`);
    throw new Error(`Unsupported matchmaking request GameMode='${GameMode}' HuntId='${HuntId}'`);
}
