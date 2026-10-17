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

import { RecordXpActivity } from "../activity/activityMonitor";
import { IsIgnoredActivitySource } from "../activity/activityRules";
import { GetRepositories, GetUnitOfWork, PlayerJourneyRepository, ProgressionGrantRecord, ProgressionTrackRecord, ProgressionTrackRepository, RepositoryProvider, UnitOfWork } from "../persistence";
import { logger } from "../logger";
import { loadGameData } from "../gameData/loader";
import { ComputeNewlyUnlockedNodeIds } from "./slayersPath";
import { GetP2PExtension } from "../extensions/p2p";
import type { ExtensionHttpResponse, HostWriteAuthorizeOptions, HostWriteKind } from "../extensions/p2p";
import crypto from "node:crypto";
import { ClientSession } from "mongodb";

// [WP-1 stage 4 — security fix] Per-track rank curves, indexed once (on first use) from the
// same file GET /progression/config serves. Used to validate confirm/public requests instead of
// trusting the client's claimed rank outright. requiredXP entries are INCREMENTAL (cost to
// advance one rank, not a cumulative threshold — see tools/CatalogExporter/ExportFlags.md) so the
// cumulative XP needed for a given rank is the running sum of every requirement up to it.
// prestigeXpPerLevel: the path's `prestige.xp_per_level`, when it has one. Past maxRank a track keeps ranking up by one
// prestige level per that much progress (the game's rank maths, FUN_140E53760); PrestigeTrack_Weapon_* has a single
// 0-XP requirement and xp_per_level 1, so its rank IS its progress (the weapon's reforge count).
type TrackCurve = { maxRank: number; cumulativeXpForRank: Map<number, number>; prestigeXpPerLevel?: number };

function BuildTrackCurves(): Map<string, TrackCurve> {
    const Curves = new Map<string, TrackCurve>();
    const Paths: any[] = loadGameData<any>("progression_config.json")?.payload?.paths ?? [];

    for (const Path of Paths) {
        const ProgressionId = Path?.progression_id;
        const Requirements: Array<{ rank_id: number; xp_required: number }> = Path?.requirements ?? [];
        if (typeof ProgressionId !== "string" || ProgressionId.length === 0 || Requirements.length === 0) continue;

        const Sorted = [...Requirements].sort((a, b) => a.rank_id - b.rank_id);
        const CumulativeXpForRank = new Map<number, number>();
        let Running = 0;
        for (const Req of Sorted) {
            Running += Number(Req.xp_required) || 0;
            CumulativeXpForRank.set(Req.rank_id, Running);
        }

        const PrestigeXpPerLevel = Number(Path?.prestige?.xp_per_level);
        Curves.set(ProgressionId, {
            maxRank: Sorted[Sorted.length - 1].rank_id,
            cumulativeXpForRank: CumulativeXpForRank,
            prestigeXpPerLevel: Number.isFinite(PrestigeXpPerLevel) && PrestigeXpPerLevel > 0 ? PrestigeXpPerLevel : undefined,
        });
    }

    return Curves;
}

// Built on first use, so modules that only need this file's auth helpers load without game data;
// the routes still load progression_config.json at startup and fail fast when it is missing.
let TrackCurvesCache: Map<string, TrackCurve> | undefined;
function TrackCurves(): Map<string, TrackCurve> {
    return TrackCurvesCache ??= BuildTrackCurves();
}

// [2026-07-30] Exposed for the store's `skuProgression` grants (src/skuProgression.ts), which must
// convert "skip N ranks" into an XP delta using the SAME curve this module already validates
// rank-confirm requests against - not a second, divergent copy of the rank maths.
export function GetTrackCurve(progressionId: string) {
    return TrackCurves().get(progressionId);
}

// `selected_huntpass` is the symbolic track id the rank-skip SKUs carry; it means "whichever Hunt
// Pass is currently selected", which for this server is the active season already reported by
// GET /huntpass/:userId (routes/system.ts) and confirmed in Progress/22_HUNT_PASS.md.
// [1.14.7 2026-10-08] season43: the 1.14.7 client only enables hunt_pass_season_table rows season43..50
// (1.12 used season19). The vendored season43 path is a clone of the season19 track whose prestige pays the
// 1.14.7 seasonal coin (CURRENCY_SEASONAL_COIN, 5/20, as the live season21..27). Progress banked on season19
// stays stored under season19.
export const ACTIVE_HUNTPASS_PROGRESSION_ID = "season43";
export const SELECTED_HUNTPASS_TRACK_ALIAS = "selected_huntpass";

export function ResolveProgressionTrackId(progressionId: string): string | undefined {
    if (progressionId === SELECTED_HUNTPASS_TRACK_ALIAS) return ACTIVE_HUNTPASS_PROGRESSION_ID;
    return TrackCurves().has(progressionId) ? progressionId : undefined;
}

// [2026-10-10] The pass GET /huntpass serves. Same expression as routes/system.ts GetServedHuntPassId (system.ts imports
// this module, so importing it back would close a cycle); GAMESERVER_HUNTPASS_ID=season19 is the 1.12 setting. The game
// grants hunt pass XP into whichever track that response named (UHuntPassComponent::AddProgressToSelectedTrack,
// FUN_1419F22E0 -> GrantProgressionInTrack 0x140E61610).
export function ServedHuntPassProgressionId(): string {
    return (process.env.GAMESERVER_HUNTPASS_ID ?? ACTIVE_HUNTPASS_PROGRESSION_ID).trim();
}

export function IsHuntPassXpTrack(progressionId: string): boolean {
    return progressionId === ACTIVE_HUNTPASS_PROGRESSION_ID || progressionId === ServedHuntPassProgressionId();
}

// Rank reached with `progress` cumulative XP on the served curve (the highest rank whose cumulative requirement is
// met) - the same requirements ConfirmPublicProgressionRank checks. undefined for a track without a curve.
export function RankForProgress(progressionId: string, progress: number): number | undefined {
    const Curve = TrackCurves().get(progressionId);
    if (Curve === undefined || !Number.isFinite(progress)) return undefined;
    let Rank = 0;
    for (const [RankId, Cumulative] of Curve.cumulativeXpForRank) {
        if (Cumulative <= progress && RankId > Rank) Rank = RankId;
    }
    return Rank;
}

// [WP-1] Persistent XP (Plans/PROGRESSION_XP_COMBAT_DATA_IMPLEMENTATION_PLAN.md section 16).
// These are the only tracks the production gameserver is allowed to mutate through the XP grant
// endpoint. The progression config also contains historical/test/pass tracks; accepting every
// config entry would turn a config-data list into an authority allowlist by accident.
export const APPROVED_XP_PROGRESSION_TRACK_IDS = Object.freeze([
    "MasteryTrack_PlayerLevel",
    "MasteryTrack_Behemoth",
    "MasteryTrack_Weapon_Axe",
    "MasteryTrack_Weapon_ChainBlades",
    "MasteryTrack_Weapon_Hammer",
    "MasteryTrack_Weapon_Repeaters",
    "MasteryTrack_Weapon_Spear",
    "MasteryTrack_Weapon_Sword",
    "MasteryTrack_Weapon_Strikers",
    "ExperienceTrack_PlayerLevel",
    "ExperienceTrack_Weapon_Axe",
    "ExperienceTrack_Weapon_ChainBlades",
    "ExperienceTrack_Weapon_Hammer",
    "ExperienceTrack_Weapon_Repeaters",
    "ExperienceTrack_Weapon_Spear",
    "ExperienceTrack_Weapon_Sword",
    "ExperienceTrack_Weapon_Strikers",
    "PrestigeTrack_Weapon_Axe",
    "PrestigeTrack_Weapon_ChainBlades",
    "PrestigeTrack_Weapon_Hammer",
    "PrestigeTrack_Weapon_Repeaters",
    "PrestigeTrack_Weapon_Spear",
    "PrestigeTrack_Weapon_Sword",
    "PrestigeTrack_Weapon_Strikers",
    ACTIVE_HUNTPASS_PROGRESSION_ID
] as const);

const ApprovedXpTracks = new Set<string>(APPROVED_XP_PROGRESSION_TRACK_IDS);

export function IsApprovedXpProgressionTrack(progressionId: string): boolean {
    // [2026-10-10] The served hunt pass is approved as well: GAMESERVER_HUNTPASS_ID can move GET /huntpass off the
    // constant above, and every grant into the pass the game was told about would then be refused. Nothing else is
    // widened; the track still needs a rank curve in the config file, and an override can only name a hunt pass id
    // (a typo'd GAMESERVER_HUNTPASS_ID must not open grants on an ExperienceTrack_/PrestigeTrack_/test track).
    const ServedPass = ServedHuntPassProgressionId();
    const Approved = ApprovedXpTracks.has(progressionId)
        || (progressionId === ServedPass && HUNT_PASS_ID_PATTERN.test(ServedPass));
    return Approved && TrackCurves().has(progressionId);
}

const HUNT_PASS_ID_PATTERN = /^(season|eventpass_|d24_)/i;

// [2026-10-10] Why the grant route refuses a track, for its rejection line - the hunt server itself only logs
// "OnGrantOnlineProgressionComplete - BadRequest".
export function DescribeUnapprovedXpTrack(progressionId: string): string {
    if (/^Linked_Slayer_Slot_\d+$/.test(progressionId)) {
        return "Slayer Link track (the hunt pass also_progress target) - deliberately not approved";
    }
    if (!TrackCurves().has(progressionId)) return "no rank curve in progression_config.json";
    if (HUNT_PASS_ID_PATTERN.test(progressionId)) {
        return `hunt pass that is not served (served=${ServedHuntPassProgressionId()})`;
    }
    return "not on the XP allowlist";
}

export function BuildProgressionGrantRequestHash(userId: string, progressionId: string, amount: number): string {
    return crypto.createHash("sha256")
        .update(JSON.stringify({ version: 1, userId, progressionId, amount }))
        .digest("hex");
}

export function IsValidProgressionGrantId(grantId: unknown): grantId is string {
    return typeof grantId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(grantId);
}

export class ProgressionGrantConflictError extends Error {
    constructor(public readonly grantId: string) {
        super(`Progression grant ${grantId} was already used with a different request.`);
        this.name = "ProgressionGrantConflictError";
    }
}

// The bound every authoritative grant must meet (dedicated server and host alike); routes/progression.ts validates the URL's
// amount against the same number.
export const MAX_PROGRESSION_GRANT_AMOUNT = 100000;

// [2026-10-13 realms S3 limits] What a player-hosted server may add to one track in one XP grant. Owner decision: refuse only
// the impossible, proven by evidence. Real play on 1.14.7 (13 Oct research): a kill sends three grants ~130 ms apart (weapon
// ~98, player level ~98, Hunt Pass ~9; a gatherable adds Hunt Pass +5); the largest real values are 225 (weapon and player
// level) and 15 applied / 25 requested (Hunt Pass); a weapon's PrestigeTrack is +1 per grant. The ceilings sit 4-8x above
// that, so only a forged value trips them; the Hunt Pass one is the game's own MaxXPAwarded for Hunt Pass XP. They bind
// hosts only (GrantProgressionXp `source`): a dedicated server's grant keeps the bound above and nothing else.
// MasteryTrack_* has no real caller on this route (mastery arrives in the progression report, controllers/masteryReport.ts),
// so a host may not grant it at all.
export const HOST_WEAPON_XP_GRANT_CEILING = 1000;
export const HOST_PLAYER_XP_GRANT_CEILING = 1000;
export const HOST_HUNT_PASS_XP_GRANT_CEILING = 200;
export const HOST_PRESTIGE_GRANT_AMOUNT = 1;
const PLAYER_EXPERIENCE_TRACK = "ExperienceTrack_PlayerLevel";

export type HostGrantRefusalReason = "track_not_writable" | "amount_over_ceiling" | "amount_not_one" | "track_full";

export interface HostGrantRefusal {
    reason: HostGrantRefusalReason;
    progressionId: string;
    amount: number;
    /** The ceiling the grant broke, the exact amount a prestige grant must be, or the track total that is already reached. */
    limit: number;
    /** The track's stored progress, for `track_full`. */
    stored?: number;
}

/**
 * [2026-10-17] Dedicated parity: whether a host limit only logs. A dedicated
 * server had neither of these, so in the host policy's observe mode (the default) they log `[HostPolicyObserve] would refuse xp ...` and
 * the grant is applied as a dedicated server's would be:
 *   - amount_over_ceiling: a grant above the per-track ceiling (big Escalation and bounty Hunt Pass rewards may exceed 200);
 *   - track_full: a grant to a full player level track (the game sends player XP with every weapon grant, also at the top level).
 * The reforge rules stay refused in both modes, as the game itself applies them: a prestige grant that is not +1 (amount_not_one) and
 * any MasteryTrack_ grant (track_not_writable; mastery arrives in the progression report). enforce refuses all of them as before.
 */
export function HostLimitOnlyLogs(refusal: HostGrantRefusal, hostPolicy = GetP2PExtension().hostPolicy): boolean {
    return (refusal.reason === "amount_over_ceiling" || refusal.reason === "track_full") && !hostPolicy.refuses();
}

/** Applies a host limit: throws HostGrantLimitError, or (observe, HostLimitOnlyLogs) logs it once and lets the grant through. */
function ApplyHostLimit(refusal: HostGrantRefusal, userId: string, grantId: string, hostPolicy = GetP2PExtension().hostPolicy): void {
    if (!HostLimitOnlyLogs(refusal, hostPolicy)) throw new HostGrantLimitError(refusal);
    hostPolicy.noteWouldRefuse("xp", `user=${userId} ${DescribeHostGrantRefusal(refusal)} grant=${grantId.slice(0, 96)}`);
}

/** A host's grant was refused by the limits above; the route answers with HostGrantLimitDenial. Nothing was stored. */
export class HostGrantLimitError extends Error {
    constructor(public readonly refusal: HostGrantRefusal) {
        super(`Host progression grant refused: ${DescribeHostGrantRefusal(refusal)}`);
        this.name = "HostGrantLimitError";
    }
}

/**
 * The most one host grant may add to `progressionId`: 0 = the track is not writable by a host, undefined = this table has no
 * opinion (the general bound still applies). Every approved track has an entry (pinned by a test), so a track added to
 * APPROVED_XP_PROGRESSION_TRACK_IDS without a decision here fails that test instead of silently going unbounded.
 */
export function HostXpGrantCeiling(progressionId: string): number | undefined {
    if (progressionId === PLAYER_EXPERIENCE_TRACK) return HOST_PLAYER_XP_GRANT_CEILING;
    if (progressionId.startsWith("ExperienceTrack_Weapon_")) return HOST_WEAPON_XP_GRANT_CEILING;
    if (progressionId.startsWith("PrestigeTrack_Weapon_")) return HOST_PRESTIGE_GRANT_AMOUNT;
    if (progressionId.startsWith("MasteryTrack_")) return 0;
    if (IsHuntPassXpTrack(progressionId)) return HOST_HUNT_PASS_XP_GRANT_CEILING;
    return undefined;
}

/** Pure: why a host may not add `amount` to `progressionId` in one grant, or undefined when it may. Needs no stored state. */
export function CheckHostXpGrant(progressionId: string, amount: number): HostGrantRefusal | undefined {
    const Ceiling = HostXpGrantCeiling(progressionId);
    if (Ceiling === undefined) return undefined;
    if (Ceiling === 0) return { reason: "track_not_writable", progressionId, amount, limit: 0 };
    if (progressionId.startsWith("PrestigeTrack_Weapon_")) {
        return amount === HOST_PRESTIGE_GRANT_AMOUNT ? undefined : { reason: "amount_not_one", progressionId, amount, limit: HOST_PRESTIGE_GRANT_AMOUNT };
    }
    return amount > Ceiling ? { reason: "amount_over_ceiling", progressionId, amount, limit: Ceiling } : undefined;
}

/**
 * The total a track cannot be pushed past by a host: its rank-sum cap from the progression config, only for the player
 * level track (141,020 XP to level 20, no prestige block). Weapon tracks keep earning past their level-20 total (prestige
 * levels, banked XP) and the Hunt Pass converts XP past rank 100 to coins, so those have no ceiling on the total.
 */
export function HostTrackTotalCap(progressionId: string): number | undefined {
    if (progressionId !== PLAYER_EXPERIENCE_TRACK) return undefined;
    const Cap = TrackCapXp(progressionId);
    return Cap !== undefined && Cap > 0 ? Cap : undefined;
}

/**
 * Pure: a host's grant to a track whose total is already at its cap. Refused only when the track is FULL, not when this grant
 * would cross the line: the game need not clip its last grant, so refusing "stored + amount > cap" could leave a player a few
 * XP short of the last level for good. The overshoot is at most one grant (under the ceiling above).
 */
export function CheckHostTrackTotal(progressionId: string, storedProgress: number, amount: number): HostGrantRefusal | undefined {
    const Cap = HostTrackTotalCap(progressionId);
    if (Cap === undefined || !(storedProgress >= Cap)) return undefined;
    return { reason: "track_full", progressionId, amount, limit: Cap, stored: storedProgress };
}

/** One line (no user id) for the log: `reason=... track=... amount=... limit=...`. */
export function DescribeHostGrantRefusal(refusal: HostGrantRefusal): string {
    return `reason=${refusal.reason} track=${refusal.progressionId.slice(0, 64).replace(/[^\x21-\x7E]/g, "?")} amount=${refusal.amount} limit=${refusal.limit}`
        + (refusal.stored !== undefined ? ` stored=${refusal.stored}` : "");
}

/** The answer to a refused host grant. 403 like the module's own host refusals (the request is well formed; this host may not write it), never a clamp. */
export function HostGrantLimitDenial(): ExtensionHttpResponse {
    return { status: 403, body: { code: "HOST_WRITE_LIMIT", message: "This write is beyond what a hosted server may report.", payload: null } };
}

export type ProgressionGrantResult = { record: ProgressionTrackRecord; replayed: boolean };

function IsDuplicateKeyError(ErrorValue: unknown): boolean {
    return typeof ErrorValue === "object" && ErrorValue !== null &&
        (ErrorValue as { code?: number }).code === 11000;
}

/**
 * Applies one authoritative gameserver XP grant exactly once. The track mutation and its result
 * ledger are committed in one Mongo transaction. A duplicate-key race aborts that transaction;
 * the bounded retry starts a fresh transaction and returns the committed result instead.
 */
export async function GrantProgressionXp(
    userId: string,
    progressionId: string,
    amount: number,
    grantId: string,
    unitOfWork: Pick<UnitOfWork, "withTransaction"> = GetUnitOfWork(),
    // [2026-10-11] Runs inside the grant's transaction for a NEW grant only (never for a replay): the reforge follow-ups
    // (controllers/reforge.ts) mark their one-time use here, so the mark and the XP commit or roll back together.
    beforeApply?: (repos: RepositoryProvider, session: ClientSession) => Promise<void>,
    // [2026-10-13 realms S3] Who sent the grant ("host" for a player-hosted server's runtime): named in the log line, and a
    // host's grant also meets the limits above (HostGrantLimitError). "gameserver" is the dedicated server, unchanged.
    source: "gameserver" | "host" = "gameserver",
    // [2026-10-14 P5.1] The economy source of a test grant (OPERATOR_TEST): the activity monitor does not count its XP.
    economySource?: string
): Promise<ProgressionGrantResult> {
    if(!IsApprovedXpProgressionTrack(progressionId)) {
        throw new Error(`Unsupported progression track '${progressionId}'.`);
    }
    if(!Number.isInteger(amount) || amount <= 0 || amount > MAX_PROGRESSION_GRANT_AMOUNT || !IsValidProgressionGrantId(grantId)) {
        throw new Error("Invalid authoritative progression grant.");
    }
    // [2026-10-13 realms S3 limits] A host's per-grant ceilings (CheckHostXpGrant). Needs no stored state, so it is the same
    // answer for a retry of a grant that was accepted; the route checks it too, ahead of its own reads.
    // [2026-10-17] In observe mode an over-ceiling amount only logs (ApplyHostLimit, HostLimitOnlyLogs).
    if(source === "host") {
        const Refusal = CheckHostXpGrant(progressionId, amount);
        if(Refusal !== undefined) ApplyHostLimit(Refusal, userId, grantId);
    }
    const requestHash = BuildProgressionGrantRequestHash(userId, progressionId, amount);
    const maxAttempts = 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const Granted = await unitOfWork.withTransaction(async (repos, session) => {
                const Existing = await repos.progressionGrants.findByGrantId(grantId, session);
                if (Existing !== undefined) {
                    if (Existing.requestHash !== requestHash || Existing.userId !== userId ||
                        Existing.progressionId !== progressionId || Existing.amount !== amount) {
                        throw new ProgressionGrantConflictError(grantId);
                    }
                    return { record: Existing.result, replayed: true };
                }

                // [2026-10-13 realms S3 limits] A host may not add to a player level track that is already full. Read inside
                // the transaction and after the replay branch above, so a retry of the grant that filled the track still
                // replays instead of being refused.
                // [2026-10-17] In observe mode a full track only logs and the grant is applied, as a dedicated server's is.
                if (source === "host" && HostTrackTotalCap(progressionId) !== undefined) {
                    const Current = await repos.progressionTracks.get(userId, progressionId, session);
                    const Full = CheckHostTrackTotal(progressionId, Current?.progress ?? 0, amount);
                    if (Full !== undefined) ApplyHostLimit(Full, userId, grantId);
                }

                if (beforeApply) await beforeApply(repos, session);
                const Before = await repos.progressionTracks.get(userId, progressionId, session);
                const After = await repos.progressionTracks.increment(userId, progressionId, amount, session);
                const Ledger: ProgressionGrantRecord = {
                    grantId,
                    userId,
                    progressionId,
                    amount,
                    requestHash,
                    status: "applied",
                    result: After,
                    createdAt: new Date().toISOString()
                };
                await repos.progressionGrants.insertApplied(Ledger, session);

                logger.info(`[ProgressionGrant] grant=${grantId} user=${userId} track=${progressionId} delta=${amount} old=${Before?.progress ?? 0} new=${After.progress} source=${source} applied=1`);
                return { record: After, replayed: false };
            });
            // [2026-10-14] The activity monitor counts an applied grant's XP by track (a replay is not counted again).
            if (!Granted.replayed && !IsIgnoredActivitySource(economySource)) RecordXpActivity(userId, progressionId, amount);
            return Granted;
        } catch (ErrorValue) {
            if (!IsDuplicateKeyError(ErrorValue) || attempt === maxAttempts) throw ErrorValue;
            logger.warn(`[ProgressionGrant] grant=${grantId} concurrent ledger race; retrying transaction attempt=${attempt + 1}`);
        }
    }

    throw new Error("Progression grant transaction exhausted without a result.");
}

export async function GetPersistedProgressionForUser(userId: string, knownTrackIds: string[]){
    const Persisted = await GetRepositories().progressionTracks.getAllForUser(userId);
    const PersistedById = new Map(Persisted.map((Row) => [Row.progressionId, Row]));

    const Rows: any[] = [];

    // Known tracks first, in the plan's stable declared order — real persisted data if present,
    // else a well-formed zero row (never omitted, so the client always sees every track it
    // might ask about).
    for(const TrackId of knownTrackIds){
        const Row = PersistedById.get(TrackId);
        Rows.push({
            phx_account_id: userId,
            progression_id: TrackId,
            progress: Row?.progress ?? 0,
            confirmed_fremium_rank: Row?.confirmedFremiumRank ?? 0,
            confirmed_premium_rank: Row?.confirmedPremiumRank ?? 0,
            confirmed_date: Row?.updatedAt ?? new Date().toISOString(),
        });
        PersistedById.delete(TrackId);
    }

    // Anything persisted that ISN'T in the known-tracks list is a track ID the client/server
    // referenced that we didn't anticipate — surfaced anyway rather than dropped (plan section
    // 6.2: "preserve unknown runtime track IDs instead of discarding them").
    for(const Row of PersistedById.values()){
        Rows.push({
            phx_account_id: userId,
            progression_id: Row.progressionId,
            progress: Row.progress,
            confirmed_fremium_rank: Row.confirmedFremiumRank,
            confirmed_premium_rank: Row.confirmedPremiumRank,
            confirmed_date: Row.updatedAt,
        });
    }

    return Rows;
}

// [WP-1 stage 2] Raw capture only. Semantics
// were proven from real sequential traffic during a live repro session: comparing
// MasteryObjective_Weapon_Sword_Generic_Kills1 (value=1 -> value=2, completed_count 0 -> 1) and
// MasteryObjective_Behemoth_Embermane_Boop (value=3 -> value=5) across two real consecutive
// payloads showed each report is an ABSOLUTE running total, not a delta — values only ever grew
// toward the session's actual current count, never reset or stayed constant per-event the way a
// delta would. Same conclusion for progress_tracks (MasteryTrack_PlayerLevel/Weapon_Sword
// reporting a stable rank number across events). Those values remain diagnostics only: a normal
// player report is not an authoritative progression grant and must never mutate canonical state.
export async function CaptureProgressionObjectiveEvent(
    userId: string,
    rawBody: unknown,
    diagnosticsRepository: Pick<ProgressionTrackRepository, "appendObjectiveEvent"> = GetRepositories().progressionTracks
){
    const BodyJson = JSON.stringify(rawBody ?? {});

    const Body = (rawBody ?? {}) as { progress_tracks?: any[]; objectives?: any[] };
    const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128 &&
        /^[A-Za-z0-9_.:-]+$/.test(value);
    const boundedNumber = (value: unknown, maximum: number) => Number.isFinite(Number(value)) &&
        Number(value) >= 0 && Number(value) <= maximum;
    if(BodyJson.length > 128 * 1024 || !Array.isArray(Body.progress_tracks ?? []) ||
        !Array.isArray(Body.objectives ?? []) || (Body.progress_tracks ?? []).length > 256 ||
        (Body.objectives ?? []).length > 512 || (Body.progress_tracks ?? []).some((Track) =>
            !validId(Track?.progression_id) || !boundedNumber(Track?.progress, 1_000_000_000)) ||
        (Body.objectives ?? []).some((Objective) => !validId(Objective?.objective_id) ||
            !boundedNumber(Objective?.value, 1_000_000_000) ||
            !boundedNumber(Objective?.completed_count ?? 0, 1_000_000))){
        const error = new Error("Progression objective report failed validation.");
        error.name = "ProgressionEventValidationError";
        throw error;
    }

    await diagnosticsRepository.appendObjectiveEvent({
        userId,
        rawBody: BodyJson,
        receivedAt: new Date().toISOString()
    });

    const TracksReceived = (Body.progress_tracks ?? []).length;
    const ObjectivesReceived = (Body.objectives ?? []).length;

    // [World Rewards investigation, 2026-07-20] This handler only ever reads progress_tracks/
    // objectives. Real Dauntless bundles hunt-completion rewards (Behemoth loot, Patrol Chest
    // contents) into the SAME progression-report call the client/gameserver already makes here
    // (confirmed via Ghidra: UHuntSystemComponent::ServerOnHuntCompleted routes through the
    // player's progression component, and the client binary's own endpoint-name table has no
    // separate reward-specific endpoint - only GrantProgressionEndpoint/ConfirmProgressionEndpoint/
    // Inventory*Endpoint). If a real 1.12 payload ever carries a reward-shaped field beyond those
    // two keys, it is currently silently ignored - it would explain a reward popup firing
    // client-side with nothing durable persisted. This makes that observable instead of guessed:
    // logs every OTHER top-level key at WARN so the very next real hunt-completion/chest capture
    // proves or disproves the hypothesis. Deliberately does NOT act on any such field yet - the
    // shape must be captured from real 1.12 traffic before writing a reducer for it (see
    // Plans/NORMAL_ACCOUNT_LOADOUT_HUNT_REWARDS_PLAN.md's "must not be guessed" rule).
    const KnownKeys = new Set(["progress_tracks", "objectives"]);
    const UnrecognizedKeys = Object.keys(Body).filter((Key) => !KnownKeys.has(Key));
    if(UnrecognizedKeys.length > 0){
        logger.warn(`[ProgressionObjective] user=${userId} UNRECOGNIZED top-level key(s) [${UnrecognizedKeys.join(", ")}] in a progression report - possible unhandled reward/grant payload, not applied. Raw: ${BodyJson.slice(0, 2000)}`);
    }

    logger.info(`[ProgressionObjective] user=${userId} mode=diagnostics-only tracksReceived=${TracksReceived} objectivesReceived=${ObjectivesReceived} authoritativeMutation=0 rawBytes=${BodyJson.length}`);
}

export function IsAuthorizedProgressionReporter(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    // A player-host process is transport/gameplay authority only. Route-derived roster identity
    // is sufficient for loading P2 data, but must never become persistent progression authority.
    if (authData?.IsPlayerHostRuntime === true) return false;
    return typeof authData?.userId === "string" && authData.userId === targetUserId;
}

// [2026-10-13 realms S3] A runtime authenticated by the optional P2P module (AuthData.IsPlayerHostRuntime) writes
// progression for the players it hosts as a dedicated server would (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md §4):
// instantly, but only after the module's hostWrites hook accepts the write (a running hunt of that host, a member of it) and
// tagged afterwards for behaviour analysis and reversal. The check lives behind the extension hook; this file holds no
// P2P rule. Without the module the hook refuses, so these routes stay dedicated-only. The host flag wins over
// IsGameserver: the auth layer never sets both, and a request that did would still be treated as a host.
export type HostWriteHooks = ReturnType<typeof GetP2PExtension>["hostWrites"];

export function IsHostRuntimeAuth(authData: any): boolean {
    return authData?.IsPlayerHostRuntime === true;
}

/**
 * Undefined when the host may write `kind` for `targetUserId`; otherwise the response to send. [2026-10-16] `options.probe`: a quiet
 * check of one kind among several (extensions/p2p.ts hostWrites.authorize); the route's last, plain call decides and logs.
 */
export async function RefuseUnauthorizedHostWrite(
    req: unknown,
    kind: HostWriteKind,
    targetUserId: string,
    hooks: HostWriteHooks = GetP2PExtension().hostWrites,
    options?: HostWriteAuthorizeOptions
): Promise<ExtensionHttpResponse | undefined> {
    return hooks.authorize(req as any, kind, targetUserId, options);
}

/**
 * [2026-10-17] Dedicated parity: whether this request is the authoritative server
 * for `targetUserId`, as a dedicated server is for its players - the gameserver key, or a realm hub or hunt whose session holds the player
 * (hostWrites.authorize with `parity`: who may write only, the host policy's observe mode only). For the backend's own work for a player
 * that only a dedicated server's request used to start: finishing an interrupted reforge at the load, the Slayer's Path catch-up at
 * login. A realm server's accepted check sets the session context, so TagHostWrite can tag what the work did.
 */
export async function IsAuthoritativeServerFor(
    req: any,
    targetUserId: string,
    kind: HostWriteKind,
    hooks: HostWriteHooks = GetP2PExtension().hostWrites
): Promise<boolean> {
    if (IsHostRuntimeAuth(req?.AuthData)) return (await hooks.authorize(req, kind, targetUserId, { parity: true })) === undefined;
    return req?.AuthData?.IsGameserver === true;
}

/** What a progression report carried, for the tag of a host's report: track increments (first 20) and counts, no objective rows. */
export function SummarizeObjectiveReport(body: any): Record<string, unknown> {
    const Tracks: any[] = Array.isArray(body?.progress_tracks) ? body.progress_tracks : [];
    const Objectives: any[] = Array.isArray(body?.objectives) ? body.objectives : [];
    return {
        progressTracks: Tracks.slice(0, 20).map((Track) => ({ id: String(Track?.progression_id).slice(0, 128), progress: Number(Track?.progress) })),
        progressTrackCount: Tracks.length,
        objectiveCount: Objectives.length,
        completedObjectiveCount: Objectives.filter((Objective) => Number(Objective?.completed_count) >= 1).length
    };
}

/** Tags an accepted host write. Never throws: the write is already stored, the tag is best effort. */
export async function TagHostWrite(
    req: unknown,
    kind: HostWriteKind,
    targetUserId: string,
    summary: Record<string, unknown>,
    hooks: HostWriteHooks = GetP2PExtension().hostWrites
): Promise<void> {
    try {
        await hooks.record(req as any, { kind, targetUserId, summary });
    } catch (error) {
        logger.error(`[HostWrite] tag failed kind=${kind} target=${targetUserId}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function IsAuthorizedProgressionReader(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    return typeof authData?.userId === "string" && authData.userId === targetUserId;
}

// [1.14.7 2026-10-11] The element shape the game reads (FOnlineProgressionPhoenix element reader 0x140E89BD0, as in
// DauntlessEndpointDocumentation/Progression/GetObjectiveProgression.md): phx_account_id, objective_id, progress,
// completed_count, created_date, last_modified_date. The list handler (0x140E72DA0) caches each element under its own
// phx_account_id (UpdateCachedObjectiveForPlayer 0x140E96FA0), so the old {objective_id, value, completed_count} rows
// were never cached for anyone: every mastery card (UMasteryCard::InitializeCard) started from progress 0, owned items
// re-completed the craft objectives on every arrival and each kill re-completed its kill objective.
export async function GetPersistedObjectivesForUser(userId: string){
    const Rows = await GetRepositories().progressionTracks.getAllObjectivesForUser(userId);

    return Rows.map((Row) => ({
        phx_account_id: userId,
        objective_id: Row.objectiveId,
        progress: Row.value,
        completed_count: Row.completedCount,
        created_date: Row.updatedAt,
        last_modified_date: Row.updatedAt,
    }));
}

// [WP-1 stage 3 — bug fix, then stage 4 — security fix] Confirms a rank WITHOUT touching the
// track's real `progress` total (stage 3: fixed the old stub echoing the rank NUMBER back as
// `progress`, which visibly dropped the Slayer's Path bar from e.g. 250 down to "3").
//
// Stage 4 closes a real loophole in that fix: it previously $set the client-claimed rank
// unconditionally, with no check against the track's actual rank range or the account's
// persisted XP. A client could confirm an out-of-range rank, or a rank its XP doesn't qualify
// for (in either direction — inflate OR deflate, since $set can lower a rank too). Now:
//   1. `rank` must be an integer within [0, track's max rank] (unknown tracks are rejected —
//      never silently accepted with an unbounded rank).
//   2. The account's persisted `progress` (cumulative XP, ProgressionTrackRepository is the only
//      writer per plan decision rule 3) must meet or exceed the cumulative XP required for that
//      rank, per the same 1.12 curve GET /progression/config serves.
//   3. Persistence uses monotonic $max (ProgressionTrackRepository.setConfirmedFremiumRank),
//      so a stale/replayed confirm can never LOWER an already-higher confirmed rank either.
export type ConfirmRankResult =
    | { ok: true; record: ProgressionTrackRecord }
    | { ok: false; reason: "unknown_track" | "rank_out_of_range" | "insufficient_xp" };

const MAX_PRESTIGE_RANKS = 100_000;

/** Cumulative progress a rank needs, prestige ranks included; undefined for a rank the track does not have. */
export function RequiredXpForRank(Curve: TrackCurve, rank: number): number | undefined {
    if (!Number.isInteger(rank) || rank < 0) return undefined;
    if (rank <= Curve.maxRank) return Curve.cumulativeXpForRank.get(rank) ?? 0;
    if (Curve.prestigeXpPerLevel === undefined || rank > Curve.maxRank + MAX_PRESTIGE_RANKS) return undefined;
    return (Curve.cumulativeXpForRank.get(Curve.maxRank) ?? 0) + (rank - Curve.maxRank) * Curve.prestigeXpPerLevel;
}

/** XP needed to reach the top regular rank (a weapon's level-20 cap, 27,775 on the 1.14.7 curve). */
export function TrackCapXp(progressionId: string): number | undefined {
    const Curve = TrackCurves().get(progressionId);
    return Curve === undefined ? undefined : (Curve.cumulativeXpForRank.get(Curve.maxRank) ?? 0);
}

/**
 * [2026-10-15] The mastery credit of one objective: a mastery objective's first completion adds 1 to its card's track and 1 to
 * MasteryTrack_PlayerLevel (controllers/masteryReport.ts PlanMasteryReport; the client claims the same +1, 1.14.7). It is the largest
 * single credit a mastery track ever receives, so it bounds the bounded sync below. It lives here, not in masteryReport.ts, which
 * imports this file.
 */
export const MASTERY_CREDIT_PER_OBJECTIVE = 1;

export function IsMasteryProgressionTrack(progressionId: string): boolean {
    return progressionId.startsWith("MasteryTrack_");
}

export interface ConfirmRankOptions {
    /**
     * [2026-10-15] A host's or a dedicated server's confirm of a MASTERY track may run ahead of the persisted progress by at most one
     * objective's credit (MASTERY_CREDIT_PER_OBJECTIVE). The cause of such a gap is not pinned down (the 1.14.7 client claimed fewer
     * increments than its rank check counted; 14 Oct, a test account): the persisted progress is raised to the rank's requirement, and
     * the confirm goes through, logged as [MasteryMon] SYNC. A larger gap stays refused. Any other track is unchanged.
     */
    boundedMasterySync?: boolean;
}

export async function ConfirmPublicProgressionRank(userId: string, progressionId: string, rank: number, options: ConfirmRankOptions = {}): Promise<ConfirmRankResult> {
    const Curve = TrackCurves().get(progressionId);
    if (Curve === undefined) {
        logger.warn(`Rejected rank confirm: unknown track '${progressionId}' has no rank curve (user=${userId})`);
        return { ok: false, reason: "unknown_track" };
    }

    const RequiredCumulativeXp = RequiredXpForRank(Curve, rank);
    if (RequiredCumulativeXp === undefined) {
        logger.warn(`Rejected rank confirm: rank ${rank} out of range [0,${Curve.maxRank}${Curve.prestigeXpPerLevel ? "+prestige" : ""}] for track ${progressionId} (user=${userId})`);
        return { ok: false, reason: "rank_out_of_range" };
    }

    // Rank 0/1 (pre-first-requirement) never needs an XP check — every track's floor.
    if (RequiredCumulativeXp > 0) {
        const ExistingTrack = await GetRepositories().progressionTracks.get(userId, progressionId);
        const PersistedProgress = ExistingTrack?.progress ?? 0;

        if (PersistedProgress < RequiredCumulativeXp) {
            const Gap = RequiredCumulativeXp - PersistedProgress;
            if (options.boundedMasterySync === true && IsMasteryProgressionTrack(progressionId) && Gap <= MASTERY_CREDIT_PER_OBJECTIVE) {
                await GetRepositories().progressionTracks.setProgressIfGreater(userId, progressionId, RequiredCumulativeXp);
                logger.info(`[MasteryMon] SYNC user=${userId} track=${progressionId} from=${PersistedProgress} to=${RequiredCumulativeXp}`);
            }
            else {
                logger.warn(`Rejected rank confirm: user=${userId} track=${progressionId} claims rank ${rank} (needs ${RequiredCumulativeXp} cumulative XP) but only has ${PersistedProgress} persisted`);
                return { ok: false, reason: "insufficient_xp" };
            }
        }
    }

    const Record = await GetRepositories().progressionTracks.setConfirmedFremiumRank(userId, progressionId, rank);
    return { ok: true, record: Record };
}

export async function QueryEncounteredContent(userId: string, characterId: string, categoriesToQuery: number[]){
    logger.info(`Querying ${categoriesToQuery.length} categories for userId ${userId} and characterId ${characterId}`);

    const EncounteredContentFromDB = await GetRepositories().encounteredContent.findByCharacterIdAndUserId(characterId, userId);

    // TODO: This can be one pass not two, and much less ugly

    let ToReturnRaw: any[] = [];

    if(EncounteredContentFromDB != undefined){
        const EncounteredContent = JSON.parse(EncounteredContentFromDB!.encounteredcontent);

        for(let Content of EncounteredContent){
            if(categoriesToQuery.includes(Content.category)){
                ToReturnRaw.push(Content);
            }
        }
    }

    let ToReturn: any[] = [];

    for(let i = 0; i < 8; i++){
        if(categoriesToQuery.includes(i)){
            const Content = [];

            for(let CmpContent of ToReturnRaw){
                if(CmpContent.category === i){
                    Content.push(CmpContent.content);
                }
            }

            ToReturn.push({
                content: Content,
                content_type: i
            });
        }
    }

    return ToReturn;
}

export async function AddEncounteredContent(userId: string, characterId: string, contentType: number, contentId: string){
    const EncounteredContentFromDB = await GetRepositories().encounteredContent.findByCharacterIdAndUserId(characterId, userId);

    if(EncounteredContentFromDB == undefined){
        await GetRepositories().encounteredContent.create({userId: userId, characterId: characterId, encounteredcontent: "[]"});
    }

    let ParsedEncounteredContent = EncounteredContentFromDB != undefined ? JSON.parse(EncounteredContentFromDB!.encounteredcontent) : [];

    ParsedEncounteredContent.push({
        content: contentId,
        category: contentType
    });

    await GetRepositories().encounteredContent.updateContent(characterId, userId, JSON.stringify(ParsedEncounteredContent));
}

/**
 * Character-scoped progression state must be bound to an existing character row.
 * A `(userId, characterId)` filter on the breadcrumbs/encountered-content rows
 * alone is insufficient: it could create an orphan row for an arbitrary ID and
 * lets callers learn whether another account's character ID is in use through a
 * duplicate-key/error path. Keep the ownership check at the controller boundary
 * so every route that can bootstrap character-scoped state shares the same rule.
 */
export async function IsCharacterOwnedByUser(
    userId: string,
    characterId: string,
    repositories: Pick<RepositoryProvider, "characters"> = GetRepositories()
): Promise<boolean> {
    if (typeof userId !== "string" || userId.trim().length === 0 ||
        typeof characterId !== "string" || characterId.trim().length === 0 ||
        userId === "INVALID" || characterId === "INVALID") {
        return false;
    }

    return await repositories.characters.findByCharacterIdAndUserId(characterId, userId) !== undefined;
}

export async function GetBreadcrumbsForCharacterIdAndUserId(userId: string, characterId: string){
    const BreadcrumbsFromDB = await GetRepositories().breadcrumbs.findByCharacterIdAndUserId(characterId, userId);

    if(BreadcrumbsFromDB == undefined){
        logger.info(`Creating new breadcrumbs entry for character ${characterId}`);

        // TODO: Validate userId/characterId match

        await GetRepositories().breadcrumbs.create({
            breadcrumbs: "[]",
            updateVersion: 0,
            userId: userId,
            characterId: characterId
        });

        return {
            breadcrumbs: [],
            updateVersion: 0
        };
    }

    return {
        breadcrumbs: JSON.parse(BreadcrumbsFromDB.breadcrumbs),
        updateVersion: BreadcrumbsFromDB.updateVersion
    };
}

export async function SetBreadcrumbsForCharacterIdAndUserId(userId: string, characterId: string, breadcrumbsFromUser: any, updateVersion: number){
    const BreadcrumbsFromDB = await GetRepositories().breadcrumbs.findByCharacterIdAndUserId(characterId, userId);

    if(BreadcrumbsFromDB == undefined){
        logger.info(`Creating new breadcrumbs entry for character ${characterId}`);

        // TODO: Validate userId/characterId match

        await GetRepositories().breadcrumbs.create({
            breadcrumbs: JSON.stringify(breadcrumbsFromUser),
            updateVersion: updateVersion,
            userId: userId,
            characterId: characterId
        });
    }
    else{
        logger.info(`Updating breadcrumbs entry for character ${characterId} with updateVersion ${updateVersion}`);

        await GetRepositories().breadcrumbs.update(characterId, userId, JSON.stringify(breadcrumbsFromUser), updateVersion);
    }

    return {
        breadcrumbs: breadcrumbsFromUser,
        updateVersion: updateVersion
    };
}

// [1.12.0] Player Journey Map (Slayer's Path) persistence. The client POSTs its full node map on unlock;
// we store it verbatim (keyed per userId) and echo it back on GET so unlocks survive relog. Empty/undefined
// means "no progress saved yet" → callers return the bootstrap graph.
export async function GetPlayerJourney(userId: string){
    if(userId === undefined || userId === "" || userId === "INVALID") return undefined;

    const Row = await GetRepositories().playerJourney.findByUserId(userId);

    if(Row == undefined) return undefined;

    let ParsedNodes: any = {};
    try { ParsedNodes = JSON.parse(Row.nodes); } catch { ParsedNodes = {}; }

    return {
        nodes: ParsedNodes,
        update_version: Row.updateVersion
    };
}

export function MergePlayerJourneyNodes(storedNodes: any, incomingNodes: any, incomingVersion: number, storedVersion: number): { nodes: any; version: number } {
    const Stored = (storedNodes && typeof storedNodes === "object" && !Array.isArray(storedNodes)) ? storedNodes : {};
    const Incoming = (incomingNodes && typeof incomingNodes === "object" && !Array.isArray(incomingNodes)) ? incomingNodes : {};
    const IsStale = incomingVersion <= storedVersion;
    return {
        nodes: IsStale ? { ...Incoming, ...Stored } : { ...Stored, ...Incoming },
        version: IsStale ? storedVersion : incomingVersion
    };
}

// [2026-10-13 realms S3] Checks the merged map of a save before it is stored (PlanHostPlayerJourney in
// controllers/slayersPath.ts, used only for a player-hosted server's writes). It runs inside the compare-and-swap loop,
// against the stored map the write replaces, so a concurrent save cannot slip an unchecked unlock in between. Returns
// the node map to store.
export type PlayerJourneyVet = (storedNodes: any, mergedNodes: any) => any;

export async function SavePlayerJourney(
    userId: string,
    nodes: any,
    updateVersion: number,
    vet?: PlayerJourneyVet,
    journeys: Pick<PlayerJourneyRepository, "findByUserId" | "createIfAbsent" | "updateIfRevision"> = GetRepositories().playerJourney
){
    const SafeNodes = (nodes && typeof nodes === "object") ? nodes : {};
    const SafeVersion = Number.isFinite(updateVersion) ? updateVersion : 1;

    for(let Attempt = 1; Attempt <= 6; Attempt++){
        const Existing = await journeys.findByUserId(userId);

        if(Existing == undefined){
            const FirstNodes = vet === undefined ? SafeNodes : vet({}, SafeNodes);
            const Created = await journeys.createIfAbsent({
                userId, nodes: JSON.stringify(FirstNodes), updateVersion: SafeVersion, revision: 0
            });
            if(Created){
                logger.info(`Creating player journey row for userId ${userId}`);
                return {
                    nodes: FirstNodes,
                    update_version: SafeVersion,
                    newlyUnlocked: ComputeNewlyUnlockedNodeIds({}, FirstNodes)
                };
            }
            continue;
        }

        let StoredNodes: any = {};
        try { StoredNodes = JSON.parse(Existing.nodes); } catch { StoredNodes = {}; }

        // [FIX 2026-07 — intermittent Slayer's Path unlock loss]
    // This previously overwrote the stored map with whatever the client POSTed, with NO
    // optimistic-concurrency check — unlike POST /character, which rejects stale writes
    // (`if (CurrentData.updateVersion >= UpdateVersion) return false`).
    //
    // Because an unlock is a single node's state change inside a ~405-node blob, a STALE full-map
    // POST silently reverted it, and the node COUNT stayed identical so it never showed up in the
    // logs. That is the "hold the interaction, it completes, nothing happens" symptom — the unlock
    // lands, then a stale write from another writer/retry clobbers it back.
    //
    // Two protections now:
    //   1) Stale write (incoming version <= stored): the stored map wins per-node; the incoming map
    //      may only ADD nodes we don't already have. The stored version is preserved.
    //   2) Fresh write (incoming version > stored): incoming wins per-node, but we still UNION over
    //      the stored map so a partial/truncated payload can never drop existing unlocks.
        const Merged = MergePlayerJourneyNodes(StoredNodes, SafeNodes, SafeVersion, Existing.updateVersion);
        const MergedNodes = vet === undefined ? Merged.nodes : vet(StoredNodes, Merged.nodes);
        const EffectiveVersion = Merged.version;
        const IsStale = SafeVersion <= Existing.updateVersion;

        if(IsStale){
            logger.warn(`[pjm-stale] Stale journey save for userId ${userId}: incoming v${SafeVersion} <= stored v${Existing.updateVersion} — merged without reverting stored unlocks (kept v${EffectiveVersion}, ${Object.keys(MergedNodes).length} nodes)`);
        }

    // Nodes that just transitioned locked -> unlocked. The caller uses this to grant each node's
    // reward item (see controllers/slayersPath.ts). Computed against the STORED map, so a client
    // re-POSTing an already-unlocked map produces an empty list — that is the primary idempotency
    // guard for reward granting.
        const NewlyUnlocked = ComputeNewlyUnlockedNodeIds(StoredNodes, MergedNodes);

        const Updated = await journeys.updateIfRevision(
            userId, JSON.stringify(MergedNodes), EffectiveVersion, Existing.revision
        );
        if(!Updated){
            logger.warn(`[pjm-cas] Concurrent journey update for userId ${userId}; retrying attempt=${Attempt + 1}`);
            continue;
        }

        return {
            nodes: MergedNodes,
            update_version: EffectiveVersion,
            newlyUnlocked: NewlyUnlocked
        };
    }

    throw new Error("Player journey update conflicted after 6 attempts.");
}
