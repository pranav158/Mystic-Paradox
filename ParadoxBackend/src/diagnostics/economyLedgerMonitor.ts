/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";
import { tryLoadGameData } from "../gameData/loader";
import { GetRepositories } from "../persistence";
import type { EconomyRollupKey, EconomyRollupRepository } from "../persistence/contracts/EconomyRollupRepository";
import { IsPlatinumCatalogId, PLATINUM_AGGREGATE_ID } from "../platinumWallet";

/*
 * [diagnostics 2026-10-14] Economy ledger monitor: every Platinum credit and spend, and every Hunt Pass reward, per source.
 * Monitoring only. Nothing here refuses, limits or changes a grant: the lines are written after the grant's transaction has
 * committed, and the daily rollup is a fire-and-forget write whose failure is only logged (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md
 * section 9, decision 5). MYSTICPARADOX_ECONOMY_MONITOR=off silences all of it (read once at startup).
 *
 *   [PlatMon] credit  user= amount= balanceAfter= source= ref=       one per Platinum credit (any bucket; balance = all buckets)
 *   [PlatMon] spend   user= amount= balanceAfter= source= for= session= host= ref=   one per transaction that spends Platinum
 *   [PlatMon] FLAG    ...      a day's credited or spent Platinum crossed MYSTICPARADOX_PLAT_DAILY_FLAG / _SPEND_FLAG
 *   [HuntPassMon] reward user= item= amount= source= ref=          one per Hunt Pass reward that is not Platinum
 *   [HuntPassMon] FLAG ...   a day's CURRENCY_SEASONAL_COIN crossed MYSTICPARADOX_SEASONAL_COIN_DAILY_FLAG
 *
 * Source: the caller says where a transaction came from (EconomyScope). A Hunt Pass reward is classed HUNT_PASS whatever
 * transaction carried it, except a challenge-funded coin (QUEST) and a store or operator grant, because the game sends its
 * rank rewards in ordinary inventory transactions and only the catalogue says which items are Hunt Pass rewards.
 * The rollup collection is `economyDaily`: _id `${userId}:${day}:${currency}`, see EconomyRollupRepository.
 */

// [2026-10-14] OPERATOR_TEST: a test grant (a future max-tester-account tool). The activity monitor ignores it (activity/activityRules.ts).
export const ECONOMY_SOURCES = ["STORE", "OPERATOR", "OPERATOR_TEST", "QUEST", "HUNT_PASS", "INVENTORY_GAMESERVER", "INVENTORY_HOST", "OTHER"] as const;
export type EconomySource = (typeof ECONOMY_SOURCES)[number];
// [2026-10-14 P5.1] Test grants (controllers/testerMaxCore.ts) are not monitored: nothing is logged, rolled up or flagged for them.
// The activity monitor ignores the same source (activity/activityRules.ts ACTIVITY_IGNORED_SOURCE).

/** Where a transaction came from. `storeSkuId` is the store purchase's SKU (named as `for=`); the P2P fields name a player-host transaction. */
export interface EconomyScope {
    source: EconomySource;
    storeSkuId?: string;
    p2pSessionId?: string;
    hostAccountId?: string;
}

export interface EconomyMonitorSettings {
    enabled: boolean;
    platinumDailyCreditFlag: number;
    platinumDailySpendFlag: number;
    seasonalCoinDailyFlag: number;
    /** [XpMon] (p2p/observability/huntXpMonitor.ts): weapon + player XP per minute of one hunt member. */
    xpPerMinuteFlag: number;
}

/** Storage keeps a rollup about this long (the Mongo TTL and the SQLite purge both read ttlAt). */
export const ECONOMY_ROLLUP_TTL_MS = 400 * 24 * 60 * 60 * 1000;
export const SEASONAL_COIN_CURRENCY = "CURRENCY_SEASONAL_COIN";
/** Rollup currency of every Platinum bucket: the account's Platinum across storefronts. */
export const PLATINUM_ROLLUP_CURRENCY = PLATINUM_AGGREGATE_ID;

// The XP default is about ten times a normal pace: one kill a minute pays ~98 weapon + ~98 player XP (13 Oct measurements, the
// largest real grant 225), so ~200 a minute is typical and 2000 is well above anything a real hunt sustains. Per-hunt XP has
// no limit by owner decision; this only flags it for review.
const FLAG_DEFAULTS = { platinumDailyCreditFlag: 5000, platinumDailySpendFlag: 5000, seasonalCoinDailyFlag: 1000, xpPerMinuteFlag: 2000 };

function ReadThreshold(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const Raw = env[name]?.trim();
    if (Raw === undefined || Raw === "") return fallback;
    const Value = Number(Raw);
    if (!Number.isFinite(Value) || Value < 0) {
        logger.warn(`[PlatMon] ${name}=${JSON.stringify(Raw.slice(0, 40))} is not a non-negative number; using ${fallback}`);
        return fallback;
    }
    return Value;
}

/** The monitor's settings from the environment (pure: tests pass their own map). */
export function ReadEconomyMonitorSettings(env: NodeJS.ProcessEnv = process.env): EconomyMonitorSettings {
    return {
        enabled: !/^(0|false|off|no)$/i.test(env.MYSTICPARADOX_ECONOMY_MONITOR ?? ""),
        platinumDailyCreditFlag: ReadThreshold(env, "MYSTICPARADOX_PLAT_DAILY_FLAG", FLAG_DEFAULTS.platinumDailyCreditFlag),
        platinumDailySpendFlag: ReadThreshold(env, "MYSTICPARADOX_PLAT_DAILY_SPEND_FLAG", FLAG_DEFAULTS.platinumDailySpendFlag),
        seasonalCoinDailyFlag: ReadThreshold(env, "MYSTICPARADOX_SEASONAL_COIN_DAILY_FLAG", FLAG_DEFAULTS.seasonalCoinDailyFlag),
        xpPerMinuteFlag: ReadThreshold(env, "MYSTICPARADOX_XP_PER_MINUTE_FLAG", FLAG_DEFAULTS.xpPerMinuteFlag),
    };
}

const SETTINGS: EconomyMonitorSettings = ReadEconomyMonitorSettings();

/** The settings the process started with (read once). */
export function CurrentEconomyMonitorSettings(): EconomyMonitorSettings {
    return SETTINGS;
}

// ---- classification (pure apart from the cached game-data read) ----

/** Platinum in any of its buckets, or the aggregate id a store price resolves to. */
export function IsPlatinumMovement(catalogId: string): boolean {
    return catalogId === PLATINUM_AGGREGATE_ID || IsPlatinumCatalogId(catalogId);
}

// The Hunt Pass's own currencies and tokens. Mirrors the HUNT_PASS class of p2p/security/hostGrantPolicy.ts (a copy, because
// core code must not import the P2P module); the catalogue-driven part is the rewards below.
const HUNT_PASS_IDS = new Set(["CURRENCY_SEASONAL_COIN", "CURRENCY_REWARDCACHE", "CURRENCY_PRESTIGE", "GRANTPROGRESSITEM_HUNTPASS"]);
const HUNT_PASS_PATTERNS: RegExp[] = [/^CURRENCY_S\d+_(COIN|DAILY)$/, /^TOKEN_HUNT_?PASS/, /^CONTAINER_CORE_PRESTIGE_/];
// Season and minipass tracks are the passes; weapon tracks have prestige rewards but are not passes.
const PASS_TRACK = /^(season|minipass|test_minipass)/i;

function AddRewardGroups(into: Set<string>, groups: unknown): void {
    const List = Array.isArray(groups) ? groups : groups != undefined ? [groups] : [];
    for (const Group of List) {
        for (const Item of (Group as any)?.stacked_items ?? []) {
            if (typeof Item?.catalog_id === "string" && Item.catalog_id.length > 0) into.add(Item.catalog_id);
        }
    }
}

/**
 * The catalog ids a Hunt Pass pays (pure): the rank rewards (free and premium) of every pass track, and the prestige rewards
 * of every track. Read from game-data/progression_config.json.
 */
export function CollectHuntPassRewardIds(progression: any): Set<string> {
    const Ids = new Set<string>();
    for (const Path of progression?.payload?.paths ?? []) {
        if (PASS_TRACK.test(String(Path?.progression_id ?? ""))) {
            AddRewardGroups(Ids, Path?.free_rewards);
            AddRewardGroups(Ids, Path?.premium_rewards);
        }
        AddRewardGroups(Ids, Path?.prestige?.free_rewards);
        AddRewardGroups(Ids, Path?.prestige?.premium_rewards);
    }
    return Ids;
}

let RewardIdsCache: ReadonlySet<string> | undefined;

/** The catalogue's Hunt Pass rewards, read once; a missing file leaves only the fixed ids and patterns. */
export function DefaultHuntPassRewardIds(): ReadonlySet<string> {
    if (RewardIdsCache == undefined) {
        let Progression: unknown;
        try {
            Progression = tryLoadGameData<any>("progression_config.json");
        } catch {
            Progression = undefined;
        }
        RewardIdsCache = CollectHuntPassRewardIds(Progression);
    }
    return RewardIdsCache;
}

/** Whether a catalog id is a Hunt Pass reward (coins, tokens, rank and prestige rewards). */
export function IsHuntPassRewardId(catalogId: string, rewardIds: ReadonlySet<string> = DefaultHuntPassRewardIds()): boolean {
    return HUNT_PASS_IDS.has(catalogId) || HUNT_PASS_PATTERNS.some((Pattern) => Pattern.test(catalogId)) || rewardIds.has(catalogId);
}

/**
 * The source a credit is logged and rolled up under. A challenge-funded coin is QUEST; a store or operator transaction keeps
 * its own source; any other Hunt Pass reward is HUNT_PASS; everything else keeps the transaction's source.
 */
export function CreditSourceOf(catalogId: string, scope: EconomyScope, challengeFunded: boolean,
    rewardIds: ReadonlySet<string> = DefaultHuntPassRewardIds()): EconomySource {
    if (challengeFunded) return "QUEST";
    if (scope.source === "STORE" || scope.source === "OPERATOR") return scope.source;
    if (IsHuntPassRewardId(catalogId, rewardIds)) return "HUNT_PASS";
    return scope.source;
}

// ---- log text (pure) ----

const MAX_FOR_ITEMS = 8;

/** A catalog id or session/account id as it may appear in a log line: plain when it is simple, quoted otherwise (no forged lines). */
export function LogToken(value: unknown): string {
    const Text = value == undefined ? "-" : String(value);
    return /^[A-Za-z0-9_.:-]{1,128}$/.test(Text) ? Text : JSON.stringify(Text.slice(0, 64));
}

/** `for=` for a transaction's grants: the first eight `id:quantity` pairs, then `+n more`. A store purchase names its SKU instead. */
export function FormatGrantedItems(items: ReadonlyArray<{ catalogId: string; quantity: number }>): string {
    if (items.length === 0) return "-";
    const Shown = items.slice(0, MAX_FOR_ITEMS).map((Item) => `${LogToken(Item.catalogId)}:${Number(Item.quantity)}`);
    return Shown.join(",") + (items.length > MAX_FOR_ITEMS ? `,+${items.length - MAX_FOR_ITEMS} more` : "");
}

/** Crossed in this write: the day total was at or under the threshold before it and is over it after. */
export function FlagCrossed(totalAfter: number, delta: number, threshold: number): boolean {
    const Before = totalAfter - delta;
    return Before <= threshold && totalAfter > threshold;
}

// ---- rollup writes ----

let RollupStoreOverride: Pick<EconomyRollupRepository, "addToRollup"> | undefined;

/** Tests: write the rollups to this store (undefined uses the configured persistence provider again). */
export function UseEconomyRollupStoreForTest(store: Pick<EconomyRollupRepository, "addToRollup"> | undefined): void {
    RollupStoreOverride = store;
}

const PendingRollups = new Set<Promise<void>>();

/** Resolves once every rollup write started so far has finished (or failed, which is only logged). Used before a process exits, and by tests. */
export async function WaitForEconomyRollups(): Promise<void> {
    while (PendingRollups.size > 0) await Promise.all([...PendingRollups]);
}

function WriteRollup(key: EconomyRollupKey, increments: Record<string, number>, ttl: Date, label: string,
    onWritten: (after: Record<string, any>) => void): void {
    const Work: Promise<void> = (async () => {
        const Store = RollupStoreOverride ?? GetRepositories().economyRollups;
        const After = await Store.addToRollup(key, increments, ttl);
        onWritten(After);
    })().catch((Err) => {
        logger.warn(`${label} rollup not stored user=${LogToken(key.userId)} day=${key.day} currency=${key.currency}: ${String(Err)}`);
    });
    PendingRollups.add(Work);
    void Work.then(() => { PendingRollups.delete(Work); });
}

// ---- the per-transaction ledger ----

export interface GrantedItem { catalogId: string; quantity: number }

export interface EconomyLedgerInit {
    userId: string;
    transactionId?: string;
    scope: EconomyScope;
    /** What the transaction granted (the `for=` list for everything but a store purchase). */
    granted: ReadonlyArray<GrantedItem>;
    settings?: EconomyMonitorSettings;
    rewardIds?: ReadonlySet<string>;
}

/**
 * Collects one transaction's Platinum credits and spends and its Hunt Pass rewards while it runs. Nothing is logged or
 * stored until commit(), which the caller runs after the transaction committed (a retried transaction starts a fresh ledger).
 */
export class EconomyLedger {
    private readonly credits: { catalogId: string; amount: number; balanceAfter: number; source: EconomySource }[] = [];
    private readonly rewards: { catalogId: string; amount: number; source: EconomySource }[] = [];
    private spent = 0;
    private spentBalanceAfter = 0;
    private readonly settings: EconomyMonitorSettings;
    private readonly rewardIds: ReadonlySet<string>;

    constructor(private readonly init: EconomyLedgerInit) {
        this.settings = init.settings ?? SETTINGS;
        this.rewardIds = init.rewardIds ?? DefaultHuntPassRewardIds();
    }

    /** A Platinum credit of one bucket; `balanceAfter` is the account's Platinum across all buckets after it. */
    recordPlatinumCredit(catalogId: string, amount: number, balanceAfter: number, challengeFunded = false): void {
        if (!(amount > 0)) return;
        this.credits.push({ catalogId, amount, balanceAfter, source: CreditSourceOf(catalogId, this.init.scope, challengeFunded, this.rewardIds) });
    }

    /** Platinum spent by this transaction (all its Platinum debits together); `balanceAfter` is the account's total after. */
    recordPlatinumSpend(amount: number, balanceAfter: number): void {
        if (!(amount > 0)) return;
        this.spent += amount;
        this.spentBalanceAfter = balanceAfter;
    }

    /** A credit of a Hunt Pass reward that is not Platinum (coins, tokens, prestige rewards). Other catalog ids are ignored. */
    recordReward(catalogId: string, amount: number, challengeFunded = false): void {
        if (!(amount > 0) || IsPlatinumMovement(catalogId)) return;
        if (!challengeFunded && !IsHuntPassRewardId(catalogId, this.rewardIds)) return;
        this.rewards.push({ catalogId, amount, source: CreditSourceOf(catalogId, this.init.scope, challengeFunded, this.rewardIds) });
    }

    get isEmpty(): boolean {
        return this.credits.length === 0 && this.spent === 0 && this.rewards.length === 0;
    }

    /** Logs every entry and starts the rollup writes. Never throws: a monitor must not break a grant that already committed. */
    commit(now: Date = new Date()): void {
        try {
            if (this.init.scope.source === "OPERATOR_TEST") return;
            if (!this.settings.enabled || this.isEmpty) return;
            const { userId, transactionId, scope } = this.init;
            const Day = now.toISOString().slice(0, 10);
            const Ttl = new Date(now.getTime() + ECONOMY_ROLLUP_TTL_MS);
            const Ref = LogToken(transactionId);
            const Key = (currency: string): EconomyRollupKey => ({ userId, day: Day, currency });

            const Platinum: Record<string, number> = {};
            const Add = (Into: Record<string, number>, Path: string, Amount: number) => { Into[Path] = (Into[Path] ?? 0) + Amount; };
            let CreditTotal = 0;
            for (const Credit of this.credits) {
                logger.info(`[PlatMon] credit user=${LogToken(userId)} amount=${Credit.amount} balanceAfter=${Credit.balanceAfter}`
                    + ` source=${Credit.source} ref=${Ref}`);
                CreditTotal += Credit.amount;
                Add(Platinum, "credited", Credit.amount);
                Add(Platinum, "count", 1);
                Add(Platinum, `bySource.${Credit.source}.credited`, Credit.amount);
                Add(Platinum, `bySource.${Credit.source}.count`, 1);
            }

            let SpendTotal = 0;
            if (this.spent > 0) {
                const Items = scope.source === "STORE" && scope.storeSkuId != undefined
                    ? [scope.storeSkuId]
                    : this.init.granted.map((Item) => Item.catalogId);
                const ForText = scope.source === "STORE" && scope.storeSkuId != undefined
                    ? LogToken(scope.storeSkuId)
                    : FormatGrantedItems(this.init.granted);
                logger.info(`[PlatMon] spend user=${LogToken(userId)} amount=${this.spent} balanceAfter=${this.spentBalanceAfter}`
                    + ` source=${scope.source} for=${ForText} session=${LogToken(scope.p2pSessionId ?? "-")}`
                    + ` host=${LogToken(scope.hostAccountId ?? "-")} ref=${Ref}`);
                SpendTotal = this.spent;
                Add(Platinum, "debited", this.spent);
                Add(Platinum, "count", 1);
                Add(Platinum, `bySource.${scope.source}.debited`, this.spent);
                Add(Platinum, `bySource.${scope.source}.count`, 1);
                // By item: the transaction counts once for each item it granted (the first eight, as in `for=`), and carries
                // its whole spend against each of them, so an item total is not a share of the spend.
                for (const Item of new Set(Items.slice(0, MAX_FOR_ITEMS).map((Id) => this.safeKey(Id)))) {
                    Add(Platinum, `byItem.${Item}.count`, 1);
                    Add(Platinum, `byItem.${Item}.debited`, this.spent);
                }
            }

            if (Object.keys(Platinum).length > 0) {
                WriteRollup(Key(PLATINUM_ROLLUP_CURRENCY), Platinum, Ttl, "[PlatMon]", (After) => {
                    if (CreditTotal > 0 && FlagCrossed(Number(After.credited) || 0, CreditTotal, this.settings.platinumDailyCreditFlag)) {
                        logger.warn(`[PlatMon] FLAG credit user=${LogToken(userId)} day=${Day} credited=${After.credited}`
                            + ` threshold=${this.settings.platinumDailyCreditFlag} (this transaction +${CreditTotal})`);
                    }
                    if (SpendTotal > 0 && FlagCrossed(Number(After.debited) || 0, SpendTotal, this.settings.platinumDailySpendFlag)) {
                        logger.warn(`[PlatMon] FLAG spend user=${LogToken(userId)} day=${Day} debited=${After.debited}`
                            + ` threshold=${this.settings.platinumDailySpendFlag} (this transaction -${SpendTotal})`);
                    }
                });
            }

            const RewardTotals = new Map<string, Record<string, number>>();
            for (const Reward of this.rewards) {
                logger.info(`[HuntPassMon] reward user=${LogToken(userId)} item=${LogToken(Reward.catalogId)} amount=${Reward.amount}`
                    + ` source=${Reward.source} ref=${Ref}`);
                const Into = RewardTotals.get(Reward.catalogId) ?? {};
                Add(Into, "credited", Reward.amount);
                Add(Into, "count", 1);
                Add(Into, `bySource.${Reward.source}.credited`, Reward.amount);
                Add(Into, `bySource.${Reward.source}.count`, 1);
                RewardTotals.set(Reward.catalogId, Into);
            }
            for (const [Currency, Increments] of RewardTotals) {
                const Added = Increments.credited ?? 0;
                WriteRollup(Key(Currency), Increments, Ttl, "[HuntPassMon]", (After) => {
                    if (Currency === SEASONAL_COIN_CURRENCY && FlagCrossed(Number(After.credited) || 0, Added, this.settings.seasonalCoinDailyFlag)) {
                        logger.warn(`[HuntPassMon] FLAG user=${LogToken(userId)} day=${Day} item=${Currency} credited=${After.credited}`
                            + ` threshold=${this.settings.seasonalCoinDailyFlag} (this transaction +${Added})`);
                    }
                });
            }
        } catch (Err) {
            logger.warn(`[PlatMon] economy ledger not recorded for ${LogToken(this.init.userId)}: ${String(Err)}`);
        }
    }

    /** A catalog id as a rollup field name: Mongo field names may not contain '.' or start with '$'. */
    private safeKey(catalogId: string): string {
        return /^[A-Za-z0-9_]{1,80}$/.test(catalogId) ? catalogId : "OTHER";
    }
}

/**
 * The ledger for one transaction, or undefined while the monitor is switched off (the caller then records nothing).
 * `settings` and `rewardIds` are for tests.
 */
export function NewEconomyLedger(init: EconomyLedgerInit): EconomyLedger | undefined {
    const Settings = init.settings ?? SETTINGS;
    if (!Settings.enabled) return undefined;
    return new EconomyLedger({ ...init, settings: Settings });
}

