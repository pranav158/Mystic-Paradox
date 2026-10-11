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
import { loadGameData } from "../gameData/loader";
import { WidenHuntPassWindows } from "./system";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { logger } from "../logger";
import { AddEncounteredContent, GetBreadcrumbsForCharacterIdAndUserId, GetPlayerJourney, QueryEncounteredContent, SavePlayerJourney, SetBreadcrumbsForCharacterIdAndUserId, GrantProgressionXp, GetPersistedProgressionForUser, CaptureProgressionObjectiveEvent, GetPersistedObjectivesForUser, ConfirmPublicProgressionRank, IsAuthorizedProgressionReader, IsAuthorizedProgressionReporter, IsApprovedXpProgressionTrack, IsValidProgressionGrantId, ProgressionGrantConflictError, IsCharacterOwnedByUser } from "../controllers/progression";
import { GetUnlockedNodeIds, GrantSlayersPathRewards } from "../controllers/slayersPath";
import { IsPrestigeSourceTrack } from "../controllers/wallet";
import { MonitorProgressionReport, MonitorProgressionServed, MonitorSourceOf } from "../diagnostics/economyMonitor";

// Game data from ParadoxBackend/game-data (gameData/loader.ts; the loader also strips a UTF-8 BOM).
// [1.12.0] The Slayer's Path graph was captured from production.
const ProgressionConfigPayload = loadGameData<any>("progression_config.json");
const SLAYERS_PATH_PAYLOAD: unknown = loadGameData("slayers_path.json");

// TODO: We will be gaining progression support very soon, but for now just a stub

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
    "season43",   // the active hunt pass (ACTIVE_HUNTPASS_PROGRESSION_ID); season19 on 1.12
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

function RequireProgressionRead(req: any, res: any, targetUserId: string): boolean {
    if (targetUserId === NO_PLAYER_SENTINEL || targetUserId === "INVALID" ||
        IsAuthorizedProgressionReader(req.AuthData, targetUserId)) {
        return true;
    }
    logger.warn(`Rejected cross-account progression read actor=${req.AuthData?.userId ?? "unknown"} target=${targetUserId}`);
    res.status(403).json({ code: null, message: "Forbidden", payload: {} });
    return false;
}

async function RequireCharacterOwnership(req: any, res: any, userId: string, characterId: string): Promise<boolean> {
    if (userId === undefined || userId === NO_PLAYER_SENTINEL) return true;
    if (await IsCharacterOwnedByUser(userId, characterId)) return true;
    logger.warn(`Rejected character-scoped progression read for characterId ${characterId}: character is not owned by userId ${userId}`);
    res.status(403).json({ code: "forbidden", message: "Character is not owned by the authenticated account.", payload: null });
    return false;
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

    if (!(await RequireCharacterOwnership(req, res, RequestorAccountId, CharacterId))) return;

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

    if (!(await RequireCharacterOwnership(req, res, RequestorAccountId, CharacterId))) return;

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

    if (!(await RequireCharacterOwnership(req, res, RequestorAccountId, CharacterId))) return;

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

    if (!(await IsCharacterOwnedByUser(RequestorAccountId, CharacterId))) {
        logger.warn(`Rejected encountered-content write for characterId ${CharacterId}: character is not owned by userId ${RequestorAccountId}`);
        res.status(403).send();
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

// [1.12 fallback — 2026-07-10] The client sometimes POSTs to /encountered-content
// with an empty characterId (before login state fully settles). The specific
// param-less path is not matched by any of the routes above, so it logs as
// Unstubbed. Acknowledge it as a no-op — the client will retry with a valid
// characterId later.
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
    if(!RequireProgressionRead(req, res, RequestorAccountId)) return;

    if(RequestorAccountId === NO_PLAYER_SENTINEL){
        logger.debug("Objective progression fetched for no-player sentinel - returning empty, not touching DB");
        res.status(200);
        res.json({ code: null, message: "OK", payload: [] });
        return;
    }

    // [1.14.7 2026-10-03] CONTRACT CORRECTION. The captured live server
    // (DauntlessEndpointDocumentation/Progression/GetConfig.md) documents this exact path as the
    // progression CONFIGURATION: "URL: https://progression-prod.steelyard.ca/progression/objectives/
    // {PHXL ID} ... Example Response: 84k lines of JSON, see ./Config.json", and that Config.json is
    // {code,message,payload:{paths:[…]}} - the hunt-pass paths whose start_date/end_date are the SEASON
    // DATES the bounty component needs:
    //   [LogArchonBounty][Error][bounty_bpc] UBountyComponent::ServerInitializeBounties()
    //       - failed to get season dates for player: <account>
    //   -> "Disconnect Error Message: An error occurred. Please try again later." -> LeavingMap
    // This route used to answer with the persisted OBJECTIVES array instead, so the client received a
    // list where it expects the paths config and could not resolve any season window.
    // The same payload is already served at /progression/config; serving it here matches the capture.
    // [1.14.7 2026-10-03] REVERTED. Round 28 changed this to serve the paths config because
    // DauntlessEndpointDocumentation/Progression/GetConfig.md documents this URL with the 84k-line
    // Config.json. That is contradicted by the SAME capture: Progression/GetObjectiveProgression.md
    // documents the identical URL as "progress on achievements and mastery objectives" with
    //   payload: [ {completed_count, created_date, last_modified_date, objective_id, phx_account_id,
    //                progress}, ... ]
    // i.e. the objectives array - which is what this route served originally and serves again now.
    // Two captured files disagree about one path, so the safer reading is the one that matches the
    // code that was already working; the config is still served at /progression/config, which is
    // where the 1.12 lineage reads it from.
    // [1.14.7 A/B 2026-10-03] The two captured docs disagree about this URL (objectives array vs the
    // paths config). This env switch makes the choice measurable without a code change:
    //   GAMESERVER_OBJECTIVES_AS_CONFIG=1 -> serve the paths config here
    //   unset/0                          -> serve the persisted objectives array (default)
    // The decisive observation is whether the client's
    // "GetProgressionConfiguration - Track ... not found in the cached progression configs" warnings
    // STOP after this response arrives (cache populated) or continue (cache populated from elsewhere).
    if ((process.env.GAMESERVER_OBJECTIVES_AS_CONFIG ?? "0") === "1") {
        logger.info(`Progression paths config served at /progression/objectives for ${RequestorAccountId} (A/B)`);
        res.status(200);
        res.json(WidenHuntPassWindows(JSON.parse(JSON.stringify(ProgressionConfigPayload))));
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

    if (!(await IsCharacterOwnedByUser(RequestorUserId, RequestedCharacterId))) {
        logger.warn(`Rejected breadcrumbs read for characterId ${RequestedCharacterId}: character is not owned by userId ${RequestorUserId}`);
        res.status(403).send();
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

    if (!(await IsCharacterOwnedByUser(RequestorUserId, RequestedCharacterId))) {
        logger.warn(`Rejected breadcrumbs write for characterId ${RequestedCharacterId}: character is not owned by userId ${RequestorUserId}`);
        res.status(403).send();
        return;
    }

    const Payload = await SetBreadcrumbsForCharacterIdAndUserId(RequestorUserId, RequestedCharacterId, BreadcrumbsFromUser, UpdateVersion);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: Payload
    });
});

// [WP-1] XP grant endpoint (plan section 6.1/16). This is what was previously missing entirely —
// the 1.12 game server has been sending POST /progression/mystpax/ExperienceTrack_Weapon_Sword/125
// (etc) since before this route existed, and getting a 404 every time, which is why no weapon/
// player/hunt-pass XP was ever persisted. The route itself now exists; server-only auth,
// input validation, and atomic persistence all per plan section 6.1's numbered rules.
//
// Rule 1/6 (plan 6.1): game-server-only. A player's own bearer token must never be able to call
// this — only req.AuthData.IsGameserver === true is accepted, exactly the flag
// middleware/HasParadoxBackendAuth.ts already sets for validated gameserver-api-key requests.
const MAX_XP_GRANT_AMOUNT = 100000; // Rule 5: conservative bound, configurable later if too low.
const PROGRESSION_ID_MAX_LENGTH = 128;

function ReadAuthoritativeGrantId(req: any): string | undefined {
    const HeaderValue = req.get?.("x-mysticparadox-grant-id") ?? req.get?.("idempotency-key");
    const BodyValue = req.body?.grant_id ?? req.body?.grantId;
    if(HeaderValue !== undefined && BodyValue !== undefined && HeaderValue !== BodyValue) return undefined;
    const Candidate = HeaderValue ?? BodyValue;
    return IsValidProgressionGrantId(Candidate) ? Candidate : undefined;
}

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
    const GrantId = ReadAuthoritativeGrantId(req);

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

    if(!IsApprovedXpProgressionTrack(ProgressionId)){
        logger.warn(`Rejected XP grant: progression track is not approved (user=${RequestedUserId}, track=${ProgressionId})`);
        res.status(400).json({ code: null, message: "Bad Request", payload: {} });
        return;
    }

    if(GrantId === undefined){
        logger.warn(`Rejected XP grant: missing or invalid authoritative grant id (user=${RequestedUserId}, track=${ProgressionId})`);
        res.status(400).json({ code: null, message: "Bad Request", payload: {} });
        return;
    }

    const Amount = Number(AmountRaw);
    if(!Number.isInteger(Amount) || Amount <= 0 || Amount > MAX_XP_GRANT_AMOUNT){
        logger.warn(`Rejected XP grant: invalid amount (${AmountRaw}) for user=${RequestedUserId} track=${ProgressionId}`);
        res.status(400);
        res.json({ code: null, message: "Bad Request", payload: {} });
        return;
    }

    let GrantResult;
    try{
        GrantResult = await GrantProgressionXp(RequestedUserId, ProgressionId, Amount, GrantId);
    }
    catch(ErrorValue){
        if(ErrorValue instanceof ProgressionGrantConflictError){
            logger.warn(`Rejected XP grant reuse with different request (grant=${GrantId}, user=${RequestedUserId})`);
            res.status(409).json({ code: null, message: "Conflict", payload: {} });
            return;
        }
        throw ErrorValue;
    }
    const Updated = GrantResult.record;

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
            grant_id: GrantId,
            replayed: GrantResult.replayed,
        }
    });
});

progressionRouter.post("/progression/:userId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestorAccountId = ResolveRequestUserId(req);

    // A player bearer may only report its own objective state. Dedicated and scoped
    // player-host runtimes resolve the acting roster identity in auth middleware; in both cases
    // an authenticated userId, when present, must match the route target exactly.
    if(!IsAuthorizedProgressionReporter(req.AuthData, RequestorAccountId)){
        logger.warn(`Rejected cross-account progression report actor=${req.AuthData?.userId ?? "unknown"} target=${RequestorAccountId}`);
        res.status(403).json({ code: null, message: "Forbidden", payload: {} });
        return;
    }

    if(RequestorAccountId === NO_PLAYER_SENTINEL){
        logger.debug("Progression/objective event received for no-player sentinel - discarding, not persisting");
    }
    else{
        // [diagnostics 2026-10-10] [PrestigeMon] - the season/prestige track values the server reports here.
        MonitorProgressionReport(RequestorAccountId, MonitorSourceOf(req.AuthData), req.body, IsPrestigeSourceTrack);
        // [WP-1 stage 1, plan section 6.3] Raw capture only — no reducer yet. This used to
        // silently discard the body entirely, which is why mastery/hunt-pass XP never
        // accumulated even though the server returned 200 OK for these calls.
        try{
            await CaptureProgressionObjectiveEvent(RequestorAccountId, req.body);
        }
        catch(error){
            if(error instanceof Error && error.name === "ProgressionEventValidationError"){
                res.status(400).json({ code: null, message: "Bad Request", payload: {} });
                return;
            }
            throw error;
        }
    }

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {}
    });
});

// [WP-1 stage 3 — bug fix, confirmed via live repro] This route previously returned
// `progress: Math.max(0, Rank)` — i.e. it echoed the CONFIRMED RANK NUMBER (e.g. 3) back in the
// `progress` field, which is supposed to be the XP TOTAL (e.g. 250). The 1.12 client trusts this
// response and overwrites its cached XP total with whatever `progress` says, so confirming rank
// 3 made the Slayer's Path bar visibly drop from 250 back down to 3 — the real XP grant (WP-1's
// atomic increments) was never lost, only clobbered in the client's display by this route's next
// response. Fix: persist ONLY the confirmed rank onto the already-existing track row (never
// resetting/overwriting `progress`, never touching the premium rank here), then return the
// REAL persisted progress total alongside it.
//
// [WP-1 stage 4 — security fix] This route previously trusted the URL's rank with NO auth gate
// and NO range/qualification check — same class of gap the grant endpoint (below) already
// closes for XP grants. Fixed the same way: gameserver-only auth (this `:userId` is supplied by
// the trusted gameserver on a player's behalf, exactly like the grant endpoint — never a player's
// own bearer token), a validated integer rank, and ConfirmPublicProgressionRank enforcing the
// rank is in-range for the track and the account's persisted XP actually qualifies for it.
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
    if(!RequireProgressionRead(req, res, RequestorAccountId)) return;

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

    // [WP-1] Real persisted totals, merged with zero-rows for any known track that has never
    // received XP, with any OTHER persisted (unanticipated) track id preserved verbatim per
    // plan section 6.2. This replaces the old always-zero stub that made XP look like it was
    // never saving even after the grant endpoint started persisting it.
    const Payload = await GetPersistedProgressionForUser(RequestorAccountId, DEFAULT_PROGRESSION_IDS);

    logger.info(`Progression fetched for userId ${RequestorAccountId} (${Payload.length} tracks, persisted)`);
    MonitorProgressionServed(RequestorAccountId, Payload, IsPrestigeSourceTrack);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: Payload
    })
});

// [1.12.0] /pjm/:userId - "Player Journey Map" (aka "Slayer's Path"). Previously unstubbed;
// UPlayerJourneyComponent on the gameserver calls this and null-derefs its response if the
// shape is missing/malformed (observed access violation in
// UPlayerJourneyComponent::OnQueryPlayerJourneyDataComplete). Response shape below matches the
// real captured payload (DauntlessEndpointDocumentation/Progression/GetSlayersPath.md) - nodes
// is a dict keyed by node_id, not an array; there's no account_id field in the real payload.
// An empty nodes dict is a valid, well-formed "no progress yet" journey map.
// "INVALID" is UE4/Phoenix's own sentinel for "no logged-in player" (e.g. a standalone
// gameserver with no client connected) - never persist or look anything up for it.
progressionRouter.get("/pjm/:userId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestedUserId = req.params.userId;
    if(!RequireProgressionRead(req, res, RequestedUserId)) return;

    if(RequestedUserId === "INVALID"){
        logger.debug(`GET /pjm called with no-player sentinel (userId=INVALID) - returning empty player journey map, not touching DB`);
        res.status(200).json({ code: null, message: "OK", payload: { nodes: {}, update_version: 1 } });
        return;
    }

    const Saved = await GetPlayerJourney(RequestedUserId);
    if(Saved != undefined){
        // Backfill rewards that were missed before the server knew how to apply Slayer's Path
        // unlock effects. Limit this to a validated game-server request: bearer-only clients may
        // read their map, but must never be able to cause inventory grants through a GET.
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

// [1.14.7 2026-10-03] GET /weapon_tracker/:userId/:itemId had no route at all, so it 404'd while the
// client was loading player data and its weapon-tracker component logged a failure:
//   [REQ]  GET progression-prod.steelyard.ca/weapon_tracker/f2aaa6bf-…/RHLDQHG6UNBG3KROD7MWHKZSKU
//   WARN:  Unstubbed route GET /weapon_tracker/… -> 404
//   [LogArchonWeaponTracker][Error] UWeaponTrackerComponent::ReadWeaponTrackersFromBackend::<lambda_…>
// The SDK gives the response contract:
//   UWeaponTrackerComponent::TrackersInfo : TArray<FWeaponTrackerInfo>   (Archon_classes.hpp:26133)
//   struct FWeaponTrackerInfo { int32 TrackerHash; int32 Score; FText UIText; }
//                                                                        (Archon_structs.hpp:7502)
// Same {code,message,payload} envelope as the rest of this surface; an empty TrackersInfo array is a
// valid "no tracker data for this item" answer and lets the loader complete.
progressionRouter.get("/weapon_tracker/:userId/:itemId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestedUserId = String(req.params.userId);
    const ItemId = String(req.params.itemId);
    if (!RequireProgressionRead(req, res, RequestedUserId)) return;

    logger.info(`Weapon trackers for userId ${RequestedUserId} item ${ItemId} (1.14.7 stub)`);
    res.status(200).json({ code: null, message: "OK", payload: { TrackersInfo: [] } });
});

progressionRouter.post("/pjm/:userId", HasParadoxBackendAuth, async (req: any, res) => {
    const RequestedUserId = req.params.userId;
    // This route now has real inventory-granting side effects. A bearer-authenticated client must
    // not be able to forge node_status=Unlocked for arbitrary reward nodes (or another user).
    // The 1.12 flow reaches this endpoint through the game server, which supplies the validated
    // x-mysticparadox-gameserver-apikey header and receives AuthData.IsGameserver=true in the auth layer.
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

    // Reconcile ALL unlocked reward nodes after every save, not only this request's transitions.
    // SavePlayerJourney and inventory currently cannot commit in one Mongo transaction; if the
    // inventory write fails after the node save, the next PJM save therefore retries the missing
    // reward. Ownership checks plus stable per-item transaction/instance ids keep retries safe.
    const Granted = await GrantSlayersPathRewards(RequestedUserId, GetUnlockedNodeIds(Saved.nodes));
    if(Granted.length > 0){
        logger.info(`Slayer's Path reconciliation granted [${Granted.join(", ")}] to ${RequestedUserId}`);
    }
    // Response shape must stay exactly { nodes, update_version } — newlyUnlocked is internal.
    res.status(200).json({
        code: null,
        message: "OK",
        payload: { nodes: Saved.nodes, update_version: Saved.update_version }
    });
});

// [1.12.0] GET /pjm — parameterless variant of the Player Journey Map endpoint. The 1.12
// client fetches BOTH GET /pjm/:userId (works via existing route above) AND GET /pjm
// (parameterless) during login. Missing this second call caused a fatal client disconnect
// with the popup "Error reading your character's Player Journey data". Verified via
// metagame.log:
//   [10:35:17.104] INFO: Player journey map fetched for userId mystpax  ← /pjm/:userId works
//   [10:35:17.372] WARN: Unstubbed route GET /pjm                       ← /pjm 404 (fatal)
//   [10:35:17.409] Disconnect: Error reading your character's Player Journey data
// Response uses the full captured Slayer's Path graph (317 nodes, update_version=1) from
// DauntlessEndpointDocumentation/Progression/GetSlayersPath.md. An empty nodes dict would
// be well-formed but the client uses this graph for unlocks and Player Journey UI.
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

// [1.12.0] Tracked Objectives. GET returns the currently-tracked quest set for the account;
// POST updates it. Bootstrap implementation returns a well-formed empty state — not fatal
// if omitted (client falls back to local settings), but adds noise in the log and blocks
// POST migration. Full shape per:
//   DauntlessEndpointDocumentation/Progression/GetTrackedObjectives.md
//   DauntlessEndpointDocumentation/Progression/PostTrackedObjectives.md
// TODO: persist tracked_quests / tracked_craftables / current_set per account.
progressionRouter.get("/progression/tracked_objectives/:phxAccountId", HasParadoxBackendAuth, (req: any, res) => {
    const PhxAccountId = req.params.phxAccountId;
    if(!RequireProgressionRead(req, res, PhxAccountId)) return;
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
    if(!RequireProgressionRead(req, res, PhxAccountId)) return;
    logger.info(`POST tracked objectives for phx_account_id=${PhxAccountId} (bootstrap, discarding update)`);
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: null
    });
});

