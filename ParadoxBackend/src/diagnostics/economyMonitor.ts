/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";
import { GetRequestId } from "../observability/requestContext.js";

/*
 * [diagnostics 2026-10-10] Always-on economy monitors - low volume, greppable, never throw.
 *
 *   [PrestigeMon]  grants of prestige-gated reward currencies (the hunt server asks for 400
 *                  CURRENCY_SEASONAL_COIN twice per kill and the backend rejects them for lack of
 *                  banked season progress), the season-track progress the backend serves, and the
 *                  progress the hunt server reports for those tracks.
 *   [DraftMon]     bounty draft tokens (TOKEN_DAILY/WEEKLY_CHALLENGE_DRAFT[_PREMIUM]) - every Ramsgate
 *                  arrival wrote them up and back down while bounties were not stored - and the bounty
 *                  saves/loads around them, with the stored counts after each (src/bountyState.ts).
 *
 * Unlike [INV-CAP] (diagnostics/capture.ts, off by default) these stay on: they only fire for the
 * few catalog ids above. MYSTICPARADOX_ECONOMY_MONITOR=off silences both.
 */

const ENABLED = !/^(0|false|off|no)$/i.test(process.env.MYSTICPARADOX_ECONOMY_MONITOR ?? "");

const DRAFT_TOKEN_PATTERN = /^TOKEN_(DAILY|WEEKLY)_CHALLENGE_DRAFT(_PREMIUM)?$/;

export function IsDraftToken(catalogId: unknown): boolean {
    return typeof catalogId === "string" && DRAFT_TOKEN_PATTERN.test(catalogId);
}

export type MonitorSource = "gs" | "host" | "player";

export function MonitorSourceOf(authData: any): MonitorSource {
    if (authData?.IsGameserver === true) return "gs";
    if (authData?.IsPlayerHostRuntime === true) return "host";
    return "player";
}

function ToArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

function Pick(items: unknown, predicate: (catalogId: string) => boolean): string {
    const Parts: string[] = [];
    for (const Item of ToArray(items)) {
        if (Item == undefined || typeof Item.catalogId !== "string" || !predicate(Item.catalogId)) continue;
        Parts.push(`${Item.catalogId} x${Item.quantity ?? "?"}`);
    }
    return `[${Parts.join(", ")}]`;
}

function Touches(predicate: (catalogId: string) => boolean, ...arrays: unknown[]): boolean {
    return arrays.some((Arr) => ToArray(Arr).some((Item) => typeof Item?.catalogId === "string" && predicate(Item.catalogId)));
}

function Safe(action: () => void): void {
    if (!ENABLED) return;
    try {
        action();
    } catch {
        /* a monitor must never break a request */
    }
}

function PickAll(items: unknown): string {
    return Pick(items, () => true);
}

/**
 * [GrantMon] One line per server-issued POST /inventory that grants or spends anything: the transaction id, the game's
 * own `source` string when the body carries one (the 1.14.7 transaction builder FUN_140dbb560 writes `source` and
 * `transactionId` from its fourth argument), and every stacked/instanced add and remove. Pure item saves are skipped.
 * Pairs with the runtime's [GrantTrace] hook on the same builder, which logs the native caller of each transaction.
 */
export function MonitorGrant(authData: any, userId: string | undefined, transactionId: string | undefined, body: any): void {
    Safe(() => {
        const Source = MonitorSourceOf(authData);
        if (Source === "player") return;
        const Moves = ["addStackedItems", "removeStackedItems", "addInstancedItems", "removeInstancedItems"]
            .some((Key) => ToArray(body?.[Key]).length > 0);
        if (!Moves) return;
        const GameSource = typeof body?.source === "string" ? body.source.slice(0, 160) : "-";
        const Instanced = (Key: string) => `[${ToArray(body?.[Key]).map((Item) => Item?.catalogId ?? "?").join(", ")}]`;
        logger.info(`[GrantMon] txn=${transactionId ?? "?"} user=${userId ?? "?"} src=${Source} source="${GameSource}"`
            + ` add=${PickAll(body?.addStackedItems)} remove=${PickAll(body?.removeStackedItems)}`
            + ` addInstanced=${Instanced("addInstancedItems")} removeInstanced=${Instanced("removeInstancedItems")}`);
    });
}

export interface MonitoredInventoryRequest {
    requestId?: string;
    transactionId?: string;
    userId?: string;
    source: MonitorSource;
    addStackedItems?: unknown;
    removeStackedItems?: unknown;
}

// Call once per POST /inventory, before the transaction runs. `isPrestigeReward` comes from wallet.ts so
// this module needs no game data. Returns which monitors the request belongs to, for the outcome call.
export function MonitorInventoryRequest(req: MonitoredInventoryRequest, isPrestigeReward: (catalogId: string) => boolean): { prestige: boolean; draft: boolean } {
    const Flags = { prestige: false, draft: false };
    Safe(() => {
        Flags.prestige = Touches(isPrestigeReward, req.addStackedItems);
        Flags.draft = Touches(IsDraftToken, req.addStackedItems, req.removeStackedItems);
        const Head = `txn=${req.transactionId ?? "?"} req=${req.requestId ?? GetRequestId() ?? "?"} user=${req.userId ?? "?"} src=${req.source}`;
        if (Flags.prestige) {
            logger.info(`[PrestigeMon] GRANT-REQUEST ${Head} add=${Pick(req.addStackedItems, isPrestigeReward)} others=${Pick(req.addStackedItems, (Id) => !isPrestigeReward(Id))}`);
        }
        if (Flags.draft) {
            logger.info(`[DraftMon] INVENTORY-REQUEST ${Head} add=${Pick(req.addStackedItems, IsDraftToken)} remove=${Pick(req.removeStackedItems, IsDraftToken)}`);
        }
    });
    return Flags;
}

// The outcome of a monitored transaction: the result's draft-token quantities (after) or the rejection.
export function MonitorInventoryOutcome(flags: { prestige: boolean; draft: boolean }, transactionId: string | undefined, result: any, error?: unknown): void {
    if (!flags.prestige && !flags.draft) return;
    Safe(() => {
        const Outcome = error != undefined
            ? `REJECTED ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
            : "OK";
        if (flags.prestige) logger.info(`[PrestigeMon] GRANT-OUTCOME txn=${transactionId ?? "?"} ${Outcome}`);
        if (flags.draft) {
            const After = error != undefined ? "" : ` after=${Pick(result?.updatedStackedItems, IsDraftToken)}`;
            logger.info(`[DraftMon] INVENTORY-OUTCOME txn=${transactionId ?? "?"} ${Outcome}${After}`);
        }
    });
}

export interface PrestigeSourceState {
    progressionId: string;
    progress: number;
    xpPerLevel: number;
    rewardQuantityPerLevel: number;
    confirmedFremiumRank?: number;
    confirmedPremiumRank?: number;
}

// Called by wallet.ts's SpendBankedPrestigeForReward with every eligible source track it read.
export function MonitorPrestigeFunding(userId: string, catalogId: string, quantity: number, sources: PrestigeSourceState[], decision: string): void {
    Safe(() => {
        const Rows = sources
            .filter((Source, Index) => Index === 0 || Source.progress > 0)   // the active season plus any track with progress
            .map((Source) => `${Source.progressionId}{progress=${Source.progress} xpPerLevel=${Source.xpPerLevel} banked=${Math.floor(Source.progress / Source.xpPerLevel)}x${Source.rewardQuantityPerLevel} ranks=${Source.confirmedFremiumRank ?? "-"}/${Source.confirmedPremiumRank ?? "-"}}`);
        logger.info(`[PrestigeMon] FUNDING user=${userId} reward=${catalogId} x${quantity} decision=${decision} sources(${sources.length})=[${Rows.join(" ")}]`);
    });
}

// POST /progression/:userId - what the hunt server reports for the prestige source tracks (diagnostics-only
// route: these numbers are never stored, which is why nothing is ever banked).
export function MonitorProgressionReport(userId: string, source: MonitorSource, body: any, isPrestigeSourceTrack: (progressionId: string) => boolean): void {
    Safe(() => {
        const Tracks = ToArray(body?.progress_tracks)
            .filter((Track) => typeof Track?.progression_id === "string" && isPrestigeSourceTrack(Track.progression_id))
            .map((Track) => `${Track.progression_id}=${Track.progress}`);
        if (Tracks.length === 0) return;
        logger.info(`[PrestigeMon] REPORT user=${userId} src=${source} tracks=[${Tracks.join(", ")}] objectives=${ToArray(body?.objectives).length}`);
    });
}

// GET /progression/:userId - the stored values for the prestige source tracks the hunt server will start from.
export function MonitorProgressionServed(userId: string, payload: any[], isPrestigeSourceTrack: (progressionId: string) => boolean): void {
    Safe(() => {
        const Rows = ToArray(payload)
            .filter((Row) => typeof Row?.progression_id === "string" && isPrestigeSourceTrack(Row.progression_id))
            .filter((Row, Index) => Index === 0 || Number(Row.progress) > 0)
            .map((Row) => `${Row.progression_id}{progress=${Row.progress} ranks=${Row.confirmed_fremium_rank}/${Row.confirmed_premium_rank}}`);
        if (Rows.length === 0) return;
        logger.info(`[PrestigeMon] SERVED user=${userId} [${Rows.join(" ")}]`);
    });
}

function DraftDataSummary(value: any): string {
    if (value == undefined || typeof value !== "object") return "-";
    return `choices=${ToArray(value.current_draft_choices).length} previous=${ToArray(value.previous_draft_selections).length}`
        + ` b/s/g=${value.bronze_count ?? "?"}/${value.silver_count ?? "?"}/${value.gold_count ?? "?"}`;
}

const RawBountySaveBudget = { remaining: 8 };

function BountySummary(bounty: any): string {
    const Progress = ToArray(bounty?.objectives).map((Objective) => Objective?.progress ?? "?").join("/");
    return `${bounty?.bounty_id ?? "?"}{p=${Progress} claimed=${bounty?.claimed === true ? 1 : 0}}`;
}

// POST /bounty/:userId - what the server saved and what the store holds afterwards (`outcome`, from routes/system.ts).
export function MonitorBountySave(userId: string, source: MonitorSource, body: any, outcome: string): void {
    Safe(() => {
        const Bounties = ToArray(body?.bounties);
        const Ids = Bounties.slice(0, 6).map(BountySummary);
        const Claimed = Bounties.filter((Bounty) => Bounty?.claimed === true).length;
        logger.info(`[DraftMon] BOUNTY-SAVE user=${userId} src=${source} keys=[${Object.keys(body ?? {}).join(", ")}]`
            + ` bounties=${Bounties.length}(claimed ${Claimed})[${Ids.join(", ")}${Bounties.length > 6 ? ", ..." : ""}] daily{${DraftDataSummary(body?.draft_data_daily)}}`
            + ` weekly{${DraftDataSummary(body?.draft_data_weekly)}} base{${DraftDataSummary(body?.draft_data)}} => ${outcome}`);
        if (RawBountySaveBudget.remaining > 0) {
            RawBountySaveBudget.remaining--;
            logger.info(`[DraftMon] BOUNTY-SAVE-RAW user=${userId} ${JSON.stringify(body ?? {}).slice(0, 3000)}`);
        }
    });
}

// [CooldownMon] GET /cooldown and PUT /cooldown/batch (src/cooldownState.ts): every id with its start date, and the raw
// body of the first 8 saves per process (no live capture of these endpoints exists).
const RawCooldownSaveBudget = { remaining: 8 };

function CooldownList(entries: unknown): string {
    return `[${ToArray(entries).map((Entry) => `${Entry?.cooldown_id ?? "?"}@${Entry?.cooldown_started_date ?? "?"}`).join(", ")}]`;
}

export function MonitorCooldownSave(userId: string, source: MonitorSource, body: any, outcome: string): void {
    Safe(() => {
        const Entries = Array.isArray(body) ? body : body?.cooldowns;
        logger.info(`[CooldownMon] SAVE user=${userId} src=${source} keys=[${Object.keys(body ?? {}).join(", ")}] cooldowns=${CooldownList(Entries)} => ${outcome}`);
        if (RawCooldownSaveBudget.remaining > 0) {
            RawCooldownSaveBudget.remaining--;
            logger.info(`[CooldownMon] SAVE-RAW user=${userId} ${JSON.stringify(body ?? {}).slice(0, 2000)}`);
        }
    });
}

export function MonitorCooldownLoad(userId: string, source: MonitorSource, served: unknown, detail: string): void {
    Safe(() => logger.info(`[CooldownMon] LOAD user=${userId} src=${source} served=${CooldownList(served)} (${detail})`));
}

export function MonitorBountyLoad(userId: string, source: MonitorSource, served: string): void {
    Safe(() => logger.info(`[DraftMon] BOUNTY-LOAD user=${userId} src=${source} served=${served}`));
}
