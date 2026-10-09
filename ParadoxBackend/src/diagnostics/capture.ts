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

/*
 * [diagnostics] Reusable, flag-gated capture for inventory / store / economy iteration.
 *
 * This is intentionally separate from app.ts's raw MYSTICPARADOX_BODY_CAPTURE dump: it emits low-noise,
 * STRUCTURED, greppable lines (stable `[INV-CAP]` prefix) that decode a transaction into its
 * per-array item deltas, so an entire debugging session (core dupe, cell equip, currency spend,
 * store reconcile, ...) can be left on without drowning the log. OFF by default.
 *
 * Environment flags (all accept 1/true/on/yes):
 *   MYSTICPARADOX_INV_CAPTURE          enable [INV-CAP] structured capture
 *   MYSTICPARADOX_INV_CAPTURE_RAW      additionally dump the full JSON of each captured payload/result
 *   MYSTICPARADOX_INV_CAPTURE_FILTER   optional case-insensitive regex of catalogIds to focus on;
 *                                a transaction that touches NO matching catalogId is skipped
 *                                (e.g. "CONTAINER_CORE|CELLCORE" while chasing the core dupe,
 *                                 or "CELL_" while chasing cell-equip saves)
 *
 * Every entry point is wrapped so diagnostics can NEVER throw into a live transaction.
 */

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

// Cheap public gate so callers can skip building a context object when capture is off.
export function InventoryCaptureEnabled(): boolean {
    return CAPTURE_ENABLED;
}

function ToArray(value: any): any[] {
    return Array.isArray(value) ? value : [];
}

// Compact one-item summary: `catalogId xN` for stacked, `catalogId#instanceId` for instanced.
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
    gsKey?: boolean;         // x-mysticparadox-gameserver-apikey header present on the request
    isGameserver?: boolean;  // AuthData.IsGameserver (authoritative grant/spend authority)
    addInstancedItems?: any;
    addStackedItems?: any;
    removeInstancedItems?: any;
    removeStackedItems?: any;
    saveInstancedItems?: any;
    result?: any;
    error?: unknown;
}

// Structured capture of a single POST /inventory transaction phase. Call once per phase:
//   - "request" at the top of the route (shows exactly what the game/gameserver sent)
//   - "result"  after RunInventoryTransaction resolves (shows what the metagame actually changed)
//   - "error"   in the catch (conflict / mismatch / insufficient balance / unexpected)
export function CaptureInventoryTransaction(ctx: InventoryTransactionContext): void {
    if (!CAPTURE_ENABLED) return;
    try {
        const FocusIds = CatalogIdsOf(
            ctx.addInstancedItems, ctx.addStackedItems, ctx.removeInstancedItems, ctx.removeStackedItems, ctx.saveInstancedItems,
            ctx.result?.createdInstancedItems, ctx.result?.updatedStackedItems, ctx.result?.updatedInstancedItems, ctx.result?.removedInstancedItems,
        );
        // For request/result we can honor the focus filter; an error has no item arrays of its
        // own, so it is always logged (a transaction that errored is worth seeing regardless).
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

        // phase === "error"
        const Message = ctx.error instanceof Error ? `${ctx.error.name}: ${ctx.error.message}` : String(ctx.error);
        logger.info(`${Head} error=${Message}`);
    } catch {
        /* diagnostics must never break a transaction */
    }
}

// Generic structured capture for other inventory/store/economy touchpoints (single-item updates,
// store reconcile/balance, wallet deltas, future endpoints). Gated by the same MYSTICPARADOX_INV_CAPTURE
// flag so one switch turns the whole economy trace on/off.
export function CaptureEvent(tag: string, fields: Record<string, unknown>): void {
    if (!CAPTURE_ENABLED) return;
    try {
        logger.info(`[INV-CAP] ${tag} ${SafeJson(fields)}`);
    } catch {
        /* diagnostics must never break a request */
    }
}
