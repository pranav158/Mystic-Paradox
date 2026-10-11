/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { BountyGroup, BountyStateRecord, StoredBounty } from "./persistence/mapping/domainTypes";

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
 *  claimed challenge and collect its reward again. Player-host runtimes are excluded, as for escalation. */
export function IsAuthorizedBountyWriter(authData: any): boolean {
    return authData?.IsGameserver === true;
}

export function IsAuthorizedBountyReader(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    if (authData?.IsPlayerHostRuntime === true) return false;
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

function Cap(list: StoredBounty[]): StoredBounty[] {
    if (list.length <= MAX_STORED_BOUNTIES) return list;
    // Drop the oldest claimed bounties first, then the oldest of the rest.
    const Ranked = list
        .map((Entry, Index) => ({ Entry, Index, Claimed: Entry.bounty.claimed === true, Time: Date.parse(String(Entry.bounty.drafted_timestamp ?? "")) || 0 }))
        .sort((a, b) => (Number(b.Claimed) - Number(a.Claimed)) || (a.Time - b.Time));
    const Drop = new Set(Ranked.slice(0, list.length - MAX_STORED_BOUNTIES).map((Item) => Item.Index));
    return list.filter((_, Index) => !Drop.has(Index));
}

export interface BountyMergeSummary {
    mode: "replace" | "upsert";
    group?: Exclude<BountyGroup, "unassigned">;
    incoming: number;
    removed: number;
}

export function MergeBountyState(
    userId: string,
    previous: BountyStateRecord | undefined,
    body: unknown,
    now: string = new Date().toISOString()
): { record: BountyStateRecord; summary: BountyMergeSummary } {
    const { bounties, draftKeys } = ValidateBountySave(body);
    const Body = body as BountySaveBody;
    let List: StoredBounty[] = previous?.bounties?.slice() ?? [];
    const DraftData: BountyStateRecord["draftData"] = { ...(previous?.draftData ?? {}) };
    let Summary: BountyMergeSummary;

    if (draftKeys.length === 1) {
        const { key, group } = draftKeys[0];
        DraftData[group] = Body[key] as Record<string, unknown>;
        let Removed = 0;
        if (bounties.length > 0) {
            const Incoming = new Set(bounties.map((Bounty) => Bounty.bounty_id as string));
            const Before = List.length;
            List = List.filter((Entry) => {
                const EntryGroup = Entry.group === "unassigned" ? InferBountyGroup(String(Entry.bounty.bounty_id)) : Entry.group;
                return EntryGroup !== group || Incoming.has(Entry.bounty.bounty_id);
            });
            Removed = Before - List.length;
            for (const Bounty of bounties) List = Upsert(List, Bounty, group, now);
        }
        Summary = { mode: "replace", group, incoming: bounties.length, removed: Removed };
    }
    else {
        for (const Key of draftKeys) DraftData[Key.group] = Body[Key.key] as Record<string, unknown>;
        for (const Bounty of bounties) List = Upsert(List, Bounty, InferBountyGroup(String(Bounty.bounty_id)), now);
        Summary = { mode: "upsert", incoming: bounties.length, removed: 0 };
    }

    return {
        record: {
            userId,
            bounties: Cap(List),
            draftData: DraftData,
            updateVersion: (previous?.updateVersion ?? 0) + 1,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        },
        summary: Summary,
    };
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
// Season-challenge rewards (10 Oct 2026). Completing a season challenge makes the game server claim it (a single-bounty
// save with claimed: true) and, ~50 ms before or after, post +N CURRENCY_SEASONAL_COIN (400 for the two measured).
// wallet.ts funds such a grant from exactly one claimed, not-yet-credited season challenge and records the credit on
// that instance in the same Mongo transaction, so each completed challenge pays once: the claim is sticky (the game
// is served claimed: true on every later load and never claims it again), and a credited instance never funds another
// grant. Daily bounties are excluded - they are still re-drafted on every arrival (38_ section 19.5).

export const CHALLENGE_REWARD_CURRENCIES: ReadonlySet<string> = new Set(["CURRENCY_SEASONAL_COIN"]);
export const MAX_CHALLENGE_REWARD_PER_CLAIM = 1000;

function GroupOf(entry: StoredBounty): Exclude<BountyGroup, "unassigned"> {
    return entry.group === "unassigned" ? InferBountyGroup(String(entry.bounty.bounty_id)) : entry.group;
}

/** The claimed, uncredited season challenge a reward grant should be charged to: the most recently claimed one
 *  (claims stored before claimedAt existed count as the oldest). Undefined when none is fundable. */
export function FindFundableSeasonClaim(record: BountyStateRecord | undefined): StoredBounty | undefined {
    let Best: StoredBounty | undefined;
    for (const Entry of record?.bounties ?? []) {
        if (GroupOf(Entry) !== "weekly" || Entry.bounty.claimed !== true || Entry.rewardCredit) continue;
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
    const Bounties = record.bounties.map((Entry) => {
        if (Entry.bounty.bounty_id !== bountyId) return Entry;
        if (Entry.bounty.claimed !== true || Entry.rewardCredit) throw new Error(`bounty ${bountyId} is not a fundable claim`);
        Found = true;
        return { ...Entry, rewardCredit: credit };
    });
    if (!Found) throw new Error(`bounty ${bountyId} is not stored`);
    return { ...record, bounties: Bounties, updateVersion: record.updateVersion + 1, updatedAt: now };
}
