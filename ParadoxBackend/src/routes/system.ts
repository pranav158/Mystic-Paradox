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
import { GetEscalationProgress, SaveEscalationProgress } from "../controllers/escalationProgress";
import { GetEntitlementsForUser } from "../controllers/entitlements";
import { ACTIVE_HUNTPASS_PROGRESSION_ID } from "../controllers/progression";
import { MonitorBountyLoad, MonitorBountySave, MonitorCooldownLoad, MonitorCooldownSave, MonitorSourceOf } from "../diagnostics/economyMonitor";
import { CooldownSaveValidationError, IsAuthorizedCooldownReader, IsAuthorizedCooldownWriter } from "../cooldownState";
import { GetCooldownState, SaveCooldowns } from "../controllers/cooldowns";
import { BountyGroupCounts, BountySaveValidationError, BountyStatePayload, IsAuthorizedBountyReader, IsAuthorizedBountyWriter } from "../bountyState";
import { GetBountyState, SaveBountyState } from "../controllers/bounty";
import { EscalationSeasonProgressUpdate, IsAuthorizedEscalationReader, IsAuthorizedEscalationWriter } from "../escalationProgress";

export const systemRouter = Router();

systemRouter.get("/dauntless-status", (req, res) => {
    logger.info("Status");

    res.json({
	    "show-status": true,
	    "en": "Welcome to Mystic Paradox!",
	    "fr": "Welcome to Mystic Paradox!",
	    "it": "Welcome to Mystic Paradox!",
	    "es": "Welcome to Mystic Paradox!",
	    "de": "Welcome to Mystic Paradox!",
	    "pt": "Welcome to Mystic Paradox!",
	    "ru": "Welcome to Mystic Paradox!",
	    "ja": "Welcome to Mystic Paradox!"
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
	// [1.14.7 2026-10-03] This stub used to answer 400 with an EMPTY body, and the hub requests it
	// during player-data load (mailbox-prod.steelyard.ca/survey/config). The 1.14.7 client parses
	// every response as JSON, so a body-less error is exactly the kind of payload that produces
	// "[LogJson][Error] Json Value of type 'String' used as a 'Object'". Answer with the same empty
	// envelope the other Phoenix stubs use so the client's parse succeeds and the loader that needs
	// it can finish.
	// [1.14.7 2026-10-03] This endpoint IS the mailbox trigger config. The client's
	// "MailboxQueryTriggerSurveyEndpoint" key (0x145137AB0) points here, and the SDK gives the exact
	// struct it parses the response into:
	//     UArchonMailbox::ParsedTriggerConfig : FOnlineMailboxTriggers   (Archon_classes.hpp:22519)
	//     struct FOnlineMailboxTriggers { TArray<FOnlineMailboxTriggerData> Triggers; }
	// The client logged "JsonObjectStringToUStruct - Unable to parse json=[]" followed by
	// "Could not parse trigger config:" - i.e. it extracted nothing from the response, stringified
	// an empty array and failed to parse it as that struct. Returning the same
	// {code,message,payload} envelope every other Phoenix endpoint uses, with the Triggers array the
	// struct declares. Empty is a valid "no triggers configured" answer.
	logger.debug("Survey config (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: {
			Triggers: []
		}
	});
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

// [2026-07-21] Trials results/summary page. leaderboards-prod.steelyard.ca/trials/leaderboards/* were
// unstubbed -> 404, so the post-trial "TRIAL RESULTS" page could not load its leaderboard sections.
// We have no leaderboard backend (trial run times are not persisted), so return a well-formed, EMPTY
// leaderboard in the documented shape ({ code, message, payload }) — this stops the 404 and lets the
// results page render cleanly. Populating actual times/ranks would require persisting per-run results
// reported by the game server (future leaderboard service). Shapes per DauntlessEndpointDocumentation.
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
	// Client fetches the player's own recorded run to display between runs. We do not persist runs yet,
	// so respond OK with an empty payload (no personal best on record) rather than 404.
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

// [2026-07-30] Now serves real persisted entitlements instead of an empty stub payload.
//
// Two changes worth calling out, both grounded in the real capture
// (DauntlessEndpointDocumentation/Auth/GetEntitlements.md) rather than guessed:
//  - the response is `{entitlements: [...]}`, the shape the live service actually returned. The old
//    stub answered `{code, message, payload: []}` - a shape this endpoint was never observed to use,
//    so a client reading `entitlements` saw nothing either way. Serving the captured shape can only
//    move it from "always empty" to "correct", but it does change the wire response, so it wants a
//    live confirmation pass (see Progress/33_PLATINUM_STORE.md).
//  - elements are `{activatedDate, duration, name}` only; our grantedAt/sourceSkuId audit fields
//    stay server-side.
systemRouter.get("/entitlementsv2", HasParadoxBackendAuth, async (req: any, res) => {
	const UserId = req.AuthData?.userId ?? "INVALID";
	const Entitlements = await GetEntitlementsForUser(UserId);

	logger.debug(`Entitlements for ${UserId}: ${Entitlements.length}`);

	res.status(200);
	res.json({ entitlements: Entitlements });
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

	// [1.14.7 TEST 2026-10-03] The hub logs "[LogJson][Error] Json Value of type 'String' used as a
	// 'Object'" three times while loading player data, and this is the only response in the whole
	// backend whose entries are bare STRINGS. Testing attribution with an empty array; if the JSON
	// errors disappear, this payload is the source and the correct entry shape can then be
	// determined from the client's own parser. COHORT_TREATMENT_LEGACY=1 restores the 1.12 array.
	// MEASURED (round 13): emptying this array did NOT remove the JSON errors - they stayed at 6 -
	// so the cohorts payload is NOT their source. The 1.12 treatment is kept.
	const LegacyTreatments = (process.env.COHORT_TREATMENT_LEGACY ?? "1") === "1"
		? ["CohortTreatment.Dojo.B"]
		: [];

	res.status(200);
	res.json({
		treatments: LegacyTreatments
	});
});

// Escalation season progress.
//
// Only the GET was ever registered, so every POST from the gameserver 404'd. That is not
// harmless: the hunt server retries on a ~30s timer for the whole match and logs
//   LogPhoenixEscalation Error  FOnlineEscalationPhoenix::OnSetSeasonalEscalationComplete
//                              - OnlinePhoenix::Parse failed - Message: NotFound
//   ArchonLog        Error  UPlayerEscalationSeasonData::TryUpdateBackendData - request to
//                              persist escalation data failed
// (14 occurrences in the 2026-07-25 escalation repro, port8788_hunt.log). Escalation progress
// was being read and never written back.
//
// State is persisted in Mongo per {userId, seasonId}; it survives metagame restarts and is
// shared by every backend instance. The 1.12 SDK/Ghidra serializer confirms these five exact
// response fields (escalation_level, next_level_xp, talents_progress, unlock_progress,
// update_version).
systemRouter.get("/escalation/:escalationSeason/:userId", HasParadoxBackendAuth, async (req, res) => {
	const EscalationSeason = String(req.params.escalationSeason);
	const UserId = String(req.params.userId);
	if (!IsAuthorizedEscalationReader((req as any).AuthData, UserId)) {
		logger.warn(`Rejected cross-account escalation read actor=${(req as any).AuthData?.userId ?? "unknown"} target=${UserId}`);
		res.status(403).send();
		return;
	}

	const Stored = await GetEscalationProgress(UserId, EscalationSeason);

	logger.debug(`Escalation Configuration for season ${EscalationSeason} user ${UserId} `
		+ `(level=${Stored.escalation_level}, version=${Stored.update_version})`);

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: Stored
	});
});

systemRouter.post("/escalation/:escalationSeason/:userId", HasParadoxBackendAuth, async (req, res) => {
	const EscalationSeason = String(req.params.escalationSeason);
	const UserId = String(req.params.userId);
	if (!IsAuthorizedEscalationWriter((req as any).AuthData, UserId)) {
		logger.warn(`Rejected cross-account or player-host escalation write actor=${(req as any).AuthData?.userId ?? "unknown"} target=${UserId}`);
		res.status(403).send();
		return;
	}

	// The gameserver posts the season data it wants persisted. Take the fields we model and keep
	// the previous value for anything it omitted, so a partial write cannot wipe progress.
	const Body = (req.body ?? {}) as EscalationSeasonProgressUpdate;
	const Updated = await SaveEscalationProgress(UserId, EscalationSeason, Body);

	logger.info(`Escalation progress saved season=${EscalationSeason} user=${UserId} `
		+ `level=${Updated.escalation_level} version=${Updated.update_version}`);

	// Same envelope as the GET - OnSetSeasonalEscalationComplete parses the response, and a
	// shape it cannot read is what produced the "Parse failed" error even when the status was OK.
	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: Updated
	});
});

systemRouter.get("/eventstats/", HasParadoxBackendAuth, (req, res) => {
	logger.debug("Event stats (stubbed)");

	res.status(200);
	res.json({
		stats: []
	});
});

// [1.14.7 2026-10-03] Every hunt pass path in the captured/vendored progression config has a window that
// ended years ago (the newest pass windows are 2024-2025), and UArchonGameInstance::FindActiveHuntPassRow
// picks the active pass by date:
//     if (start < UtcNow() && UtcNow() <= end)  -> store the active row
//     else if (end < UtcNow())                  -> keep a future candidate
// With every window in the past it resolves NOTHING (measured: gameInstance+0x6d0 stays null), so the
// hunt pass component falls back to 'none', the hunt_pass_season_table lookup uses row 'None', the bounty
// component cannot get season dates, and the hub leaves the map. Only ExperienceTrack_* / Linked_Slayer_Slot_2
// cover the present in the served config - no hunt pass does.
//
// This rewrites the windows of the paths that are hunt passes (eventpass_*/d24_*/season*), which is the same
// class of fix as the bounty grant windows. Tracks are left untouched because they already cover now.
//
// [1.14.7 2026-10-08] Only the ACTIVE pass may cover the present. Widening every hunt-pass path (the 10-03
// version) made 67 passes current at once and the client settled on an old one: it showed a 2020 pass and
// requested the season10a pass/rank SKUs instead of season43's. Now the active pass (the id GET /huntpass
// serves) gets the open window, every other pass keeps its captured window clamped so it has ended (this
// includes season19's local 2099 edit), and the recent-season placeholders get a future window so their
// lookups succeed without being current.
const HUNT_PASS_WINDOW_START = "2019-01-01T00:00:00+00:00";
const ENDED_PASS_WINDOW_END = "2024-12-03T00:00:00+00:00";      // the live service's last pass cutoff

// [1.14.7 2026-10-08] The active pass gets a ROLLING 12-week window, not 2019-2099. The client builds the
// Challenges "Week N" list (each week with its challenge rows) from the active season's window, so an 80-year
// window made every bounty-board open (U) construct hundreds-to-thousands of week entries: 50-80k script calls
// per open, a multi-second freeze, and gigabytes that were never returned (the client reached 19 GB after five
// opens). Live passes ran 84 days starting Thursday 17:00 UTC (season24..26); the cycle is anchored on
// season27's real start, so the window always covers the present and never spans more than 12 weeks.
const ACTIVE_SEASON_ANCHOR_MS = Date.parse("2024-09-26T17:00:00+00:00");
const ACTIVE_SEASON_LENGTH_MS = 84 * 24 * 60 * 60 * 1000;

function IsoUtc(Ms: number): string {
    return new Date(Ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function ActiveSeasonWindow(NowMs: number): { start: string; end: string } {
    const Cycle = Math.floor((NowMs - ACTIVE_SEASON_ANCHOR_MS) / ACTIVE_SEASON_LENGTH_MS);
    const Start = ACTIVE_SEASON_ANCHOR_MS + Cycle * ACTIVE_SEASON_LENGTH_MS;
    return { start: IsoUtc(Start), end: IsoUtc(Start + ACTIVE_SEASON_LENGTH_MS) };
}
const FUTURE_PASS_WINDOW_START = "2099-01-02T00:00:00+00:00";
const FUTURE_PASS_WINDOW_END = "2099-12-31T00:00:00+00:00";

function IsHuntPassProgressionId(Id: unknown): boolean {
    if (typeof Id !== "string") return false;
    return /^(eventpass_|d24_|season)/i.test(Id);
}

export function GetServedHuntPassId(): string {
    return (process.env.GAMESERVER_HUNTPASS_ID ?? ACTIVE_HUNTPASS_PROGRESSION_ID).trim();
}

// [1.14.7 2026-10-03] MEASURED root cause of the active-hunt-pass failure. The client iterates the game's
// HuntPassSeasonDataTable (113 rows, read live from gameInstance+0x6e0): the newest rows are
// season43..season50 and those are the ones with the "enabled" byte set to 1 (the older ones are 0). For
// each enabled row it asks the cached progression config for that row's window, keyed by the season id.
// Our served config has season ids only up to the season12 era - there is NO season43..season50 - so every
// lookup fails, no row is active, the hunt pass component falls back to 'none', the season table lookup
// uses row 'None', the bounty component cannot get season dates and the hub leaves the map.
// This adds a path for each recent season, cloned from the active path. GAMESERVER_RECENT_SEASONS overrides
// the id list (comma separated).
const DEFAULT_RECENT_SEASONS = ["season43", "season44", "season45", "season46", "season47", "season48", "season49", "season50"];

export function WidenHuntPassWindows(Config: any): any {
    if ((process.env.GAMESERVER_WIDEN_HUNTPASS_WINDOWS ?? "1") === "0") return Config;
    const Paths = Config?.payload?.paths;
    if (!Array.isArray(Paths)) return Config;
    const ActiveId = GetServedHuntPassId();
    const Now = Date.now();
    let Opened = 0;
    let Ended = 0;
    for (const Path of Paths) {
        if (!Path || !IsHuntPassProgressionId(Path.progression_id)) continue;
        if (Path.progression_id === ActiveId) {
            const Window = ActiveSeasonWindow(Now);
            Path.start_date = Window.start;
            Path.end_date = Window.end;
            Opened++;
            continue;
        }
        const End = Date.parse(Path.end_date);
        if (!Number.isFinite(End) || End > Now) {
            Path.end_date = ENDED_PASS_WINDOW_END;
            const Start = Date.parse(Path.start_date);
            if (!Number.isFinite(Start) || Start >= Date.parse(ENDED_PASS_WINDOW_END)) Path.start_date = HUNT_PASS_WINDOW_START;
            Ended++;
        }
    }
    const Window = ActiveSeasonWindow(Now);
    logger.info(`Hunt pass windows: '${ActiveId}' ${Window.start}..${Window.end} (${Opened} path), ${Ended} other pass windows clamped to have ended`);
    if (Opened === 0) logger.warn(`Hunt pass windows: the active pass '${ActiveId}' is not in the progression config`);

    // Add the newest seasons the game's table exposes (see the block comment) so the window lookup for an
    // ENABLED row can succeed. They copy the active track's shape and get a future window, so they resolve
    // without competing with the active pass.
    const RecentSeasons = (process.env.GAMESERVER_RECENT_SEASONS ?? DEFAULT_RECENT_SEASONS.join(","))
        .split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const Template = Paths.find((P: any) => P?.progression_id === ActiveId)
        ?? Paths.find((P: any) => P && typeof P.progression_id === "string" && /^season/i.test(P.progression_id));
    if (Template) {
        const Existing = new Set(Paths.map((P: any) => P?.progression_id));
        const Added: string[] = [];
        for (const SeasonId of RecentSeasons) {
            if (Existing.has(SeasonId)) continue;
            const Clone = JSON.parse(JSON.stringify(Template));
            Clone.progression_id = SeasonId;
            Clone.start_date = FUTURE_PASS_WINDOW_START;
            Clone.end_date = FUTURE_PASS_WINDOW_END;
            Paths.push(Clone);
            Added.push(SeasonId);
        }
        if (Added.length > 0) {
            logger.info(`Progression config: added ${Added.length} recent season paths with future windows (${Added.join(", ")})`);
        }
    } else {
        logger.warn("Progression config: no season template found; recent seasons not added");
    }

    return Config;
}

systemRouter.get("/progression/config", HasParadoxBackendAuth, (req, res) => {
	logger.info("Progression Config (stubbed)");

	res.status(200);
	res.json(WidenHuntPassWindows(JSON.parse(JSON.stringify(progressionconfig))));
});

// [1.14.7 2026-10-03] GET /config on the Gauntlet host.
//
// The 1.14.7 client asks gauntlet-prod.steelyard.ca/config while loading player data:
//   [LogOnline][Error] QueryTriggerConfig failed:
//   [LogPhoenixGauntlet][Error] FOnlineGauntletPhoenix::OnGetSeasonDataComplete - OnlinePhoenix::Parse failed - Message: NotFound
// There was no route for it, so it returned 404 and the Gauntlet/season loader never completed -
// which fails the whole player-data aggregation (UArchonLoadManager::LoadFailed at +66s) and then
// the map reload ("LoadMap: failed to Listen"), leaving the hub no longer listening.
// The archived 1.12 Metagame logs contain no gauntlet requests at all, so this is a 1.14.7-only
// contract. Stubbed here with the same envelope the other Phoenix stubs use; the exact 1.14.7
// payload shape is being probed against the client's own parser log.
systemRouter.get("/config", HasParadoxBackendAuth, (req: any, res, next) => {
    const originHost = String(req.originHost ?? "");
    if (!originHost.includes("gauntlet")) {
        next();
        return;
    }
    logger.info(`Gauntlet config requested by ${originHost} (1.14.7 stub)`);
    // [1.14.7 PROBE 2026-10-03] Ghidra has NO function defined anywhere in the Gauntlet module
    // (0x140DD59AF / 0x140DF2649 are inside .text but unanalyzed), so its parser cannot be
    // decompiled for a field list the way the character parser was. Probing instead with the
    // sibling contract this backend already serves successfully - the Escalation payload fields
    // (escalation_level, next_level_xp, talents_progress, unlock_progress, update_version) - plus
    // the gauntlet_id field the client itself references (0x14512EEC0). The client's own parse log
    // is the oracle: any change in its message tells us whether this endpoint is the one it wants.
    const ProbePayload = (process.env.GAUNTLET_CONFIG_PROBE ?? "1") === "1"
        ? {
            gauntlet_id: "ESC_SEASON_1",
            escalation_level: 0,
            next_level_xp: 0,
            talents_progress: [],
            unlock_progress: [],
            update_version: 0
        }
        : {};
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: ProbePayload
    });
});

// [1.14.7 2026-10-03] Gauntlet (seasonal mode) endpoint family.
//
// The 1.14.7 client requests these on gauntlet-prod.steelyard.ca while loading player data and
// each one previously 404'd, so every FOnlineGauntletPhoenix completion logged
// "OnlinePhoenix::Parse failed - Message: NotFound" and the Gauntlet/season loader never
// completed - which fails the whole player-data aggregation and then the map reload:
//   GET /config                              -> served by the stub above
//   GET /progression/{season}/{userId}       -> OnGetProgressionComplete
//   GET /rewards/personal/{season}/{userId}  -> OnGetPersonalLevelComplete
//   GET /rewards/guild/{season}/{userId}     -> OnGetGuildRewardsLevelComplete
//   GET /leaderboard/get_leaderboard/...     -> OnGetLeaderboardComplete
// The archived 1.12 Metagame logs contain no gauntlet requests, so there is no 1.12 shape to
// copy. These stubs return the same envelope every other Phoenix stub uses; the client's own
// parser log is the oracle for refining the payloads. Every handler passes through with next()
// for any other origin host, so no existing route is shadowed.
const GauntletEnvelope = (payload: Record<string, unknown>) => ({
    code: null,
    message: "OK",
    payload
});

function IsGauntletOrigin(req: any): boolean {
    return String(req.originHost ?? "").includes("gauntlet");
}

// NOTE: the client requests these with an EMPTY season segment ("/progression//INVALID"), so
// named ":season" parameters never match (Express params are non-empty). Regex routes are used so
// the empty segment is accepted - that is the whole reason the first attempt still 404'd. They are case-insensitive
// ("i") like Express's string routes, so an upper-case path still meets HasParadoxBackendAuth here.
systemRouter.get(/^\/progression\/([^/]*)\/([^/]+)$/i, HasParadoxBackendAuth, (req: any, res, next) => {
    if (!IsGauntletOrigin(req)) { next(); return; }
    logger.info(`Gauntlet progression requested season='${req.params[0]}' user='${req.params[1]}' (1.14.7 stub)`);
    res.status(200).json(GauntletEnvelope({}));
});

systemRouter.get(/^\/rewards\/personal\/([^/]*)\/([^/]+)$/i, HasParadoxBackendAuth, (req: any, res, next) => {
    if (!IsGauntletOrigin(req)) { next(); return; }
    logger.info(`Gauntlet personal rewards requested season='${req.params[0]}' user='${req.params[1]}' (1.14.7 stub)`);
    res.status(200).json(GauntletEnvelope({}));
});

systemRouter.get(/^\/rewards\/guild\/([^/]*)\/([^/]+)$/i, HasParadoxBackendAuth, (req: any, res, next) => {
    if (!IsGauntletOrigin(req)) { next(); return; }
    logger.info(`Gauntlet guild rewards requested season='${req.params[0]}' user='${req.params[1]}' (1.14.7 stub)`);
    res.status(200).json(GauntletEnvelope({}));
});

// NOTE: Express 5 (path-to-regexp v6+) rejects a bare "*" route; use an explicit regex so this
// keeps working regardless of the path that follows.
systemRouter.get(/^\/leaderboard\/get_leaderboard\//i, HasParadoxBackendAuth, (req: any, res, next) => {
    if (!IsGauntletOrigin(req)) { next(); return; }
    logger.info(`Gauntlet leaderboard requested (1.14.7 stub)`);
    res.status(200).json(GauntletEnvelope({ entries: [] }));
});

systemRouter.get("/huntpass/:userId", HasParadoxBackendAuth, (req: any, res) => {
	// [1.14.7 2026-10-03] This was the ONLY route in the backend returning a scalar payload
	// ("payload": "season19") while every other Phoenix response carries an object - exactly the
	// shape that makes a client log "[LogJson][Error] Json Value of type 'String' used as a
	// 'Object'". HuntPassComponent is also one of the six loaders that never complete on 1.14.7.
	// The season id belongs INSIDE an object; the exact 1.14.7 field set is still being determined
	// from the client's parser, so this returns the same empty envelope as the other stubs.
	logger.info("Huntpass (stubbed)");

	// [1.14.7 2026-10-03] The client parses this response with huntpass_id (verified: FUN_141dbd260
	// reads "huntpass_id" - string 0x1454FA8B8 - alongside "main_screen" and the states
	// huntpass_preview/selected/active/purchase). This route used to return "season" instead, so the
	// client's season id stayed EMPTY, and the hub then logged:
	//   [LogDataTable][Warning] UDataTable::FindRow : '' requested invalid row 'None'
	//       from DataTable '/Game/Gameplay/hunt_pass/hunt_pass_season_table...'
	//   [bounty_bpc] UBountyComponent::ServerInitializeBounties() - failed to get season dates for player
	//   -> Disconnect Error Message -> LeavingMap
	// The id must also exist as a row of the HuntPassSeasonDataTable (113 rows on 1.14.7, only season43..50
	// enabled). The row name in the warning is the oracle for whether this id is accepted.
	// [1.14.7 2026-10-08] Defaults to the active pass (season43) so the client, the XP grants and the
	// prestige earn gate all name the same track; GAMESERVER_HUNTPASS_ID still overrides.
	const HuntPassId = GetServedHuntPassId();

	logger.info(`Huntpass (stubbed) -> huntpass_id=${HuntPassId}`);

	res.status(200);
	res.json({
        code: null,
        message: "OK",
        payload: {
            huntpass_id: HuntPassId,
            season: HuntPassId
        }
    });
});

// [2026-10-10] Per-account cooldowns, persisted in Mongo (src/cooldownState.ts). These were stubs: the GET answered an
// empty payload and the PUT discarded every save, so the daily bounty's and the patrol bonus's once-per-period gates
// never found their cooldown and fired on every arrival (38_ section 19.7). MYSTICPARADOX_COOLDOWN_PERSISTENCE=off
// restores the stubs.
const COOLDOWN_PERSISTENCE = !/^(0|false|off|no)$/i.test(process.env.MYSTICPARADOX_COOLDOWN_PERSISTENCE ?? "");
const COOLDOWN_NO_PLAYER = "INVALID";

systemRouter.get("/cooldown/:userId", HasParadoxBackendAuth, async (req: any, res) => {
	const UserId = String(req.params.userId);
	if (!IsAuthorizedCooldownReader(req.AuthData, UserId)) {
		logger.warn(`Rejected cross-account cooldown read actor=${req.AuthData?.userId ?? "unknown"} target=${UserId}`);
		res.status(403).send();
		return;
	}
	if (!COOLDOWN_PERSISTENCE || UserId === COOLDOWN_NO_PLAYER) {
		MonitorCooldownLoad(UserId, MonitorSourceOf(req.AuthData), [], COOLDOWN_PERSISTENCE ? "no-player sentinel" : "persistence off (stub)");
		res.status(200).json({ code: null, message: "OK", payload: {} });
		return;
	}
	const { payload, list, record } = await GetCooldownState(UserId);
	MonitorCooldownLoad(UserId, MonitorSourceOf(req.AuthData), list, `stored version=${record?.updateVersion ?? 0}, served as an id->date map`);
	res.status(200).json({ code: null, message: "OK", payload });
});

systemRouter.put("/cooldown/batch/:userId", HasParadoxBackendAuth, async (req: any, res) => {
	const UserId = String(req.params.userId);
	if (!IsAuthorizedCooldownWriter(req.AuthData)) {
		logger.warn(`Rejected cooldown write without gameserver authority actor=${req.AuthData?.userId ?? "unknown"} target=${UserId}`);
		res.status(403).send();
		return;
	}
	if (!COOLDOWN_PERSISTENCE || UserId === COOLDOWN_NO_PLAYER) {
		MonitorCooldownSave(UserId, MonitorSourceOf(req.AuthData), req.body, COOLDOWN_PERSISTENCE ? "no-player sentinel, not stored" : "persistence off (stub), not stored");
		res.status(200).json({ code: null, message: "OK", payload: {} });
		return;
	}
	try {
		const { payload, record } = await SaveCooldowns(UserId, req.body);
		MonitorCooldownSave(UserId, MonitorSourceOf(req.AuthData), req.body, `stored -> ${record.entries.length} cooldown(s) version=${record.updateVersion}`);
		res.status(200).json({ code: null, message: "OK", payload });
	}
	catch (Err) {
		if (Err instanceof CooldownSaveValidationError) {
			MonitorCooldownSave(UserId, MonitorSourceOf(req.AuthData), req.body, `REJECTED ${Err.message}`);
			res.status(400).json({ code: null, message: "Bad Request", payload: {} });
			return;
		}
		throw Err;
	}
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

// [2026-10-10] Per-account bounty state, persisted in Mongo (src/bountyState.ts has the wire shape and merge rules).
// These routes were stubs that discarded every save, so each arrival re-seeded the season challenges at progress 0
// and auto-drafted the daily bounty again (38_ section 19.4). The GET also masks /bounty/game-data above only for the
// literal id "game-data", which is registered first. MYSTICPARADOX_BOUNTY_PERSISTENCE=off restores the stubs.
const BOUNTY_PERSISTENCE = !/^(0|false|off|no)$/i.test(process.env.MYSTICPARADOX_BOUNTY_PERSISTENCE ?? "");
const BOUNTY_NO_PLAYER = "INVALID";

systemRouter.get("/bounty/:userId", HasParadoxBackendAuth, async (req: any, res) => {
	const UserId = String(req.params.userId);
	if (!IsAuthorizedBountyReader(req.AuthData, UserId)) {
		logger.warn(`Rejected cross-account bounty read actor=${req.AuthData?.userId ?? "unknown"} target=${UserId}`);
		res.status(403).send();
		return;
	}
	if (!BOUNTY_PERSISTENCE || UserId === BOUNTY_NO_PLAYER) {
		MonitorBountyLoad(UserId, MonitorSourceOf(req.AuthData), BOUNTY_PERSISTENCE ? "no-player sentinel" : "persistence off (stub)");
		res.status(200).json({ code: null, message: "OK", payload: BountyStatePayload(undefined) });
		return;
	}

	const { payload, record } = await GetBountyState(UserId);
	MonitorBountyLoad(UserId, MonitorSourceOf(req.AuthData), `stored ${JSON.stringify(BountyGroupCounts(record))} version=${record?.updateVersion ?? 0}`);
	res.status(200).json({ code: null, message: "OK", payload });
});

systemRouter.post("/bounty/:userId", HasParadoxBackendAuth, async (req: any, res) => {
	const UserId = String(req.params.userId);
	if (!IsAuthorizedBountyWriter(req.AuthData)) {
		logger.warn(`Rejected bounty write without gameserver authority actor=${req.AuthData?.userId ?? "unknown"} target=${UserId}`);
		res.status(403).send();
		return;
	}
	if (!BOUNTY_PERSISTENCE || UserId === BOUNTY_NO_PLAYER) {
		MonitorBountySave(UserId, MonitorSourceOf(req.AuthData), req.body, BOUNTY_PERSISTENCE ? "no-player sentinel, not stored" : "persistence off (stub), not stored");
		res.status(200).json({ code: null, message: "OK", payload: BountyStatePayload(undefined) });
		return;
	}

	try {
		const { payload, record, summary } = await SaveBountyState(UserId, req.body);
		MonitorBountySave(UserId, MonitorSourceOf(req.AuthData), req.body,
			`stored ${summary.mode}${summary.group ? `:${summary.group}` : ""} incoming=${summary.incoming} removed=${summary.removed}`
			+ ` -> ${JSON.stringify(BountyGroupCounts(record))} version=${record.updateVersion}`);
		// The same envelope as the GET (the full merged state), as the live service answered a save.
		res.status(200).json({ code: null, message: "OK", payload });
	}
	catch (Err) {
		if (Err instanceof BountySaveValidationError) {
			MonitorBountySave(UserId, MonitorSourceOf(req.AuthData), req.body, `REJECTED ${Err.message}`);
			res.status(400).json({ code: null, message: "Bad Request", payload: {} });
			return;
		}
		throw Err;
	}
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


// [1.12.0] mailbox-prod.steelyard.ca/patchnotes/{lang}/{version} - client warns (parse NotFound) without this.
// The login screen shows title + description in its preview box and `notes` behind "Read More" (same shape as
// the live 1.14.7 capture, DauntlessEndpointDocumentation/Mailbox/Patchnotes.md). The client's "Update
// <release_version>" line is collapsed by the runtime (LoginBranding in dllmain.cpp), so no version is served.
systemRouter.get("/patchnotes/:language/:gameversion", (req, res) => {
	logger.info(`Patch notes ${req.params.language}/${req.params.gameversion}`);

	res.status(200).json({
		code: null,
		message: "OK",
		payload: {
			date: "2026-10-08T00:00:00.000+00:00",
			description: "Welcome, Slayer! The Shattered Isles are calling again. Gather your party in Ramsgate and return to the hunt.",
			language: req.params.language ?? "en",
			notes: [
				{
					sections: [
						{
							description: "Mystic Paradox is a community project that keeps Dauntless alive. Your Slayer, gear and loadouts are kept on Mystic Paradox servers, so you can pick up right where you left off.",
							title: "The hunt continues",
							type: "featured"
						},
						{
							changes: [
								{
									list: [
										"Press **PLAY!** to travel to **Ramsgate**, the heart of the Shattered Isles",
										"Visit the **Training Grounds** to try out weapons and omnicells before you head out",
										"Pick a hunt, form a party and bring down your first **Behemoth**"
									]
								}
							],
							title: "Getting started",
							type: "default"
						}
					],
					title: "Welcome to Mystic Paradox",
					type: "new_to_dauntless"
				},
				{
					sections: [
						{
							changes: [
								{
									list: [
										"Mystic Paradox is still growing, so you may run into the odd bug",
										"If something goes wrong, tell the Mystic Paradox team what you were doing and roughly when it happened",
										"Thank you for hunting with us!"
									]
								}
							],
							title: "Help and feedback",
							type: "default"
						}
					],
					title: "Community",
					type: "quality_of_life"
				}
			],
			permalink: "/patch-notes/mysticparadox/",
			release_version: "",
			title: "Mystic Paradox"
		}
	});
});
