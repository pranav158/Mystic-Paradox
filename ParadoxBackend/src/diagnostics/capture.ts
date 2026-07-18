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

import { logger } from "../logger";



function IsFlagOn(value: string | undefined): boolean {
    return /^(1|true|on|yes)$/i.test(value ?? "");
}

const CAPTURE_ENABLED = IsFlagOn(process.env.MYSTICPARADOX_INV_CAPTURE);
const CAPTURE_RAW = IsFlagOn(process.env.MYSTICPARADOX_INV_CAPTURE_RAW);

const FocusPattern: RegExp | undefined = (() => {
    const Raw = process.env.MYSTICPARADOX_INV_CAPTURE_FILTER;
    if (Raw == undefined || Raw.length === 0) return undefined;
    try {
        return new RegExp(Raw, "i");
    } catch {
        logger.warn(`[INV-CAP] ignoring invalid MYSTICPARADOX_INV_CAPTURE_FILTER regex: ${Raw}`);
        return undefined;
    }
})();


export function InventoryCaptureEnabled(): boolean {
    return CAPTURE_ENABLED;
}

function ToArray(value: any): any[] {
    return Array.isArray(value) ? value : [];
}


function SummarizeItems(items: any): string {
    const Items = ToArray(items);
    if (Items.length === 0) return "[]";
    return "[" + Items.map((Item) => {
        if (Item == undefined || typeof Item !== "object") return String(Item);
        const CatalogId = typeof Item.catalogId === "string" ? Item.catalogId : "?";
        if (typeof Item.quantity === "number") return `${CatalogId} x${Item.quantity}`;
        if (typeof Item.instanceId === "string") return `${CatalogId}#${Item.instanceId}`;
        return CatalogId;
    }).join(", ") + "]";
}

function CatalogIdsOf(...arrays: any[]): string[] {
    const Ids: string[] = [];
    for (const Arr of arrays) {
        for (const Item of ToArray(Arr)) {
            if (Item != undefined && typeof Item.catalogId === "string") Ids.push(Item.catalogId);
        }
    }
    return Ids;
}

function MatchesFocus(ids: string[]): boolean {
    if (FocusPattern == undefined) return true;
    return ids.some((Id) => FocusPattern.test(Id));
}

function SafeJson(value: unknown): string {
    try {
        return JSON.stringify(value) ?? "null";
    } catch {
        return "<unserializable>";
    }
}

export interface InventoryTransactionContext {
    phase: "request" | "result" | "error";
    userId?: string;
    characterId?: string;
    transactionId?: string;
    gsKey?: boolean;         
    isGameserver?: boolean;  
    addInstancedItems?: any;
    addStackedItems?: any;
    removeInstancedItems?: any;
    removeStackedItems?: any;
    saveInstancedItems?: any;
    result?: any;
    error?: unknown;
}





export function CaptureInventoryTransaction(ctx: InventoryTransactionContext): void {
    if (!CAPTURE_ENABLED) return;
    try {
        const FocusIds = CatalogIdsOf(
            ctx.addInstancedItems, ctx.addStackedItems, ctx.removeInstancedItems, ctx.removeStackedItems, ctx.saveInstancedItems,
            ctx.result?.createdInstancedItems, ctx.result?.updatedStackedItems, ctx.result?.updatedInstancedItems, ctx.result?.removedInstancedItems,
        );
        
        
        if (ctx.phase !== "error" && !MatchesFocus(FocusIds)) return;

        const Head = `[INV-CAP] ${ctx.phase.toUpperCase()} txn=${ctx.transactionId ?? "?"} user=${ctx.userId ?? "?"} char=${ctx.characterId ?? "?"} gsKey=${ctx.gsKey ? "Y" : "N"} gs=${ctx.isGameserver ? "Y" : "N"}`;

        if (ctx.phase === "request") {
            logger.info(`${Head} addStacked=${SummarizeItems(ctx.addStackedItems)} removeStacked=${SummarizeItems(ctx.removeStackedItems)} addInstanced=${SummarizeItems(ctx.addInstancedItems)} removeInstanced=${SummarizeItems(ctx.removeInstancedItems)} saveInstanced=${SummarizeItems(ctx.saveInstancedItems)}`);
            if (CAPTURE_RAW) {
                logger.info(`[INV-CAP] REQ-RAW txn=${ctx.transactionId ?? "?"} ${SafeJson({
                    addStackedItems: ctx.addStackedItems ?? [],
                    removeStackedItems: ctx.removeStackedItems ?? [],
                    addInstancedItems: ctx.addInstancedItems ?? [],
                    removeInstancedItems: ctx.removeInstancedItems ?? [],
                    saveInstancedItems: ctx.saveInstancedItems ?? [],
                })}`);
            }
            return;
        }

        if (ctx.phase === "result") {
            const Result = ctx.result;
            if (Result == undefined || typeof Result !== "object") {
                logger.info(`${Head} result=${String(Result)}`);
                return;
            }
            logger.info(`${Head} created=${SummarizeItems(Result.createdInstancedItems)} updatedStacked=${SummarizeItems(Result.updatedStackedItems)} updatedInstanced=${SummarizeItems(Result.updatedInstancedItems)} removedInstanced=${SummarizeItems(Result.removedInstancedItems)}`);
            if (CAPTURE_RAW) logger.info(`[INV-CAP] RES-RAW txn=${ctx.transactionId ?? "?"} ${SafeJson(Result)}`);
            return;
        }

        
        const Message = ctx.error instanceof Error ? `${ctx.error.name}: ${ctx.error.message}` : String(ctx.error);
        logger.info(`${Head} error=${Message}`);
    } catch {
        /* diagnostics must never break a transaction */
    }
}




export function CaptureEvent(tag: string, fields: Record<string, unknown>): void {
    if (!CAPTURE_ENABLED) return;
    try {
        logger.info(`[INV-CAP] ${tag} ${SafeJson(fields)}`);
    } catch {
        /* diagnostics must never break a request */
    }
}
