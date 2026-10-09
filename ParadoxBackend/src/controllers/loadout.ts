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
    ResolveActiveLoadoutIndex,
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

export async function GetLoadoutStateForUserIdAndCharacterId(UserId: string, CharacterId: string){
    // This is a no-op when inventory and loadout both exist. If either is missing, the helper
    // repairs both records atomically and derives slot IDs from inventory rather than constants.
    await EnsureStarterBootstrapRecords(UserId, CharacterId);
    const LoadoutDbRow = await GetRepositories().loadouts.findByCharacterIdAndUserId(CharacterId, UserId);
    if (LoadoutDbRow == undefined) throw new Error(`Bootstrap recovery did not create loadout for ${CharacterId}`);
    const StoredLoadouts = ParseLoadoutArray(LoadoutDbRow.loadouts, CharacterId);
    const VisibleTotalSlots = ResolveVisibleTotalLoadoutSlots(StoredLoadouts.length, LoadoutDbRow.unlockedTotalSlots);
    return {
        loadouts: StoredLoadouts.slice(0, VisibleTotalSlots),
        persistent: JSON.parse(LoadoutDbRow.persistent),
        activeIndex: ResolveActiveLoadoutIndex(LoadoutDbRow.activeIndex, VisibleTotalSlots)
    };
}

export async function GetAllLoadoutsForUserIdAndCharacterId(UserId: string, CharacterId: string){
    return (await GetLoadoutStateForUserIdAndCharacterId(UserId, CharacterId)).loadouts;
}

export async function GetPersistentLoadoutForUserIdAndCharacterId(UserId: string, CharacterId: string){
    return (await GetLoadoutStateForUserIdAndCharacterId(UserId, CharacterId)).persistent;
}

export async function GetActiveLoadoutIndexForUserIdAndCharacterId(UserId: string, CharacterId: string){
    return (await GetLoadoutStateForUserIdAndCharacterId(UserId, CharacterId)).activeIndex;
}

// The route derives DesiredTotalSlots from persisted LoadoutSlot_01..05 Slayer's Path nodes.
// The native `/unlock/N` argument is only a delta hint, not the entitlement itself. Stored excess
// contents from earlier interpretations remain dormant so reconciliation never destroys player data.
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

    // [hardening] Validate the write payload before any DB work: index must be supported and the
    // data must be a JSON object string of a sane size. Rejects malformed/oversized blobs that
    // would otherwise be persisted verbatim and corrupt later reads.
    const ValidationError = ValidateLoadoutWriteData(Index, Data);
    if (ValidationError != undefined) {
        logger.error(`Loadout write rejected for characterId ${CharacterId}: ${ValidationError}`);
        return false;
    }

    // [hardening] Optimistic-concurrency-guarded write with a small bounded retry: read the
    // row's current revision, attempt the write conditioned on that exact revision, and if a
    // concurrent writer landed first (e.g. two client requests for the same character racing
    // each other), re-read and retry rather than either silently overwriting the other write
    // (the previous unconditional behavior) or failing a request that would have succeeded on a
    // clean retry. A short jittered backoff between attempts spreads out retries under heavier
    // contention (verified against 10 fully-simultaneous writers for the same characterId+index —
    // an extreme case for real traffic, included specifically to size this budget correctly).
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

export async function SetActiveLoadoutIndexForUserIdAndCharacterId(UserId: string, CharacterId: string, ActiveIndex: number){
    if (!Number.isSafeInteger(ActiveIndex) || ActiveIndex < 0 || ActiveIndex >= MAX_TOTAL_LOADOUT_SLOTS) {
        return false;
    }

    await EnsureStarterBootstrapRecords(UserId, CharacterId);
    const MAX_ATTEMPTS = 10;
    for (let Attempt = 0; Attempt < MAX_ATTEMPTS; Attempt++) {
        if (Attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
        }

        const CurrentRow = await GetRepositories().loadouts.findByCharacterIdAndUserId(CharacterId, UserId);
        if (CurrentRow == undefined) {
            return false;
        }
        const StoredLoadouts = ParseLoadoutArray(CurrentRow.loadouts, CharacterId);
        const VisibleTotalSlots = ResolveVisibleTotalLoadoutSlots(StoredLoadouts.length, CurrentRow.unlockedTotalSlots);
        if (ActiveIndex >= VisibleTotalSlots) {
            return false;
        }

        const Applied = await GetRepositories().loadouts.updateActiveIndexIfRevisionMatches(
            CharacterId, UserId, ActiveIndex, CurrentRow.revision ?? 0
        );
        if (Applied) {
            return true;
        }
        logger.warn(`Active loadout revision conflict for characterId ${CharacterId} index ${ActiveIndex}, attempt ${Attempt + 1}/${MAX_ATTEMPTS} - retrying`);
    }

    logger.error(`Active loadout write for characterId ${CharacterId} index ${ActiveIndex} failed after ${MAX_ATTEMPTS} attempts`);
    return false;
}
