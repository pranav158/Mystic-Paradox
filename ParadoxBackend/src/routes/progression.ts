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

import { Router } from "express";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { logger } from "../logger";
import { AddEncounteredContent, GetBreadcrumbsForCharacterIdAndUserId, GetPlayerJourney, QueryEncounteredContent, SavePlayerJourney, SetBreadcrumbsForCharacterIdAndUserId, GrantProgressionXp, GetPersistedProgressionForUser, CaptureProgressionObjectiveEvent, GetPersistedObjectivesForUser, ConfirmPublicProgressionRank } from "../controllers/progression";
import { GetUnlockedNodeIds, GrantSlayersPathRewards } from "../controllers/slayersPath";
import { loadGameData } from "../gameData/loader";
import fs from "node:fs";
import path from "node:path";



const SLAYERS_PATH_PAYLOAD: unknown = loadGameData("slayers_path.json");



export const progressionRouter = Router();

const DEFAULT_PROGRESS = 0;
const DEFAULT_CONFIRMED_RANK = 0;
const NO_PLAYER_SENTINEL = "INVALID";

const DEFAULT_PROGRESSION_IDS = [
    "MasteryTrack_PlayerLevel",
    "MasteryTrack_Weapon_Axe",
    "MasteryTrack_Weapon_ChainBlades",
    "MasteryTrack_Weapon_Hammer",
    "MasteryTrack_Weapon_Repeaters",
    "MasteryTrack_Weapon_Sword",
    "MasteryTrack_Weapon_Spear",
    "MasteryTrack_Weapon_Strikers",
    "ExperienceTrack_PlayerLevel",
    "ExperienceTrack_Weapon_Axe",
    "ExperienceTrack_Weapon_ChainBlades",
    "ExperienceTrack_Weapon_Hammer",
    "ExperienceTrack_Weapon_Repeaters",
    "ExperienceTrack_Weapon_Sword",
    "ExperienceTrack_Weapon_Spear",
    "ExperienceTrack_Weapon_Strikers",
    "PrestigeTrack_Weapon_Axe",
    "PrestigeTrack_Weapon_ChainBlades",
    "PrestigeTrack_Weapon_Hammer",
    "PrestigeTrack_Weapon_Repeaters",
    "PrestigeTrack_Weapon_Sword",
    "PrestigeTrack_Weapon_Spear",
    "PrestigeTrack_Weapon_Strikers",
    "season19",
];

function EmptyEncounteredContentResponse(contentTypes: number[]){
    return {
        code: null,
        message: "OK",
        payload: {
            content_types: contentTypes.map((contentType) => ({
                content: [],
                content_type: contentType
            })),
            success: true
        }
    };
}

function ResolveRequestUserId(req: any, paramName = "userId"){
    const ParamUserId = req.params?.[paramName];

    if(typeof ParamUserId === "string" && ParamUserId.length > 0){
        return ParamUserId;
    }

    if(typeof req.body?.accountId === "string" && req.body.accountId.length > 0){
        return req.body.accountId;
    }

    return req.AuthData?.userId ?? NO_PLAYER_SENTINEL;
}

progressionRouter.get("/encountered-content/:characterId/:contentType", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = Number(req.params.contentType);

    logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    if(RequestorAccountId === undefined){
        res.status(200).send(EmptyEncounteredContentResponse([ContentType]));
        return;
    }

    const Content = await QueryEncounteredContent(RequestorAccountId, CharacterId, [ContentType]);

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {
            content_types: Content,
            success: true
        }
    });
});

progressionRouter.post("/encountered-content/query/:characterId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentTypes = req.body.content_types ?? [];

    logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    if(RequestorAccountId === undefined){
        res.status(200).send(EmptyEncounteredContentResponse(ContentTypes));
        return;
    }

    const Content = await QueryEncounteredContent(RequestorAccountId, CharacterId, ContentTypes);

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {
            content_types: Content,
            success: true
        }
    });
});

progressionRouter.post("/encountered-content/query", HasParadoxBackendAuth, async (req: any, res) => {
    const ContentTypes = req.body.content_types ?? [];

    logger.info("Querying encountered content without characterId; returning empty content");

    res.status(200);
    res.send(EmptyEncounteredContentResponse(ContentTypes));
});

progressionRouter.post("/encountered-content/:characterId/query", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentTypes = req.body.content_types ?? [];

    logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    if(RequestorAccountId === undefined){
        res.status(200).send(EmptyEncounteredContentResponse(ContentTypes));
        return;
    }

    const Content = await QueryEncounteredContent(RequestorAccountId, CharacterId, ContentTypes);

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {
            content_types: Content,
            success: true
        }
    });
});

progressionRouter.post("/encountered-content/:characterId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = req.body.content_type;
    const ContentId = req.body.content_id;

    logger.info(`Adding encountered content ${ContentId} for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    if(RequestorAccountId === undefined || ContentType === undefined || ContentId === undefined){
        res.status(200);
        res.send({
            code: null,
            message: "OK",
            payload: {}
        });
        return;
    }

    await AddEncounteredContent(RequestorAccountId, CharacterId, ContentType, ContentId);

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {}
    });
});






progressionRouter.post("/encountered-content", HasParadoxBackendAuth, (_req: any, res) => {
    res.status(200);
    res.send({ code: null, message: "OK", payload: {} });
});
progressionRouter.post("/encountered-content/", HasParadoxBackendAuth, (_req: any, res) => {
    res.status(200);
    res.send({ code: null, message: "OK", payload: {} });
});

progressionRouter.get("/progression/objectives/:userId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = ResolveRequestUserId(req);

    if(RequestorAccountId === NO_PLAYER_SENTINEL){
        logger.debug("Objective progression fetched for no-player sentinel - returning empty, not touching DB");
        res.status(200);
        res.json({ code: null, message: "OK", payload: [] });
        return;
    }

    
    
    const Payload = await GetPersistedObjectivesForUser(RequestorAccountId);

    logger.info(`Objective progression fetched for userId ${RequestorAccountId} (${Payload.length} objectives, persisted)`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: Payload
    })
});

progressionRouter.get("/breadcrumbs/", HasParadoxBackendAuth, async (req: any, res) => {
    logger.info("Requested breadcrumbs without characterId; returning empty breadcrumbs");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            breadcrumbs: [],
            updateVersion: 0
        }
    });
});

progressionRouter.get("/breadcrumbs/:characterId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;

    logger.info(`Requested breadcrumbs for characterId ${RequestedCharacterId}`);

    if(RequestorUserId === undefined){
        res.status(200);
        res.json({
            code: null,
            message: "OK",
            payload: {
                breadcrumbs: [],
                updateVersion: 0
            }
        });
        return;
    }

    const Payload = await GetBreadcrumbsForCharacterIdAndUserId(RequestorUserId, RequestedCharacterId);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: Payload
    });
});

progressionRouter.post("/breadcrumbs/:characterId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;
    const BreadcrumbsFromUser = req.body.breadcrumbs;
    const UpdateVersion = req.body.updateVersion;

    logger.info(`Setting breadcrumbs for characterId ${RequestedCharacterId}`);

    const Payload = await SetBreadcrumbsForCharacterIdAndUserId(RequestorUserId, RequestedCharacterId, BreadcrumbsFromUser, UpdateVersion);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: Payload
    });
});










const MAX_XP_GRANT_AMOUNT = 100000; 
const PROGRESSION_ID_MAX_LENGTH = 128;

progressionRouter.post("/progression/:userId/:progressionId/:amount", HasParadoxBackendAuth, async (req: any, res) => {
    if(req.AuthData?.IsGameserver !== true){
        logger.warn(`Rejected XP grant attempt without gameserver auth (userId=${req.params.userId}, track=${req.params.progressionId})`);
        res.status(403);
        res.json({ code: null, message: "Forbidden", payload: {} });
        return;
    }

    const RequestedUserId = req.params.userId;
    const ProgressionId = req.params.progressionId;
    const AmountRaw = req.params.amount;

    if(typeof RequestedUserId !== "string" || RequestedUserId.length === 0 || RequestedUserId === NO_PLAYER_SENTINEL){
        logger.warn(`Rejected XP grant: invalid/sentinel userId (${RequestedUserId})`);
        res.status(400);
        res.json({ code: null, message: "Bad Request", payload: {} });
        return;
    }

    if(typeof ProgressionId !== "string" || ProgressionId.length === 0 || ProgressionId.length > PROGRESSION_ID_MAX_LENGTH){
        logger.warn(`Rejected XP grant: invalid progressionId (len=${ProgressionId?.length})`);
        res.status(400);
        res.json({ code: null, message: "Bad Request", payload: {} });
        return;
    }

    const Amount = Number(AmountRaw);
    if(!Number.isInteger(Amount) || Amount <= 0 || Amount > MAX_XP_GRANT_AMOUNT){
        logger.warn(`Rejected XP grant: invalid amount (${AmountRaw}) for user=${RequestedUserId} track=${ProgressionId}`);
        res.status(400);
        res.json({ code: null, message: "Bad Request", payload: {} });
        return;
    }

    const Updated = await GrantProgressionXp(RequestedUserId, ProgressionId, Amount);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            phx_account_id: RequestedUserId,
            progression_id: ProgressionId,
            progress: Updated.progress,
            confirmed_fremium_rank: Updated.confirmedFremiumRank,
            confirmed_premium_rank: Updated.confirmedPremiumRank,
            confirmed_date: Updated.updatedAt,
        }
    });
});

progressionRouter.post("/progression/:userId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = ResolveRequestUserId(req);

    if(RequestorAccountId === NO_PLAYER_SENTINEL){
        logger.debug("Progression/objective event received for no-player sentinel - discarding, not persisting");
    }
    else{
        
        
        
        await CaptureProgressionObjectiveEvent(RequestorAccountId, req.body);
    }

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {}
    });
});

















progressionRouter.post("/progression/:userId/:progressionId/:rank/confirm/public", HasParadoxBackendAuth, async (req: any, res) => {
    if(req.AuthData?.IsGameserver !== true){
        logger.warn(`Rejected rank confirm attempt without gameserver auth (userId=${req.params.userId}, track=${req.params.progressionId})`);
        res.status(403);
        res.json({ code: null, message: "Forbidden", payload: {} });
        return;
    }

    const RequestedUserId = req.params.userId;
    const ProgressionId = req.params.progressionId;
    const RankRaw = req.params.rank;

    if(typeof RequestedUserId !== "string" || RequestedUserId.length === 0 || RequestedUserId === NO_PLAYER_SENTINEL){
        logger.warn(`Rejected rank confirm: invalid/sentinel userId (${RequestedUserId})`);
        res.status(400);
        res.json({ code: null, message: "Bad Request", payload: {} });
        return;
    }

    const Rank = Number(RankRaw);
    if(!Number.isInteger(Rank) || Rank < 0){
        logger.warn(`Rejected rank confirm: invalid rank (${RankRaw}) for user=${RequestedUserId} track=${ProgressionId}`);
        res.status(400);
        res.json({ code: null, message: "Bad Request", payload: {} });
        return;
    }

    const Result = await ConfirmPublicProgressionRank(RequestedUserId, ProgressionId, Rank);

    if(!Result.ok){
        const StatusByReason = { unknown_track: 400, rank_out_of_range: 400, insufficient_xp: 409 } as const;
        res.status(StatusByReason[Result.reason]);
        res.json({ code: null, message: `Rejected: ${Result.reason}`, payload: {} });
        return;
    }

    const Updated = Result.record;
    logger.info(`Confirm public progression rank ${Rank} for userId ${RequestedUserId} track ${ProgressionId} - progress preserved at ${Updated.progress}`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            phx_account_id: RequestedUserId,
            progression_id: ProgressionId,
            progress: Updated.progress,
            confirmed_fremium_rank: Updated.confirmedFremiumRank,
            confirmed_premium_rank: Updated.confirmedPremiumRank,
            confirmed_date: Updated.updatedAt,
        }
    });
});

progressionRouter.get("/progression/:userId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = ResolveRequestUserId(req);

    if(RequestorAccountId === NO_PLAYER_SENTINEL){
        logger.debug("Progression fetched for no-player sentinel - returning empty zero-baseline, not touching DB");
        res.status(200);
        res.json({
            code: null,
            message: "OK",
            payload: DEFAULT_PROGRESSION_IDS.map((progressionId) => ({
                phx_account_id: RequestorAccountId,
                progression_id: progressionId,
                progress: DEFAULT_PROGRESS,
                confirmed_fremium_rank: DEFAULT_CONFIRMED_RANK,
                confirmed_premium_rank: DEFAULT_CONFIRMED_RANK,
                confirmed_date: new Date().toISOString(),
            }))
        });
        return;
    }

    
    
    
    
    const Payload = await GetPersistedProgressionForUser(RequestorAccountId, DEFAULT_PROGRESSION_IDS);

    logger.info(`Progression fetched for userId ${RequestorAccountId} (${Payload.length} tracks, persisted)`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: Payload
    })
});










progressionRouter.get("/pjm/:userId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestedUserId = req.params.userId;

    if(RequestedUserId === "INVALID"){
        logger.debug(`GET /pjm called with no-player sentinel (userId=INVALID) - returning empty player journey map, not touching DB`);
        res.status(200).json({ code: null, message: "OK", payload: { nodes: {}, update_version: 1 } });
        return;
    }

    const Saved = await GetPlayerJourney(RequestedUserId);
    if(Saved != undefined){
        
        
        
        if(req.AuthData?.IsGameserver === true){
            const RewardEligibleNodeIds = GetUnlockedNodeIds(Saved.nodes);
            logger.info(`[slayers-path] login reconciliation evaluating ${RewardEligibleNodeIds.length} reward-eligible nodes for ${RequestedUserId}`);
            const Granted = await GrantSlayersPathRewards(RequestedUserId, RewardEligibleNodeIds);
            if(Granted.length > 0){
                logger.info(`Slayer's Path login reconciliation granted [${Granted.join(", ")}] to ${RequestedUserId}`);
            }
        }

        logger.info(`Player journey map fetched for userId ${RequestedUserId} (persisted: ${Object.keys(Saved.nodes).length} nodes, v${Saved.update_version})`);
        res.status(200).json({ code: null, message: "OK", payload: Saved });
        return;
    }
    logger.info(`Player journey map fetched for userId ${RequestedUserId} (no save yet - empty baseline)`);
    res.status(200).json({ code: null, message: "OK", payload: { nodes: {}, update_version: 1 } });
});

progressionRouter.post("/pjm/:userId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestedUserId = req.params.userId;
    
    
    
    
    if(req.AuthData?.IsGameserver !== true){
        logger.warn(`Rejected player journey mutation without gameserver auth (userId=${RequestedUserId})`);
        res.status(403).json({ code: null, message: "Forbidden", payload: {} });
        return;
    }

    if(RequestedUserId === "INVALID"){
        logger.debug("POST /pjm called with no-player sentinel (userId=INVALID) - no-op update, not touching DB");
        res.status(200).json({ code: null, message: "OK", payload: { nodes: {}, update_version: req.body?.update_version ?? 1 } });
        return;
    }

    const Nodes = req.body?.nodes ?? {};
    const UpdateVersion = req.body?.update_version ?? 1;
    const Saved = await SavePlayerJourney(RequestedUserId, Nodes, UpdateVersion);

    logger.info(`Player journey map SAVED for userId ${RequestedUserId} (${Object.keys(Nodes).length} nodes, v${UpdateVersion})`);

    
    
    
    
    const Granted = await GrantSlayersPathRewards(RequestedUserId, GetUnlockedNodeIds(Saved.nodes));
    if(Granted.length > 0){
        logger.info(`Slayer's Path reconciliation granted [${Granted.join(", ")}] to ${RequestedUserId}`);
    }
    
    res.status(200).json({
        code: null,
        message: "OK",
        payload: { nodes: Saved.nodes, update_version: Saved.update_version }
    });
});












progressionRouter.get("/pjm", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData?.userId;
    if(UserId != undefined && UserId !== "INVALID"){
        const Saved = await GetPlayerJourney(UserId);
        if(Saved != undefined){
            logger.info(`GET /pjm — returning persisted map for ${UserId} (${Object.keys(Saved.nodes).length} nodes, v${Saved.update_version})`);
            res.status(200).json({ code: null, message: "OK", payload: Saved });
            return;
        }
    }
    logger.info("GET /pjm — no persisted map; returning captured Slayer's Path bootstrap payload (317 nodes)");
    res.status(200);
    res.json(SLAYERS_PATH_PAYLOAD);
});








progressionRouter.get("/progression/tracked_objectives/:phxAccountId", HasParadoxBackendAuth, (req: any, res) => {
    const PhxAccountId = req.params.phxAccountId;
    logger.info(`GET tracked objectives for phx_account_id=${PhxAccountId} (bootstrap)`);
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            current_set: "quest_slayer_links",
            omitted_quests: [],
            phx_account_id: PhxAccountId,
            tracked_craftables: [],
            tracked_quests: []
        }
    });
});

progressionRouter.post("/progression/tracked_objectives/:phxAccountId", HasParadoxBackendAuth, (req: any, res) => {
    const PhxAccountId = req.params.phxAccountId;
    logger.info(`POST tracked objectives for phx_account_id=${PhxAccountId} (bootstrap, discarding update)`);
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: null
    });
});

