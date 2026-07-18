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
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { loadGameData } from "../gameData/loader";
const progressionconfig = loadGameData<any>("progression_config.json");

export const systemRouter = Router();

systemRouter.get("/dauntless-status", (req, res) => {
    logger.info("Status");

    res.json({
	    "show-status": true,
	    "en": "Welcome to Mystic Paradox v0.0.3!",
	    "fr": "Welcome to Mystic Paradox v0.0.3!",
	    "it": "Welcome to Mystic Paradox v0.0.3!",
	    "es": "Welcome to Mystic Paradox v0.0.3!",
	    "de": "Welcome to Mystic Paradox v0.0.3!",
	    "pt": "Welcome to Mystic Paradox v0.0.3!",
	    "ru": "Welcome to Mystic Paradox v0.0.3!",
	    "ja": "Welcome to Mystic Paradox v0.0.3!"
    });
});

systemRouter.post("/heartbeat", (req, res) => {
    res.status(200).type("text/plain").send("20000");
});

systemRouter.post("/event", (req, res) => {
    res.status(200);
    res.json({});
});

systemRouter.get("/crash/CrashReporter/Ping", (req, res) => {
	logger.debug("Crash reporter ping (stubbed)");

	res.status(200);
	res.type("text/plain");
	res.send("OK");
});

systemRouter.post("/crash/CrashReporter/CheckReport", (req, res) => {
	logger.debug("Crash reporter check report (stubbed)");

	res.status(200);
	res.json({});
});

systemRouter.get("/survey/config", HasParadoxBackendAuth, (req, res) => {
	logger.debug("Survey config (stubbed)");

	res.status(400);
	res.send();
});

systemRouter.post("/account/migrate", HasParadoxBackendAuth, (req, res) => {
	logger.info("Account migration (stubbed)");

	res.status(200);
	res.json({
		migration_failed: false,
		migration_finished: true
	});
});

systemRouter.post("/profile/update", HasParadoxBackendAuth, (req, res) => {
	logger.info("Leaderboard update profile (stubbed)");

	res.status(200);
	res.send();
});







systemRouter.post("/trials/leaderboards/all", HasParadoxBackendAuth, (req, res) => {
	const body = (req.body ?? {}) as { difficulty?: number; page?: number; page_size?: number; trial_id?: string };
	const difficulty = body.difficulty ?? 1;
	logger.info(`Trials leaderboard all (stubbed empty) trial_id=${body.trial_id ?? ""} difficulty=${difficulty}`);

	res.status(200).json({
		code: null,
		message: "OK",
		payload: {
			difficulty,
			guild: {},
			page: body.page ?? 0,
			page_size: body.page_size ?? 100,
			trial_id: body.trial_id ?? "",
			world: {
				group: { difficulty, entries: [] },
				solo: { all: { difficulty, entries: [] } }
			}
		}
	});
});

systemRouter.post("/trials/leaderboards/solo/individual", HasParadoxBackendAuth, (req, res) => {
	
	
	logger.info("Trials leaderboard solo/individual (stubbed - no persisted run)");

	res.status(200).json({
		code: null,
		message: "OK",
		payload: {}
	});
});

systemRouter.get("/vivox/login", HasParadoxBackendAuth, (req, res) => {
	logger.info("Vivox login (stubbed)");

	res.status(404);
	res.send();
});

systemRouter.post("/motd/", HasParadoxBackendAuth, (req, res) => {
	logger.info("MOTD (stubbed)");

	res.status(204);
	res.send();
});

systemRouter.get("/entitlementsv2", HasParadoxBackendAuth, (req, res) => {
	logger.debug("Entitlements (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: []
	});
});

systemRouter.post("/entitlementv2/:userId", HasParadoxBackendAuth, (req, res) => {
	logger.debug("Entitlements (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: []
	});
});

systemRouter.get(["/playertreatments", "/playertreatments/", "/playertreatments/:userId"], HasParadoxBackendAuth, (req, res) => {
	logger.debug("Cohorts (stubbed)");

	res.status(200);
	res.json({
		treatments: [
			"CohortTreatment.Dojo.B"
		]
	});
});

systemRouter.get("/escalation/:escalationSeason/:userId", HasParadoxBackendAuth, (req, res) => {
	const EscalationSeason = req.params.escalationSeason;

	logger.debug(`Escalation Configuration for season ${EscalationSeason} (stubbed)`);

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: {
        	escalation_level: 0,
        	next_level_xp: 0,
        	talents_progress: [],
        	unlock_progress: [],
        	update_version: 0,
      	}
	});
});

systemRouter.get("/eventstats/", HasParadoxBackendAuth, (req, res) => {
	logger.debug("Event stats (stubbed)");

	res.status(200);
	res.json({
		stats: []
	});
});

systemRouter.get("/progression/config", HasParadoxBackendAuth, (req, res) => {
	logger.info("Progression Config (stubbed)");

	res.status(200);
	res.json(progressionconfig);
});

systemRouter.get("/huntpass/:userId", HasParadoxBackendAuth, (req: any, res) => {
	logger.info("Huntpass (stubbed)");

	res.status(200);
	res.json({
        code: null,
        message: "OK",
        payload: "season19"
    });
});



systemRouter.get("/cooldown/:userId", HasParadoxBackendAuth, (req: any, res) => {
	logger.debug("Cooldowns (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: {

		}
	});
});

systemRouter.put("/cooldown/batch/:userId", HasParadoxBackendAuth, (req: any, res) => {
	logger.info("Add Cooldowns (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: {

		}
	});
});

systemRouter.get("/bounty/game-data", HasParadoxBackendAuth, (req: any, res) => {
	logger.info("Bounty game data (stubbed)");

	res.status(200);
	res.json({
    code: null,
    message: "OK",
    payload: {
      max_slots: 4,
      num_draft_options: 3,
      num_spicy_options: 1,
      bounty_token_id: "TOKEN_BOUNTY_DRAFT",
      premium_bounty_token_id: "TOKEN_BOUNTY_DRAFT_PREMIUM",
      num_tokens_hp_start: 4,
      num_tokens_per_day: 0,
      bounty_token_grant_hour: 0,
      history_length: 10,
      bronze_count: 9,
      silver_count: 3,
      gold_count: 1,
      new_season_reset_bounties: false,
      bounty_data: [],
      item_grant_data: [],
      token_rollover_warning_days: 1000,
      automatic_draft: false,
      automatic_claim: false,
      delete_claimed_bounties: false,
    },
  });
});

systemRouter.get("/bounty/:userId", HasParadoxBackendAuth, (req: any, res) => { // TODO: This masks /bounty/game-data Right now they seem to have compatible schema, but I could be wrong about that.
	logger.info("Bounties (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: {
			season_start_date: "2020-08-23T00:00:00.000Z",
			season_end_date: "2099-01-01T00:00:00.000Z",
			bounties: [],
			draft_data: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			},
			draft_data_daily: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			},
			draft_data_weekly: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			}
		}
	})
});

systemRouter.post("/bounty/:userId", HasParadoxBackendAuth, (req: any, res) => { // TODO: This masks /bounty/game-data Right now they seem to have compatible schema, but I could be wrong about that.
	logger.info("Set Bounties (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: {
			season_start_date: "2020-08-23T00:00:00.000Z",
			season_end_date: "2099-01-01T00:00:00.000Z",
			bounties: [],
			draft_data: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			},
			draft_data_daily: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			},
			draft_data_weekly: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			}
		}
	})
});

systemRouter.get("/all/", HasParadoxBackendAuth, (req: any, res) => {
	logger.info("Mailbox (stubbed)");

	res.json({
		code: null,
		message: "OK",
		payload: {
			messages: []
		}
	});
});



systemRouter.get("/patchnotes/:language/:gameversion", (req, res) => {
	logger.info(`Patch notes ${req.params.language}/${req.params.gameversion} (stubbed)`);

	res.status(200).json({
		code: null,
		message: "OK",
		payload: {
			date: "2024-12-19T18:00:00.000+00:00",
			description: "Welcome to Mystic Paradox!",
			language: req.params.language ?? "en",
			notes: [],
			permalink: "/patch-notes/mysticparadox/",
			release_version: "1.12.0",
			title: "Mystic Paradox"
		}
	});
});
