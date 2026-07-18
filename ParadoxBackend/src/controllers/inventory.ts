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

import { GetRepositories, GetUnitOfWork, InventoryTransactionAlreadyExistsError } from "../persistence";
import { GetCharacterWithUid } from "./character";
import { logger } from "../logger";
import { ApplyCurrencyDeltas, MergeWalletIntoStacked } from "./wallet";
import { EnsureStarterBootstrapRecords, EnsureStarterBootstrapRecordsInTransaction } from "./starterManifest";
import crypto from "node:crypto";




function StableStringify(value: any): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return "[" + value.map(StableStringify).join(",") + "]";
    return "{" + Object.keys(value).sort().map((Key) => JSON.stringify(Key) + ":" + StableStringify(value[Key])).join(",") + "}";
}




function ComputeInventoryRequestHash(InstancedItemsToAdd: any[], StackedItemsToAdd: any[], InstancedItemsToRemove: any[], StackedItemsToRemove: any[], InstancedItemsToSave: any[]): string {
    const Canonical = StableStringify({
        addInstancedItems: InstancedItemsToAdd ?? [],
        addStackedItems: StackedItemsToAdd ?? [],
        removeInstancedItems: InstancedItemsToRemove ?? [],
        removeStackedItems: StackedItemsToRemove ?? [],
        saveInstancedItems: InstancedItemsToSave ?? [],
    });
    return crypto.createHash("sha256").update(Canonical).digest("hex");
}













function ApplyItemDataSave(existing: any, incomingItemData: any, incomingUpdateVersion: any): any | undefined {
    const ExistingVersion = typeof existing.updateVersion === "number" ? existing.updateVersion : 0;
    const IncomingVersion = typeof incomingUpdateVersion === "number" ? incomingUpdateVersion : ExistingVersion;
    const NextItemData = incomingItemData ?? null;
    const ExistingItemData = existing.itemData ?? null;

    if (IncomingVersion < ExistingVersion) {
        logger.warn(`Ignoring stale itemData save: updateVersion ${IncomingVersion} < stored ${ExistingVersion} for instanceId ${existing.instanceId} (catalogId ${existing.catalogId})`);
        return undefined;
    }

    if (IncomingVersion === ExistingVersion) {
        if (NextItemData === ExistingItemData) {
            
            
            return undefined;
        }
        
        logger.warn(`Same-version divergent itemData save for instanceId ${existing.instanceId} (catalogId ${existing.catalogId}) at updateVersion ${IncomingVersion} - applying, flagged for review`);
    }

    return { ...existing, itemData: NextItemData, updateVersion: IncomingVersion };
}

export const DEV_USER_ID = process.env.DEV_USER_ID ?? "mysticparadox";












const INVALID_STARTER_CATALOG_IDS = new Set([
    "DYE_BANNER_BACKGROUND_DEFAULT",
    "DYE_BANNER_SIGIL_DEFAULT",
]);

function NormalizeInstancedItems(InstancedItems: any[]){
    let Changed = false;
    const NormalizedItems: any[] = [];
    const SeenInstanceIds = new Set<string>();

    for(const Item of InstancedItems){
        if(Item == undefined || typeof Item !== "object"){
            Changed = true;
            continue;
        }

        const CatalogId = Item.catalogId;
        const InstanceId = Item.instanceId;
        if(typeof CatalogId !== "string" || CatalogId.length === 0 || INVALID_STARTER_CATALOG_IDS.has(CatalogId) ||
           typeof InstanceId !== "string" || InstanceId.length === 0 || SeenInstanceIds.has(InstanceId)){
            Changed = true;
            continue;
        }
        SeenInstanceIds.add(InstanceId);

        const NormalizedItem = {
            ...Item,
            catalogId: CatalogId,
            instanceId: InstanceId,
            
            
            itemData: Item.itemData ?? null,
            updateVersion: typeof Item.updateVersion === "number" ? Item.updateVersion : 0,
        };
        if(NormalizedItem.itemData !== Item.itemData || NormalizedItem.updateVersion !== Item.updateVersion) Changed = true;
        NormalizedItems.push(NormalizedItem);
    }

    InstancedItems.splice(0, InstancedItems.length, ...NormalizedItems);
    return Changed;
}

function NormalizeStackedItems(StackedItems: any[]){
    let Changed = false;
    const NormalizedItems: any[] = [];
    const QuantitiesByCatalogId = new Map<string, number>();
    for(const Item of StackedItems){
        if(Item == undefined || typeof Item !== "object" || typeof Item.catalogId !== "string" || INVALID_STARTER_CATALOG_IDS.has(Item.catalogId)){
            Changed = true;
            continue;
        }
        const Quantity = typeof Item.quantity === "number" ? Item.quantity : 0;
        QuantitiesByCatalogId.set(Item.catalogId, (QuantitiesByCatalogId.get(Item.catalogId) ?? 0) + Quantity);
    }
    for(const [catalogId, quantity] of QuantitiesByCatalogId) NormalizedItems.push({catalogId, quantity});
    if(NormalizedItems.length !== StackedItems.length) Changed = true;
    StackedItems.splice(0, StackedItems.length, ...NormalizedItems);
    return Changed;
}

function RemoveInstancedItems(InstancedItems: any[], ItemsToRemove: any[]){
    if(!Array.isArray(ItemsToRemove) || ItemsToRemove.length === 0){
        return false;
    }

    const InstanceIdsToRemove = new Set(ItemsToRemove.map((Item) => Item?.instanceId).filter((InstanceId) => typeof InstanceId === "string" && InstanceId.length > 0));

    if(InstanceIdsToRemove.size === 0){
        return false;
    }

    const OriginalLength = InstancedItems.length;
    const KeptItems = InstancedItems.filter((Item) => !InstanceIdsToRemove.has(Item.instanceId));
    InstancedItems.splice(0, InstancedItems.length, ...KeptItems);

    return KeptItems.length !== OriginalLength;
}

function RemoveStackedItems(StackedItems: any[], ItemsToRemove: any[]){
    if(!Array.isArray(ItemsToRemove) || ItemsToRemove.length === 0){
        return false;
    }

    let Changed = false;

    for(const ItemToRemove of ItemsToRemove){
        if(typeof ItemToRemove?.catalogId !== "string"){
            continue;
        }

        const ExistingItem = StackedItems.find((Item) => Item.catalogId === ItemToRemove.catalogId);

        if(ExistingItem == undefined){
            continue;
        }

        ExistingItem.quantity -= typeof ItemToRemove.quantity === "number" ? ItemToRemove.quantity : ExistingItem.quantity;
        Changed = true;
    }

    const KeptItems = StackedItems.filter((Item) => Item.quantity > 0);
    StackedItems.splice(0, StackedItems.length, ...KeptItems);

    return Changed;
}

async function DoesInventoryBelongToUserId(UserId: string, CharacterId: string){
    const CharacterFromDb = await GetCharacterWithUid(CharacterId, UserId);

    return CharacterFromDb != undefined;
}

export async function UpdateInstancedItem(CharacterId: string, UserId: string, InstanceId: string, CatalogId: string, ItemData: string, UpdateVersion: number){
    
    if(!await DoesInventoryBelongToUserId(UserId, CharacterId)){
        logger.error(`UpdateInstancedItem: characterId ${CharacterId} does not belong to user ${UserId}`);
        return undefined;
    }

    
    
    
    
    
    
    const MAX_ATTEMPTS = 5;
    for(let Attempt = 0; Attempt < MAX_ATTEMPTS; Attempt++){
        if(Attempt > 0){
            await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
        }

        const CurrentInventory = await GetRepositories().inventories.findByCharacterId(CharacterId);
        if(CurrentInventory == undefined){
            logger.error(`UpdateInstancedItem: no inventory for characterId ${CharacterId}`);
            return undefined;
        }

        const ExpectedRevision = CurrentInventory.revision ?? 0;
        const InstancedItems: any[] = JSON.parse(CurrentInventory.instancedItems);
        const ItemIndex = InstancedItems.findIndex((Item) => Item.instanceId === InstanceId);

        if(ItemIndex < 0){
            logger.warn(`UpdateInstancedItem: instanceId ${InstanceId} not found for characterId ${CharacterId}`);
            return undefined;
        }

        const Existing = InstancedItems[ItemIndex];

        
        
        
        if(Existing.catalogId !== CatalogId){
            logger.warn(`UpdateInstancedItem: refusing catalogId change ${Existing.catalogId} -> ${CatalogId} for instanceId ${InstanceId} (userId ${UserId})`);
            return undefined;
        }

        
        
        
        
        const NextItem = ApplyItemDataSave(Existing, ItemData, UpdateVersion);
        if(NextItem === undefined){
            return Existing;
        }

        InstancedItems[ItemIndex] = NextItem;

        const Updated = await GetRepositories().inventories.updateBothIfRevisionMatches(
            CharacterId, JSON.stringify(InstancedItems), CurrentInventory.stackedItems, ExpectedRevision
        );

        if(Updated != undefined){
            logger.info(`Updated instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
            return InstancedItems[ItemIndex];
        }

        logger.warn(`UpdateInstancedItem: revision conflict for characterId ${CharacterId}, attempt ${Attempt + 1}/${MAX_ATTEMPTS} - retrying`);
    }

    logger.error(`UpdateInstancedItem for characterId ${CharacterId} failed after ${MAX_ATTEMPTS} revision-conflict retries`);
    return undefined;
}





export class InventoryTransactionConflictError extends Error {
    constructor(transactionId: string) {
        super(`Inventory transaction ${transactionId} is already in progress (concurrent duplicate request)`);
        this.name = "InventoryTransactionConflictError";
    }
}





export class InventoryTransactionMismatchError extends Error {
    constructor(transactionId: string) {
        super(`Inventory transaction ${transactionId} was reused with a different request body`);
        this.name = "InventoryTransactionMismatchError";
    }
}






class InventoryRevisionConflictError extends Error {
    constructor(public readonly characterId: string) {
        super(`Inventory revision conflict for characterId ${characterId} - concurrent write detected`);
        this.name = "InventoryRevisionConflictError";
    }
}

export async function RunInventoryTransaction(UserId: string, CharacterId: string, TransactionId: string, InstancedItemsToAdd: any[], StackedItemsToAdd: any[], InstancedItemsToRemove: any[], StackedItemsToRemove: any[], InstancedItemsToSave: any[]){
    if(!await DoesInventoryBelongToUserId(UserId, CharacterId)){
        logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
        return false;
    }

    
    
    
    
    
    

    
    
    
    
    
    
    
    
    
    
    
    
    const RequestHash = ComputeInventoryRequestHash(InstancedItemsToAdd, StackedItemsToAdd, InstancedItemsToRemove, StackedItemsToRemove, InstancedItemsToSave);

    try {
        return await GetUnitOfWork().withTransaction(async (Repos, Session) => {
            await Repos.inventoryTransactions.tryBegin(TransactionId, UserId, CharacterId, RequestHash, Session);
            

            
            
            await ApplyCurrencyDeltas(UserId, StackedItemsToAdd, StackedItemsToRemove, Session);

        
        
        
        
        
        
        let CurrentInventory = await Repos.inventories.findByCharacterId(CharacterId, Session);

        if(CurrentInventory == undefined){
            logger.info(`Recovering bootstrap records for characterId ${CharacterId}`);
            const Recovery = await EnsureStarterBootstrapRecordsInTransaction(Repos, UserId, CharacterId, Session);
            CurrentInventory = Recovery.inventory;
        }

        const ExpectedRevision = CurrentInventory.revision ?? 0;

        
        let InstancedItems: any[] = JSON.parse(CurrentInventory!.instancedItems);

        let StackedItems: any[] = JSON.parse(CurrentInventory!.stackedItems);
        const CreatedInstancedItems: any[] = [];
        const UpdatedInstancedItems: any[] = [];
        const UpdatedStackedItems: any[] = [];

        for(let NewInstancedItem of InstancedItemsToAdd ?? []){
            const Items = [NewInstancedItem];
            NormalizeInstancedItems(Items);

            if(Items.length > 0){
                RemoveInstancedItems(InstancedItems, Items);
                InstancedItems.push(Items[0]);
                CreatedInstancedItems.push(Items[0]);
            }
        }

        const StackedItemsByCatalogId = new Map<string, any>();

        for(let StackedItem of StackedItems){
            StackedItemsByCatalogId.set(StackedItem.catalogId, StackedItem);
        }

        for(let NewStackedItem of StackedItemsToAdd ?? []){
            if(INVALID_STARTER_CATALOG_IDS.has(NewStackedItem?.catalogId)){
                continue;
            }

            const ExistingStackedItem = StackedItemsByCatalogId.get(NewStackedItem.catalogId);

            if(ExistingStackedItem != undefined){
                ExistingStackedItem.quantity = ExistingStackedItem.quantity + NewStackedItem.quantity;
                UpdatedStackedItems.push(ExistingStackedItem);
            }
            else{
                StackedItems.push(NewStackedItem);
                StackedItemsByCatalogId.set(NewStackedItem.catalogId, NewStackedItem);
                UpdatedStackedItems.push(NewStackedItem);
            }
        }

        RemoveInstancedItems(InstancedItems, InstancedItemsToRemove ?? []);
        RemoveStackedItems(StackedItems, StackedItemsToRemove ?? []);

        
        
        
        
        
        
        
        
        
        
        {
            const StackedByCatalogAfterRemoval = new Map<string, any>();
            for(const Item of StackedItems) StackedByCatalogAfterRemoval.set(Item.catalogId, Item);
            const AlreadyReported = new Set(UpdatedStackedItems.map((Item) => Item.catalogId));
            for(const Removed of StackedItemsToRemove ?? []){
                const RemovedCatalogId = Removed?.catalogId;
                if(typeof RemovedCatalogId !== "string" || RemovedCatalogId.length === 0) continue;
                if(RemovedCatalogId.startsWith("CURRENCY_")) continue;
                if(AlreadyReported.has(RemovedCatalogId)) continue;
                AlreadyReported.add(RemovedCatalogId);
                const StillPresent = StackedByCatalogAfterRemoval.get(RemovedCatalogId);
                UpdatedStackedItems.push({ catalogId: RemovedCatalogId, quantity: StillPresent ? StillPresent.quantity : 0 });
            }
        }

        for(const SavedItem of InstancedItemsToSave ?? []){
            const Items = [SavedItem];
            NormalizeInstancedItems(Items);

            if(Items.length === 0){
                continue;
            }

            const ExistingItemIndex = InstancedItems.findIndex((Item) => Item.instanceId === Items[0].instanceId);

            if(ExistingItemIndex < 0){
                
                
                logger.warn(`Ignoring save for unknown instanceId ${Items[0].instanceId} (catalogId ${Items[0].catalogId}) - not owned by characterId ${CharacterId} (userId ${UserId})`);
                continue;
            }

            const Existing = InstancedItems[ExistingItemIndex];

            
            
            
            
            
            
            
            if(Existing.catalogId !== Items[0].catalogId){
                logger.warn(`Rejecting save that would change catalogId ${Existing.catalogId} -> ${Items[0].catalogId} for instanceId ${Existing.instanceId} (userId ${UserId})`);
                continue;
            }

            
            
            
            
            const NextItem = ApplyItemDataSave(Existing, Items[0].itemData, Items[0].updateVersion);
            if(NextItem !== undefined){
                InstancedItems[ExistingItemIndex] = NextItem;
                UpdatedInstancedItems.push(NextItem);
            }
        }

        const UpdatedInventory = await Repos.inventories.updateBothIfRevisionMatches(
            CharacterId, JSON.stringify(InstancedItems), JSON.stringify(StackedItems), ExpectedRevision, Session
        );

        if (UpdatedInventory == undefined) {
            
            
            
            
            
            throw new InventoryRevisionConflictError(CharacterId);
        }

        const Result = {
            createdInstancedItems: CreatedInstancedItems,
            updatedInstancedItems: UpdatedInstancedItems,
            updatedStackedItems: UpdatedStackedItems,
            removedInstancedItems: InstancedItemsToRemove ?? []
        };

        await Repos.inventoryTransactions.complete(TransactionId, UserId, CharacterId, Result, Session);

        return Result;
        });
    } catch (Err) {
        if (Err instanceof InventoryRevisionConflictError) {
            logger.warn(`transactionId ${TransactionId} for userId ${UserId} hit a revision conflict on characterId ${Err.characterId} - another write landed first, caller should retry`);
            throw new InventoryTransactionConflictError(TransactionId);
        }
        if (Err instanceof InventoryTransactionAlreadyExistsError) {
            
            
            

            
            
            
            
            
            
            
            
            
            
            
            
            const HasStoredRequestHash = typeof Err.existing.requestHash === "string" && Err.existing.requestHash.length > 0;
            if (HasStoredRequestHash && Err.existing.requestHash !== RequestHash) {
                logger.error(`transactionId ${TransactionId} for userId ${UserId} reused with a different request body - rejecting (stored ${Err.existing.requestHash.slice(0, 12)} != incoming ${RequestHash.slice(0, 12)})`);
                throw new InventoryTransactionMismatchError(TransactionId);
            }
            if (!HasStoredRequestHash) {
                logger.warn(`transactionId ${TransactionId} for userId ${UserId} is a legacy ledger record with no requestHash - replaying on original (pre-body-binding) semantics`);
            }
            if (Err.existing.status === "completed") {
                logger.info(`[Inventory] Replayed transactionId ${TransactionId} for userId ${UserId} - returning original stored result, not re-applying`);
                return Err.existing.result;
            }
            
            
            throw new InventoryTransactionConflictError(TransactionId);
        }
        throw Err;
    }
}

export async function GetInventoryForUserIdAndCharacterId(UserId: string, CharacterId: string){
    if(!await DoesInventoryBelongToUserId(UserId, CharacterId)){ // TODO: HACK: Get rid of this ugly thing, this is a workaround as we don't have a userId on our inventories table
        return undefined;
    }

    
    
    
    
    
    
    
    

    
    
    
    await EnsureStarterBootstrapRecords(UserId, CharacterId);
    const InventoryFromDb = await GetRepositories().inventories.findByCharacterId(CharacterId);
    if (InventoryFromDb == undefined) throw new Error(`Bootstrap recovery did not create inventory for ${CharacterId}`);

    return {
        characterId: CharacterId,
        instancedItems: JSON.parse(InventoryFromDb!.instancedItems),
        stackedItems: await MergeWalletIntoStacked(UserId, JSON.parse(InventoryFromDb!.stackedItems))
    };
}
