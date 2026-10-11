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
import { logger } from "../logger";
import { GetInventoryForUserIdAndCharacterId, RunInventoryTransaction, UpdateInstancedItem, InventoryTransactionConflictError, InventoryTransactionMismatchError, InsufficientStackedItemError } from "../controllers/inventory";
import { InsufficientBalanceError, InsufficientPrestigeProgressError, IsPrestigeGatedReward } from "../controllers/wallet";
import { MonitorGrant, MonitorInventoryOutcome, MonitorInventoryRequest, MonitorSourceOf } from "../diagnostics/economyMonitor";
import { IsChallengeRewardGrant, WaitForFundableSeasonClaim } from "../controllers/challengeRewards";
import { ValidateInventoryTransactionBody, InventoryBodyHasGrantOrSpend, ValidateInstancedItemUpdateBody } from "../validation";
import { CaptureInventoryTransaction, CaptureEvent } from "../diagnostics/capture";
import { GetCharactersForUid } from "../controllers/character";
import { ExtensionInventoryTransaction, GetP2PExtension } from "../extensions/p2p";

export const inventoryRouter = Router();

// [1.12.0] "INVALID" is UE4/Phoenix's own sentinel for "no logged-in player" (e.g. a standalone
// gameserver with no client connected yet). Never auto-create, never persist, never write for
// it - only the exact literal sentinel is special-cased; any other unresolved id still falls
// through to normal (loud) error handling.
const NO_PLAYER_SENTINEL = "INVALID";

// [1.14.7 FIX 2026-10-04] Express 5 does not match :param against an EMPTY path segment, so the client's
//     POST /inventory//dauntlessrel-1.14.7:647472      (empty characterId; build string as the 2nd segment)
// fell through to the unstubbed handler in app.ts and answered 404. That 404 is what failed the login:
//     [LoginOpFailed] class=LoginToDauntlessProxy
//     [EnqueueDisconnectError] reason='An error occurred while communicating with the game servers...'
// The regex below matches BOTH the normal /inventory/<characterId>/<changeList> and the empty-character form,
// and is registered first so it wins. Response shape is unchanged from the stub it replaces.
inventoryRouter.post(/^\/inventory\/([^/]*)\/(.+)$/, HasParadoxBackendAuth, (req: any, res) => {
    logger.info(`Inventory migration (stubbed) characterId='${req.params[0] ?? ""}' changeList='${req.params[1] ?? ""}'`);

    res.status(200);
    res.json({
        code: "NONE",
        message: ""
    });
});

inventoryRouter.post("/inventory/:characterId/:changeList", HasParadoxBackendAuth, (req: any, res) => {
    logger.info("Inventory migration (stubbed)");

    res.status(200);
    res.json({
        code: "NONE",
        message: ""
    });
});

inventoryRouter.get("/inventory/:userId/:characterId", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;

    if(UserId === NO_PLAYER_SENTINEL){
        logger.debug(`GET /inventory called with no-player sentinel (userId=INVALID) for characterId ${CharacterId} - returning empty inventory, not touching DB`);

        res.status(200);
        res.json({
            characterId: CharacterId,
            instancedItems: [],
            stackedItems: []
        });
        return;
    }

    logger.info(`UserId ${UserId} requested inventory for CharacterId ${CharacterId}`);

    const Inventory = await GetInventoryForUserIdAndCharacterId(UserId, CharacterId);

    if(Inventory != undefined){
        res.status(200);
        res.json(Inventory);
    }
    else{
        res.status(400);
        res.send();
    }
});

inventoryRouter.get("/inventory/:userId/", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;

    if(UserId === NO_PLAYER_SENTINEL){
        logger.debug("GET /inventory called with no-player sentinel and no characterId - returning empty inventory, not touching DB");

        res.status(200);
        res.json({
            characterId: "INVALID",
            instancedItems: [],
            stackedItems: []
        });
        return;
    }

    // [1.14.7 2026-10-03] The hub's phantom player fetches inventory WITHOUT a characterId
    // ("/inventory/<account>/"), which previously always answered 400. The client then logged
    // "OnGetAllCharacterItemsRequestComplete - Response Status ..." /
    // "Failed to retrieve player inventory attempting to return to main menu", raised
    // "Disconnect Error Message: Failed to retrieve your character's inventory." and the hub left
    // the map (LeavingMap -> "LoadMap: failed to Listen"). Resolve the account's character (the
    // same single-account rule used for the INVALID sentinel and the POST path) and return its real
    // inventory instead. Player requests (bearer) are unaffected because they carry a characterId.
    if (req.AuthData.IsGameserver && typeof UserId === "string" && UserId.length > 0) {
        const Characters = await GetCharactersForUid(UserId);
        const CharacterId = Characters.length > 0 ? Characters[0].id : undefined;
        if (typeof CharacterId === "string" && CharacterId.length > 0) {
            const Inventory = await GetInventoryForUserIdAndCharacterId(UserId, CharacterId);
            if (Inventory != undefined) {
                logger.info(`GET /inventory (no characterId): gameserver request resolved to '${CharacterId}' for ${UserId}`);
                res.status(200);
                res.json(Inventory);
                return;
            }
        }
    }

    res.status(400);
    res.send();
});

inventoryRouter.post("/inventory", HasParadoxBackendAuth, async (req: any, res) => {
    // [hardening] Validate the body is an object BEFORE dereferencing any field, so a missing/null
    // body can never throw a TypeError (and never reaches field access). Full field-level
    // validation runs below for real (non-sentinel) requests before any mutation.
    if (req.body == null || typeof req.body !== "object" || Array.isArray(req.body)) {
        logger.warn("POST /inventory rejected: request body is not an object");
        res.status(400);
        res.json({ code: null, message: "Invalid inventory request: body must be an object", payload: {} });
        return;
    }

    const IsPlayerHostRuntime = req.AuthData.IsPlayerHostRuntime === true;

    // [1.12.0] Same double-auth fallback as POST /character - when the gameserver forwards
    // a client-initiated transaction, AuthData carries both IsGameserver=true and the
    // client's JWT-derived userId. Prefer body.accountId when the gameserver provides it
    // explicitly, otherwise use the JWT userId.
    let UserId = req.AuthData.IsGameserver
        ? (req.body.accountId ?? req.AuthData.userId)
        : req.AuthData.userId;

    // [1.14.7 2026-10-03] The hub's phantom player posts inventory with an empty accountId AND no
    // bearer, so UserId could still be "" here. Fall back to the configured single-account identity
    // (the middleware sets it for bearer-less gameserver requests; this covers an empty body value).
    if (req.AuthData.IsGameserver && (typeof UserId !== "string" || UserId.length === 0 || UserId === NO_PLAYER_SENTINEL)) {
        const NoPlayerUserId = (process.env.GAMESERVER_NO_PLAYER_USER_ID ?? process.env.DEV_USER_ID ?? "").trim();
        if (NoPlayerUserId.length > 0) {
            UserId = NoPlayerUserId;
            logger.info(`POST /inventory: gameserver request with no accountId resolved to '${NoPlayerUserId}'`);
        }
    }

    let CharacterId = req.body.characterId;

    // [1.14.7 2026-10-03] A dedicated hub's phantom local player posts inventory with an EMPTY
    // characterId - it never went through character selection - so validation rejected the request
    // with "characterId must be a non-empty string" (400). The client then logged
    // "Failed to retrieve player inventory attempting to return to main menu", raised
    // "Disconnect Error Message: Failed to retrieve your character's inventory." and the hub left
    // the map (LeavingMap -> "LoadMap: failed to Listen"). For gameserver requests that carry a
    // real account but no character, resolve to that account's character - the same single-account
    // rule the auth middleware already applies to the path-based INVALID sentinel.
    if (req.AuthData.IsGameserver
        && (typeof CharacterId !== "string" || CharacterId.length === 0)
        && typeof UserId === "string" && UserId.length > 0 && UserId !== NO_PLAYER_SENTINEL) {
        const Characters = await GetCharactersForUid(UserId);
        const Resolved = Characters.length > 0 ? Characters[0].id : undefined;
        if (typeof Resolved === "string" && Resolved.length > 0) {
            CharacterId = Resolved;
            // The body validator (ValidateInventoryTransactionBody) reads req.body.characterId, so
            // the resolution must be written back or validation still rejects the request.
            req.body.characterId = Resolved;
            logger.info(`POST /inventory: gameserver request with no characterId resolved to '${Resolved}' for ${UserId}`);
        }
    }

    const TransactionId = req.body.transactionId;
    const InstancedItemsToAdd = req.body.addInstancedItems;
    const StackedItemsToAdd = req.body.addStackedItems;
    const InstancedItemsToRemove = req.body.removeInstancedItems;
    const StackedItemsToRemove = req.body.removeStackedItems;
    const InstancedItemsToSave = req.body.saveInstancedItems;

    // [diagnostics] Structured capture of the raw transaction intent (gated by MYSTICPARADOX_INV_CAPTURE).
    // Emitted BEFORE the sentinel/validation/grant-gate checks so rejected attempts are captured too.
    const GsKeyPresent = req.headers["x-mysticparadox-gameserver-apikey"] != undefined;
    CaptureInventoryTransaction({
        phase: "request",
        userId: UserId,
        characterId: CharacterId,
        transactionId: TransactionId,
        gsKey: GsKeyPresent,
        isGameserver: req.AuthData.IsGameserver === true,
        addInstancedItems: InstancedItemsToAdd,
        addStackedItems: StackedItemsToAdd,
        removeInstancedItems: InstancedItemsToRemove,
        removeStackedItems: StackedItemsToRemove,
        saveInstancedItems: InstancedItemsToSave,
    });

    // [diagnostics 2026-10-10] [GrantMon]: one line per server-issued transaction (who granted what, with the game's own
    // `source` string when it sends one) - see diagnostics/economyMonitor.ts.
    MonitorGrant(req.AuthData, UserId, TransactionId, req.body);

    // [diagnostics 2026-10-10] Always-on [PrestigeMon]/[DraftMon] lines for the few catalog ids they watch.
    const MonitorFlags = MonitorInventoryRequest({
        transactionId: TransactionId,
        userId: UserId,
        source: MonitorSourceOf(req.AuthData),
        addStackedItems: StackedItemsToAdd,
        removeStackedItems: StackedItemsToRemove,
    }, IsPrestigeGatedReward);

    if(UserId === NO_PLAYER_SENTINEL){
        logger.debug(`POST /inventory called with no-player sentinel (userId=INVALID) for transactionId ${TransactionId} - no-op transaction, not touching DB`);

        res.status(200);
        res.json({
            createdInstancedItems: [],
            updatedInstancedItems: InstancedItemsToSave ?? [],
            updatedStackedItems: StackedItemsToAdd ?? [],
            removedInstancedItems: InstancedItemsToRemove ?? []
        });
        return;
    }

    // [hardening] Payload validation: reject a malformed body before it can reach the
    // transaction/JSON-blob layer and corrupt stored state.
    const ValidationError = ValidateInventoryTransactionBody(req.body);
    if (ValidationError != undefined) {
        logger.warn(`POST /inventory rejected (bad payload) for userId ${UserId}: ${ValidationError}`);
        res.status(400);
        res.json({ code: null, message: `Invalid inventory request: ${ValidationError}`, payload: {} });
        return;
    }

    // A runtime authenticated by an optional module (AuthData.IsPlayerHostRuntime) is neither a
    // player nor a gameserver: the module authorizes its transaction or rejects it.
    let ExtensionTransaction: ExtensionInventoryTransaction | undefined;
    if (IsPlayerHostRuntime) {
        const Decision = await GetP2PExtension().inventory.authorizeTransaction(req,
            { userId: UserId, characterId: CharacterId, transactionId: TransactionId });
        if (!("options" in Decision)) {
            res.status(Decision.status).json(Decision.body);
            return;
        }
        ExtensionTransaction = Decision;
    }

    // [hardening] Authoritative mutations require dedicated gameserver authority or the
    // module-authorized transaction above. A raw player bearer token may only save already-
    // owned instances; it cannot grant items/currency or force spends. Dedicated gameservers
    // continue to relay client-initiated transactions with their existing API key.
    if (!req.AuthData.IsGameserver && ExtensionTransaction == undefined && InventoryBodyHasGrantOrSpend(req.body)) {
        logger.error(`POST /inventory grant/spend rejected: player bearer for userId ${UserId} attempted an authoritative mutation without gameserver auth`);
        res.status(403);
        res.json({ code: null, message: "Authoritative inventory mutations require gameserver authority", payload: {} });
        return;
    }

    // [2026-10-10] A season challenge's coin reward may arrive ~50 ms before the bounty save that claims the challenge;
    // give that claim a moment to land so it can fund the grant (controllers/challengeRewards.ts).
    const IsDedicatedServer = req.AuthData.IsGameserver === true && ExtensionTransaction == undefined;
    if (IsDedicatedServer && Array.isArray(StackedItemsToAdd)
        && StackedItemsToAdd.some((Item: any) => IsChallengeRewardGrant(Item?.catalogId, Item?.quantity))) {
        const Ready = await WaitForFundableSeasonClaim(UserId);
        if (!Ready) logger.warn(`transactionId ${TransactionId}: challenge-reward currency with no claimed, uncredited season challenge after 1.5 s`);
    }

    let TransactionResult: any;
    try {
        ExtensionTransaction?.report?.("applying");
        TransactionResult = await RunInventoryTransaction(UserId, CharacterId, TransactionId, InstancedItemsToAdd, StackedItemsToAdd, InstancedItemsToRemove, StackedItemsToRemove, InstancedItemsToSave,
            { ...(ExtensionTransaction?.options ?? {}), allowChallengeRewardFunding: IsDedicatedServer });
    } catch (Err) {
        CaptureInventoryTransaction({
            phase: "error",
            userId: UserId,
            characterId: CharacterId,
            transactionId: TransactionId,
            gsKey: GsKeyPresent,
            isGameserver: req.AuthData.IsGameserver === true,
            error: Err,
        });
        MonitorInventoryOutcome(MonitorFlags, TransactionId, undefined, Err);
        const ExtensionDenial = ExtensionTransaction?.errorResponse?.(Err);
        if (ExtensionDenial != undefined) {
            res.status(ExtensionDenial.status).json(ExtensionDenial.body);
            return;
        }
        if (Err instanceof InsufficientBalanceError) {
            // [hardening] AddCurrency now rejects overspend atomically instead of clamping to
            // zero (see controllers/wallet.ts) — surface that as a clean 409, not a 500/crash.
            logger.warn(`transactionId ${TransactionId} for userId ${UserId} rejected: ${Err.message}`);
            res.status(409);
            res.json({ code: null, message: "Insufficient balance", payload: {} });
            return;
        }
        if (Err instanceof InsufficientPrestigeProgressError) {
            // [hardening 2026-07-26] A gated reward currency (e.g. Aether Hearts) was requested
            // without enough real banked PrestigeTrack progress to back it — see wallet.ts's
            // SpendBankedPrestigeForReward. Reject rather than credit an unbacked reward.
            logger.warn(`transactionId ${TransactionId} for userId ${UserId} rejected: ${Err.message}`);
            res.status(409);
            res.json({ code: null, message: "Insufficient banked prestige progress", payload: {} });
            return;
        }
        if (Err instanceof InsufficientStackedItemError) {
            // [hardening 2026-07-26] A removeStackedItems entry asked to remove more of a
            // non-currency item than is actually owned — see controllers/inventory.ts's
            // InsufficientStackedItemError doc comment (closes the Reward-Core-dupe bug class for
            // every non-currency consume-item transaction, including cell fusion).
            logger.warn(`transactionId ${TransactionId} for userId ${UserId} rejected: ${Err.message}`);
            res.status(409);
            res.json({ code: null, message: "Insufficient stacked item", payload: {} });
            return;
        }
        if (Err instanceof InventoryTransactionMismatchError) {
            // [hardening] transactionId reused with a DIFFERENT body - misuse, not a retry.
            // Reject without mutating (the original transaction's effect is left intact).
            logger.error(`transactionId ${TransactionId} for userId ${UserId} mismatch: ${Err.message}`);
            res.status(409);
            res.json({ code: null, message: "Transaction id reused with a different request body", payload: {} });
            return;
        }
        if (Err instanceof InventoryTransactionConflictError) {
            // [hardening] A genuinely concurrent duplicate of the same transactionId is still
            // mid-flight (not yet completed) — 409 so the caller can retry, rather than risk
            // double-applying the grant/spend.
            logger.warn(`transactionId ${TransactionId} for userId ${UserId} conflict: ${Err.message}`);
            res.status(409);
            res.json({ code: null, message: "Transaction already in progress", payload: {} });
            return;
        }
        throw Err;
    }

    if(TransactionResult !== false){
        ExtensionTransaction?.report?.("accepted");
        CaptureInventoryTransaction({
            phase: "result",
            userId: UserId,
            characterId: CharacterId,
            transactionId: TransactionId,
            gsKey: GsKeyPresent,
            isGameserver: req.AuthData.IsGameserver === true,
            result: TransactionResult,
        });
        MonitorInventoryOutcome(MonitorFlags, TransactionId, TransactionResult);

        logger.info(`Ran transactionId ${TransactionId} for userId ${UserId} and characterId ${CharacterId}`);

        res.status(200);
        res.json(TransactionResult);

        return;
    }
    else{
        ExtensionTransaction?.report?.("failed");
        logger.error(`transactionId ${TransactionId} for userId ${UserId} and characterId ${CharacterId} FAILED!`);

        res.status(400);
        res.send();
        return;
    }
});

inventoryRouter.post("/inventory/instanceditem", HasParadoxBackendAuth, async (req: any, res) => {
    // [hardening] Guard the body is an object before dereferencing any field.
    if (req.body == null || typeof req.body !== "object" || Array.isArray(req.body)) {
        logger.warn("POST /inventory/instanceditem rejected: request body is not an object");
        res.status(400);
        res.json({ code: null, message: "Invalid item update: body must be an object", payload: {} });
        return;
    }

    // This endpoint persists item state, so a runtime authenticated by an optional module must not
    // be able to write through it. Keep the check ahead of sentinel handling for the same reason as
    // POST /inventory; standalone dedicated gameservers remain unaffected.
    if (req.AuthData.IsPlayerHostRuntime === true) {
        logger.warn("POST /inventory/instanceditem rejected: a module runtime cannot mutate inventory");
        res.status(403).json({ code: "forbidden", message: "Player-host runtime cannot mutate inventory.", payload: null });
        return;
    }

    const CharacterId = req.body.characterId;
    // [1.12.0] Same double-auth fallback as POST /character. Also fixes a latent bug:
    // previously read req.AuthData.UserId (capital U) which is undefined on the JWT
    // payload (the field is lowercase userId), so the fallback path was dead code.
    const UserId = req.AuthData.IsGameserver
        ? (req.body.accountId ?? req.AuthData.userId)
        : req.AuthData.userId;
    const InstanceId = req.body.instanceId;
    const CatalogId = req.body.catalogId;
    const ItemData = req.body.itemData;
    const UpdateVersion = req.body.updateVersion;

    if(UserId === NO_PLAYER_SENTINEL){
        logger.debug(`POST /inventory/instanceditem called with no-player sentinel (userId=INVALID) - no-op update, not touching DB`);

        res.status(200);
        res.json({
            characterId: CharacterId,
            instanceId: InstanceId,
            catalogId: CatalogId,
            itemData: ItemData,
            updateVersion: UpdateVersion
        });
        return;
    }

    const UpdateValidationError = ValidateInstancedItemUpdateBody(req.body);
    if (UpdateValidationError != undefined) {
        logger.warn(`POST /inventory/instanceditem rejected (bad payload) for userId ${UserId}: ${UpdateValidationError}`);
        res.status(400);
        res.json({ code: null, message: `Invalid item update: ${UpdateValidationError}`, payload: {} });
        return;
    }

    // [diagnostics] Capture single-item saves (gated by MYSTICPARADOX_INV_CAPTURE). itemData carries
    // EquippedCells for cell-equip flows, so this doubles as a cell-equip trace.
    CaptureEvent("ITEM-UPDATE", {
        userId: UserId,
        characterId: CharacterId,
        instanceId: InstanceId,
        catalogId: CatalogId,
        updateVersion: UpdateVersion,
        itemDataLen: typeof ItemData === "string" ? ItemData.length : 0,
        itemDataPreview: typeof ItemData === "string" ? ItemData.slice(0, 400) : ItemData,
    });

    const Item = await UpdateInstancedItem(CharacterId, UserId, InstanceId, CatalogId, ItemData, UpdateVersion);

    res.status(200);
    res.json(Item);
});
