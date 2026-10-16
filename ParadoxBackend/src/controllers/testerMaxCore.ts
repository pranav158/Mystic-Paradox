/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";

// [2026-10-14, launch plan section 5] "Max this tester account": a kit of grants for an account with the tester role, run through
// the normal ledgers and never by editing documents. The kit file is game-data/tester_max_kit.json (the example is committed).
//   progression  set-to-target XP per approved track, through the progression grant ledger (GrantProgressionXp), one grant per
//                absolute XP block of MAX_PROGRESSION_GRANT_AMOUNT, so a repeat plans the same grant ids.
//   inventory    stacked adds by catalog id (instanced items are minted by the storage policy), one inventory transaction.
//   currencies   CURRENCY_* adds in the same inventory transaction as inventory. The Platinum aggregate is refused (grant a
//                storefront bucket). [2026-10-16] A prestige-gated reward currency (the Reward Cache coin) is credited without
//                banked prestige (InventoryTransactionOptions.operatorTestFunding).
// Every grant carries the economy source OPERATOR_TEST, which the activity monitor and the economy monitor do not count.
// [2026-10-16, owner] No Slayer's Path section any more: a tester unlocks it in game. Its unlockAll wrote ids the 1.14.7 client
// lacks and sent the player back to the login screen (SteamDocs/RAMSGATE_KICK_AFTER_TESTER_MAX_2026_10_16.md).
//
// Idempotency: a call names its runId (8-64 characters, [A-Za-z0-9._-]). Every ledger id is derived from the runId and the
// grant's position (DeriveTesterMaxId), so repeating a call with the same runId replays its ledger rows instead of granting
// again. XP is set-to-target: a new runId tops a track up to its target and grants nothing above it. The sections are
// independent: a failing section does not stop the others, and re-running the same runId finishes what is left.
//
// This file is pure apart from the ledgers it is given (TesterMaxDeps). controllers/testerMax.ts supplies the real ones.

export const TESTER_MAX_ECONOMY_SOURCE = "OPERATOR_TEST";
export const TESTER_MAX_KIT_FILE = "tester_max_kit.json";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
const MAX_PROGRESSION_ENTRIES = 50;
const MAX_TARGET_XP = 10_000_000;
const MAX_INVENTORY_ENTRIES = 200;
const MAX_ITEM_QUANTITY = 1_000;
const MAX_CURRENCY_ENTRIES = 50;
const MAX_CURRENCY_QUANTITY = 10_000_000;
const KIT_SECTIONS: readonly string[] = ["comment", "progression", "inventory", "currencies"];

export interface TesterMaxKit {
    comment?: string;
    progression?: Array<{ progressionId: string; targetProgress: number | "max" }>;
    inventory?: Array<{ catalogId: string; quantity: number }>;
    currencies?: Array<{ catalogId: string; quantity: number }>;
}

/** What the kit may name, from the progression config, the inventory storage policy and the wallet. */
export interface TesterMaxKitChecks {
    isApprovedXpTrack(progressionId: string): boolean;
    /** XP to the top regular rank, or undefined when the track has none (prestige tracks). */
    trackCapXp(progressionId: string): number | undefined;
    /** [2026-10-16] The rank a track's progress reaches on its curve (undefined for an unknown track). */
    rankForProgress(progressionId: string, progress: number): number | undefined;
    /** The id is in the inventory storage policy (which lists every id the game data references). */
    isKnownCatalogId(catalogId: string): boolean;
    /** The aggregate CURRENCY_PLATINUM: a view over the storefront buckets, so the kit names a bucket instead. */
    isPlatinumAggregate(catalogId: string): boolean;
    /** Largest single XP grant the ledger accepts. */
    maxXpGrant: number;
}

/** The ledgers the run uses. The real ones are in controllers/testerMax.ts; tests pass fakes. */
export interface TesterMaxDeps {
    findCharacterId(userId: string): Promise<string | undefined>;
    readTrackProgress(userId: string, progressionId: string): Promise<number>;
    grantXp(userId: string, progressionId: string, amount: number, grantId: string, economySource: string): Promise<unknown>;
    /**
     * [2026-10-16] Confirms a rank the track's XP qualifies for (the game's own confirm, ConfirmPublicProgressionRank; it never
     * lowers one). XP granted outside a game session is never confirmed by the game: a tester's weapons sat at 27,775 XP with rank
     * 0 confirmed, a state normal play never produces, and the player was sent back to the login screen right after Ramsgate.
     */
    confirmRank(userId: string, progressionId: string, rank: number): Promise<void>;
    /** One inventory transaction; a prestige-gated reward currency in it is operator-funded (no banked prestige is spent). */
    runInventory(userId: string, characterId: string, transactionId: string,
        stackedAdds: Array<{ catalogId: string; quantity: number }>, economySource: string): Promise<unknown>;
}

export interface TesterMaxInput {
    userId: string;
    runId: string;
    kit: TesterMaxKit;
    checks: TesterMaxKitChecks;
}

/** A refusal before anything was granted (its code is what the HTTP layer answers with). */
export class TesterMaxRefusal extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = "TesterMaxRefusal";
    }
}

export interface TesterMaxProgressionReport {
    progressionId: string;
    target: number;
    startProgress: number;
    granted: number;
    grants: number;
    /** [2026-10-16] The rank confirmed after the grants (the rank the track's progress reaches). */
    confirmedRank?: number;
    status: "done" | "error";
    error?: string;
}

export interface TesterMaxReport {
    runId: string;
    userId: string;
    characterId: string;
    status: "done" | "partial";
    progression: TesterMaxProgressionReport[];
    items?: { status: "done" | "error"; error?: string; stacks: number };
}

export interface XpGrantStep {
    /** The absolute XP block the step starts in (floor(start / maxGrant)); part of the grant id, so a repeat plans the same id. */
    index: number;
    amount: number;
}

export function IsValidTesterMaxRunId(value: unknown): value is string {
    return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

/** Deterministic ledger id for one grant of one run: `tmax-` and 40 hex characters (a valid progression grant id). */
export function DeriveTesterMaxId(runId: string, part: string): string {
    return `tmax-${crypto.createHash("sha256").update(`${runId}\0${part}`).digest("hex").slice(0, 40)}`;
}

/**
 * The XP grants that take a track from `current` to `target` (nothing when it is already there or above). Each grant stays inside
 * one absolute block of `maxGrant`, and its index is that block: the same current and target always give the same ids and amounts,
 * and a partly applied plan resumes on the same ids.
 */
export function PlanXpGrants(current: number, target: number, maxGrant: number): XpGrantStep[] {
    if (!Number.isSafeInteger(maxGrant) || maxGrant < 1) throw new Error("maxGrant must be a positive integer.");
    const Steps: XpGrantStep[] = [];
    let Start = Math.max(0, Math.floor(current));
    const End = Math.floor(target);
    while (Start < End) {
        const Index = Math.floor(Start / maxGrant);
        const Stop = Math.min(End, (Index + 1) * maxGrant);
        Steps.push({ index: Index, amount: Stop - Start });
        Start = Stop;
    }
    return Steps;
}

function IsPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Problems with a kit, as readable lines (empty = the kit can run). Pure: every catalog question goes through `checks`. */
export function ValidateTesterMaxKit(kit: unknown, checks: TesterMaxKitChecks): string[] {
    if (!IsPlainObject(kit)) return ["the kit must be a JSON object"];
    const Problems: string[] = [];
    for (const Key of Object.keys(kit)) {
        if (Key === "slayersPath") Problems.push(`slayersPath was removed (16 Oct): a tester unlocks the Slayer's Path in game`);
        else if (!KIT_SECTIONS.includes(Key)) Problems.push(`unknown section "${Key}"`);
    }
    if (kit.comment !== undefined && typeof kit.comment !== "string") Problems.push("comment must be a string");

    if (kit.progression !== undefined) {
        if (!Array.isArray(kit.progression) || kit.progression.length > MAX_PROGRESSION_ENTRIES) {
            Problems.push(`progression must be an array of at most ${MAX_PROGRESSION_ENTRIES} entries`);
        } else {
            const Seen = new Set<string>();
            kit.progression.forEach((Entry: unknown, Index: number) => {
                const At = `progression[${Index}]`;
                const Row = IsPlainObject(Entry) ? Entry : {};
                const Id = Row.progressionId;
                if (typeof Id !== "string" || !checks.isApprovedXpTrack(Id)) {
                    Problems.push(`${At}: "${String(Id)}" is not an approved XP track (progression config)`);
                } else if (Seen.has(Id)) {
                    Problems.push(`${At}: ${Id} is listed twice`);
                } else {
                    Seen.add(Id);
                }
                const Target = Row.targetProgress;
                if (Target === "max") {
                    if (typeof Id === "string" && checks.trackCapXp(Id) === undefined) {
                        Problems.push(`${At}: ${Id} has no top rank, so "max" is not defined for it; give a number`);
                    }
                } else if (!Number.isSafeInteger(Target) || (Target as number) < 1 || (Target as number) > MAX_TARGET_XP) {
                    Problems.push(`${At}: targetProgress must be "max" or an integer from 1 to ${MAX_TARGET_XP}`);
                }
            });
        }
    }

    if (kit.inventory !== undefined) {
        if (!Array.isArray(kit.inventory) || kit.inventory.length > MAX_INVENTORY_ENTRIES) {
            Problems.push(`inventory must be an array of at most ${MAX_INVENTORY_ENTRIES} entries`);
        } else {
            kit.inventory.forEach((Entry: unknown, Index: number) => {
                const At = `inventory[${Index}]`;
                const Row = IsPlainObject(Entry) ? Entry : {};
                const Id = Row.catalogId;
                if (typeof Id !== "string" || !checks.isKnownCatalogId(Id)) {
                    Problems.push(`${At}: "${String(Id)}" is not in the inventory storage policy (do not invent catalog ids)`);
                } else if (Id.startsWith("CURRENCY_")) {
                    Problems.push(`${At}: ${Id} is a currency; list it under currencies`);
                }
                if (!Number.isSafeInteger(Row.quantity) || (Row.quantity as number) < 1 || (Row.quantity as number) > MAX_ITEM_QUANTITY) {
                    Problems.push(`${At}: quantity must be an integer from 1 to ${MAX_ITEM_QUANTITY}`);
                }
            });
        }
    }

    if (kit.currencies !== undefined) {
        if (!Array.isArray(kit.currencies) || kit.currencies.length > MAX_CURRENCY_ENTRIES) {
            Problems.push(`currencies must be an array of at most ${MAX_CURRENCY_ENTRIES} entries`);
        } else {
            kit.currencies.forEach((Entry: unknown, Index: number) => {
                const At = `currencies[${Index}]`;
                const Row = IsPlainObject(Entry) ? Entry : {};
                const Id = Row.catalogId;
                if (typeof Id !== "string" || !Id.startsWith("CURRENCY_") || !checks.isKnownCatalogId(Id)) {
                    Problems.push(`${At}: "${String(Id)}" is not a known CURRENCY_* id`);
                } else if (checks.isPlatinumAggregate(Id)) {
                    Problems.push(`${At}: ${Id} is the Platinum aggregate; grant a storefront bucket (CURRENCY_PLATINUM_*) instead`);
                }
                if (!Number.isSafeInteger(Row.quantity) || (Row.quantity as number) < 1 || (Row.quantity as number) > MAX_CURRENCY_QUANTITY) {
                    Problems.push(`${At}: quantity must be an integer from 1 to ${MAX_CURRENCY_QUANTITY}`);
                }
            });
        }
    }

    return Problems;
}

function Describe(error: unknown): string {
    const Text = error instanceof Error ? error.message : String(error);
    return Text.slice(0, 200);
}

/** Runs a validated kit for one tester account. Throws TesterMaxRefusal only before anything is granted. */
export async function RunTesterMax(input: TesterMaxInput, deps: TesterMaxDeps): Promise<TesterMaxReport> {
    const { userId, runId, kit, checks } = input;
    if (!IsValidTesterMaxRunId(runId)) {
        throw new TesterMaxRefusal("ADMIN_TESTER_MAX_RUN_ID", "runId must be 8 to 64 characters: letters, digits, dot, underscore or hyphen.");
    }
    const characterId = await deps.findCharacterId(userId);
    if (characterId === undefined) {
        throw new TesterMaxRefusal("ADMIN_TESTER_MAX_NO_CHARACTER", "The tester has no character yet; the account must sign in to the game once first.");
    }

    const Report: TesterMaxReport = { runId, userId, characterId, status: "done", progression: [] };

    for (const Entry of kit.progression ?? []) {
        const Row: TesterMaxProgressionReport = {
            progressionId: Entry.progressionId, target: 0, startProgress: 0, granted: 0, grants: 0, status: "done"
        };
        Report.progression.push(Row);
        try {
            const Start = await deps.readTrackProgress(userId, Entry.progressionId);
            const Target = Entry.targetProgress === "max" ? checks.trackCapXp(Entry.progressionId) : Entry.targetProgress;
            if (Target === undefined) throw new Error("the track has no top rank");
            Row.startProgress = Start;
            Row.target = Target;
            for (const Step of PlanXpGrants(Start, Target, checks.maxXpGrant)) {
                const GrantId = DeriveTesterMaxId(runId, `xp:${Entry.progressionId}:${Step.index}`);
                await deps.grantXp(userId, Entry.progressionId, Step.amount, GrantId, TESTER_MAX_ECONOMY_SOURCE);
                Row.granted += Step.amount;
                Row.grants += 1;
            }
            // [2026-10-16] Confirm the rank the track now reaches, as the game does after a level-up (also on a replay: it never lowers).
            const Reached = checks.rankForProgress(Entry.progressionId, Math.max(Start, Target));
            if (Reached !== undefined && Reached > 0) {
                await deps.confirmRank(userId, Entry.progressionId, Reached);
                Row.confirmedRank = Reached;
            }
        } catch (Err) {
            Row.status = "error";
            Row.error = Describe(Err);
            Report.status = "partial";
        }
    }

    // Items and currencies: one transaction, stacks merged by catalog id.
    const Stacks = new Map<string, number>();
    for (const Entry of [...(kit.inventory ?? []), ...(kit.currencies ?? [])]) {
        Stacks.set(Entry.catalogId, (Stacks.get(Entry.catalogId) ?? 0) + Entry.quantity);
    }
    if (Stacks.size > 0) {
        const Adds = [...Stacks.keys()].sort().map((CatalogId) => ({ catalogId: CatalogId, quantity: Stacks.get(CatalogId) ?? 0 }));
        try {
            const Applied = await deps.runInventory(userId, characterId, DeriveTesterMaxId(runId, "items"), Adds, TESTER_MAX_ECONOMY_SOURCE);
            if (!Applied) throw new Error("the inventory transaction did not apply");
            Report.items = { status: "done", stacks: Adds.length };
        } catch (Err) {
            Report.items = { status: "error", error: Describe(Err), stacks: Adds.length };
            Report.status = "partial";
        }
    }

    return Report;
}
