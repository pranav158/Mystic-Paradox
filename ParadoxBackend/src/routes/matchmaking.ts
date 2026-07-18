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
import { CheckAndUpdateQueueStatus, GetCandidateStatusPeriodMillis, HandlePlayerMatchmaking } from "../controllers/matchmaking";
import { GetPartyForPlayer } from "../controllers/party";

export const matchmakingRouter = Router();

const QOS_TARGET_URL = process.env.QOS_TARGET_URL;
const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;

matchmakingRouter.post("/candidate/player/register", HasParadoxBackendAuth, (req: any, res) => {
    logger.info(`userId ${req.AuthData.userId} is registering for matchmaking!`);

    res.status(200);
    res.json({});
});




matchmakingRouter.post("/candidate/player/alive", HasParadoxBackendAuth, (_req: any, res) => {
    res.status(200);
    res.json({});
});

matchmakingRouter.get("/candidate/regions", HasParadoxBackendAuth, (req: any, res) => {
    logger.info(`Querying regions for QoS`);

    res.status(200);
    res.json({
        code: 200,
        message: "success",
        payload: {
            maxPingingStepTime: 3,
            pingCount: 5,
            pingFrequency: 0.25,
            regionUrls: [
                QOS_TARGET_URL
            ]
        }
    });
});

matchmakingRouter.post("/key/generate", HasParadoxBackendAuth, async (req: any, res) => {
    res.status(400);
    res.send();
});

matchmakingRouter.get("/candidate/status", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;

    const MatchmakingResult = await CheckAndUpdateQueueStatus(UserId);

    if(MatchmakingResult != undefined){
        if(MatchmakingResult.Ready){
            logger.info(`Telling user ${UserId} to travel to ${MatchmakingResult.Host}:${MatchmakingResult.Port} candidateId=${MatchmakingResult.CandidateId} gameSessionId=${MatchmakingResult.GameSessionId}`);

            res.status(200);
            res.json({
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: GetCandidateStatusPeriodMillis(MatchmakingResult),
                gameMode: "ISLAND",
                huntId: MatchmakingResult.HuntId,
                playerStates: {
                    [UserId]: {}
                },
                serverInfo: {
                    buildId: TARGET_CHANGELIST + "_1.12.0_shipping", // TODO: pull the end of the buildstring from somewhere nonstatic
                    gameSessionId: MatchmakingResult.GameSessionId,
                    host: MatchmakingResult.Host,
                    port: MatchmakingResult.Port
                },
                status: "IN_PROGRESS",
                statusDuration: 0.0,
                statusReason: null
            });
        }
        else{
            logger.info(`MM not ready yet!`);

            res.status(200);
            res.json({
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: GetCandidateStatusPeriodMillis(MatchmakingResult),
                gameMode: "ISLAND",
                huntId: MatchmakingResult.HuntId,
                playerStates: {
                    [UserId]: {}
                },
                status : "MATCHING",
                statusDuration : 0.0,
                statusReason : null
            })
        }
    }
    else{
        logger.error(`UserId ${UserId} was not found in the MatchmakingMap`);

        res.status(404);
        res.send();
    }
});

matchmakingRouter.post("/candidate/join", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const GameMode = req.body.gameMode;
    const GameArgs = req.body.gameArgs;
    const HuntId = req.body.playerHuntId;

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    

    logger.info(`UserId ${UserId} wants to join a game with GameMode ${GameMode} & GameArgs ${GameArgs} & HuntId ${HuntId}`);

    
    
    

    
    
    
    
    
    
    
    
    const PartyForPlayer = GetPartyForPlayer(UserId);
    const PartyId = PartyForPlayer?.partyId;
    const PartyMembers = PartyForPlayer?.members;

    const MatchmakingResult = await HandlePlayerMatchmaking(GameMode, GameArgs, HuntId, UserId, PartyId, PartyMembers);

    if(!MatchmakingResult){
        res.status(400);
        res.send();
        return;
    }

    const MatchmakingEntry = await CheckAndUpdateQueueStatus(UserId);

    res.status(200);
    res.json({
        candidateId: MatchmakingEntry!.CandidateId,
        gameMode: GameMode,
        huntId: MatchmakingEntry!.HuntId,
        status: "MATCHING",
        statusReason: null
    });
});

matchmakingRouter.get("/QoS", (req, res) => {
    logger.info(`QoS Ping`);

    res.status(200);
    res.send("<!DOCTYPE html><html><body>pong</body></html>");
})
