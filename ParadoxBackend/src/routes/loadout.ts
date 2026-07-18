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

import { Router } from "express";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import {
    EnsureTotalLoadoutSlots,
    GetAllLoadoutsForUserIdAndCharacterId,
    GetPersistentLoadoutForUserIdAndCharacterId,
    SetLoadoutDataForUserIdAndCharacterId
} from "../controllers/loadout";
import {
    DEFAULT_ACCOUNT_LOADOUT_SLOTS,
    MAX_CHARACTER_LOADOUT_SLOTS,
    MAX_TOTAL_LOADOUT_SLOTS
} from "../loadoutSlots";
import { CharacterOwnershipError } from "../controllers/starterManifest";
import { logger } from "../logger";
import { CaptureEvent, InventoryCaptureEnabled } from "../diagnostics/capture";

export const loadoutRouter = Router();





const NO_PLAYER_SENTINEL = "INVALID";

function LoadoutPayload(Loadouts: any[], Persistent: any) {
    return {
        loadouts: Loadouts,
        persistent: Persistent,
        num_account_slots: DEFAULT_ACCOUNT_LOADOUT_SLOTS,
        max_account_slots: DEFAULT_ACCOUNT_LOADOUT_SLOTS,
        num_character_slots: Math.max(0, Loadouts.length - DEFAULT_ACCOUNT_LOADOUT_SLOTS),
        max_character_slots: MAX_CHARACTER_LOADOUT_SLOTS,
        
        
        active_index: 0,
        needs_migration: false
    };
}

function EmptyLoadoutResponse() {
    return {
        code: null,
        message: "OK",
        payload: {
            loadouts: [],
            persistent: null,
            num_account_slots: 1,
            max_account_slots: 1,
            num_character_slots: 0,
            max_character_slots: MAX_CHARACTER_LOADOUT_SLOTS,
            active_index: 0,
            needs_migration: false
        }
    };
}

loadoutRouter.get("/loadout/:userId//all", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;

    if(RequestorAccountId === NO_PLAYER_SENTINEL){
        logger.debug("GET /loadout called with no-player sentinel and no characterId - returning empty loadouts, not touching DB");

        res.status(200);
        res.json(EmptyLoadoutResponse());
        return;
    }

    res.status(400);
    res.send();
});

loadoutRouter.get("/loadout/:userId/:characterId/all", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;

    if(RequestorAccountId === NO_PLAYER_SENTINEL){
        logger.debug(`GET /loadout called with no-player sentinel (userId=INVALID) for characterId ${CharacterId} - returning empty loadouts, not touching DB`);

        res.status(200);
        res.json(EmptyLoadoutResponse());
        return;
    }

    let Loadouts: any[];
    let Persistent: any;
    try {
        Loadouts = await GetAllLoadoutsForUserIdAndCharacterId(RequestorAccountId, CharacterId);
        Persistent = await GetPersistentLoadoutForUserIdAndCharacterId(RequestorAccountId, CharacterId); 
    } catch (Err) {
        if (Err instanceof CharacterOwnershipError) {
            logger.warn(`GET /loadout rejected for userId ${RequestorAccountId}: ${Err.message}`);
            res.status(400);
            res.send();
            return;
        }
        throw Err;
    }

    logger.info(`Fetched ${Loadouts.length} loadout(s) for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: LoadoutPayload(Loadouts, Persistent)
    });
});




loadoutRouter.post("/loadout/:userId/:characterId/unlock/:numSlots", HasParadoxBackendAuth, async (req: any, res) => {
    
    
    if (req.AuthData?.IsGameserver !== true) {
        logger.warn(`POST character loadout unlock rejected without gameserver authority userId=${req.params.userId} characterId=${req.params.characterId}`);
        res.status(403).json({ code: "forbidden", message: "Loadout slot unlocks require gameserver authority.", payload: null });
        return;
    }
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const TotalSlots = Number(req.params.numSlots);

    if(RequestorAccountId === NO_PLAYER_SENTINEL || !Number.isSafeInteger(TotalSlots) || TotalSlots < DEFAULT_ACCOUNT_LOADOUT_SLOTS || TotalSlots > MAX_TOTAL_LOADOUT_SLOTS){
        logger.warn(`POST loadout unlock rejected userId=${RequestorAccountId} characterId=${CharacterId} requested=${req.params.numSlots}; valid total-slot range is ${DEFAULT_ACCOUNT_LOADOUT_SLOTS}..${MAX_TOTAL_LOADOUT_SLOTS}`);
        res.status(400).json({ code: "invalid_loadout_slot_count", message: `Total loadout slot count must be between ${DEFAULT_ACCOUNT_LOADOUT_SLOTS} and ${MAX_TOTAL_LOADOUT_SLOTS}.`, payload: null });
        return;
    }

    let Loadouts: any[];
    let Persistent: any;
    try {
        Loadouts = await EnsureTotalLoadoutSlots(RequestorAccountId, CharacterId, TotalSlots);
        Persistent = await GetPersistentLoadoutForUserIdAndCharacterId(RequestorAccountId, CharacterId);
    } catch (Err) {
        if (Err instanceof CharacterOwnershipError) {
            logger.warn(`POST character loadout unlock rejected for userId ${RequestorAccountId}: ${Err.message}`);
            res.status(400).send();
            return;
        }
        throw Err;
    }

    logger.info(`Loadout slot entitlement ensured userId=${RequestorAccountId} characterId=${CharacterId} requestedTotalSlots=${TotalSlots} visibleTotalSlots=${Loadouts.length} characterSlots=${Loadouts.length - DEFAULT_ACCOUNT_LOADOUT_SLOTS}`);
    res.status(200).json({
        code: null,
        message: "OK",
        payload: LoadoutPayload(Loadouts, Persistent)
    });
});

loadoutRouter.post("/loadout/:userId/:characterId/:index", HasParadoxBackendAuth, async (req: any, res) => {
    
    if (req.body == null || typeof req.body !== "object" || Array.isArray(req.body)) {
        logger.warn("POST /loadout rejected: request body is not an object");
        res.status(400);
        res.send();
        return;
    }

    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const Data = req.body.data;
    const Index = req.params.index;

    if(RequestorAccountId === NO_PLAYER_SENTINEL){
        logger.warn(`POST /loadout called with no-player sentinel (userId=INVALID) for characterId ${CharacterId} - refusing update, not touching DB`);

        res.status(400);
        res.send();
        return;
    }

    
    
    
    
    
    
    
    
    
    
    
    
    if(InventoryCaptureEnabled()){
        let TopLevelKeys: string[] = [];
        try {
            const Parsed = JSON.parse(Data);
            if(Parsed != null && typeof Parsed === "object" && !Array.isArray(Parsed)) TopLevelKeys = Object.keys(Parsed);
        } catch { /* ValidateLoadoutWriteData will reject unparsable data below; nothing to capture */ }
        CaptureEvent("LOADOUT-WRITE", {
            userId: RequestorAccountId,
            characterId: CharacterId,
            index: Index,
            gsKey: req.headers["x-mysticparadox-gameserver-apikey"] != undefined,
            isGameserver: req.AuthData?.IsGameserver === true,
            bytes: typeof Data === "string" ? Data.length : -1,
            topLevelKeys: TopLevelKeys,
        });
    }

    const Success = await SetLoadoutDataForUserIdAndCharacterId(RequestorAccountId, CharacterId, Index, Data);

    if(Success){
        logger.info(`Successfully updated loadout index ${Index} for userId ${RequestorAccountId} and characterId ${CharacterId}`);
        

        const Loadouts: any[] = await GetAllLoadoutsForUserIdAndCharacterId(RequestorAccountId, CharacterId);
        const Persistent: any = await GetPersistentLoadoutForUserIdAndCharacterId(RequestorAccountId, CharacterId); 

        logger.info(`Fetched ${Loadouts.length} loadout(s) for userId ${RequestorAccountId} and characterId ${CharacterId}`);

        res.status(200);
        res.json({
            code: null,
            message: "OK",
            payload: LoadoutPayload(Loadouts, Persistent)
        });
    }
    else{
        logger.error(`Failed to update loadout index ${Index} for userId ${RequestorAccountId} and characterId ${CharacterId}`);

        res.status(400);
        res.send();
    }
});
