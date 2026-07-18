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

import { GetRepositories } from "../persistence";
import { logger } from "../logger";
import { loadGameData } from "../gameData/loader";
const progressionconfig = loadGameData<any>("progression_config.json");
import { ProgressionTrackRecord } from "../persistence/mapping/domainTypes";
import { ComputeNewlyUnlockedNodeIds } from "./slayersPath";






type TrackCurve = { maxRank: number; cumulativeXpForRank: Map<number, number> };

function BuildTrackCurves(): Map<string, TrackCurve> {
    const Curves = new Map<string, TrackCurve>();
    const Paths: any[] = (progressionconfig as any)?.payload?.paths ?? [];

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

const TrackCurves = BuildTrackCurves();








export async function GrantProgressionXp(userId: string, progressionId: string, amount: number){
    const Before = await GetRepositories().progressionTracks.get(userId, progressionId);
    const OldTotal = Before?.progress ?? 0;

    const After = await GetRepositories().progressionTracks.increment(userId, progressionId, amount);

    logger.info(`[ProgressionGrant] user=${userId} track=${progressionId} delta=${amount} old=${OldTotal} new=${After.progress} source=gameserver`);

    return After;
}

export async function GetPersistedProgressionForUser(userId: string, knownTrackIds: string[]){
    const Persisted = await GetRepositories().progressionTracks.getAllForUser(userId);
    const PersistedById = new Map(Persisted.map((Row) => [Row.progressionId, Row]));

    const Rows: any[] = [];

    
    
    
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












export async function CaptureProgressionObjectiveEvent(userId: string, rawBody: unknown){
    const BodyJson = JSON.stringify(rawBody ?? {});

    await GetRepositories().progressionTracks.appendObjectiveEvent({
        userId,
        rawBody: BodyJson,
        receivedAt: new Date().toISOString()
    });

    const Body = (rawBody ?? {}) as { progress_tracks?: any[]; objectives?: any[] };
    let TracksUpdated = 0;
    let ObjectivesUpdated = 0;

    for(const Track of (Body.progress_tracks ?? [])){
        const TrackId = Track?.progression_id;
        const Progress = Number(Track?.progress);
        if(typeof TrackId !== "string" || TrackId.length === 0 || !Number.isFinite(Progress)) continue;

        await GetRepositories().progressionTracks.setProgressIfGreater(userId, TrackId, Progress);
        TracksUpdated++;
    }

    for(const Objective of (Body.objectives ?? [])){
        const ObjectiveId = Objective?.objective_id;
        const Value = Number(Objective?.value);
        const CompletedCount = Number(Objective?.completed_count ?? 0);
        if(typeof ObjectiveId !== "string" || ObjectiveId.length === 0 || !Number.isFinite(Value)) continue;

        await GetRepositories().progressionTracks.setObjectiveIfGreater(userId, ObjectiveId, Value, Number.isFinite(CompletedCount) ? CompletedCount : 0);
        ObjectivesUpdated++;
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    const KnownKeys = new Set(["progress_tracks", "objectives"]);
    const UnrecognizedKeys = Object.keys(Body).filter((Key) => !KnownKeys.has(Key));
    if(UnrecognizedKeys.length > 0){
        logger.warn(`[ProgressionObjective] user=${userId} UNRECOGNIZED top-level key(s) [${UnrecognizedKeys.join(", ")}] in a progression report - possible unhandled reward/grant payload, not applied. Raw: ${BodyJson.slice(0, 2000)}`);
    }

    logger.info(`[ProgressionObjective] user=${userId} mode=absolute-max-guard tracksUpdated=${TracksUpdated} objectivesUpdated=${ObjectivesUpdated} rawBytes=${BodyJson.length}`);
}

export async function GetPersistedObjectivesForUser(userId: string){
    const Rows = await GetRepositories().progressionTracks.getAllObjectivesForUser(userId);

    return Rows.map((Row) => ({
        objective_id: Row.objectiveId,
        value: Row.value,
        completed_count: Row.completedCount,
    }));
}
















export type ConfirmRankResult =
    | { ok: true; record: ProgressionTrackRecord }
    | { ok: false; reason: "unknown_track" | "rank_out_of_range" | "insufficient_xp" };

export async function ConfirmPublicProgressionRank(userId: string, progressionId: string, rank: number): Promise<ConfirmRankResult> {
    const Curve = TrackCurves.get(progressionId);
    if (Curve === undefined) {
        logger.warn(`Rejected rank confirm: unknown track '${progressionId}' has no rank curve (user=${userId})`);
        return { ok: false, reason: "unknown_track" };
    }

    if (!Number.isInteger(rank) || rank < 0 || rank > Curve.maxRank) {
        logger.warn(`Rejected rank confirm: rank ${rank} out of range [0,${Curve.maxRank}] for track ${progressionId} (user=${userId})`);
        return { ok: false, reason: "rank_out_of_range" };
    }

    
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

export async function GetBreadcrumbsForCharacterIdAndUserId(userId: string, characterId: string){
    const BreadcrumbsFromDB = await GetRepositories().breadcrumbs.findByCharacterIdAndUserId(characterId, userId);

    if(BreadcrumbsFromDB == undefined){
        logger.info(`Creating new breadcrumbs entry for character ${characterId}`);

        

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

export async function SavePlayerJourney(userId: string, nodes: any, updateVersion: number){
    const SafeNodes = (nodes && typeof nodes === "object") ? nodes : {};
    const SafeVersion = Number.isFinite(updateVersion) ? updateVersion : 1;

    const Existing = await GetRepositories().playerJourney.findByUserId(userId);

    
    if(Existing == undefined){
        logger.info(`Creating player journey row for userId ${userId}`);
        await GetRepositories().playerJourney.create({ userId, nodes: JSON.stringify(SafeNodes), updateVersion: SafeVersion });

        return {
            nodes: SafeNodes,
            update_version: SafeVersion,
            newlyUnlocked: ComputeNewlyUnlockedNodeIds({}, SafeNodes)
        };
    }

    let StoredNodes: any = {};
    try { StoredNodes = JSON.parse(Existing.nodes); } catch { StoredNodes = {}; }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const IsStale = SafeVersion <= Existing.updateVersion;

    const MergedNodes = IsStale
        ? { ...SafeNodes, ...StoredNodes }   
        : { ...StoredNodes, ...SafeNodes };  

    const EffectiveVersion = IsStale ? Existing.updateVersion : SafeVersion;

    if(IsStale){
        logger.warn(`[pjm-stale] Stale journey save for userId ${userId}: incoming v${SafeVersion} <= stored v${Existing.updateVersion} — merged without reverting stored unlocks (kept v${EffectiveVersion}, ${Object.keys(MergedNodes).length} nodes)`);
    }

    
    
    
    
    const NewlyUnlocked = ComputeNewlyUnlockedNodeIds(StoredNodes, MergedNodes);

    await GetRepositories().playerJourney.update(userId, JSON.stringify(MergedNodes), EffectiveVersion);

    return {
        nodes: MergedNodes,
        update_version: EffectiveVersion,
        newlyUnlocked: NewlyUnlocked
    };
}
