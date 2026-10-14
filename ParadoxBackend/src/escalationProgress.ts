/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { tryLoadGameData } from "./gameData/loader";
import { EscalationProgressRecord } from "./persistence";
import { IsRuntimeRosterTarget } from "./security/runtimeRoster";

export interface EscalationSeasonProgressPayload {
    escalation_level: number;
    next_level_xp: number;
    talents_progress: unknown[];
    unlock_progress: unknown[];
    update_version: number;
}

export type EscalationSeasonProgressUpdate = Partial<EscalationSeasonProgressPayload>;

const MAX_INT32 = 2_147_483_647;

/**
 * Limits who may persist a season-progress update for a route target.
 *
 * A validated gameserver API-key request is the authoritative writer and may update any
 * admitted account. A player-host runtime is deliberately never a progression writer, even when
 * its forwarded bearer identifies the same account. A normal player bearer may only write its own
 * route target; this preserves the existing self-save contract while closing cross-account writes.
 */
export function IsAuthorizedEscalationWriter(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    if (authData?.IsPlayerHostRuntime === true) return false;
    return typeof authData?.userId === "string" && authData.userId === targetUserId;
}

/**
 * [2026-10-13 realms S3] A player-host runtime (AuthData.IsPlayerHostRuntime, never IsGameserver) writes escalation
 * progress for its realm's members under the hostWrites hooks (route: authorize "ESCALATION", MergeHostEscalationProgress,
 * record). IsAuthorizedEscalationWriter above stays false for it so every other caller is unchanged.
 */
export function IsHostEscalationWriter(authData: any): boolean {
    return authData?.IsPlayerHostRuntime === true && authData?.IsGameserver !== true;
}

/**
 * Reads may be served to the authoritative gameserver or to the account that owns the record.
 * Player-host runtimes do not gain cross-account access merely because they carry a forwarded
 * player bearer: [2026-10-11 P2P, plan 39_ §13.1 B8] they may read the accounts of their own hunt's
 * roster (AuthData.RuntimeRosterAccountIds), which includes every identity they can authenticate as.
 */
export function IsAuthorizedEscalationReader(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    if (authData?.IsPlayerHostRuntime === true) return IsRuntimeRosterTarget(authData, targetUserId);
    return typeof authData?.userId === "string" && authData.userId === targetUserId;
}

export function DefaultEscalationProgress(): EscalationSeasonProgressPayload {
    return {
        escalation_level: 0,
        next_level_xp: 0,
        talents_progress: [],
        unlock_progress: [],
        update_version: 0
    };
}

function IsNonNegativeInt32(Value: unknown): Value is number {
    return typeof Value === "number"
        && Number.isInteger(Value)
        && Value >= 0
        && Value <= MAX_INT32;
}

function CloneArray(Value: unknown[]): unknown[] {
    // Request bodies are JSON values. Cloning prevents later middleware/caller mutation from
    // changing the value selected for persistence while an async Mongo write is in flight.
    return structuredClone(Value);
}

export function RecordToEscalationPayload(
    Record: EscalationProgressRecord | undefined
): EscalationSeasonProgressPayload {
    if (Record === undefined) {
        return DefaultEscalationProgress();
    }

    return {
        escalation_level: Record.escalationLevel,
        next_level_xp: Record.nextLevelXp,
        talents_progress: CloneArray(Record.talentsProgress),
        unlock_progress: CloneArray(Record.unlockProgress),
        update_version: Record.updateVersion
    };
}

/**
 * Builds the next durable record from a game-server POST.
 *
 * Escalation level is monotonic in normal play, so a stale server or a newly-created hunt that
 * started from a zero baseline may never lower a level Mongo already knows. Talent arrays are
 * deliberately replaceable (including with []) because the in-game RESET button is legitimate.
 * Omitted fields retain their previous value, matching the endpoint's established partial-write
 * behavior. updateVersion is backend-authored and increments once per accepted write.
 */
export function MergeEscalationProgress(
    userId: string,
    seasonId: string,
    Previous: EscalationProgressRecord | undefined,
    Update: EscalationSeasonProgressUpdate,
    Now = new Date().toISOString()
): EscalationProgressRecord {
    const PreviousPayload = RecordToEscalationPayload(Previous);
    const RequestedLevel = IsNonNegativeInt32(Update.escalation_level)
        ? Update.escalation_level
        : PreviousPayload.escalation_level;

    return {
        userId,
        seasonId,
        escalationLevel: Math.max(PreviousPayload.escalation_level, RequestedLevel),
        nextLevelXp: IsNonNegativeInt32(Update.next_level_xp)
            ? Update.next_level_xp
            : PreviousPayload.next_level_xp,
        talentsProgress: Array.isArray(Update.talents_progress)
            ? CloneArray(Update.talents_progress)
            : PreviousPayload.talents_progress,
        unlockProgress: Array.isArray(Update.unlock_progress)
            ? CloneArray(Update.unlock_progress)
            : PreviousPayload.unlock_progress,
        updateVersion: PreviousPayload.update_version + 1,
        createdAt: Previous?.createdAt ?? Now,
        updatedAt: Now
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// [2026-10-13 realms S3] Host writes: stored escalation progress is never lowered.
//
// The dedicated merge above lets a server replace next_level_xp and both arrays (it trusts its server; a stale hunt can
// even write a lower next_level_xp next to a level it was not allowed to lower). A host runs on a player's PC, so its
// writes may only add to what is stored (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md section 4.1: "Escalation progress -
// accepted, never lowered"), and anything it sends below the stored state is kept at the stored value and counted in the
// summary that tags the write:
//   - level + next_level_xp are compared as a pair, as the 1.12 backend's snapshot check did (research/escalation:
//     "nothing native lowers level or XP"): a higher level takes its own XP remainder, the same level keeps the larger
//     XP, a lower level keeps the stored level AND XP;
//   - talents_progress / unlock_progress are merged per entry (keyed by talent_id, or reward_id / unlock_id): numbers keep
//     the larger value, a true flag (collected, unlocked) never goes back to false, entries the host omits stay. An entry
//     with none of those keys cannot be compared, so it is not accepted from a host. New keys stop at
//     MAX_HOST_ESCALATION_ENTRIES per array (a real season has well under a hundred talents and unlocks), because a
//     union only ever grows.
// A consequence: the in-game talent RESET button does not persist when pressed in a host's session (the dedicated
// merge still honours it). Spent talent points never exceed the level, so a respec gains nothing; if the owner wants
// it back for hosts, replace the talents merge below with the plain replacement.
//
// [2026-10-13 realms S3 limits] That last sentence was overtaken: the union also INFLATES talents (a respec's new build
// merged with the old one gave 18 points at level 9), and the plain never-lower rules know no ceilings. When
// game-data/escalation_tuning.json is present (the 1.14.7 tables, see "Season limits" below) MergeHostEscalationProgress
// takes a tuning table and judges the write against what the game allows instead: talents are replaced by a valid new
// build (respec included) and the level, XP and unlocks are bounded by the season's rules. Without the file (public
// checkouts, a rejected file) nothing changes: the rules above apply as written.

export const MAX_HOST_ESCALATION_ENTRIES = 512;
const ESCALATION_ENTRY_KEY_FIELDS = ["talent_id", "reward_id", "unlock_id"] as const;

export interface HostEscalationMergeSummary {
    levelBefore: number;
    levelAfter: number;
    xpBefore: number;
    xpAfter: number;
    /** The request carried a lower level, or the same level with lower XP; the stored values were kept. */
    levelXpRegressionIgnored: boolean;
    talents: { before: number; after: number; ignored: number };
    unlocks: { before: number; after: number; ignored: number };
    version: number;
    // The fields below are set only when the season limits were applied (a tuning table was passed).
    /** Why the request's level / XP pair was impossible; the stored level and XP were kept. */
    levelXpRejected?: string;
    /** Talent points spent by the stored build before the write and by the build stored after it. */
    talentPoints?: { before: number; after: number };
    /** The accepted build spends fewer points than the stored one did: a respec (or a refund) happened. */
    talentsReset?: true;
    /** Why the sent talents_progress was impossible; the stored talents were kept. */
    talentsRejected?: string;
}

function EntryKey(Entry: unknown): string | undefined {
    if (Entry === null || typeof Entry !== "object" || Array.isArray(Entry)) return undefined;
    for (const Field of ESCALATION_ENTRY_KEY_FIELDS) {
        const Value = (Entry as Record<string, unknown>)[Field];
        if (typeof Value === "string" && Value.length > 0) return `${Field}\u0000${Value}`;
    }
    return undefined;
}

/** Fields of one stored entry merged with the incoming copy: numbers keep the larger value, true stays true. */
function MergeEntryNeverLower(Stored: Record<string, unknown>, Incoming: Record<string, unknown>): { merged: Record<string, unknown>; restored: boolean } {
    const Fields = new Map<string, unknown>(Object.entries(Stored));
    let Restored = false;
    for (const [Field, Value] of Object.entries(Incoming)) {
        const Old = Fields.get(Field);
        if (typeof Old === "number" && !(typeof Value === "number" && Value >= Old)) { Restored = true; continue; }
        if (Old === true && Value !== true) { Restored = true; continue; }
        Fields.set(Field, Value);
    }
    // fromEntries defines own properties, so a "__proto__" field of a request body cannot reach a prototype.
    return { merged: Object.fromEntries(Fields), restored: Restored };
}

/** The stored array with the incoming one merged in per entry; `ignored` counts what the host tried to take away or
 *  could not be compared (a lowered value, an omitted stored entry, an entry without a key, a key past the cap). */
export function MergeEntriesNeverLower(
    Stored: unknown[],
    Incoming: unknown[],
    KeyOf: (Entry: unknown) => string | undefined = EntryKey
): { merged: unknown[]; ignored: number } {
    const Order: string[] = [];
    const ByKey = new Map<string, Record<string, unknown>>();
    const Keyless: unknown[] = [];
    for (const Entry of Stored) {
        const Key = KeyOf(Entry);
        if (Key === undefined) { Keyless.push(Entry); continue; }
        const Existing = ByKey.get(Key);
        if (Existing === undefined) { Order.push(Key); ByKey.set(Key, Entry as Record<string, unknown>); }
        else ByKey.set(Key, MergeEntryNeverLower(Existing, Entry as Record<string, unknown>).merged);
    }
    const StoredKeys = new Set(Order);
    const Offered = new Set<string>();
    let Ignored = 0;
    for (const Entry of Incoming) {
        const Key = KeyOf(Entry);
        if (Key === undefined) { Ignored++; continue; }
        Offered.add(Key);
        const Existing = ByKey.get(Key);
        if (Existing === undefined) {
            if (ByKey.size >= MAX_HOST_ESCALATION_ENTRIES) { Ignored++; continue; }
            Order.push(Key);
            ByKey.set(Key, Entry as Record<string, unknown>);
            continue;
        }
        const { merged, restored } = MergeEntryNeverLower(Existing, Entry as Record<string, unknown>);
        if (restored) Ignored++;
        ByKey.set(Key, merged);
    }
    for (const Key of StoredKeys) if (!Offered.has(Key)) Ignored++;
    return { merged: [...Order.map((Key) => ByKey.get(Key) as Record<string, unknown>), ...Keyless], ignored: Ignored };
}

// ---------------------------------------------------------------------------------------------------------------------
// [2026-10-13 realms S3 limits] Season limits: a host write is refused only where it is impossible.
//
// What the game itself allows, per season (ESC_SEASON_1..6; game-data/escalation_tuning.json, extracted from the 1.14.7 paks):
//   - the escalation level is 0..maxLevel (25); next_level_xp is the XP inside the current level (the remainder carries over on
//     a level-up), so below maxLevel it stays under the XP the next level needs (xpToReachLevel);
//   - unlock_progress has six rewards per season, each collectable from its own level;
//   - talents: the points earned are the escalation level; every purchase adds one rank (rank r costs pointCosts[r - 1]: 1,
//     apart from one free rank in ESC_SEASON_2), a talent's rank is 1..maxRank, and a talent is only bought once its tier gate
//     (pointsToUnlock) is covered by the points already spent. "Reset talents" is free and empties talents_progress; level,
//     XP and unlocks are untouched, and the game POSTs the whole state every 30 s.
// Nothing here is guessed from play: a value is refused only when no legitimate play can produce it. What a host could still
// do (level up quickly, pick any valid build) the game allows too.

export const ESCALATION_TUNING_FILE = "escalation_tuning.json";
const MAX_TUNING_LEVEL = 1000;
const MAX_TUNING_RANKS = 100;

export interface EscalationTalentTuning {
    /** Tier gate: the points already spent when a rank of this talent is bought must be at least this. */
    pointsToUnlock: number;
    /** pointCosts[r - 1] is the cost of buying rank r; the talent's maxRank is pointCosts.length. */
    pointCosts: readonly number[];
}

export interface EscalationSeasonTuning {
    maxLevel: number;
    /** xpToReachLevel[i] is the XP needed to reach level i + 1 (one value per level). */
    xpToReachLevel: readonly number[];
    /** reward_id -> the level from which that unlock may be collected. */
    unlockLevels: ReadonlyMap<string, number>;
    /** talent_id -> its rules; Maps, so an id like "__proto__" or "constructor" from a request body is simply unknown. */
    talents: ReadonlyMap<string, EscalationTalentTuning>;
}

export interface EscalationTuning {
    seasons: ReadonlyMap<string, EscalationSeasonTuning>;
}

export type EscalationTuningParse =
    | { tuning: EscalationTuning; problem?: undefined }
    | { tuning?: undefined; problem: string };

export interface EscalationTuningLoad {
    tuning: EscalationTuning | undefined;
    /** "missing": no file (host writes keep the never-lower merge); "invalid": the file was rejected (same fallback, see problem). */
    status: "loaded" | "missing" | "invalid";
    problem?: string;
}

function IsPlainObject(Value: unknown): Value is Record<string, unknown> {
    return Value !== null && typeof Value === "object" && !Array.isArray(Value);
}

function IsIntInRange(Value: unknown, Min: number, Max: number): Value is number {
    return typeof Value === "number" && Number.isInteger(Value) && Value >= Min && Value <= Max;
}

/** Request-supplied text quoted in a reason: bounded and escaped, since reasons are logged and stored with the write's tag. */
function Quote(Value: string): string {
    return JSON.stringify(Value.length > 80 ? `${Value.slice(0, 80)}...` : Value);
}

function ParseSeasonTuning(At: string, Raw: unknown): { season: EscalationSeasonTuning } | { problem: string } {
    if (!IsPlainObject(Raw)) return { problem: `${At} is not an object` };
    const MaxLevel = Raw.maxLevel;
    if (!IsIntInRange(MaxLevel, 1, MAX_TUNING_LEVEL)) return { problem: `${At}.maxLevel must be an integer 1..${MAX_TUNING_LEVEL}` };

    const Xp = Raw.xpToReachLevel;
    if (!Array.isArray(Xp) || Xp.length !== MaxLevel) return { problem: `${At}.xpToReachLevel must hold one value per level (${MaxLevel})` };
    for (let Index = 0; Index < Xp.length; Index++) {
        if (!IsIntInRange(Xp[Index], 1, MAX_INT32)) return { problem: `${At}.xpToReachLevel[${Index}] must be a positive integer` };
    }

    const UnlocksRaw = Raw.unlocks;
    if (!IsPlainObject(UnlocksRaw) || Object.keys(UnlocksRaw).length === 0) return { problem: `${At}.unlocks must be a non-empty object` };
    const UnlockLevels = new Map<string, number>();
    for (const [RewardId, Entry] of Object.entries(UnlocksRaw)) {
        if (RewardId.length === 0 || !IsPlainObject(Entry) || !IsIntInRange(Entry.level, 1, MaxLevel)) {
            return { problem: `${At}.unlocks.${RewardId}.level must be an integer 1..${MaxLevel}` };
        }
        UnlockLevels.set(RewardId, Entry.level);
    }

    const TalentsRaw = Raw.talents;
    if (!IsPlainObject(TalentsRaw) || Object.keys(TalentsRaw).length === 0) return { problem: `${At}.talents must be a non-empty object` };
    const Talents = new Map<string, EscalationTalentTuning>();
    for (const [TalentId, Entry] of Object.entries(TalentsRaw)) {
        if (TalentId.length === 0 || !IsPlainObject(Entry)) return { problem: `${At}.talents.${TalentId} must be an object` };
        if (!IsIntInRange(Entry.pointsToUnlock, 0, MAX_TUNING_LEVEL)) return { problem: `${At}.talents.${TalentId}.pointsToUnlock must be a non-negative integer` };
        const Costs = Entry.pointCosts;
        if (!Array.isArray(Costs) || Costs.length < 1 || Costs.length > MAX_TUNING_RANKS) {
            return { problem: `${At}.talents.${TalentId}.pointCosts must list the cost of each rank (1..${MAX_TUNING_RANKS})` };
        }
        for (let Index = 0; Index < Costs.length; Index++) {
            if (!IsIntInRange(Costs[Index], 0, MAX_TUNING_LEVEL)) return { problem: `${At}.talents.${TalentId}.pointCosts[${Index}] must be a non-negative integer` };
        }
        Talents.set(TalentId, { pointsToUnlock: Entry.pointsToUnlock, pointCosts: [...(Costs as number[])] });
    }

    return { season: { maxLevel: MaxLevel, xpToReachLevel: [...(Xp as number[])], unlockLevels: UnlockLevels, talents: Talents } };
}

/** Validates the parsed JSON of escalation_tuning.json. One bad value rejects the whole file, with the first problem found. */
export function ParseEscalationTuning(Raw: unknown): EscalationTuningParse {
    if (!IsPlainObject(Raw)) return { problem: "the file is not a JSON object" };
    const SeasonsRaw = Raw.seasons;
    if (!IsPlainObject(SeasonsRaw) || Object.keys(SeasonsRaw).length === 0) return { problem: "\"seasons\" must be a non-empty object" };
    const Seasons = new Map<string, EscalationSeasonTuning>();
    for (const [SeasonId, SeasonRaw] of Object.entries(SeasonsRaw)) {
        if (SeasonId.length === 0) return { problem: "a season id is empty" };
        const Parsed = ParseSeasonTuning(`seasons.${SeasonId}`, SeasonRaw);
        if ("problem" in Parsed) return { problem: Parsed.problem };
        Seasons.set(SeasonId, Parsed.season);
    }
    return { tuning: { seasons: Seasons } };
}

/** Reads and validates game-data/escalation_tuning.json. `Read` is a seam for tests. Never throws. */
export function LoadEscalationTuning(Read: () => unknown = () => tryLoadGameData(ESCALATION_TUNING_FILE)): EscalationTuningLoad {
    let Raw: unknown;
    try {
        Raw = Read();
    } catch (Failure) {
        return { tuning: undefined, status: "invalid", problem: `unreadable: ${Failure instanceof Error ? Failure.message : String(Failure)}` };
    }
    if (Raw === undefined) return { tuning: undefined, status: "missing" };
    const Parsed = ParseEscalationTuning(Raw);
    if (Parsed.tuning === undefined) return { tuning: undefined, status: "invalid", problem: Parsed.problem };
    return { tuning: Parsed.tuning, status: "loaded" };
}

let LoadedTuning: EscalationTuningLoad | undefined;

/** The process-wide tuning, read once (restart to pick up a regenerated file, like the other game data). */
export function GetEscalationTuning(): EscalationTuningLoad {
    LoadedTuning ??= LoadEscalationTuning();
    return LoadedTuning;
}

/** True when a host may write this season: always without a tuning table, otherwise only the table's seasons. */
export function IsHostEscalationSeasonAllowed(Tuning: EscalationTuning | undefined, SeasonId: string): boolean {
    return Tuning === undefined || Tuning.seasons.has(SeasonId);
}

/** The XP that reaching `Level` (1..maxLevel) takes from the level below; undefined outside that range. */
export function EscalationXpToReachLevel(Season: EscalationSeasonTuning, Level: number): number | undefined {
    return Level >= 1 && Level <= Season.maxLevel ? Season.xpToReachLevel[Level - 1] : undefined;
}

/**
 * Why a level / next_level_xp pair is impossible, or undefined when some play can reach it. Below maxLevel the XP inside the
 * level is under what the next level needs; at maxLevel any XP is accepted (nothing in the tables bounds it).
 */
export function CheckEscalationLevelXp(Season: EscalationSeasonTuning, Level: number, Xp: number): string | undefined {
    if (Level > Season.maxLevel) return `level ${Level} is above the season maximum ${Season.maxLevel}`;
    if (Level < Season.maxLevel) {
        const Needed = EscalationXpToReachLevel(Season, Level + 1) as number;
        if (Xp >= Needed) return `next_level_xp ${Xp} is not below the ${Needed} XP level ${Level + 1} takes`;
    }
    return undefined;
}

/** The points spent on a talent up to `Rank` (0 for no rank). */
export function EscalationTalentRankCost(Talent: EscalationTalentTuning, Rank: number): number {
    let Cost = 0;
    for (let Index = 0; Index < Rank && Index < Talent.pointCosts.length; Index++) Cost += Talent.pointCosts[Index];
    return Cost;
}

export type EscalationTalentsCheck = { ok: true; points: number } | { ok: false; reason: string };

/**
 * Whether a whole talents_progress array is a build the game could have produced at escalation level `Level`: an array of
 * { talent_id, rank } with ids of this season's table (exact rows), none twice, each rank 1..maxRank, no more points spent
 * than the level earned, and an order of purchases that satisfies every tier gate. [] is valid (a respec). Buying in
 * ascending gate order is the best order (it banks the most spent points before each gate), so that order is the test.
 */
export function CheckEscalationTalents(Season: EscalationSeasonTuning, Entries: unknown, Level: number): EscalationTalentsCheck {
    if (!Array.isArray(Entries)) return { ok: false, reason: "talents_progress is not an array" };
    if (Entries.length > Season.talents.size) return { ok: false, reason: `${Entries.length} entries for a season with ${Season.talents.size} talents` };
    const Seen = new Set<string>();
    const Purchases: { gate: number; cost: number }[] = [];
    let Points = 0;
    for (let Index = 0; Index < Entries.length; Index++) {
        const Entry: unknown = Entries[Index];
        if (!IsPlainObject(Entry)) return { ok: false, reason: `entry ${Index} is not an object` };
        const Id = Entry.talent_id;
        if (typeof Id !== "string") return { ok: false, reason: `entry ${Index} has no talent_id` };
        const Talent = Season.talents.get(Id);
        if (Talent === undefined) return { ok: false, reason: `talent ${Quote(Id)} is not in this season's table` };
        if (Seen.has(Id)) return { ok: false, reason: `talent ${Quote(Id)} appears twice` };
        Seen.add(Id);
        if (!IsIntInRange(Entry.rank, 1, Talent.pointCosts.length)) return { ok: false, reason: `talent ${Quote(Id)} needs a rank of 1..${Talent.pointCosts.length}` };
        for (let RankIndex = 0; RankIndex < Entry.rank; RankIndex++) {
            Purchases.push({ gate: Talent.pointsToUnlock, cost: Talent.pointCosts[RankIndex] });
            Points += Talent.pointCosts[RankIndex];
        }
    }
    const Earned = Math.min(Level, Season.maxLevel);
    if (Points > Earned) return { ok: false, reason: `${Points} points spent with ${Earned} earned (level ${Level})` };
    Purchases.sort((A, B) => A.gate - B.gate);
    let Spent = 0;
    for (const Purchase of Purchases) {
        if (Spent < Purchase.gate) return { ok: false, reason: `a talent gated at ${Purchase.gate} points is bought with ${Spent} spent` };
        Spent += Purchase.cost;
    }
    return { ok: true, points: Points };
}

/** Points spent by a stored build; entries that do not resolve in the season (older data) count for nothing. */
export function EscalationTalentPoints(Season: EscalationSeasonTuning, Entries: readonly unknown[]): number {
    const Seen = new Set<string>();
    let Points = 0;
    for (const Entry of Entries) {
        if (!IsPlainObject(Entry) || typeof Entry.talent_id !== "string" || Seen.has(Entry.talent_id)) continue;
        const Talent = Season.talents.get(Entry.talent_id);
        if (Talent === undefined || !IsIntInRange(Entry.rank, 1, MAX_INT32)) continue;
        Seen.add(Entry.talent_id);
        Points += EscalationTalentRankCost(Talent, Entry.rank);
    }
    return Points;
}

/**
 * The unlock_progress entries a host may submit at `Level`: { reward_id, collected } with a reward_id of the season, a boolean
 * `collected` when present, and collected: true only once the level has reached the reward's unlock level. The rest are
 * counted in `rejected` and left out (the stored entry, if any, stays).
 */
export function FilterEscalationUnlocks(Season: EscalationSeasonTuning, Entries: readonly unknown[], Level: number): { accepted: unknown[]; rejected: number } {
    const Accepted: unknown[] = [];
    let Rejected = 0;
    for (const Entry of Entries) {
        const UnlockLevel = IsPlainObject(Entry) && typeof Entry.reward_id === "string" ? Season.unlockLevels.get(Entry.reward_id) : undefined;
        if (!IsPlainObject(Entry) || UnlockLevel === undefined) { Rejected++; continue; }
        const Collected = Entry.collected;
        if (Collected !== undefined && typeof Collected !== "boolean") { Rejected++; continue; }
        if (Collected === true && Level < UnlockLevel) { Rejected++; continue; }
        Accepted.push(Entry);
    }
    return { accepted: Accepted, rejected: Rejected };
}

function RewardEntryKey(Entry: unknown): string | undefined {
    return IsPlainObject(Entry) && typeof Entry.reward_id === "string" && Entry.reward_id.length > 0 ? `reward_id\u0000${Entry.reward_id}` : undefined;
}

/**
 * The next durable record for a host's POST: MergeEscalationProgress's validation and partial-write rules, then the
 * never-lower rules above. updateVersion stays backend-authored. `summary` is what the route tags the write with.
 *
 * [2026-10-13 realms S3 limits] With a `Tuning` table (game-data/escalation_tuning.json) the season limits apply instead of
 * the plain talent / unlock union; the caller must have checked IsHostEscalationSeasonAllowed (an unlisted season throws).
 * A write that breaks a limit is not refused whole: the parts that hold are applied, the rest keep their stored value and
 * the summary says which.
 *   - level: never lower, at most maxLevel; a level / XP pair that is impossible (above maxLevel, or next_level_xp not under
 *     the next level's XP) leaves the stored pair, otherwise the pair compare above decides;
 *   - unlock_progress: collected never true -> false and omitted entries stay; entries naming a reward of another season,
 *     or collected before the (accepted) level reaches its unlock level, are ignored;
 *   - talents_progress: REPLACED, including by [] (respec), lower ranks and dropped entries, when the whole array is valid for
 *     the season at the accepted level (CheckEscalationTalents); otherwise the stored build stays (summary.talentsRejected).
 *     A build spending fewer points than the stored one sets summary.talentsReset.
 * Without a `Tuning` the rules above apply as written.
 */
export function MergeHostEscalationProgress(
    userId: string,
    seasonId: string,
    Previous: EscalationProgressRecord | undefined,
    Update: EscalationSeasonProgressUpdate,
    Now = new Date().toISOString(),
    Tuning?: EscalationTuning
): { record: EscalationProgressRecord; summary: HostEscalationMergeSummary } {
    const PreviousPayload = RecordToEscalationPayload(Previous);
    const Season = Tuning?.seasons.get(seasonId);
    if (Tuning !== undefined && Season === undefined) {
        throw new Error(`Escalation season ${Quote(seasonId)} is not in the tuning table; check IsHostEscalationSeasonAllowed before merging.`);
    }
    // Base's arrays are clones of the request's, so merging them below never aliases the request body.
    const Base = MergeEscalationProgress(userId, seasonId, Previous, Update, Now);
    const RequestedLevel = IsNonNegativeInt32(Update.escalation_level) ? Update.escalation_level : PreviousPayload.escalation_level;

    // An impossible pair is not compared at all. Only a request that sent a level or XP is judged (an omitted pair is the stored one).
    const SentLevelXp = IsNonNegativeInt32(Update.escalation_level) || IsNonNegativeInt32(Update.next_level_xp);
    const LevelXpRejected = Season !== undefined && SentLevelXp ? CheckEscalationLevelXp(Season, RequestedLevel, Base.nextLevelXp) : undefined;

    let Level = PreviousPayload.escalation_level;
    let Xp = PreviousPayload.next_level_xp;
    let Regression = false;
    if (LevelXpRejected !== undefined) {
        // The stored level and XP stay.
    } else if (RequestedLevel > Level) {
        Level = RequestedLevel;
        Xp = Base.nextLevelXp;
    } else if (RequestedLevel === Level) {
        Regression = Base.nextLevelXp < Xp;
        Xp = Math.max(Xp, Base.nextLevelXp);
    } else {
        Regression = true;
    }

    // An array the request omitted keeps its stored value in Base already; only a sent array needs judging.
    let Talents: { merged: unknown[]; ignored: number };
    let TalentsRejected: string | undefined;
    let TalentsReset = false;
    const PointsBefore = Season === undefined ? 0 : EscalationTalentPoints(Season, PreviousPayload.talents_progress);
    let PointsAfter = PointsBefore;
    if (!Array.isArray(Update.talents_progress)) {
        Talents = { merged: Base.talentsProgress, ignored: 0 };
    } else if (Season === undefined) {
        Talents = MergeEntriesNeverLower(PreviousPayload.talents_progress, Base.talentsProgress);
    } else {
        const Check = CheckEscalationTalents(Season, Base.talentsProgress, Level);
        if (Check.ok) {
            Talents = { merged: Base.talentsProgress, ignored: 0 };
            PointsAfter = Check.points;
            TalentsReset = Check.points < PointsBefore;
        } else {
            Talents = { merged: PreviousPayload.talents_progress, ignored: Base.talentsProgress.length };
            TalentsRejected = Check.reason;
        }
    }

    let Unlocks: { merged: unknown[]; ignored: number };
    if (!Array.isArray(Update.unlock_progress)) {
        Unlocks = { merged: Base.unlockProgress, ignored: 0 };
    } else if (Season === undefined) {
        Unlocks = MergeEntriesNeverLower(PreviousPayload.unlock_progress, Base.unlockProgress);
    } else {
        const Filtered = FilterEscalationUnlocks(Season, Base.unlockProgress, Level);
        const Merged = MergeEntriesNeverLower(PreviousPayload.unlock_progress, Filtered.accepted, RewardEntryKey);
        Unlocks = { merged: Merged.merged, ignored: Merged.ignored + Filtered.rejected };
    }

    const Next: EscalationProgressRecord = {
        ...Base,
        escalationLevel: Level,
        nextLevelXp: Xp,
        talentsProgress: Talents.merged,
        unlockProgress: Unlocks.merged
    };
    const Summary: HostEscalationMergeSummary = {
        levelBefore: PreviousPayload.escalation_level,
        levelAfter: Level,
        xpBefore: PreviousPayload.next_level_xp,
        xpAfter: Xp,
        levelXpRegressionIgnored: Regression,
        talents: { before: PreviousPayload.talents_progress.length, after: Talents.merged.length, ignored: Talents.ignored },
        unlocks: { before: PreviousPayload.unlock_progress.length, after: Unlocks.merged.length, ignored: Unlocks.ignored },
        version: Next.updateVersion
    };
    if (Season !== undefined) {
        if (LevelXpRejected !== undefined) Summary.levelXpRejected = LevelXpRejected;
        Summary.talentPoints = { before: PointsBefore, after: PointsAfter };
        if (TalentsReset) Summary.talentsReset = true;
        if (TalentsRejected !== undefined) Summary.talentsRejected = TalentsRejected;
    }
    return { record: Next, summary: Summary };
}
