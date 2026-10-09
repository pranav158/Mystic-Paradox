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
    GetLoadoutStateForUserIdAndCharacterId,
    SetActiveLoadoutIndexForUserIdAndCharacterId,
    SetLoadoutDataForUserIdAndCharacterId
} from "../controllers/loadout";
import {
    MAX_TOTAL_LOADOUT_SLOTS,
    ResolvePlayerJourneyTotalLoadoutSlots,
    ResolveWireLoadoutSlotCounts
} from "../loadoutSlots";
import { CharacterOwnershipError } from "../controllers/starterManifest";
import { GetPlayerJourney } from "../controllers/progression";
import { logger } from "../logger";
import { CaptureEvent, InventoryCaptureEnabled } from "../diagnostics/capture";

export const loadoutRouter = Router();

// [1.12.0] "INVALID" is UE4/Phoenix's own sentinel for "no logged-in player" (e.g. a standalone
// gameserver with no client connected yet). Never auto-create, never persist, never write for
// it - only the exact literal sentinel is special-cased; any other unresolved id still falls
// through to normal (loud) error handling.
const NO_PLAYER_SENTINEL = "INVALID";

// [2026-10-08] Slot counts come from ResolveWireLoadoutSlotCounts: the default slot is a CHARACTER slot on the
// wire (see the helper). The old 1 account + (N-1) character split made the gameserver re-request /unlock/1
// after every response, forever. Totals, caps and UI tiles are unchanged.
function LoadoutPayload(Loadouts: any[], Persistent: any, ActiveIndex: number) {
    return {
        loadouts: Loadouts,
        persistent: Persistent,
        ...ResolveWireLoadoutSlotCounts(Loadouts.length),
        active_index: ActiveIndex,
        needs_migration: false
    };
}

// The no-player sentinel's (the hub phantom's) empty state: 0/0 account, 1/6 character, so it still gets a
// one-entry slot array and a valid active index 0, and its delta is 0. NEVER answer the phantom's
// POST /loadout/INVALID//unlock/:n with a 2xx: a 2xx runs the native success branch, which re-runs the slot
// resolve and would turn today's single terminal 404 into a loop.
function EmptyLoadoutResponse() {
    return {
        code: null,
        message: "OK",
        payload: {
            loadouts: [],
            persistent: null,
            ...ResolveWireLoadoutSlotCounts(1),
            active_index: 0,
            needs_migration: false
        }
    };
}

// [2026-10-08] Read-only loop detector: a gameserver that keeps re-requesting /unlock after the wire fix means
// it counts more unlocked LoadoutSlot conditions than the persisted Slayer's Path grants. Never changes a
// response, never throws.
const UNLOCK_REPEAT_WINDOW_MS = 60_000;
const UNLOCK_REPEAT_WARN_THRESHOLD = 5;
const UNLOCK_REPEAT_PRUNE_MS = 600_000;
const UnlockRepeatTracker = new Map<string, { windowStartMs: number; count: number; lastWarnMs: number; lastSeenMs: number }>();

function NoteLoadoutUnlockRequest(UserId: string, CharacterId: string, Delta: number, Total: number): void {
    try {
        const Now = Date.now();
        for (const [Key, Entry] of UnlockRepeatTracker) {
            if (Now - Entry.lastSeenMs > UNLOCK_REPEAT_PRUNE_MS) UnlockRepeatTracker.delete(Key);
        }
        const Key = `${UserId}/${CharacterId}`;
        let Entry = UnlockRepeatTracker.get(Key);
        if (!Entry || Now - Entry.windowStartMs > UNLOCK_REPEAT_WINDOW_MS) {
            Entry = { windowStartMs: Now, count: 0, lastWarnMs: Entry?.lastWarnMs ?? 0, lastSeenMs: Now };
            UnlockRepeatTracker.set(Key, Entry);
        }
        Entry.count++;
        Entry.lastSeenMs = Now;
        if (Entry.count > UNLOCK_REPEAT_WARN_THRESHOLD && Now - Entry.lastWarnMs >= UNLOCK_REPEAT_WINDOW_MS) {
            Entry.lastWarnMs = Now;
            logger.warn(`Loadout unlock still repeating userId=${UserId} characterId=${CharacterId} requestsInWindow=${Entry.count} gameserverDelta=${Delta} authoritativeTotalSlots=${Total} - gameserver counts more unlocked LoadoutSlot conditions than the persisted Slayer's Path grants`);
        }
    } catch { /* diagnostic only */ }
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

    let State: Awaited<ReturnType<typeof GetLoadoutStateForUserIdAndCharacterId>>;
    try {
        State = await GetLoadoutStateForUserIdAndCharacterId(RequestorAccountId, CharacterId);
    } catch (Err) {
        if (Err instanceof CharacterOwnershipError) {
            logger.warn(`GET /loadout rejected for userId ${RequestorAccountId}: ${Err.message}`);
            res.status(400);
            res.send();
            return;
        }
        throw Err;
    }

    logger.info(`Fetched ${State.loadouts.length} loadout(s) for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: LoadoutPayload(State.loadouts, State.persistent, State.activeIndex)
    });
});

// Entitlement is 1 default slot + up to five Slayer's Path unlocks (LoadoutSlot_01..05); on the wire all 1+U are
// reported as CHARACTER slots and account slots are 0/0 (store-only extras) - see ResolveWireLoadoutSlotCounts.
// Ghidra proves `ResolveProgressionLoadoutSlotUnlocks` passes a DELTA to UnlockLoadoutSlots:
// `1 + unlockedConditions - NumCharacterLoadoutSlots`. Therefore `/unlock/3` is not a desired
// total. Treat the path value as a bounded gameserver hint and derive the exact, idempotent
// entitlement from the persisted LoadoutSlot_01..05 nodes.
loadoutRouter.post("/loadout/:userId/:characterId/unlock/:numSlots", HasParadoxBackendAuth, async (req: any, res) => {
    // Slot entitlement comes from authoritative Slayer's Path state applied by the gameserver.
    // A player bearer token must not be able to call /unlock directly.
    if (req.AuthData?.IsGameserver !== true) {
        logger.warn(`POST character loadout unlock rejected without gameserver authority userId=${req.params.userId} characterId=${req.params.characterId}`);
        res.status(403).json({ code: "forbidden", message: "Loadout slot unlocks require gameserver authority.", payload: null });
        return;
    }
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const RequestedAdditionalSlots = Number(req.params.numSlots);

    if(RequestorAccountId === NO_PLAYER_SENTINEL
        || !Number.isSafeInteger(RequestedAdditionalSlots)
        || RequestedAdditionalSlots < 1
        || RequestedAdditionalSlots > MAX_TOTAL_LOADOUT_SLOTS){
        logger.warn(`POST loadout unlock rejected userId=${RequestorAccountId} characterId=${CharacterId} requested=${req.params.numSlots}; valid gameserver delta range is 1..${MAX_TOTAL_LOADOUT_SLOTS}`);
        res.status(400).json({ code: "invalid_loadout_slot_count", message: `Loadout slot unlock delta must be between 1 and ${MAX_TOTAL_LOADOUT_SLOTS}.`, payload: null });
        return;
    }

    let State: Awaited<ReturnType<typeof GetLoadoutStateForUserIdAndCharacterId>>;
    try {
        const Journey = await GetPlayerJourney(RequestorAccountId);
        const AuthoritativeTotalSlots = ResolvePlayerJourneyTotalLoadoutSlots(Journey?.nodes);
        await EnsureTotalLoadoutSlots(RequestorAccountId, CharacterId, AuthoritativeTotalSlots);
        State = await GetLoadoutStateForUserIdAndCharacterId(RequestorAccountId, CharacterId);
    } catch (Err) {
        if (Err instanceof CharacterOwnershipError) {
            logger.warn(`POST character loadout unlock rejected for userId ${RequestorAccountId}: ${Err.message}`);
            res.status(400).send();
            return;
        }
        throw Err;
    }

    const Wire = ResolveWireLoadoutSlotCounts(State.loadouts.length);
    logger.info(`Loadout slot entitlement reconciled userId=${RequestorAccountId} characterId=${CharacterId} gameserverDelta=${RequestedAdditionalSlots} authoritativeTotalSlots=${State.loadouts.length} wire=account:${Wire.num_account_slots}/${Wire.max_account_slots},character:${Wire.num_character_slots}/${Wire.max_character_slots}`);
    NoteLoadoutUnlockRequest(RequestorAccountId, CharacterId, RequestedAdditionalSlots, State.loadouts.length);
    res.status(200).json({
        code: null,
        message: "OK",
        payload: LoadoutPayload(State.loadouts, State.persistent, State.activeIndex)
    });
});

// Captured 1.12 traffic and the client's UpdateLoadoutSlotSetActiveEndpoint contract use this
// distinct mutation whenever the carousel selection changes. Slot contents and active identity
// are intentionally stored separately.
loadoutRouter.post("/loadout/:userId/:characterId/active/:index", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ActiveIndex = Number(req.params.index);

    if (RequestorAccountId === NO_PLAYER_SENTINEL
        || !Number.isSafeInteger(ActiveIndex)
        || ActiveIndex < 0
        || ActiveIndex >= MAX_TOTAL_LOADOUT_SLOTS) {
        res.status(400).json({ code: "invalid_active_loadout", message: "Active loadout index is invalid.", payload: null });
        return;
    }

    let Success: boolean;
    try {
        Success = await SetActiveLoadoutIndexForUserIdAndCharacterId(RequestorAccountId, CharacterId, ActiveIndex);
    } catch (Err) {
        if (Err instanceof CharacterOwnershipError) {
            logger.warn(`POST active loadout rejected for userId ${RequestorAccountId}: ${Err.message}`);
            res.status(400).send();
            return;
        }
        throw Err;
    }
    if (!Success) {
        logger.warn(`POST active loadout rejected userId=${RequestorAccountId} characterId=${CharacterId} index=${ActiveIndex}; slot is not unlocked`);
        res.status(400).json({ code: "loadout_slot_not_unlocked", message: "The requested loadout slot is not unlocked.", payload: null });
        return;
    }

    const State = await GetLoadoutStateForUserIdAndCharacterId(RequestorAccountId, CharacterId);
    logger.info(`Active loadout updated userId=${RequestorAccountId} characterId=${CharacterId} index=${State.activeIndex}`);
    res.status(200).json({
        code: null,
        message: "OK",
        payload: LoadoutPayload(State.loadouts, State.persistent, State.activeIndex)
    });
});

loadoutRouter.post("/loadout/:userId/:characterId/:index", HasParadoxBackendAuth, async (req: any, res) => {
    // [hardening] Guard the body is an object before dereferencing req.body.data.
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

    // [Omnicell investigation, 2026-07-21] Loadout writes had NO diagnostic capture at all - unlike
    // POST /inventory (MYSTICPARADOX_INV_CAPTURE). Whole-slot writes (replaceSlotIfRevisionMatches /
    // updatePersistentIfRevisionMatches, see controllers/loadout.ts) are a REPLACE, not a merge - if
    // the client ever issues two logically-separate loadout saves (e.g. a weapon/armor equip and an
    // Omnicell/ability equip) from two different local snapshots, the later write can silently erase
    // the earlier one's field, the same class of bug already found and fixed for Slayer's Path
    // (SavePlayerJourney's stale-overwrite, see 21_SLAYERS_PATH.md). We don't yet know the field name
    // Omnicell equip data uses (EUIMoveAttackType::OmnicellAbility in the SDK proves it's a distinct
    // activatable-ability slot, not a passive EquippedCells/EquippedCellsv2 entry - but not where it's
    // stored). Reusing the existing MYSTICPARADOX_INV_CAPTURE flag/[INV-CAP] convention rather than a new
    // one. Logs the top-level keys of the written blob (reveals the real field name on the very next
    // equip attempt) and a byte-length before/after so a same-request truncation is visible too.
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
        // TODO: RE success shape, below is a complete guess

        const State = await GetLoadoutStateForUserIdAndCharacterId(RequestorAccountId, CharacterId);

        logger.info(`Fetched ${State.loadouts.length} loadout(s) for userId ${RequestorAccountId} and characterId ${CharacterId}`);

        res.status(200);
        res.json({
            code: null,
            message: "OK",
            payload: LoadoutPayload(State.loadouts, State.persistent, State.activeIndex)
        });
    }
    else{
        logger.error(`Failed to update loadout index ${Index} for userId ${RequestorAccountId} and characterId ${CharacterId}`);

        res.status(400);
        res.send();
    }
});
