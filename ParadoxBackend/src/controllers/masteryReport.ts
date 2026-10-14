/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

/*
 * Mastery from the game server's progression report (POST /progression/:userId), 1.14.7.
 *
 * UProgressionComponent::GrantProgressAndUpdateObjectives (0x141A809B0) sends
 *   progress_tracks: [{ progression_id, progress }]     FProgressTrackEvent {Track, Amount}: an INCREMENT per report
 *   objectives:      [{ objective_id, value, completed_count }]   FPlayerObjective: the objective's absolute state
 * UMasteryCard::OnOwnedObjectiveModified (0x141BF1E70) reports a mastery objective once, when it completes, and adds +1
 * to its card's track and +1 to MasteryTrack_PlayerLevel (all 361 track-carrying reports since 1 Oct match that).
 * The card's starting point is the cached objective list the server loaded from GET /progression/objectives, so a
 * missing or wrongly shaped list makes every owned/killed objective "complete" again on each arrival.
 *
 * Credit therefore comes from STORED objective state, not from the claimed increments: a MasteryObjective_* whose stored
 * completed_count goes from 0 to >= 1 in this report credits +1 to MasteryTrack_PlayerLevel and +1 to its card track,
 * each capped at what the report itself claimed for that track. Everything runs in one Mongo transaction, so a retry, a
 * re-sent arrival report or a concurrent hub/hunt report finds the objective already completed and credits nothing.
 * Achievement objectives are stored the same way and credit nothing. Experience/Hunt Pass XP never comes from here (it
 * uses the authoritative grant route). MYSTICPARADOX_MASTERY_PERSISTENCE=off keeps the report diagnostics-only.
 *
 * [2026-10-13 realms S3] A player-hosted server's report is applied by the same code (routes/progression.ts, after the
 * hostWrites check) and its plan is tagged (SummarizeMasteryPlan). Mastery can only rise there: objectives merge with $max,
 * credit is +1 per objective that completes for the first time, capped at the report's own claim.
 *
 * [2026-10-13 realms S3 limits] A player-hosted server's report is also bounded (MasteryHostLimits, applied only when the
 * route passes them; a dedicated server's report is planned exactly as before). Owner decision: refuse only the impossible,
 * proven by evidence - real reports carry at most 9 new completions on 1.14.7 (49 in any report ever), per-objective
 * completed_count 0-2 and a largest value of 1,186,502; the 1,614 stored rows of the live database hold only
 * MasteryObjective_ (629 distinct ids, all matching the id grammar below) and AchievementObjective_ ids.
 */

import { logger } from "../logger";
import { tryLoadGameData } from "../gameData/loader";
import { ClientSession } from "mongodb";
import { GetUnitOfWork, ProgressionObjectiveRecord, ProgressionTrackRecord, RepositoryProvider, UnitOfWork } from "../persistence";
import { MASTERY_CREDIT_PER_OBJECTIVE, TrackCapXp } from "./progression";

export const MASTERY_PERSISTENCE = !/^(0|false|off|no)$/i.test(process.env.MYSTICPARADOX_MASTERY_PERSISTENCE ?? "");

export const MASTERY_PLAYER_TRACK = "MasteryTrack_PlayerLevel";
const MASTERY_BEHEMOTH_TRACK = "MasteryTrack_Behemoth";

// Weapon codes in MasteryObjective_Weapon_<code>_* ids. Axe and Sword are seen in live reports; Pike -> Spear and
// DP -> Repeaters were matched against the claimed tracks. The rest are the track names themselves; an unknown code
// still credits MasteryTrack_PlayerLevel and is logged. [2026-10-13] game-data/mastery_objectives.json (exported card table)
// holds exactly seven codes - Axe, CB, DP, Hammer, Pike, Strikers, Sword - and its cards name the track of each; CB is chain
// blades (it was missing here, so a chain blades objective credited the player track only and was logged UNMAPPED).
const WEAPON_CODE_TRACKS: Record<string, string> = {
    Axe: "MasteryTrack_Weapon_Axe",
    Sword: "MasteryTrack_Weapon_Sword",
    Strikers: "MasteryTrack_Weapon_Strikers",
    Pike: "MasteryTrack_Weapon_Spear",
    Spear: "MasteryTrack_Weapon_Spear",
    DP: "MasteryTrack_Weapon_Repeaters",
    Repeaters: "MasteryTrack_Weapon_Repeaters",
    CB: "MasteryTrack_Weapon_ChainBlades",
    ChainBlades: "MasteryTrack_Weapon_ChainBlades",
    Chainblades: "MasteryTrack_Weapon_ChainBlades",
    Hammer: "MasteryTrack_Weapon_Hammer",
};

/** The card track a mastery objective feeds: a track id, null for an unknown weapon code, undefined for a non-mastery id. */
export function MasteryCardTrackFor(objectiveId: string): string | null | undefined {
    if (!objectiveId.startsWith("MasteryObjective_")) return undefined;
    if (objectiveId.startsWith("MasteryObjective_Behemoth_")) return MASTERY_BEHEMOTH_TRACK;
    const Weapon = /^MasteryObjective_Weapon_([A-Za-z]+)_/.exec(objectiveId);
    if (Weapon) return WEAPON_CODE_TRACKS[Weapon[1]] ?? null;
    return null;
}

export interface StoredObjectiveState { value: number; completedCount: number }

export interface MasteryPlan {
    objectives: { objectiveId: string; value: number; completedCount: number }[];   // reported state, duplicates merged
    merged: Map<string, StoredObjectiveState>;                                        // max(stored, reported), for the response
    newlyCompleted: string[];
    credits: Record<string, number>;
    claimed: Record<string, number>;
    unmapped: string[];
    capped: string[];
    // [2026-10-13 realms S3 limits] What MasteryHostLimits did to a host's report; all four stay empty for a dedicated server's.
    ignored: { objectiveId: string; reason: string }[];   // not stored, not credited, left out of the response
    overLimit: string[];                                   // new completions past the per-report limit: not stored, not credited
    clamped: string[];                                     // "<id> value|count <reported>-><limit>": stored at the limit
    atCap: string[];                                       // "<track> <credit>-><room>": credit cut at the track's rank-sum total
}

// [2026-10-13 realms S3 limits] The limits of a player-hosted server's mastery report.
export const HOST_MASTERY_MAX_NEWLY_COMPLETED = 64;        // 7x the 9 of any real 1.14.7 report, above the 49 of the worst one ever
export const HOST_MASTERY_MAX_COMPLETED_COUNT = 10;        // real: 0-2
export const HOST_MASTERY_MAX_VALUE = 100_000_000;         // real largest 1,186,502; the report validation allows 1e9

export interface MasteryHostLimits {
    /** New completions credited per report. The extra ones are ignored: not stored, so a later report can still credit them. */
    maxNewlyCompleted: number;
    /** completed_count and value are CLAMPED, not dropped: the row still records that the objective was reached, and a
     *  stored $max value above any real one could never be lowered by an honest report later. */
    maxCompletedCount: number;
    maxValue: number;
    /** Whether a MasteryObjective_ / AchievementObjective_ id is a real objective: the id list of game-data/mastery_objectives.json
     *  when it loads, else the id grammar. */
    isKnownObjective: (objectiveId: string) => boolean;
    /** What a mastery track can total at most (its rank-sum from progression_config.json); undefined = no cap known. */
    trackCap?: (progressionId: string) => number | undefined;
    /** The stored totals of the mastery tracks the report claims (ApplyMasteryReportWithPlan reads them inside its
     *  transaction); credit is cut at cap - total. Without it no total is enforced. */
    trackTotals?: ReadonlyMap<string, number>;
}

// Ids seen in the live database and the documented captures: MasteryObjective_<Behemoth|Weapon>_<Name>_<Suffix...>
// (..._Kill, _Boop_X_Times, _Craft_Armor, _Generic_Damage3, _Generic_Shock_Damage3, _Generic_Breaks1, _SkiesOfOstia_XP).
// Matches all 1,762 mastery ids of game-data/mastery_objectives.json (card XP-bar ids such as ..._Charrogg_XP and
// ..._PrestigeXP included) and all 66 achievement ids. Only used when that file does not load. Linear: segments are split
// by the underscores.
const MASTERY_OBJECTIVE_ID_SHAPE = /^MasteryObjective_(?:Behemoth|Weapon)_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/;
const ACHIEVEMENT_OBJECTIVE_ID_SHAPE = /^AchievementObjective_[A-Za-z0-9_]+$/;
const OBJECTIVE_ID_MAX_LENGTH = 128;

/** The grammar fallback for "is this an objective id a host may report": a mastery or an achievement id of the known shape. */
export function IsMasteryObjectiveIdShape(objectiveId: string): boolean {
    return objectiveId.length <= OBJECTIVE_ID_MAX_LENGTH
        && (MASTERY_OBJECTIVE_ID_SHAPE.test(objectiveId) || ACHIEVEMENT_OBJECTIVE_ID_SHAPE.test(objectiveId));
}

/**
 * Pure: why a host's objective row is not stored (undefined = it is). Only mastery and achievement ids exist in real
 * reports (all 1,614 stored rows), so any other family is refused, and each id must pass `isKnownObjective`.
 */
export function HostObjectiveIdRefusal(objectiveId: string, isKnownObjective: (objectiveId: string) => boolean): string | undefined {
    if (objectiveId.length === 0 || objectiveId.length > OBJECTIVE_ID_MAX_LENGTH) return "bad_id";
    if (objectiveId.startsWith("MasteryObjective_")) return isKnownObjective(objectiveId) ? undefined : "unknown_mastery_id";
    if (objectiveId.startsWith("AchievementObjective_")) return isKnownObjective(objectiveId) ? undefined : "unknown_achievement_id";
    return "unrecognised_id_family";
}

/** Pure: the exact-id check from the parsed game-data file ({ objectiveIds: string[] }), undefined when it holds no ids. */
export function BuildMasteryObjectiveCheck(data: unknown): ((objectiveId: string) => boolean) | undefined {
    const Ids = (data as { objectiveIds?: unknown } | null | undefined)?.objectiveIds;
    if (!Array.isArray(Ids)) return undefined;
    const Known = new Set<string>(Ids.filter((Id): Id is string => typeof Id === "string"));
    return Known.size === 0 ? undefined : (objectiveId) => Known.has(objectiveId);
}

let LoadedObjectiveCheck: ((objectiveId: string) => boolean) | undefined;

// game-data/mastery_objectives.json when it loads (read once per process), else the id grammar. A file that exists but cannot
// be read or holds no ids falls back too, with one warning: a host's report must not stop working over the file.
function KnownObjectiveCheck(): (objectiveId: string) => boolean {
    if (LoadedObjectiveCheck !== undefined) return LoadedObjectiveCheck;
    let Check: ((objectiveId: string) => boolean) | undefined;
    try {
        Check = BuildMasteryObjectiveCheck(tryLoadGameData("mastery_objectives.json"));
    } catch (error) {
        logger.warn(`[MasteryMon] game-data/mastery_objectives.json is unreadable (${error instanceof Error ? error.message : String(error)}); host mastery reports use the id grammar`);
    }
    logger.info(`[MasteryMon] host objective ids are checked against ${Check !== undefined ? "game-data/mastery_objectives.json" : "the id grammar (no game-data/mastery_objectives.json)"}`);
    return LoadedObjectiveCheck = Check ?? IsMasteryObjectiveIdShape;
}

// A mastery track's rank-sum from the progression config (MasteryTrack_PlayerLevel 1111, _Behemoth 411, each weapon 115).
function MasteryTrackCap(progressionId: string): number | undefined {
    if (!progressionId.startsWith("MasteryTrack_")) return undefined;
    try {
        const Cap = TrackCapXp(progressionId);
        return Cap !== undefined && Cap > 0 ? Cap : undefined;
    } catch {
        return undefined;     // no progression config: the routes would not have started either
    }
}

/** The limits a player-hosted server's report is applied under. `overrides` is for tests. */
export function HostMasteryLimits(overrides: Partial<MasteryHostLimits> = {}): MasteryHostLimits {
    return {
        maxNewlyCompleted: HOST_MASTERY_MAX_NEWLY_COMPLETED,
        maxCompletedCount: HOST_MASTERY_MAX_COMPLETED_COUNT,
        maxValue: HOST_MASTERY_MAX_VALUE,
        isKnownObjective: overrides.isKnownObjective ?? KnownObjectiveCheck(),
        trackCap: MasteryTrackCap,
        ...overrides,
    };
}

/**
 * Pure: what this report changes, given the stored state of its objectives. The body is already validated.
 * With `limits` (a player-hosted server's report) rows with an unknown id are dropped, values and counts are clamped, at most
 * limits.maxNewlyCompleted new completions are applied and credit stops at the track's total; without them the plan is the
 * dedicated server's, exactly as it was.
 */
export function PlanMasteryReport(body: any, stored: Map<string, StoredObjectiveState>, limits?: MasteryHostLimits): MasteryPlan {
    const Reported = new Map<string, StoredObjectiveState>();
    const Ignored: MasteryPlan["ignored"] = [];
    const IgnoredIds = new Set<string>();
    const Clamped: string[] = [];
    for (const Objective of Array.isArray(body?.objectives) ? body.objectives : []) {
        const Id = String(Objective.objective_id);
        let Value = Math.floor(Number(Objective.value ?? 0));
        let Count = Math.floor(Number(Objective.completed_count ?? 0));
        if (limits !== undefined) {
            const Reason = HostObjectiveIdRefusal(Id, limits.isKnownObjective);
            if (Reason !== undefined) {
                if (!IgnoredIds.has(Id)) {
                    IgnoredIds.add(Id);
                    Ignored.push({ objectiveId: Id, reason: Reason });
                }
                continue;
            }
            if (Value > limits.maxValue) {
                Clamped.push(`${Id} value ${Value}->${limits.maxValue}`);
                Value = limits.maxValue;
            }
            if (Count > limits.maxCompletedCount) {
                Clamped.push(`${Id} count ${Count}->${limits.maxCompletedCount}`);
                Count = limits.maxCompletedCount;
            }
        }
        const Previous = Reported.get(Id);
        Reported.set(Id, {
            value: Math.max(Previous?.value ?? 0, Value),
            completedCount: Math.max(Previous?.completedCount ?? 0, Count),
        });
    }

    const Claimed: Record<string, number> = {};
    for (const Track of Array.isArray(body?.progress_tracks) ? body.progress_tracks : []) {
        const Id = String(Track.progression_id);
        if (!Id.startsWith("MasteryTrack_")) continue;
        Claimed[Id] = (Claimed[Id] ?? 0) + Math.max(0, Math.floor(Number(Track.progress ?? 0)));
    }

    const Raw: Record<string, number> = {};
    const NewlyCompleted: string[] = [];
    const Unmapped: string[] = [];
    const Merged = new Map<string, StoredObjectiveState>();
    const Skipped = new Set<string>();
    const OverLimit: string[] = [];
    for (const [Id, State] of Reported) {
        const Before = stored.get(Id);
        const CardTrack = MasteryCardTrackFor(Id);
        const IsNew = CardTrack !== undefined && (Before?.completedCount ?? 0) < 1 && State.completedCount >= 1;
        if (IsNew && limits !== undefined && NewlyCompleted.length >= limits.maxNewlyCompleted) {
            // Past the per-report limit: nothing of this row is stored (the objective stays incomplete, so a later report can
            // still credit it) and the response keeps what was stored.
            OverLimit.push(Id);
            Skipped.add(Id);
            if (Before !== undefined) Merged.set(Id, { value: Before.value, completedCount: Before.completedCount });
            continue;
        }
        Merged.set(Id, {
            value: Math.max(Before?.value ?? 0, State.value),
            completedCount: Math.max(Before?.completedCount ?? 0, State.completedCount),
        });
        if (CardTrack === undefined) continue;                                  // achievements: stored, no credit
        if (!IsNew) continue;
        NewlyCompleted.push(Id);
        Raw[MASTERY_PLAYER_TRACK] = (Raw[MASTERY_PLAYER_TRACK] ?? 0) + MASTERY_CREDIT_PER_OBJECTIVE;
        if (CardTrack === null) Unmapped.push(Id);
        else Raw[CardTrack] = (Raw[CardTrack] ?? 0) + MASTERY_CREDIT_PER_OBJECTIVE;
    }

    // The report's own increments bound the credit: the game never claims less than it earned, so a smaller claim means
    // the server and our store disagree about what is new - credit the smaller number and log it.
    const Credits: Record<string, number> = {};
    const Capped: string[] = [];
    const AtCap: string[] = [];
    for (const [Track, Amount] of Object.entries(Raw)) {
        let Allowed = Math.min(Amount, Claimed[Track] ?? 0);
        if (Allowed < Amount) Capped.push(`${Track} ${Amount}->${Allowed}`);
        // [2026-10-13 realms S3 limits] A host's credit stops at the track's rank-sum total (the stored total is read by the caller).
        const Cap = limits?.trackCap?.(Track);
        const Total = limits?.trackTotals?.get(Track);
        if (Cap !== undefined && Total !== undefined) {
            const Room = Math.max(0, Cap - Total);
            if (Allowed > Room) {
                AtCap.push(`${Track} ${Allowed}->${Room} (total ${Total}, cap ${Cap})`);
                Allowed = Room;
            }
        }
        if (Allowed > 0) Credits[Track] = Allowed;
    }

    return {
        objectives: [...Reported].filter(([Id]) => !Skipped.has(Id)).map(([objectiveId, State]) => ({ objectiveId, ...State })),
        merged: Merged,
        newlyCompleted: NewlyCompleted,
        credits: Credits,
        claimed: Claimed,
        unmapped: Unmapped,
        capped: Capped,
        ignored: Ignored,
        overLimit: OverLimit,
        clamped: Clamped,
        atCap: AtCap,
    };
}

function TrackRow(userId: string, progressionId: string, Row: ProgressionTrackRecord | undefined) {
    return {
        phx_account_id: userId,
        progression_id: progressionId,
        progress: Row?.progress ?? 0,
        confirmed_fremium_rank: Row?.confirmedFremiumRank ?? 0,
        confirmed_premium_rank: Row?.confirmedPremiumRank ?? 0,
        confirmed_date: Row?.updatedAt ?? new Date().toISOString(),
    };
}

/**
 * Applies a game server's report and returns the response payload the game parses (handler 0x140E70990):
 * { progress_tracks: [track rows], objectives: [GET /progression/objectives element rows] }. The objectives in the
 * response overwrite the server's cache, so they carry max(stored, reported) and never less than was reported.
 */
export async function ApplyMasteryReport(
    userId: string,
    body: any,
    unitOfWork: Pick<UnitOfWork, "withTransaction"> = GetUnitOfWork()
): Promise<{ progress_tracks: any[]; objectives: any[] }> {
    return (await ApplyMasteryReportWithPlan(userId, body, unitOfWork)).payload;
}

/**
 * [2026-10-13 realms S3] What a stored report changed, for the tag of a player-hosted server's write (the game itself only
 * gets the payload). Credits are what was added to the tracks; `objectives` counts every objective the report merged.
 */
export function SummarizeMasteryPlan(plan: MasteryPlan): Record<string, unknown> {
    return {
        objectives: plan.objectives.length,
        newlyCompleted: plan.newlyCompleted.slice(0, 20),
        newlyCompletedCount: plan.newlyCompleted.length,
        credits: plan.credits,
        claimed: plan.claimed,
        ...(plan.capped.length > 0 ? { capped: plan.capped.slice(0, 20) } : {}),
        ...(plan.unmapped.length > 0 ? { unmapped: plan.unmapped.slice(0, 20) } : {}),
        // [2026-10-13 realms S3 limits] Only when the host limits cut something, so an unlimited plan's tag is unchanged.
        ...(plan.ignored.length > 0 ? { ignoredCount: plan.ignored.length, ignored: plan.ignored.slice(0, 20).map((Entry) => `${Entry.objectiveId}:${Entry.reason}`) } : {}),
        ...(plan.overLimit.length > 0 ? { overLimitCount: plan.overLimit.length, overLimit: plan.overLimit.slice(0, 20) } : {}),
        ...(plan.clamped.length > 0 ? { clamped: plan.clamped.slice(0, 20) } : {}),
        ...(plan.atCap.length > 0 ? { atCap: plan.atCap.slice(0, 20) } : {}),
    };
}

/** One line for the warning about a host report the limits cut, or undefined when they cut nothing. At most 10 ids per list. */
export function DescribeMasteryLimits(plan: MasteryPlan): string | undefined {
    if (plan.ignored.length === 0 && plan.overLimit.length === 0 && plan.clamped.length === 0 && plan.atCap.length === 0) return undefined;
    const Head = (Items: string[]) => `${Items.length}[${Items.slice(0, 10).join(", ")}${Items.length > 10 ? ", ..." : ""}]`;
    return `ignored=${Head(plan.ignored.map((Entry) => `${Entry.objectiveId}:${Entry.reason}`))} overLimit=${Head(plan.overLimit)}`
        + ` clamped=${Head(plan.clamped)} atCap=${Head(plan.atCap)}`;
}

// [2026-10-13 realms S3 limits] The stored totals of the mastery tracks a host's report claims and that have a cap, read inside the
// report's transaction (at most the handful of mastery tracks; any other id the report names is not read).
async function WithStoredTrackTotals(
    limits: MasteryHostLimits, userId: string, body: any, repos: RepositoryProvider, session: ClientSession
): Promise<MasteryHostLimits> {
    if (limits.trackCap === undefined || limits.trackTotals !== undefined) return limits;
    const Totals = new Map<string, number>();
    for (const Track of Array.isArray(body?.progress_tracks) ? body.progress_tracks : []) {
        const Id = String(Track.progression_id);
        if (!Id.startsWith("MasteryTrack_") || Totals.has(Id) || limits.trackCap(Id) === undefined) continue;
        Totals.set(Id, (await repos.progressionTracks.get(userId, Id, session))?.progress ?? 0);
    }
    return { ...limits, trackTotals: Totals };
}

/** ApplyMasteryReport, also returning the plan that was applied. The payload is what the route answers with. */
export async function ApplyMasteryReportWithPlan(
    userId: string,
    body: any,
    unitOfWork: Pick<UnitOfWork, "withTransaction"> = GetUnitOfWork(),
    // [2026-10-13 realms S3 limits] Passed for a player-hosted server's report (HostMasteryLimits); absent = a dedicated server's.
    limits?: MasteryHostLimits
): Promise<{ payload: { progress_tracks: any[]; objectives: any[] }; plan: MasteryPlan }> {
    const Ids = [...new Set((Array.isArray(body?.objectives) ? body.objectives : []).map((Objective: any) => String(Objective.objective_id)))] as string[];

    const Outcome = await unitOfWork.withTransaction(async (repos, session) => {
        const StoredRows: ProgressionObjectiveRecord[] = await repos.progressionTracks.getObjectives(userId, Ids, session);
        const Stored = new Map(StoredRows.map((Row) => [Row.objectiveId, { value: Row.value, completedCount: Row.completedCount }]));
        const Plan = PlanMasteryReport(body, Stored, limits === undefined ? undefined : await WithStoredTrackTotals(limits, userId, body, repos, session));

        await repos.progressionTracks.mergeObjectives(userId, Plan.objectives, session);
        const Totals = new Map<string, ProgressionTrackRecord | undefined>();
        for (const [Track, Amount] of Object.entries(Plan.credits)) {
            Totals.set(Track, await repos.progressionTracks.increment(userId, Track, Amount, session));
        }
        for (const Track of Object.keys(Plan.claimed)) {
            if (!Totals.has(Track)) Totals.set(Track, await repos.progressionTracks.get(userId, Track, session));
        }
        return { Plan, Totals };
    });

    const { Plan, Totals } = Outcome;
    if (Plan.newlyCompleted.length > 0 || Object.keys(Plan.claimed).length > 0) {
        logger.info(`[MasteryMon] user=${userId} newly=[${Plan.newlyCompleted.join(", ")}]`
            + ` credit={${Object.entries(Plan.credits).map(([Track, Amount]) => `${Track}+${Amount}`).join(", ")}}`
            + ` claimed={${Object.entries(Plan.claimed).map(([Track, Amount]) => `${Track}+${Amount}`).join(", ")}}`
            + ` totals={${[...Totals].map(([Track, Row]) => `${Track}=${Row?.progress ?? 0}`).join(", ")}}`
            + (Plan.capped.length > 0 ? ` capped=[${Plan.capped.join("; ")}]` : "")
            + (Plan.unmapped.length > 0 ? ` UNMAPPED=[${Plan.unmapped.join(", ")}]` : "")
            + ` objectives=${Plan.objectives.length}`);
    }
    const Limited = DescribeMasteryLimits(Plan);
    if (Limited !== undefined) logger.warn(`[HostWrite] limited kind=MASTERY target=${userId} ${Limited}`);

    const Now = new Date().toISOString();
    return {
        payload: {
            progress_tracks: [...Totals].map(([Track, Row]) => TrackRow(userId, Track, Row)),
            objectives: [...Plan.merged].map(([ObjectiveId, State]) => ({
                phx_account_id: userId,
                objective_id: ObjectiveId,
                progress: State.value,
                completed_count: State.completedCount,
                created_date: Now,
                last_modified_date: Now,
            })),
        },
        plan: Plan,
    };
}
