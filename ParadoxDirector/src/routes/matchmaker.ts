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
import { logger } from "../logger";
import { HandleMatchmakingRequest } from "../controllers/matchmaker";
import express from "express";

export const matchmakingRouter = Router();

matchmakingRouter.post("/handle-matchmaking-for-player", express.json(), async (req, res) => {
    try {
        const GameMode = req.body.GameMode;
        const GameArgs = req.body.GameArgs;
        const HuntId = req.body.HuntId;
        const ExpectedPlayers = req.body.ExpectedPlayers;

        const MatchmakingResult = await HandleMatchmakingRequest(GameMode, GameArgs, HuntId, ExpectedPlayers);

        res.status(200);
        res.json(MatchmakingResult);
    } catch(Err: any) {
        
        
        logger.error(`handle-matchmaking-for-player failed: ${Err?.message ?? Err}`);
        res.status(500);
        res.json({ error: "matchmaking_failed" });
    }
});