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
import { EnsureStarterBootstrapRecords } from "./starterManifest";
import { ValidateLoadoutWriteData } from "../validation";
import { logger } from "../logger";
import {
    DEFAULT_ACCOUNT_LOADOUT_SLOTS,
    MAX_TOTAL_LOADOUT_SLOTS,
    ResolveRequestedTotalLoadoutSlots,
    ResolveVisibleTotalLoadoutSlots
} from "../loadoutSlots";

function ParseLoadoutArray(Raw: string, CharacterId: string): any[] {
    let Parsed: any;
    try {
        Parsed = JSON.parse(Raw);
    } catch {
        throw new Error(`Persisted loadout JSON is invalid for character ${CharacterId}`);
    }
    if (!Array.isArray(Parsed) || Parsed.length < DEFAULT_ACCOUNT_LOADOUT_SLOTS || Parsed.length > MAX_TOTAL_LOADOUT_SLOTS) {
        throw new Error(`Persisted loadout count ${Array.isArray(Parsed) ? Parsed.length : "non-array"} is invalid for character ${CharacterId}`);
    }
    return Parsed;
}

function CloneLoadoutForSlot(Source: any, SlotIndex: number): any {
    const Clone = JSON.parse(JSON.stringify(Source));
    Clone.slot_index = SlotIndex;
    Clone.update_version = 0;
    Clone.custom_name = "";
    return Clone;
}

export async function GetAllLoadoutsForUserIdAndCharacterId(UserId: string, CharacterId: string){
    
    
    await EnsureStarterBootstrapRecords(UserId, CharacterId);
    const LoadoutDbRow = await GetRepositories().loadouts.findByCharacterIdAndUserId(CharacterId, UserId);
    if (LoadoutDbRow == undefined) throw new Error(`Bootstrap recovery did not create loadout for ${CharacterId}`);
    const StoredLoadouts = ParseLoadoutArray(LoadoutDbRow.loadouts, CharacterId);
    const VisibleTotalSlots = ResolveVisibleTotalLoadoutSlots(StoredLoadouts.length, LoadoutDbRow.unlockedTotalSlots);
    return StoredLoadouts.slice(0, VisibleTotalSlots);
}

export async function GetPersistentLoadoutForUserIdAndCharacterId(UserId: string, CharacterId: string){
    await EnsureStarterBootstrapRecords(UserId, CharacterId);
    const LoadoutDbRow = await GetRepositories().loadouts.findByCharacterIdAndUserId(CharacterId, UserId);
    if (LoadoutDbRow == undefined) throw new Error(`Bootstrap recovery did not create persistent loadout for ${CharacterId}`);
    return JSON.parse(LoadoutDbRow.persistent);
}





export async function EnsureTotalLoadoutSlots(UserId: string, CharacterId: string, DesiredTotalSlots: number): Promise<any[]> {
    if (!Number.isSafeInteger(DesiredTotalSlots) || DesiredTotalSlots < 1 || DesiredTotalSlots > MAX_TOTAL_LOADOUT_SLOTS) {
        throw new RangeError(`Total loadout slot count must be between 1 and ${MAX_TOTAL_LOADOUT_SLOTS}`);
    }

    await EnsureStarterBootstrapRecords(UserId, CharacterId);
    const MAX_ATTEMPTS = 10;

    for (let Attempt = 0; Attempt < MAX_ATTEMPTS; Attempt++) {
        if (Attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));

        const CurrentRow = await GetRepositories().loadouts.findByCharacterIdAndUserId(CharacterId, UserId);
        if (CurrentRow == undefined) throw new Error(`Bootstrap recovery did not create loadout for ${CharacterId}`);
        const StoredLoadouts = ParseLoadoutArray(CurrentRow.loadouts, CharacterId);
        if (CurrentRow.unlockedTotalSlots != undefined) {
            ResolveVisibleTotalLoadoutSlots(StoredLoadouts.length, CurrentRow.unlockedTotalSlots);
        }
        const TargetVisibleTotalSlots = ResolveRequestedTotalLoadoutSlots(CurrentRow.unlockedTotalSlots, DesiredTotalSlots);

        const Extended = [...StoredLoadouts];
        while (Extended.length < TargetVisibleTotalSlots) {
            Extended.push(CloneLoadoutForSlot(StoredLoadouts[0], Extended.length));
        }

        const EntitlementAlreadyPersisted = CurrentRow.unlockedTotalSlots === TargetVisibleTotalSlots;
        if (Extended.length === StoredLoadouts.length && EntitlementAlreadyPersisted) {
            return Extended.slice(0, TargetVisibleTotalSlots);
        }

        const Applied = await GetRepositories().loadouts.replaceAllAndEntitlementIfRevisionMatches(
            CharacterId, UserId, JSON.stringify(Extended), TargetVisibleTotalSlots, CurrentRow.revision ?? 0
        );
        if (Applied) return Extended.slice(0, TargetVisibleTotalSlots);
        logger.warn(`Loadout unlock revision conflict for characterId ${CharacterId}, attempt ${Attempt + 1}/${MAX_ATTEMPTS} - retrying`);
    }

    throw new Error(`Loadout unlock for characterId ${CharacterId} failed after ${MAX_ATTEMPTS} revision-conflict retries`);
}

export async function SetLoadoutDataForUserIdAndCharacterId(UserId: string, CharacterId: string, Index: string, Data: string){
    logger.info(`Attempting to update loadout data Index ${Index}`);

    
    
    
    const ValidationError = ValidateLoadoutWriteData(Index, Data);
    if (ValidationError != undefined) {
        logger.error(`Loadout write rejected for characterId ${CharacterId}: ${ValidationError}`);
        return false;
    }

    
    
    
    
    
    
    
    
    const MAX_ATTEMPTS = 10;
    for (let Attempt = 0; Attempt < MAX_ATTEMPTS; Attempt++) {
        if (Attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
        }

        const CurrentRow = await GetRepositories().loadouts.findByCharacterIdAndUserId(CharacterId, UserId);
        const ExpectedRevision = CurrentRow?.revision ?? 0;

        const Applied = Index === "persistent"
            ? await GetRepositories().loadouts.updatePersistentIfRevisionMatches(CharacterId, UserId, Data, ExpectedRevision)
            : await GetRepositories().loadouts.replaceSlotIfRevisionMatches(CharacterId, UserId, Number(Index), Data, ExpectedRevision);

        if (Applied) {
            return true;
        }

        logger.warn(`Loadout revision conflict for characterId ${CharacterId} index ${Index}, attempt ${Attempt + 1}/${MAX_ATTEMPTS} - retrying`);
    }

    logger.error(`Loadout write for characterId ${CharacterId} index ${Index} failed after ${MAX_ATTEMPTS} revision-conflict retries`);
    return false;
}
