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

import { GetRepositories, GetUnitOfWork, ProgressionGrantRecord, ProgressionTrackRecord, ProgressionTrackRepository, RepositoryProvider, UnitOfWork } from "../persistence";
import { logger } from "../logger";
import { loadGameData } from "../gameData/loader";
import { ComputeNewlyUnlockedNodeIds } from "./slayersPath";
import crypto from "node:crypto";

// [WP-1 stage 4 — security fix] Per-track rank curves, indexed once (on first use) from the
// same file GET /progression/config serves. Used to validate confirm/public requests instead of
// trusting the client's claimed rank outright. requiredXP entries are INCREMENTAL (cost to
// advance one rank, not a cumulative threshold — see tools/CatalogExporter/ExportFlags.md) so the
// cumulative XP needed for a given rank is the running sum of every requirement up to it.
type TrackCurve = { maxRank: number; cumulativeXpForRank: Map<number, number> };

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

        Curves.set(ProgressionId, { maxRank: Sorted[Sorted.length - 1].rank_id, cumulativeXpForRank: CumulativeXpForRank });
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
    return ApprovedXpTracks.has(progressionId) && TrackCurves().has(progressionId);
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
    unitOfWork: Pick<UnitOfWork, "withTransaction"> = GetUnitOfWork()
): Promise<ProgressionGrantResult> {
    if(!IsApprovedXpProgressionTrack(progressionId)) {
        throw new Error(`Unsupported progression track '${progressionId}'.`);
    }
    if(!Number.isInteger(amount) || amount <= 0 || amount > 100000 || !IsValidProgressionGrantId(grantId)) {
        throw new Error("Invalid authoritative progression grant.");
    }
    const requestHash = BuildProgressionGrantRequestHash(userId, progressionId, amount);
    const maxAttempts = 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await unitOfWork.withTransaction(async (repos, session) => {
                const Existing = await repos.progressionGrants.findByGrantId(grantId, session);
                if (Existing !== undefined) {
                    if (Existing.requestHash !== requestHash || Existing.userId !== userId ||
                        Existing.progressionId !== progressionId || Existing.amount !== amount) {
                        throw new ProgressionGrantConflictError(grantId);
                    }
                    return { record: Existing.result, replayed: true };
                }

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

                logger.info(`[ProgressionGrant] grant=${grantId} user=${userId} track=${progressionId} delta=${amount} old=${Before?.progress ?? 0} new=${After.progress} source=gameserver applied=1`);
                return { record: After, replayed: false };
            });
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

export function IsAuthorizedProgressionReader(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    return typeof authData?.userId === "string" && authData.userId === targetUserId;
}

export async function GetPersistedObjectivesForUser(userId: string){
    const Rows = await GetRepositories().progressionTracks.getAllObjectivesForUser(userId);

    return Rows.map((Row) => ({
        objective_id: Row.objectiveId,
        value: Row.value,
        completed_count: Row.completedCount,
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

export async function ConfirmPublicProgressionRank(userId: string, progressionId: string, rank: number): Promise<ConfirmRankResult> {
    const Curve = TrackCurves().get(progressionId);
    if (Curve === undefined) {
        logger.warn(`Rejected rank confirm: unknown track '${progressionId}' has no rank curve (user=${userId})`);
        return { ok: false, reason: "unknown_track" };
    }

    if (!Number.isInteger(rank) || rank < 0 || rank > Curve.maxRank) {
        logger.warn(`Rejected rank confirm: rank ${rank} out of range [0,${Curve.maxRank}] for track ${progressionId} (user=${userId})`);
        return { ok: false, reason: "rank_out_of_range" };
    }

    // Rank 0/1 (pre-first-requirement) never needs an XP check — every track's floor.
    const RequiredCumulativeXp = Curve.cumulativeXpForRank.get(rank) ?? 0;
    if (RequiredCumulativeXp > 0) {
        const ExistingTrack = await GetRepositories().progressionTracks.get(userId, progressionId);
        const PersistedProgress = ExistingTrack?.progress ?? 0;

        if (PersistedProgress < RequiredCumulativeXp) {
            logger.warn(`Rejected rank confirm: user=${userId} track=${progressionId} claims rank ${rank} (needs ${RequiredCumulativeXp} cumulative XP) but only has ${PersistedProgress} persisted`);
            return { ok: false, reason: "insufficient_xp" };
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

export async function SavePlayerJourney(userId: string, nodes: any, updateVersion: number){
    const SafeNodes = (nodes && typeof nodes === "object") ? nodes : {};
    const SafeVersion = Number.isFinite(updateVersion) ? updateVersion : 1;

    for(let Attempt = 1; Attempt <= 6; Attempt++){
        const Existing = await GetRepositories().playerJourney.findByUserId(userId);

        if(Existing == undefined){
            const Created = await GetRepositories().playerJourney.createIfAbsent({
                userId, nodes: JSON.stringify(SafeNodes), updateVersion: SafeVersion, revision: 0
            });
            if(Created){
                logger.info(`Creating player journey row for userId ${userId}`);
                return {
                    nodes: SafeNodes,
                    update_version: SafeVersion,
                    newlyUnlocked: ComputeNewlyUnlockedNodeIds({}, SafeNodes)
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
        const MergedNodes = Merged.nodes;
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

        const Updated = await GetRepositories().playerJourney.updateIfRevision(
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
