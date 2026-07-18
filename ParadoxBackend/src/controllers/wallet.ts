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

import { ClientSession } from "mongodb";
import { GetRepositories } from "../persistence";
import { IsValidBalanceCatalogId } from "../persistence/contracts/WalletRepository";
import { logger } from "../logger";

const NO_PLAYER_SENTINEL = "INVALID";






export const STARTER_WALLET: Record<string, number> = {
    CURRENCY_NOTES: 5000,
    CURRENCY_PJM_WEAPON: 50,
    CURRENCY_PJM_ARMOR: 50,
    CURRENCY_PJM_ALCHEMY: 50,
    CURRENCY_PJM_AIRSHIP: 50,
    CURRENCY_PJM_FISHING: 50,
};




export async function GetWallet(userId: string, session?: ClientSession): Promise<Record<string, number>> {
    if (!userId || userId === NO_PLAYER_SENTINEL) return {};

    
    
    
    const Wallet = await GetRepositories().wallets.createIfMissing(
        { userId, balances: { ...STARTER_WALLET } },
        session
    );
    return Wallet.balances;
}

export async function GetBalance(userId: string, catalogId: string, session?: ClientSession): Promise<number> {
    const Wallet = await GetWallet(userId, session);
    return Wallet[catalogId] ?? 0;
}



export class InsufficientBalanceError extends Error {
    constructor(userId: string, catalogId: string, delta: number, currentBalance: number) {
        super(`Insufficient balance: user ${userId} has ${currentBalance} of ${catalogId}, cannot apply delta ${delta}`);
        this.name = "InsufficientBalanceError";
    }
}





export async function AddCurrency(userId: string, catalogId: string, delta: number, session?: ClientSession): Promise<number> {
    if (!userId || userId === NO_PLAYER_SENTINEL || !catalogId || !Number.isFinite(delta) || delta === 0) {
        return await GetBalance(userId, catalogId, session);
    }

    
    
    
    if (!IsValidBalanceCatalogId(catalogId)) {
        throw new Error(`Refusing currency change: unsafe balance catalogId ${JSON.stringify(catalogId)}`);
    }

    
    
    
    
    await GetWallet(userId, session);

    const Updated = await GetRepositories().wallets.incrementBalance(userId, catalogId, delta, session);
    if (Updated == undefined) {
        
        
        
        const CurrentBalance = await GetBalance(userId, catalogId, session);
        throw new InsufficientBalanceError(userId, catalogId, delta, CurrentBalance);
    }

    const Next = Updated.balances[catalogId] ?? 0;
    logger.info(`[Wallet] ${userId} ${catalogId} ${delta >= 0 ? "+" : ""}${delta} -> ${Next}`);
    return Next;
}




export async function ApplyCurrencyDeltas(userId: string, adds: any[], removes: any[], session?: ClientSession): Promise<void> {
    if (!userId || userId === NO_PLAYER_SENTINEL) return;

    for (const Item of (adds ?? [])) {
        if (typeof Item?.catalogId === "string" && Item.catalogId.startsWith("CURRENCY_")) {
            await AddCurrency(userId, Item.catalogId, Number(Item.quantity ?? 0), session);
        }
    }
    for (const Item of (removes ?? [])) {
        if (typeof Item?.catalogId === "string" && Item.catalogId.startsWith("CURRENCY_")) {
            await AddCurrency(userId, Item.catalogId, -Number(Item.quantity ?? 0), session);
        }
    }
}






export async function MergeWalletIntoStacked(userId: string, stackedItems: any[]): Promise<any[]> {
    const Wallet = await GetWallet(userId);
    const Out: any[] = Array.isArray(stackedItems) ? stackedItems.slice() : [];
    for (const [Cid, Amt] of Object.entries(Wallet)) {
        const Idx = Out.findIndex((it) => it && it.catalogId === Cid);
        if (Idx >= 0) Out[Idx] = { ...Out[Idx], catalogId: Cid, quantity: Amt };
        else Out.push({ catalogId: Cid, quantity: Amt });
    }
    return Out;
}



export async function BuildBalanceDict(userId: string, base: Record<string, number> = {}): Promise<Record<string, number>> {
    const Wallet = await GetWallet(userId);
    const Balance: Record<string, number> = { ...base };
    for (const [Cid, Amt] of Object.entries(Wallet)) {
        Balance[Cid] = Amt;
        Balance["id_currency_" + Cid.replace(/^CURRENCY_/, "").toLowerCase()] = Amt;
    }
    return Balance;
}
