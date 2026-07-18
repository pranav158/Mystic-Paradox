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

import crypto from "node:crypto";
import { GetRepositories } from "../persistence";
import { GetBalance, InsufficientBalanceError } from "./wallet";
import { RunInventoryTransaction, InventoryTransactionConflictError, InventoryTransactionMismatchError } from "./inventory";
import { logger } from "../logger";
import { loadGameData } from "../gameData/loader";
const LadyLuckStoreData = loadGameData<any>("ladyluck_store.json");


















type LadyLuckSkuItem = { catalogId: string; quantity: number; instanced: boolean };
type LadyLuckSku = {
    id: string;
    displayName: string;
    displayDescription: string;
    displayPriority: number;
    prices: { currencyId: string; price: number }[];
    maxAllowed: number | null;
    tags: string[];
    items: LadyLuckSkuItem[];
    
    
    
    
    
    
    
    
    duplicateInstancedItems: string[];
};

const LADYLUCK_SKUS = LadyLuckStoreData as LadyLuckSku[];





const CURRENCY_ID_MAP: Record<string, string> = {
    id_currency_marks_gilded: "CURRENCY_MARKS_GILDED",
    id_currency_marks_steel: "CURRENCY_MARKS_STEEL",
};

export function GetLadyLuckSkus(): LadyLuckSku[] {
    return LADYLUCK_SKUS;
}






export function FindLadyLuckSkuByIdOrCatalogId(idOrCatalogId: string): LadyLuckSku | undefined {
    return (
        LADYLUCK_SKUS.find((s) => s.id === idOrCatalogId) ??
        LADYLUCK_SKUS.find((s) => s.items.some((i) => i.catalogId === idOrCatalogId))
    );
}

export type PurchaseResult =
    | { ok: true; result: any }
    | { ok: false; reason: "unknown_sku" | "insufficient_balance" | "conflict" | "already_purchased_different_request" | "transaction_failed" };








export async function PurchaseLadyLuckSku(userId: string, characterId: string, skuId: string): Promise<PurchaseResult> {
    const Sku = LADYLUCK_SKUS.find((s) => s.id === skuId);
    if (!Sku) {
        return { ok: false, reason: "unknown_sku" };
    }

    
    
    
    
    
    
    
    const IsOneTime = Sku.maxAllowed === 1;
    const TransactionId = IsOneTime
        ? crypto.createHash("sha256").update(`ladyluck-purchase:${userId}:${skuId}`).digest("hex").slice(0, 32).toUpperCase()
        : crypto.randomBytes(16).toString("hex").toUpperCase();

    const StackedItemsToRemove = Sku.prices.map((p) => ({
        catalogId: CURRENCY_ID_MAP[p.currencyId] ?? p.currencyId.toUpperCase(),
        quantity: p.price,
    }));

    const InstancedItemsToAdd: any[] = [];
    const StackedItemsToAdd: any[] = [];
    for (const item of Sku.items) {
        if (item.instanced) {
            
            
            
            
            for (let i = 0; i < item.quantity; i++) {
                const InstanceId = crypto
                    .createHash("sha256")
                    .update(`ladyluck-purchase-instance:${userId}:${skuId}:${item.catalogId}:${i}`)
                    .digest("hex")
                    .slice(0, 26)
                    .toUpperCase();
                InstancedItemsToAdd.push({ catalogId: item.catalogId, instanceId: InstanceId, itemData: null, updateVersion: 0 });
            }
        } else {
            StackedItemsToAdd.push({ catalogId: item.catalogId, quantity: item.quantity });
        }
    }

    try {
        const Result = await RunInventoryTransaction(
            userId,
            characterId,
            TransactionId,
            InstancedItemsToAdd,
            StackedItemsToAdd,
            [],
            StackedItemsToRemove,
            []
        );
        if (!Result) {
            return { ok: false, reason: "transaction_failed" };
        }
        logger.info(`[LadyLuckStore] ${userId} purchased ${skuId} (transactionId=${TransactionId})`);
        return { ok: true, result: Result };
    } catch (Err) {
        if (Err instanceof InsufficientBalanceError) {
            return { ok: false, reason: "insufficient_balance" };
        }
        if (Err instanceof InventoryTransactionConflictError) {
            return { ok: false, reason: "conflict" };
        }
        if (Err instanceof InventoryTransactionMismatchError) {
            return { ok: false, reason: "already_purchased_different_request" };
        }
        throw Err;
    }
}

export async function GetNotesForUser(userId: string){
    if(userId === undefined || userId === "" || userId === "INVALID"){
        return 0;
    }

    
    let UserFromDb = await GetRepositories().accounts.findByUserId(userId);

    if(UserFromDb === undefined){
        await GetRepositories().accounts.create({
            userId,
            name: userId,
            notes: 0
        });
    }

    
    return await GetBalance(userId, "CURRENCY_NOTES");
}
