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

import { kill } from "node:process";
import { logger } from "../logger";
import { Gameserver, Gameservers, CleanupServer, LogMissingHuntRequests } from "./gameservers";

/**
 * Watchdog: reclaims dead gameservers — frees ports for hunts, restarts the persistent Ramsgate/Dojo.
 * Abandoned/empty hunts are NOT reaped here by wall-clock (that would kill an active long hunt); the
 * gameserver DLL self-terminates when it has had no client connections for a grace period, and that
 * exit is what this watchdog (and the process exit handler) reclaims.
 */

function IsGameserverStillAlive(GameserverToCheck: Gameserver){
    try{
        kill(GameserverToCheck.processId, 0);

        return true;
    } catch(err) {
        return false;
    }
}

export async function RunWatchdog(){
    logger.info(`Running Gameserver Watchdog!`);

    // Iterate a SNAPSHOT: CleanupServer and the process exit handlers reassign the Gameservers array,
    // so iterating it live would skip entries.
    for(const Server of [...Gameservers]){
        if(!IsGameserverStillAlive(Server)){
            logger.warn(`Cleaning up dead gameserver on port ${Server.port}`);

            await CleanupServer(Server);
        }
    }

    // Keeps content-coverage gaps visible. A missing hunt row is silent otherwise: the client
    // retries, each attempt logs one error, and the underlying cause scrolls away.
    LogMissingHuntRequests();
}