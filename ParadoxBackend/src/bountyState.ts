/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { BountyGroup, BountyStateRecord, StoredBounty } from "./persistence/mapping/domainTypes";
import { IsRuntimeRosterTarget } from "./security/runtimeRoster";
import { ACTIVE_SEASON_LENGTH_MS, ActiveSeasonWindowMs } from "./seasonWindow";

/*
 * Per-account bounty state for GET/POST /bounty/:userId (the hub/hunt server's UBountyComponents).
 *
 * Until 10 Oct 2026 both routes were stubs that discarded every save and always answered "no bounties, no draft
 * choices". Measured with [DraftMon] (38_ section 19.4): every arrival on any server re-seeded the 110 season
 * challenges at progress 0 and auto-drafted a daily bounty again, spending the daily draft tokens each time, so
 * challenge progress never survived a map change and a completed challenge could be claimed again next session.
 *
 * Wire shape, as the 1.14.7 server sends it (no live capture of these two endpoints exists; the [DraftMon] raw
 * bodies are the reference):
 *   GET  -> { season_start_date, season_end_date, bounties: [...], draft_data, draft_data_daily, draft_data_weekly }
 *   POST <- one of
 *     { bounties: [the component's whole list], draft_data_weekly | draft_data_daily | draft_data: {...} }
 *     { bounties: [one bounty] }                                   (objective progress / claim update)
 *   bounty = { bounty_id, premium_bounty, slot_index, objectives: [{ objective_id, progress }],
 *              drafted_timestamp, update_version, claimed }
 * One GET serves all three components (base, daily, weekly), so the payload carries every bounty.
 *
 * Merge rules (MergeBountyState):
 *   - A save that carries exactly ONE draft-data key is that component's full list: its draft data replaces the
 *     stored one, and its bounties replace the stored bounties of that group. An EMPTY list never deletes anything
 *     (the server sends `bounties: []` with draft data while it is still initialising; deleting there would wipe
 *     the season challenges' progress). A save with no (or several) draft-data keys upserts the bounties it names.
 *   - The same bounty instance (same bounty_id and drafted_timestamp) is merged monotonically: each objective's
 *     progress keeps the maximum, `claimed` never goes back to false, update_version keeps the maximum. A re-seed
 *     at progress 0 therefore cannot erase progress, and a claimed challenge stays claimed - the server sees it
 *     claimed on the next load and cannot claim its reward twice. A different drafted_timestamp is a new draft and
 *     replaces the old instance.
 *   - Bounties of unknown group are grouped by id (Challenge_Daily_* daily, *Challenge_Season* weekly, the rest
 *     base). The stored list is capped (oldest claimed dropped first).
 *
 * A player-host runtime's saves go through MergeHostBountyState instead (same merge, plus the limits of "Host saves"
 * below); dedicated-server saves never touch that code.
 */

export const BOUNTY_SEASON_START_DATE = "2020-08-23T00:00:00.000Z";
export const BOUNTY_SEASON_END_DATE = "2099-01-01T00:00:00.000Z";
export const MAX_STORED_BOUNTIES = 1000;
const MAX_BOUNTIES_PER_SAVE = 512;
const MAX_BOUNTY_ID_LENGTH = 200;

const DRAFT_KEYS: ReadonlyArray<{ key: "draft_data" | "draft_data_daily" | "draft_data_weekly"; group: Exclude<BountyGroup, "unassigned"> }> = [
    { key: "draft_data", group: "base" },
    { key: "draft_data_daily", group: "daily" },
    { key: "draft_data_weekly", group: "weekly" },
];

export function DefaultDraftData(): Record<string, unknown> {
    return {
        current_draft_choices: [],
        previous_draft_selections: [],
        bronze_count: 0,
        silver_count: 0,
        gold_count: 0,
    };
}

/** Writes come from the authoritative dedicated server only: a player bearer could otherwise unclaim or re-date a
 *  claimed challenge and collect its reward again. Player-host runtimes are excluded here; their path is
 *  IsHostBountyWriter + the hostWrites hooks (below). */
export function IsAuthorizedBountyWriter(authData: any): boolean {
    return authData?.IsGameserver === true;
}

// [2026-10-13 realms S3] In a Paradox-account realm a player's PC hosts the game server and does what a dedicated server
// does (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md section 4): bounty saves, claims included (owner decision), through the
// same SaveBountyState flow. This only recognises such a runtime (auth layer: IsPlayerHostRuntime, never IsGameserver); the
// route then asks GetP2PExtension().hostWrites.authorize(req, "BOUNTY", userId) and tags the save with record().
export function IsHostBountyWriter(authData: any): boolean {
    return authData?.IsPlayerHostRuntime === true && authData?.IsGameserver !== true;
}

/** [2026-10-11 P2P, plan 39_ §13.1 B8] A player-host runtime may read the bounty state of its own hunt's roster (its
 *  UBountyComponents load on arrival like a dedicated server's); writes stay dedicated-only (claims pay rewards). */
export function IsAuthorizedBountyReader(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    if (authData?.IsPlayerHostRuntime === true) return IsRuntimeRosterTarget(authData, targetUserId);
    return typeof authData?.userId === "string" && authData.userId === targetUserId;
}

export function InferBountyGroup(bountyId: string): Exclude<BountyGroup, "unassigned"> {
    if (bountyId.startsWith("Challenge_Daily_")) return "daily";
    if (bountyId.includes("Challenge_Season")) return "weekly";
    return "base";
}

export class BountySaveValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BountySaveValidationError";
    }
}

function IsPlainObject(value: unknown): value is Record<string, any> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

export interface BountySaveBody {
    bounties?: unknown;
    draft_data?: unknown;
    draft_data_daily?: unknown;
    draft_data_weekly?: unknown;
}

/** Validates the save and returns its bounties (verbatim wire objects). Throws BountySaveValidationError. */
export function ValidateBountySave(body: unknown): { bounties: Record<string, any>[]; draftKeys: typeof DRAFT_KEYS[number][] } {
    if (!IsPlainObject(body)) throw new BountySaveValidationError("body must be an object");
    const Bounties = body.bounties ?? [];
    if (!Array.isArray(Bounties)) throw new BountySaveValidationError("bounties must be an array");
    if (Bounties.length > MAX_BOUNTIES_PER_SAVE) throw new BountySaveValidationError(`too many bounties (${Bounties.length})`);
    for (const Bounty of Bounties) {
        if (!IsPlainObject(Bounty)) throw new BountySaveValidationError("every bounty must be an object");
        const Id = Bounty.bounty_id;
        if (typeof Id !== "string" || Id.length === 0 || Id.length > MAX_BOUNTY_ID_LENGTH) {
            throw new BountySaveValidationError("every bounty needs a bounty_id string");
        }
        if (Bounty.objectives !== undefined && !Array.isArray(Bounty.objectives)) {
            throw new BountySaveValidationError(`objectives of ${Id} must be an array`);
        }
    }
    const DraftKeys = DRAFT_KEYS.filter(({ key }) => body[key] !== undefined);
    for (const { key } of DraftKeys) {
        if (!IsPlainObject(body[key])) throw new BountySaveValidationError(`${key} must be an object`);
    }
    return { bounties: Bounties as Record<string, any>[], draftKeys: DraftKeys };
}

function SameInstance(a: Record<string, any>, b: Record<string, any>): boolean {
    return a.bounty_id === b.bounty_id && (a.drafted_timestamp ?? null) === (b.drafted_timestamp ?? null);
}

/** Monotonic merge of two saves of the same bounty instance (see the module comment). */
export function MergeBountyInstance(stored: Record<string, any>, incoming: Record<string, any>): Record<string, any> {
    const StoredProgress = new Map<string, number>();
    for (const Objective of Array.isArray(stored.objectives) ? stored.objectives : []) {
        if (IsPlainObject(Objective) && typeof Objective.objective_id === "string") {
            StoredProgress.set(Objective.objective_id, Number(Objective.progress) || 0);
        }
    }
    const IncomingObjectives = Array.isArray(incoming.objectives) ? incoming.objectives : [];
    const SeenIds = new Set<string>();
    const Objectives = IncomingObjectives.map((Objective: any) => {
        if (!IsPlainObject(Objective) || typeof Objective.objective_id !== "string") return Objective;
        SeenIds.add(Objective.objective_id);
        const Previous = StoredProgress.get(Objective.objective_id);
        const Progress = Number(Objective.progress) || 0;
        return Previous !== undefined && Previous > Progress ? { ...Objective, progress: Previous } : Objective;
    });
    // An objective the stored copy has and the incoming one omits is kept rather than dropped.
    for (const Objective of Array.isArray(stored.objectives) ? stored.objectives : []) {
        if (IsPlainObject(Objective) && typeof Objective.objective_id === "string" && !SeenIds.has(Objective.objective_id)) {
            Objectives.push(Objective);
        }
    }
    const Merged: Record<string, any> = { ...incoming, objectives: Objectives };
    if (stored.claimed === true) Merged.claimed = true;
    const StoredVersion = Number(stored.update_version);
    const IncomingVersion = Number(incoming.update_version);
    if (Number.isFinite(StoredVersion) && (!Number.isFinite(IncomingVersion) || StoredVersion > IncomingVersion)) {
        Merged.update_version = StoredVersion;
    }
    return Merged;
}

// The claim metadata (claimedAt, rewardCredit) belongs to one drafted instance: it is kept while the instance is the
// same and dropped when a new draft replaces it. claimedAt is set the first time the backend sees the instance claimed.
function WithClaimMetadata(entry: StoredBounty, previous: StoredBounty | undefined, now: string): StoredBounty {
    const Same = previous !== undefined && SameInstance(previous.bounty, entry.bounty);
    const Next: StoredBounty = { group: entry.group, bounty: entry.bounty };
    if (Same && previous!.claimedAt) Next.claimedAt = previous!.claimedAt;
    else if (entry.bounty.claimed === true && !(Same && previous!.bounty.claimed === true)) Next.claimedAt = now;
    if (Same && previous!.rewardCredit) Next.rewardCredit = previous!.rewardCredit;
    return Next;
}

function Upsert(list: StoredBounty[], incoming: Record<string, any>, group: Exclude<BountyGroup, "unassigned">, now: string): StoredBounty[] {
    const Index = list.findIndex((Entry) => Entry.bounty.bounty_id === incoming.bounty_id);
    if (Index < 0) return [...list, WithClaimMetadata({ group, bounty: incoming }, undefined, now)];
    const Existing = list[Index];
    const Next = SameInstance(Existing.bounty, incoming) ? MergeBountyInstance(Existing.bounty, incoming) : incoming;
    const Copy = list.slice();
    Copy[Index] = WithClaimMetadata({ group: Existing.group === "unassigned" ? group : Existing.group, bounty: Next }, Existing, now);
    return Copy;
}

// `isKept` (host saves only) ranks the entries a host must not lose after everything else, so a flood of new entries
// cannot push them out (see "Host saves"); without it the order is exactly the original one.
function Cap(list: StoredBounty[], isKept?: (entry: StoredBounty) => boolean): StoredBounty[] {
    if (list.length <= MAX_STORED_BOUNTIES) return list;
    // Drop the oldest claimed bounties first, then the oldest of the rest.
    const Ranked = list
        .map((Entry, Index) => ({ Entry, Index, Kept: isKept?.(Entry) === true, Claimed: Entry.bounty.claimed === true, Time: Date.parse(String(Entry.bounty.drafted_timestamp ?? "")) || 0 }))
        .sort((a, b) => (Number(a.Kept) - Number(b.Kept)) || (Number(b.Claimed) - Number(a.Claimed)) || (a.Time - b.Time));
    const Drop = new Set(Ranked.slice(0, list.length - MAX_STORED_BOUNTIES).map((Item) => Item.Index));
    return list.filter((_, Index) => !Drop.has(Index));
}

export interface BountyMergeSummary {
    mode: "replace" | "upsert";
    group?: Exclude<BountyGroup, "unassigned">;
    incoming: number;
    removed: number;
    /** [2026-10-13 realms S3 limits] Present on a host save only: what the host limits changed (MergeHostBountyState). */
    host?: HostBountyAdjustments;
}

// What a host save carries into the shared merge: the plan's sanitised bounties are merged, the original ids still decide
// what a replace-mode save names (so an ignored entry stays as stored), and the claimed weekly instances stay protected.
interface HostMergeContext {
    nowMs: number;
    sentIds: ReadonlySet<string>;
    sentCount: number;
    adjustments: HostBountyAdjustments;
}

function ApplyBountySave(
    userId: string,
    previous: BountyStateRecord | undefined,
    body: BountySaveBody,
    bounties: Record<string, any>[],
    draftKeys: typeof DRAFT_KEYS[number][],
    now: string,
    host?: HostMergeContext
): { record: BountyStateRecord; summary: BountyMergeSummary } {
    let List: StoredBounty[] = previous?.bounties?.slice() ?? [];
    const DraftData: BountyStateRecord["draftData"] = { ...(previous?.draftData ?? {}) };
    let Summary: BountyMergeSummary;
    // A dedicated save names what it carries; a host save names what the host sent (the plan may have ignored some of it).
    const SentIds: ReadonlySet<string> = host?.sentIds ?? new Set(bounties.map((Bounty) => Bounty.bounty_id as string));
    const SentCount = host?.sentCount ?? bounties.length;

    if (draftKeys.length === 1) {
        const { key, group } = draftKeys[0];
        DraftData[group] = body[key] as Record<string, unknown>;
        let Removed = 0;
        if (SentCount > 0) {
            const Before = List.length;
            List = List.filter((Entry) => {
                const EntryGroup = Entry.group === "unassigned" ? InferBountyGroup(String(Entry.bounty.bounty_id)) : Entry.group;
                if (EntryGroup !== group || SentIds.has(Entry.bounty.bounty_id)) return true;
                if (host !== undefined && IsProtectedClaimedWeekly(Entry, host.nowMs)) {
                    // A claimed weekly instance the host's list leaves out stays: dropping it would let a later save add it back unclaimed.
                    host.adjustments.keptClaimedWeekly++;
                    NoteAdjustedId(host.adjustments.keptClaimedWeeklyIds, String(Entry.bounty.bounty_id));
                    return true;
                }
                return false;
            });
            Removed = Before - List.length;
            // A host's entry is filed by its id (a Challenge_Daily_* id sent under the weekly key must not become a fundable weekly claim).
            for (const Bounty of bounties) List = Upsert(List, Bounty, host ? InferBountyGroup(String(Bounty.bounty_id)) : group, now);
        }
        Summary = { mode: "replace", group, incoming: SentCount, removed: Removed };
    }
    else {
        for (const Key of draftKeys) DraftData[Key.group] = body[Key.key] as Record<string, unknown>;
        for (const Bounty of bounties) List = Upsert(List, Bounty, InferBountyGroup(String(Bounty.bounty_id)), now);
        Summary = { mode: "upsert", incoming: SentCount, removed: 0 };
    }
    if (host) Summary.host = host.adjustments;

    return {
        record: {
            userId,
            bounties: Cap(List, host ? (Entry) => IsProtectedClaimedWeekly(Entry, host.nowMs) : undefined),
            draftData: DraftData,
            // The once-a-day daily reward key belongs to the account, not to a save: every save keeps it.
            ...(previous?.dailyRewardCreditedOn !== undefined ? { dailyRewardCreditedOn: previous.dailyRewardCreditedOn } : {}),
            // [2026-10-15] The host's daily premium draft token day is the account's too: every save keeps it.
            ...(previous?.dailyPremiumDraftGrantedOn !== undefined ? { dailyPremiumDraftGrantedOn: previous.dailyPremiumDraftGrantedOn } : {}),
            updateVersion: (previous?.updateVersion ?? 0) + 1,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        },
        summary: Summary,
    };
}

export function MergeBountyState(
    userId: string,
    previous: BountyStateRecord | undefined,
    body: unknown,
    now: string = new Date().toISOString()
): { record: BountyStateRecord; summary: BountyMergeSummary } {
    const { bounties, draftKeys } = ValidateBountySave(body);
    return ApplyBountySave(userId, previous, body as BountySaveBody, bounties, draftKeys, now);
}

export function BountyStatePayload(record: BountyStateRecord | undefined): Record<string, unknown> {
    return {
        season_start_date: BOUNTY_SEASON_START_DATE,
        season_end_date: BOUNTY_SEASON_END_DATE,
        bounties: (record?.bounties ?? []).map((Entry) => Entry.bounty),
        draft_data: record?.draftData?.base ?? DefaultDraftData(),
        draft_data_daily: record?.draftData?.daily ?? DefaultDraftData(),
        draft_data_weekly: record?.draftData?.weekly ?? DefaultDraftData(),
    };
}

const MAX_RECORDED_BOUNTY_IDS = 24;

/** [2026-10-13 realms S3] The bounty ids this save turned from unclaimed (or new) into claimed. WithClaimMetadata stamps
 *  claimedAt with the save's own `now`, which is also the record's updatedAt, so an instance claimed in this very save is
 *  the one whose claimedAt equals record.updatedAt; an older claim keeps its older stamp (and a legacy claim has none). */
export function NewlyClaimedBountyIds(record: BountyStateRecord): string[] {
    return record.bounties
        .filter((Entry) => Entry.bounty.claimed === true && Entry.claimedAt !== undefined && Entry.claimedAt === record.updatedAt)
        .map((Entry) => String(Entry.bounty.bounty_id));
}

/** [2026-10-13 realms S3] What a host's accepted bounty save tags for behaviour analysis (hostWrites.record): the merge
 *  mode and group, how many bounties came in, and which ids became claimed (a claim funds one Cache Coins grant, so a
 *  host claiming the same id again and again shows up as repeats across records). Ids are capped. */
export function HostBountyWriteSummary(summary: BountyMergeSummary, record: BountyStateRecord): Record<string, unknown> {
    const Claimed = NewlyClaimedBountyIds(record);
    const Host = summary.host;
    return {
        mode: summary.mode,
        ...(summary.group ? { group: summary.group } : {}),
        incoming: summary.incoming,
        removed: summary.removed,
        newlyClaimedCount: Claimed.length,
        newlyClaimed: Claimed.slice(0, MAX_RECORDED_BOUNTY_IDS),
        // [2026-10-13 realms S3 limits] What the host limits changed in this save (MergeHostBountyState); the id lists are
        // capped samples and only present when something was changed.
        ...(Host ? {
            keptClaimedWeekly: Host.keptClaimedWeekly,
            ignoredWeekly: Host.ignoredWeekly,
            clampedProgress: Host.clampedProgress,
            ...(Host.keptClaimedWeeklyIds.length > 0 ? { keptClaimedWeeklyIds: Host.keptClaimedWeeklyIds } : {}),
            ...(Host.ignoredWeeklyIds.length > 0 ? { ignoredWeeklyIds: Host.ignoredWeeklyIds } : {}),
        } : {}),
        version: record.updateVersion,
    };
}

/** Counts per group, for the [DraftMon] lines. `credited` = claims that already funded their reward. */
export function BountyGroupCounts(record: BountyStateRecord | undefined): Record<string, number> {
    const Counts: Record<string, number> = { base: 0, daily: 0, weekly: 0, unassigned: 0, claimed: 0, credited: 0 };
    for (const Entry of record?.bounties ?? []) {
        Counts[Entry.group] = (Counts[Entry.group] ?? 0) + 1;
        if (Entry.bounty.claimed === true) Counts.claimed++;
        if (Entry.rewardCredit) Counts.credited++;
    }
    return Counts;
}

// ---------------------------------------------------------------------------------------------------------------------
// [2026-10-13 realms S3 limits] Host saves: refuse only the impossible, proven by evidence.
//
// A player-host runtime's claims are accepted (owner decision), and every claimed, uncredited weekly instance funds one Cache
// Coins grant of up to MAX_CHALLENGE_REWARD_PER_CLAIM (FindFundableSeasonClaim). The 13 Oct research of the real data shows
// what a host can legitimately send, so a host save is held to exactly that and nothing more:
//   - Weekly season challenges (ids with Challenge_Season) are a FIXED SCHEDULE: never drafted by the player, claimed by the
//     game itself. Per hunt-pass window there are 11 weeks x 10 = 110 instances with ids
//     `<season>_<week>_<n>_Challenge_Season_<name>-season<season>-<week-1>`, and every instance's drafted_timestamp is
//     window start + 7 days x (week-1) (seasonWindow.ts). A claimed instance gets a new stamp only when the window rolls;
//     there is no reroll. Three loopholes follow from storing whatever a host says: (1) re-stamping a claimed instance makes
//     it a "new" one, claimed and paid again; (2) a save that leaves a claimed instance out drops it (a replace-mode list, or
//     the stored-list cap evicting claimed entries first) and a later save adds it back unclaimed; (3) any invented id
//     containing Challenge_Season is accepted and fundable (also one filed under another group's draft key).
//   - Objective progress has no ceiling in the merge; the largest real value is 500,752 and the largest 1.12 target
//     10,000,000.
// Daily bounties are real drafts and keep their behaviour. Everything below is applied to a host's save only (the pure
// planning in PlanHostBountySave, then the shared merge); offending entries are silently kept as stored (or not stored), the
// save otherwise proceeds with a 200, and the counts go into the host-write tag (HostBountyWriteSummary).

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEKLY_CHALLENGE_WEEKS = 11;
export const WEEKLY_CHALLENGES_PER_WEEK = 10;
/** The most weekly instances one hunt-pass window holds (11 weeks x 10): a host cannot make an account hold more. */
export const WEEKLY_INSTANCES_PER_WINDOW = WEEKLY_CHALLENGE_WEEKS * WEEKLY_CHALLENGES_PER_WEEK;
/** A server that fetched the pass window before it rolled keeps stamping the previous window's schedule for a while, so
 *  that schedule is still accepted for this long after a roll. */
export const WEEKLY_PREVIOUS_WINDOW_GRACE_MS = 2 * 60 * 60 * 1000;
/** Clamp, not refusal: refusing the entry would also drop its claim and the other objectives riding on it, and the game
 *  re-sends it on every arrival; a clamped value is stable under the monotonic merge. 100 M is 10x the largest 1.12 target. */
export const MAX_HOST_OBJECTIVE_PROGRESS = 100000000;
const MAX_RECORDED_ADJUSTED_IDS = 10;

export interface HostBountyAdjustments {
    /** Claimed weekly instances that stayed as stored: a re-stamp or a dropped entry a host tried (the save went on). */
    keptClaimedWeekly: number;
    /** Weekly entries not stored: bad id, off-schedule stamp, a stamp older than the stored one, or a full window. */
    ignoredWeekly: number;
    /** Objectives whose progress was clamped to MAX_HOST_OBJECTIVE_PROGRESS. */
    clampedProgress: number;
    keptClaimedWeeklyIds: string[];
    ignoredWeeklyIds: string[];
}

function NewAdjustments(): HostBountyAdjustments {
    return { keptClaimedWeekly: 0, ignoredWeekly: 0, clampedProgress: 0, keptClaimedWeeklyIds: [], ignoredWeeklyIds: [] };
}

function NoteAdjustedId(list: string[], id: string): void {
    if (list.length < MAX_RECORDED_ADJUSTED_IDS) list.push(id);
}

const WEEKLY_ID_PATTERN = /^(\d+)_(\d+)_(\d+)_Challenge_Season_[A-Za-z0-9_]+-season(\d+)-(\d+)$/;

export interface WeeklyBountyId {
    season: number;
    week: number;
    slot: number;
}

/** The weekly id shape: `<season>_<week>_<n>_Challenge_Season_<name>-season<season>-<week-1>`, week 1..11, n 1..10 (the 110
 *  instances of a window), the trailing index equal to week-1, numbers written canonically (no leading zeros). */
export function ParseWeeklyBountyId(bountyId: string): WeeklyBountyId | undefined {
    const Match = WEEKLY_ID_PATTERN.exec(bountyId);
    if (Match === null) return undefined;
    const Week = Number(Match[2]);
    const Slot = Number(Match[3]);
    if (!Number.isInteger(Week) || Week < 1 || Week > WEEKLY_CHALLENGE_WEEKS || Match[2] !== String(Week)) return undefined;
    if (!Number.isInteger(Slot) || Slot < 1 || Slot > WEEKLY_CHALLENGES_PER_WEEK || Match[3] !== String(Slot)) return undefined;
    if (Match[5] !== String(Week - 1)) return undefined;
    return { season: Number(Match[1]), week: Week, slot: Slot };
}

/** The drafted_timestamp the schedule gives week `week` of the window that starts at `windowStartMs`. */
export function WeeklyScheduleStampMs(windowStartMs: number, week: number): number {
    return windowStartMs + (week - 1) * 7 * DAY_MS;
}

/** The stamps a host may give week `week` at `nowMs`: the current window's schedule, and the previous window's for
 *  WEEKLY_PREVIOUS_WINDOW_GRACE_MS after a roll. */
export function AcceptedWeeklyStampsMs(week: number, nowMs: number): number[] {
    const { startMs } = ActiveSeasonWindowMs(nowMs);
    const Stamps = [WeeklyScheduleStampMs(startMs, week)];
    if (nowMs - startMs < WEEKLY_PREVIOUS_WINDOW_GRACE_MS) Stamps.push(WeeklyScheduleStampMs(startMs - ACTIVE_SEASON_LENGTH_MS, week));
    return Stamps;
}

function BountyStampMs(bounty: Record<string, any>): number {
    const Stamp = bounty.drafted_timestamp;
    return typeof Stamp === "string" ? Date.parse(Stamp) : Number.NaN;
}

/** A stored, claimed weekly instance whose stamp is one a host may still send: dropping it (an omitted entry, the list cap)
 *  would let a host add it back unclaimed and claim it again. Older claimed instances are not protected - no accepted stamp
 *  can bring them back, so losing them changes nothing a host can use. */
export function IsProtectedClaimedWeekly(entry: StoredBounty, nowMs: number): boolean {
    if (entry.bounty.claimed !== true) return false;
    const Id = String(entry.bounty.bounty_id);
    if (InferBountyGroup(Id) !== "weekly") return false;
    const Parsed = ParseWeeklyBountyId(Id);
    if (Parsed === undefined) return false;
    return AcceptedWeeklyStampsMs(Parsed.week, nowMs).includes(BountyStampMs(entry.bounty));
}

/** Clamps every objective progress above MAX_HOST_OBJECTIVE_PROGRESS (read the way the merge reads it: Number(progress)).
 *  Returns the same object when nothing needed clamping. */
export function ClampHostObjectiveProgress(bounty: Record<string, any>): { bounty: Record<string, any>; clamped: number } {
    if (!Array.isArray(bounty.objectives)) return { bounty, clamped: 0 };
    let Clamped = 0;
    const Objectives = bounty.objectives.map((Objective: any) => {
        if (!IsPlainObject(Objective) || !(Number(Objective.progress) > MAX_HOST_OBJECTIVE_PROGRESS)) return Objective;
        Clamped++;
        return { ...Objective, progress: MAX_HOST_OBJECTIVE_PROGRESS };
    });
    return Clamped === 0 ? { bounty, clamped: 0 } : { bounty: { ...bounty, objectives: Objectives }, clamped: Clamped };
}

interface WeeklyState {
    stampMs: number;
    stamp: unknown;
    claimed: boolean;
}

/**
 * Pure. The sanitised bounty list a host's save is merged from, and what was changed. Per weekly entry (an id with
 * Challenge_Season), judged in order against the stored instances as earlier entries of the same save left them:
 *   - the id must be a ParseWeeklyBountyId id and the stamp an AcceptedWeeklyStampsMs stamp, else it is not stored;
 *   - an entry for an instance that is stored with the same stamp (compared as instants: the stored notation is kept) is
 *     the same instance and merges monotonically as always;
 *   - an entry whose stamp differs from the stored one is a replacement, allowed only forward (a later stamp: the window
 *     rolled), never back - an older schedule stamp over a newer instance would bring a claimed instance back from the
 *     previous window;
 *   - a new id, or a move into another window, is refused once the window already holds WEEKLY_INSTANCES_PER_WINDOW.
 * A refused entry that targets a stored CLAIMED instance counts as keptClaimedWeekly, any other as ignoredWeekly; neither
 * is merged, so the stored instance stays as it was. Objective progress above MAX_HOST_OBJECTIVE_PROGRESS is clamped in
 * every bounty, daily and base ones included.
 */
export function PlanHostBountySave(
    previous: BountyStateRecord | undefined,
    bounties: Record<string, any>[],
    nowMs: number
): { bounties: Record<string, any>[]; adjustments: HostBountyAdjustments } {
    const Adjustments = NewAdjustments();
    const Weekly = new Map<string, WeeklyState>();
    const Windows = new Map<number, Set<string>>();   // window start -> the weekly ids whose stamp lies in it
    const Place = (id: string, stampMs: number): void => {
        for (const Ids of Windows.values()) Ids.delete(id);
        if (!Number.isFinite(stampMs)) return;
        const Key = ActiveSeasonWindowMs(stampMs).startMs;
        const Ids = Windows.get(Key) ?? new Set<string>();
        Ids.add(id);
        Windows.set(Key, Ids);
    };
    for (const Entry of previous?.bounties ?? []) {
        const Id = String(Entry.bounty.bounty_id);
        if (InferBountyGroup(Id) !== "weekly" || Weekly.has(Id)) continue;   // the merge finds the first entry of an id too
        const StampMs = BountyStampMs(Entry.bounty);
        Weekly.set(Id, { stampMs: StampMs, stamp: Entry.bounty.drafted_timestamp, claimed: Entry.bounty.claimed === true });
        Place(Id, StampMs);
    }

    const Planned: Record<string, any>[] = [];
    for (const Sent of bounties) {
        const Id = String(Sent.bounty_id);
        const { bounty: Bounty, clamped } = ClampHostObjectiveProgress(Sent);
        Adjustments.clampedProgress += clamped;
        if (InferBountyGroup(Id) !== "weekly") {
            Planned.push(Bounty);
            continue;
        }

        const Stored = Weekly.get(Id);
        const Refuse = (): void => {
            if (Stored?.claimed === true) {
                Adjustments.keptClaimedWeekly++;
                NoteAdjustedId(Adjustments.keptClaimedWeeklyIds, Id);
            }
            else {
                Adjustments.ignoredWeekly++;
                NoteAdjustedId(Adjustments.ignoredWeeklyIds, Id);
            }
        };
        const Parsed = ParseWeeklyBountyId(Id);
        const StampMs = BountyStampMs(Bounty);
        if (Parsed === undefined || !AcceptedWeeklyStampsMs(Parsed.week, nowMs).includes(StampMs)) {
            Refuse();
            continue;
        }
        if (Stored !== undefined && Stored.stampMs === StampMs) {
            // The same instance; a different notation of the same instant must not look like a re-stamp to the merge.
            Planned.push(Stored.stamp === Bounty.drafted_timestamp ? Bounty : { ...Bounty, drafted_timestamp: Stored.stamp });
            Stored.claimed = Stored.claimed || Bounty.claimed === true;
            continue;
        }
        if (Stored !== undefined && Number.isFinite(Stored.stampMs) && StampMs < Stored.stampMs) {
            Refuse();
            continue;
        }
        const InWindow = Windows.get(ActiveSeasonWindowMs(StampMs).startMs);
        if (InWindow?.has(Id) !== true && (InWindow?.size ?? 0) >= WEEKLY_INSTANCES_PER_WINDOW) {
            Refuse();
            continue;
        }
        Place(Id, StampMs);
        Weekly.set(Id, { stampMs: StampMs, stamp: Bounty.drafted_timestamp, claimed: Bounty.claimed === true });
        Planned.push(Bounty);
    }
    return { bounties: Planned, adjustments: Adjustments };
}

/** MergeBountyState for a player-host runtime's save: PlanHostBountySave first, then the shared merge with the claimed
 *  weekly instances protected from omission and from the list cap. Same validation (BountySaveValidationError), same record. */
export function MergeHostBountyState(
    userId: string,
    previous: BountyStateRecord | undefined,
    body: unknown,
    now: string = new Date().toISOString()
): { record: BountyStateRecord; summary: BountyMergeSummary } {
    const { bounties, draftKeys } = ValidateBountySave(body);
    const Parsed = Date.parse(now);
    const NowMs = Number.isFinite(Parsed) ? Parsed : Date.now();
    const Plan = PlanHostBountySave(previous, bounties, NowMs);
    return ApplyBountySave(userId, previous, body as BountySaveBody, Plan.bounties, draftKeys, now, {
        nowMs: NowMs,
        sentIds: new Set(bounties.map((Bounty) => Bounty.bounty_id as string)),
        sentCount: bounties.length,
        adjustments: Plan.adjustments,
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// Season-challenge rewards (10 Oct 2026). Completing a season challenge makes the game server claim it (a single-bounty
// save with claimed: true) and, ~50 ms before or after, post +N CURRENCY_SEASONAL_COIN (400 for the two measured).
// wallet.ts funds such a grant from exactly one claimed, not-yet-credited season challenge and records the credit on
// that instance in the same Mongo transaction, so each completed challenge pays once: the claim is sticky (the game
// is served claimed: true on every later load and never claims it again), and a credited instance never funds another
// grant.
// [2026-10-14] Daily challenges pay too (owner: "enable daily cache coins ... add time based cooldown"). The game's daily
// challenge (`Challenge_Daily_*`, bounty_game_data_daily: one bronze, automatic draft and claim, one
// TOKEN_DAILY_CHALLENGE_DRAFT per draft) pays its 100 Cache Coins when its objective is completed and it is claimed - per
// completion, not per day - and the game's own top-up grants +4 draft tokens, so paying every claimed daily could pay
// several a day. A daily claim therefore funds at most ONE reward per UTC day (the game's daily reset is 00:00 UTC,
// bounty_token_grant_hour 0), recorded durably on the account (`dailyRewardCreditedOn`), not only on the instance a
// re-draft can replace. Weekly season challenges keep their rule (one reward per claimed instance).

export const CHALLENGE_REWARD_CURRENCIES: ReadonlySet<string> = new Set(["CURRENCY_SEASONAL_COIN"]);
export const MAX_CHALLENGE_REWARD_PER_CLAIM = 1000;

function GroupOf(entry: StoredBounty): Exclude<BountyGroup, "unassigned"> {
    return entry.group === "unassigned" ? InferBountyGroup(String(entry.bounty.bounty_id)) : entry.group;
}

/** The UTC day of an instant, as YYYY-MM-DD (the daily challenge reward's once-a-day key). */
export function UtcDay(at: number | string = Date.now()): string {
    return new Date(at).toISOString().slice(0, 10);
}

/** The claimed, uncredited challenge a reward grant should be charged to: the most recently claimed weekly season
 *  challenge or daily challenge (claims stored before claimedAt existed count as the oldest); a daily one only while no
 *  daily reward was paid on this UTC day. Undefined when none is fundable. */
export function FindFundableSeasonClaim(record: BountyStateRecord | undefined, nowMs: number = Date.now()): StoredBounty | undefined {
    const DailyAllowed = record?.dailyRewardCreditedOn !== UtcDay(nowMs);
    let Best: StoredBounty | undefined;
    for (const Entry of record?.bounties ?? []) {
        const Group = GroupOf(Entry);
        if (Entry.bounty.claimed !== true || Entry.rewardCredit) continue;
        if (Group !== "weekly" && !(Group === "daily" && DailyAllowed)) continue;
        if (!Best || (Entry.claimedAt ?? "") > (Best.claimedAt ?? "")) Best = Entry;
    }
    return Best;
}

/** Returns a copy of the record with the credit recorded on `bountyId` (the caller saves it with a version check). */
export function WithRewardCredit(
    record: BountyStateRecord,
    bountyId: string,
    credit: NonNullable<StoredBounty["rewardCredit"]>,
    now: string = new Date().toISOString()
): BountyStateRecord {
    let Found = false;
    let Daily = false;
    const Bounties = record.bounties.map((Entry) => {
        if (Entry.bounty.bounty_id !== bountyId) return Entry;
        if (Entry.bounty.claimed !== true || Entry.rewardCredit) throw new Error(`bounty ${bountyId} is not a fundable claim`);
        Found = true;
        Daily = GroupOf(Entry) === "daily";
        return { ...Entry, rewardCredit: credit };
    });
    if (!Found) throw new Error(`bounty ${bountyId} is not stored`);
    return {
        ...record,
        bounties: Bounties,
        ...(Daily ? { dailyRewardCreditedOn: UtcDay(credit.at) } : {}),
        updateVersion: record.updateVersion + 1,
        updatedAt: now
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// [2026-10-15] The host-granted daily premium draft token. A realm host may add TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM once per UTC day
// per account (p2p/security/hostDraftPremium.ts decides). The day lives on the account's bounty record, next to dailyRewardCreditedOn,
// so the grant reads and writes it with the same versioned save as the rest of the record, inside its inventory transaction.

/**
 * Returns the record with `day` recorded as the day this account's premium draft token was last host-granted. A missing record
 * becomes an empty one at version 1: the bounty board answers an empty record exactly as it answers a missing one (BountyStatePayload).
 */
export function WithDraftPremiumGrantDay(
    record: BountyStateRecord | undefined,
    userId: string,
    day: string,
    now: string = new Date().toISOString()
): BountyStateRecord {
    if (record === undefined) {
        return { userId, bounties: [], draftData: {}, dailyPremiumDraftGrantedOn: day, updateVersion: 1, createdAt: now, updatedAt: now };
    }
    return { ...record, dailyPremiumDraftGrantedOn: day, updateVersion: record.updateVersion + 1, updatedAt: now };
}
