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
import { GetInventoryForUserIdAndCharacterId, RunInventoryTransaction, UpdateInstancedItem, InventoryTransactionConflictError, InventoryTransactionMismatchError } from "../controllers/inventory";
import { InsufficientBalanceError } from "../controllers/wallet";
import { ValidateInventoryTransactionBody, InventoryBodyHasGrantOrSpend, ValidateInstancedItemUpdateBody } from "../validation";
import { CaptureInventoryTransaction, CaptureEvent } from "../diagnostics/capture";

export const inventoryRouter = Router();





const NO_PLAYER_SENTINEL = "INVALID";

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

    res.status(400);
    res.send();
});

inventoryRouter.post("/inventory", HasParadoxBackendAuth, async (req: any, res) => {
    
    
    
    if (req.body == null || typeof req.body !== "object" || Array.isArray(req.body)) {
        logger.warn("POST /inventory rejected: request body is not an object");
        res.status(400);
        res.json({ code: null, message: "Invalid inventory request: body must be an object", payload: {} });
        return;
    }

    
    
    
    
    const UserId = req.AuthData.IsGameserver
        ? (req.body.accountId ?? req.AuthData.userId)
        : req.AuthData.userId;
    const CharacterId = req.body.characterId;
    const TransactionId = req.body.transactionId;
    const InstancedItemsToAdd = req.body.addInstancedItems;
    const StackedItemsToAdd = req.body.addStackedItems;
    const InstancedItemsToRemove = req.body.removeInstancedItems;
    const StackedItemsToRemove = req.body.removeStackedItems;
    const InstancedItemsToSave = req.body.saveInstancedItems;

    
    
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

    
    
    const ValidationError = ValidateInventoryTransactionBody(req.body);
    if (ValidationError != undefined) {
        logger.warn(`POST /inventory rejected (bad payload) for userId ${UserId}: ${ValidationError}`);
        res.status(400);
        res.json({ code: null, message: `Invalid inventory request: ${ValidationError}`, payload: {} });
        return;
    }

    
    
    
    
    
    
    if (!req.AuthData.IsGameserver && InventoryBodyHasGrantOrSpend(req.body)) {
        logger.error(`POST /inventory grant/spend rejected: player bearer for userId ${UserId} attempted an authoritative mutation without gameserver auth`);
        res.status(403);
        res.json({ code: null, message: "Authoritative inventory mutations require gameserver authority", payload: {} });
        return;
    }

    let TransactionResult: any;
    try {
        TransactionResult = await RunInventoryTransaction(UserId, CharacterId, TransactionId, InstancedItemsToAdd, StackedItemsToAdd, InstancedItemsToRemove, StackedItemsToRemove, InstancedItemsToSave);
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
        if (Err instanceof InsufficientBalanceError) {
            
            
            logger.warn(`transactionId ${TransactionId} for userId ${UserId} rejected: ${Err.message}`);
            res.status(409);
            res.json({ code: null, message: "Insufficient balance", payload: {} });
            return;
        }
        if (Err instanceof InventoryTransactionMismatchError) {
            
            
            logger.error(`transactionId ${TransactionId} for userId ${UserId} mismatch: ${Err.message}`);
            res.status(409);
            res.json({ code: null, message: "Transaction id reused with a different request body", payload: {} });
            return;
        }
        if (Err instanceof InventoryTransactionConflictError) {
            
            
            
            logger.warn(`transactionId ${TransactionId} for userId ${UserId} conflict: ${Err.message}`);
            res.status(409);
            res.json({ code: null, message: "Transaction already in progress", payload: {} });
            return;
        }
        throw Err;
    }

    if(TransactionResult !== false){
        CaptureInventoryTransaction({
            phase: "result",
            userId: UserId,
            characterId: CharacterId,
            transactionId: TransactionId,
            gsKey: GsKeyPresent,
            isGameserver: req.AuthData.IsGameserver === true,
            result: TransactionResult,
        });

        logger.info(`Ran transactionId ${TransactionId} for userId ${UserId} and characterId ${CharacterId}`);

        res.status(200);
        res.json(TransactionResult);

        return;
    }
    else{
        logger.error(`transactionId ${TransactionId} for userId ${UserId} and characterId ${CharacterId} FAILED!`);

        res.status(400);
        res.send();
        return;
    }
});

inventoryRouter.post("/inventory/instanceditem", HasParadoxBackendAuth, async (req: any, res) => {
    
    if (req.body == null || typeof req.body !== "object" || Array.isArray(req.body)) {
        logger.warn("POST /inventory/instanceditem rejected: request body is not an object");
        res.status(400);
        res.json({ code: null, message: "Invalid item update: body must be an object", payload: {} });
        return;
    }

    const CharacterId = req.body.characterId;
    
    
    
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
