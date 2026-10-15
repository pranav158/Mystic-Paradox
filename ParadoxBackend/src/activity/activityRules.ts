/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { IsPlatinumMovement, ReadEconomyMonitorSettings, SEASONAL_COIN_CURRENCY } from "../diagnostics/economyLedgerMonitor";
import { VersionAtLeast } from "../security/launcherVersion";

// [2026-10-14] Activity monitor rules (pure: no database, no clock except the arguments). The stateful part is activityMonitor.ts.
//
// Daily row fields (one row per account and UTC day, counters only):
//   playtimeMinutes, sessions, hostingMinutes, huntsHosted
//   huntsStarted.<kind>, huntsCompleted.<kind>, huntsAbandoned.<kind>      kind: dedicated | realm | playerHosted
//   kills.<BEHEMOTH_TOKEN_SUFFIX>                                          from TOKEN_KILL_COUNT_<NAME> grants
//   xp.<progression track>                                                 from GrantProgressionXp (applied grants only)
//   itemsGained.<economy source>                                           non-currency items, kill counters excluded
//   currency.<catalog id>.credited / .debited                              wallet adds and removes
//   platinumSpendsByItem.<catalog id or store SKU>                         a transaction's Platinum spend, per item it granted
//   challengesClaimed, slayersPathUnlocks, reforges

/** Retention of every activity record (the Privacy Policy's statistics line; the Mongo TTL and the SQLite purge read ttlAt). */
export const ACTIVITY_RETENTION_DAYS = 400;
/** A gap of more than this between two presence touches ends the playtime session (the next touch starts a new one). */
export const ACTIVITY_SESSION_GAP_MS = 3 * 60 * 1000;
/** A kill grant is accepted for a dedicated hunt that ended up to this long before the grant (the hunt's last grants). */
export const ACTIVITY_HUNT_GRACE_MS = 10 * 60 * 1000;
/** A dedicated hunt is never longer than this; an older open record is not a hunt the account could be in. */
export const ACTIVITY_HUNT_MAX_MS = 6 * 60 * 60 * 1000;
/** Rate flags (kills, rewards, XP per minute) are judged only on at least this much playtime in the day. */
export const ACTIVITY_MIN_RATE_MINUTES = 15;
/** The most catalog ids of one transaction that get a platinumSpendsByItem entry (as the economy ledger's `for=` list does). */
export const ACTIVITY_MAX_ITEMS_PER_TRANSACTION = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The source of a test grant (a future "max tester account" tool). The monitor and the flags ignore it entirely. */
export const ACTIVITY_IGNORED_SOURCE = "OPERATOR_TEST";

export interface ActivitySettings {
    enabled: boolean;
    killsPerHourFlag: number;
    rewardsPerHourFlag: number;
    /** Existing economy thresholds (MYSTICPARADOX_PLAT_DAILY_FLAG, _SPEND_FLAG, MYSTICPARADOX_SEASONAL_COIN_DAILY_FLAG, _XP_PER_MINUTE_FLAG). */
    platinumDailyCreditFlag: number;
    platinumDailySpendFlag: number;
    seasonalCoinDailyFlag: number;
    xpPerMinuteFlag: number;
}

function ReadNonNegative(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const Raw = env[name]?.trim();
    if (Raw === undefined || Raw === "") return fallback;
    const Value = Number(Raw);
    return Number.isFinite(Value) && Value >= 0 ? Value : fallback;
}

/** The monitor's settings from the environment (pure: tests pass their own map). MYSTICPARADOX_ACTIVITY_MONITOR is on unless off. */
export function ReadActivitySettings(env: NodeJS.ProcessEnv = process.env): ActivitySettings {
    const Economy = ReadEconomyMonitorSettings(env);
    return {
        enabled: !/^(0|false|off|no)$/i.test(env.MYSTICPARADOX_ACTIVITY_MONITOR?.trim() ?? ""),
        killsPerHourFlag: ReadNonNegative(env, "MYSTICPARADOX_KILLS_PER_HOUR_FLAG", 90),
        rewardsPerHourFlag: ReadNonNegative(env, "MYSTICPARADOX_REWARDS_PER_HOUR_FLAG", 600),
        platinumDailyCreditFlag: Economy.platinumDailyCreditFlag,
        platinumDailySpendFlag: Economy.platinumDailySpendFlag,
        seasonalCoinDailyFlag: Economy.seasonalCoinDailyFlag,
        xpPerMinuteFlag: Economy.xpPerMinuteFlag
    };
}

let SettingsCache: ActivitySettings | undefined;

/** The settings the process started with (read once). */
export function CurrentActivitySettings(): ActivitySettings {
    SettingsCache ??= ReadActivitySettings();
    return SettingsCache;
}

/** Tests: replace the settings (undefined reads the environment again). */
export function UseActivitySettingsForTest(settings: ActivitySettings | undefined): void {
    SettingsCache = settings;
}

// ---- days and times ----

/** The UTC day of an instant, YYYY-MM-DD. */
export function DayOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/** The first millisecond of a UTC day (YYYY-MM-DD). */
export function DayStartMs(day: string): number {
    return Date.parse(`${day}T00:00:00.000Z`);
}

/** The storage-only ttlAt of a day's record: 400 days after the day starts. */
export function ActivityTtlAt(day: string): Date {
    return new Date(DayStartMs(day) + ACTIVITY_RETENTION_DAYS * DAY_MS);
}

/** Whole minutes between two ISO instants (0 when either is missing or the end is not after the start). */
export function MinutesBetween(startIso: string | undefined, endIso: string | undefined): number {
    if (startIso === undefined || endIso === undefined) return 0;
    const Span = Date.parse(endIso) - Date.parse(startIso);
    return Number.isFinite(Span) && Span > 0 ? Span / 60000 : 0;
}

// ---- keys ----

/** A catalog id, track id or source as a stored field name: Mongo field names may not contain '.' or start with '$'. */
export function SafeKey(text: string): string {
    return /^[A-Za-z0-9_]{1,80}$/.test(text) ? text : "OTHER";
}

/** The Behemoth part of a kill-count token: TOKEN_KILL_COUNT_LERAWR_BETA -> "LERAWR_BETA". Undefined for any other id. */
export function KillTokenName(catalogId: string): string | undefined {
    const Match = /^TOKEN_KILL_COUNT_(.+)$/.exec(catalogId);
    return Match === null ? undefined : SafeKey(Match[1]);
}

export function IsIgnoredActivitySource(source: string | undefined): boolean {
    return source === ACTIVITY_IGNORED_SOURCE;
}

// ---- playtime ----

export interface PlaytimeStep {
    /** A new session starts at this touch (the first touch, or the first after a gap longer than the session gap). */
    sessionStarted: boolean;
    /** Minutes to add to each UTC day the interval since the last touch crosses. */
    segments: Array<{ day: string; minutes: number }>;
}

/**
 * The gap rule (pure). `lastMs` is the previous touch of this account, or undefined for the first. An interval of up to `gapMs` is
 * playtime (split at UTC midnight); a longer one ends the session, and only the touch that follows it counts as a new session.
 */
export function AdvancePlaytime(lastMs: number | undefined, nowMs: number, gapMs: number = ACTIVITY_SESSION_GAP_MS): PlaytimeStep {
    if (lastMs === undefined) return { sessionStarted: true, segments: [] };
    const Gap = nowMs - lastMs;
    if (Gap > gapMs) return { sessionStarted: true, segments: [] };
    if (Gap <= 0) return { sessionStarted: false, segments: [] };
    const Segments: Array<{ day: string; minutes: number }> = [];
    let Cursor = lastMs;
    while (Cursor < nowMs) {
        const Day = DayOf(Cursor);
        const End = Math.min(DayStartMs(Day) + DAY_MS, nowMs);
        Segments.push({ day: Day, minutes: (End - Cursor) / 60000 });
        Cursor = End;
    }
    return { sessionStarted: false, segments: Segments };
}

// ---- inventory grants ----

export interface InventoryActivityInput {
    source: string;
    /** A store purchase's SKU: the Platinum spend is attributed to it, not to the items granted. */
    storeSkuId?: string;
    /** The non-currency adds of the transaction (kill-count tokens included). */
    granted: ReadonlyArray<{ catalogId: string; quantity: number }>;
    currencyCredits: ReadonlyArray<{ catalogId: string; amount: number }>;
    currencyDebits: ReadonlyArray<{ catalogId: string; amount: number }>;
}

export interface InventoryActivityTotals {
    increments: Record<string, number>;
    /** Kill-count grants in this transaction. */
    kills: number;
    /** Non-kill items granted (quantity sum). */
    rewards: number;
}

function Add(into: Record<string, number>, path: string, amount: number): void {
    if (amount === 0) return;
    into[path] = (into[path] ?? 0) + amount;
}

/**
 * The daily increments of one inventory transaction (pure). A Platinum spend is attributed to each granted item it bought, the
 * way the economy ledger counts `byItem`: a transaction that grants three items shows its whole spend against each of them.
 */
export function InventoryIncrements(input: InventoryActivityInput): InventoryActivityTotals {
    const Increments: Record<string, number> = {};
    let Kills = 0;
    let Rewards = 0;
    const Bought: string[] = [];

    for (const Item of input.granted) {
        const Quantity = Number(Item.quantity);
        if (!(Quantity > 0) || typeof Item.catalogId !== "string") continue;
        const Kill = KillTokenName(Item.catalogId);
        if (Kill !== undefined) {
            Add(Increments, `kills.${Kill}`, Quantity);
            Kills += Quantity;
            continue;
        }
        Add(Increments, `itemsGained.${SafeKey(input.source)}`, Quantity);
        Rewards += Quantity;
        if (Bought.length < ACTIVITY_MAX_ITEMS_PER_TRANSACTION && !Bought.includes(Item.catalogId)) Bought.push(Item.catalogId);
    }

    for (const Credit of input.currencyCredits) {
        if (!(Number(Credit.amount) > 0)) continue;
        Add(Increments, `currency.${SafeKey(Credit.catalogId)}.credited`, Number(Credit.amount));
    }

    let PlatinumSpent = 0;
    for (const Debit of input.currencyDebits) {
        if (!(Number(Debit.amount) > 0)) continue;
        Add(Increments, `currency.${SafeKey(Debit.catalogId)}.debited`, Number(Debit.amount));
        if (IsPlatinumMovement(Debit.catalogId)) PlatinumSpent += Number(Debit.amount);
    }
    if (PlatinumSpent > 0) {
        const Items = input.storeSkuId !== undefined ? [input.storeSkuId] : Bought;
        for (const Item of new Set(Items.map(SafeKey))) Add(Increments, `platinumSpendsByItem.${Item}`, PlatinumSpent);
    }

    return { increments: Increments, kills: Kills, rewards: Rewards };
}

// ---- daily flags ----

export interface DailyFlagCandidate {
    kind: string;
    severity: "review" | "high";
    detail: string;
}

function SumValues(record: unknown): number {
    if (typeof record !== "object" || record === null) return 0;
    let Total = 0;
    for (const Value of Object.values(record as Record<string, unknown>)) Total += Number(Value) || 0;
    return Total;
}

/**
 * The flags a day's row (after a write) meets (pure). Every flag is "review": a reviewer decides; nothing is refused. The rate flags
 * (XP, kills and rewards per minute or hour) are judged only on at least ACTIVITY_MIN_RATE_MINUTES of playtime, because playtime is
 * counted from presence touches and a short day can understate it.
 */
export function DailyFlagCandidates(row: Record<string, any>, settings: ActivitySettings): DailyFlagCandidate[] {
    const Flags: DailyFlagCandidate[] = [];
    const Playtime = Number(row.playtimeMinutes) || 0;
    const Currency: Record<string, any> = typeof row.currency === "object" && row.currency !== null ? row.currency : {};

    let PlatinumCredited = 0;
    let PlatinumDebited = 0;
    for (const [Id, Totals] of Object.entries(Currency)) {
        if (!IsPlatinumMovement(Id)) continue;
        PlatinumCredited += Number(Totals?.credited) || 0;
        PlatinumDebited += Number(Totals?.debited) || 0;
    }
    if (PlatinumCredited > settings.platinumDailyCreditFlag) {
        Flags.push({ kind: "PLATINUM_CREDIT_DAY", severity: "review", detail: `credited=${PlatinumCredited} threshold=${settings.platinumDailyCreditFlag}` });
    }
    if (PlatinumDebited > settings.platinumDailySpendFlag) {
        Flags.push({ kind: "PLATINUM_SPEND_DAY", severity: "review", detail: `debited=${PlatinumDebited} threshold=${settings.platinumDailySpendFlag}` });
    }
    const SeasonalCoins = Number(Currency[SEASONAL_COIN_CURRENCY]?.credited) || 0;
    if (SeasonalCoins > settings.seasonalCoinDailyFlag) {
        Flags.push({ kind: "SEASONAL_COIN_DAY", severity: "review", detail: `credited=${SeasonalCoins} threshold=${settings.seasonalCoinDailyFlag}` });
    }

    if (Playtime >= ACTIVITY_MIN_RATE_MINUTES) {
        const Hours = Playtime / 60;
        const Xp = SumValues(row.xp);
        const XpPerMinute = Xp / Playtime;
        if (XpPerMinute > settings.xpPerMinuteFlag) {
            Flags.push({ kind: "XP_PER_MINUTE", severity: "review", detail: `xp=${Xp} playtimeMinutes=${Playtime} perMinute=${XpPerMinute.toFixed(1)} threshold=${settings.xpPerMinuteFlag}` });
        }
        const Kills = SumValues(row.kills);
        if (Kills / Hours > settings.killsPerHourFlag) {
            Flags.push({ kind: "KILLS_PER_HOUR", severity: "review", detail: `kills=${Kills} playtimeMinutes=${Playtime} threshold=${settings.killsPerHourFlag}` });
        }
        const Rewards = SumValues(row.itemsGained);
        if (Rewards / Hours > settings.rewardsPerHourFlag) {
            Flags.push({ kind: "REWARDS_PER_HOUR", severity: "review", detail: `items=${Rewards} playtimeMinutes=${Playtime} threshold=${settings.rewardsPerHourFlag}` });
        }
    }
    return Flags;
}

// ---- launcher builds (UNOFFICIAL_LAUNCHER) ----

/** [2026-10-15] What the launcher says about itself at Play: its version and the SHA-256 of its own launcher.exe. */
export interface LauncherBuildReport {
    version: string;
    sha256: string;
}

/**
 * - official: the hash Guard's manifest pins for the LAUNCHER role;
 * - outdated: another hash on an older version than the served one (an earlier official build, until it updates itself);
 * - unofficial: another hash on the served version or newer (self-built or repackaged), the flag;
 * - unknown: no report, or no pinned launcher (a server without a Guard manifest).
 */
export type LauncherBuildVerdict = "official" | "outdated" | "unofficial" | "unknown";

/** The report from a request body, or undefined when absent or malformed (never refuses the request). */
export function ParseLauncherBuildReport(value: unknown): LauncherBuildReport | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const Input = value as Record<string, unknown>;
    if (typeof Input.version !== "string" || !/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.-]{1,32})?$/.test(Input.version)) return undefined;
    if (typeof Input.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(Input.sha256)) return undefined;
    return { version: Input.version, sha256: Input.sha256.toLowerCase() };
}

/** The verdict for a report against the pinned launcher hash and the served launcher version (see LauncherBuildVerdict). */
export function ClassifyLauncherBuild(report: LauncherBuildReport | undefined, pinnedSha256: string | undefined,
    servedVersion: string | undefined): LauncherBuildVerdict {
    if (report === undefined || pinnedSha256 === undefined) return "unknown";
    if (report.sha256 === pinnedSha256.toLowerCase()) return "official";
    if (servedVersion !== undefined && !VersionAtLeast(report.version, servedVersion)) return "outdated";
    return "unofficial";
}

/** The window in which a kill grant at `atMs` may belong to a dedicated hunt: started within the hunt maximum, ended within the grace. */
export function HuntLootWindow(atMs: number): { atIso: string; notBeforeIso: string; graceFloorIso: string } {
    return {
        atIso: new Date(atMs).toISOString(),
        notBeforeIso: new Date(atMs - ACTIVITY_HUNT_MAX_MS).toISOString(),
        graceFloorIso: new Date(atMs - ACTIVITY_HUNT_GRACE_MS).toISOString()
    };
}
