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

export const tuningRouter = Router();

tuningRouter.get("/game_tuning/seasonal_event_schedule", (req: any, res) => {
    logger.info("Seasonal Event Schedule (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            ScheduledItems: []
        }
    });
})

tuningRouter.get("/game_tuning/huntpass_xp_config", (req: any, res) => {
    logger.info("Huntpass XP Config (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            EventConfigs: [],
            GlobalConfig: {
                DifficultyBias: 1.000000000000000,
                GlobalMultiplier: 1.000000000000000,
                MaxXPAwarded: 200
            }
        }
    });
});

tuningRouter.get("/game_tuning/island_content_config", (req: any, res) => {
    logger.debug("Island content config (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            DisallowedIslandContentAssets: []
        }
    });
});


tuningRouter.get("/game_tuning/bounty_game_data", (req: any, res) => {
    logger.debug("Bounty game data (stubbed)");
    res.status(200).json({
        code: null,
        message: "OK",
        payload: {
            bounty_data: [
                { bounty_id: "Bounty_Bronze_KillWithFriends", enabled: false },
                { bounty_id: "Bounty_Silver_KillWithFriends", enabled: false },
                { bounty_id: "Bounty_Gold_KillWithFriends", enabled: false }
            ],
            bounty_token_grant_hour: 0,
            bounty_token_id: "TOKEN_BOUNTY_DRAFT",
            bronze_count: 9,
            silver_count: 3,
            gold_count: 1,
            history_length: 10,
            item_grant_data: [],
            max_slots: 4,
            new_season_reset_bounties: false,
            num_draft_options: 3,
            num_spicy_options: 1,
            num_tokens_hp_start: 4,
            num_tokens_per_day: 0,
            premium_bounty_token_id: "TOKEN_BOUNTY_DRAFT_PREMIUM",
            token_rollover_warning_days: 1000
        }
    });
});

tuningRouter.get("/game_tuning/bounty_game_data_daily", (req: any, res) => {
    logger.debug("Bounty game data daily (stubbed)");
    res.status(200).json({
        code: null,
        message: "OK",
        payload: {
            automatic_claim: true,
            automatic_draft: true,
            bounty_data: [
                { bounty_id: "Challenge_Daily_Bronze_GetHuntPassXP", enabled: false }
            ],
            bounty_token_grant_hour: 0,
            bounty_token_id: "TOKEN_DAILY_CHALLENGE_DRAFT",
            bronze_count: 1,
            delete_claimed_bounties: false,
            gold_count: 0,
            history_length: 10,
            item_grant_data: [],
            max_slots: 1,
            new_season_reset_bounties: true,
            num_draft_options: 3,
            num_spicy_options: 1,
            num_tokens_hp_start: 1,
            num_tokens_per_day: 0,
            premium_bounty_token_id: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM",
            silver_count: 0,
            token_rollover_warning_days: 1000
        }
    });
});

tuningRouter.get("/game_tuning/bounty_game_data_weekly", (req: any, res) => {
    logger.debug("Bounty game data weekly (stubbed)");
    res.status(200).json({
        code: null,
        message: "OK",
        payload: {
            automatic_claim: true,
            automatic_draft: true,
            bounty_data: [
                { bounty_id: "26_11_7_Challenge_Season_BreakParts_Firesacs_Aether_Sally_Terra", enabled: false }
            ],
            item_grant_data: [],
            bounty_token_id: "TOKEN_WEEKLY_CHALLENGE_DRAFT",
            bounty_token_grant_hour: 0,
            bronze_count: 0,
            silver_count: 0,
            gold_count: 0,
            history_length: 8,
            max_slots: 4,
            num_draft_options: 3,
            num_spicy_options: 1,
            num_tokens_hp_start: 4,
            num_tokens_per_day: 0,
            new_season_reset_bounties: true,
            delete_claimed_bounties: false,
            premium_bounty_token_id: "TOKEN_WEEKLY_CHALLENGE_DRAFT_PREMIUM",
            token_rollover_warning_days: 1000
        }
    });
});
