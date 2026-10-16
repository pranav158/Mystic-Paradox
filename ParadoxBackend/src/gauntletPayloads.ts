/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ActiveSeasonWindow } from "./seasonWindow";

// [2026-10-16] The payloads of the Gauntlet stubs (routes/system.ts), in the shapes the 1.14.7 client parses (Ghidra: each
// FOnlineGauntletPhoenix::On*Complete result type's Serialize; the reader's slots tell the value types). Only a high-level account
// (player level 20) runs the Gauntlet flow, and the old stubs (an object everywhere, a season with no dates) sent such a player back
// to the login screen ~1 s after Ramsgate (SteamDocs/RAMSGATE_KICK_AFTER_TESTER_MAX_2026_10_16.md). Gauntlet itself stays off
// (MYSTICPARADOX_GAUNTLET): these answer "a current season, nothing earned, no access".

/** The season id the client then asks progression and rewards for. */
export const GAUNTLET_SEASON_ID = "ESC_SEASON_1";

/**
 * GET /config: {gauntlet_id: string, start_at: ISO 8601, end_at: ISO 8601} (OnGetSeasonDataComplete; start_at/end_at are FDateTime
 * read by ParseIso8601). Without the dates the season ran from year 1 to year 1, already over. The rolling 12-week window is the
 * served Hunt Pass's (seasonWindow.ts), so the season always covers the present.
 */
export function GauntletConfigPayload(nowMs: number): { gauntlet_id: string; start_at: string; end_at: string } {
    const Window = ActiveSeasonWindow(nowMs);
    return { gauntlet_id: GAUNTLET_SEASON_ID, start_at: Window.start, end_at: Window.end };
}

/**
 * GET /progression/<season>/<user>. The level-access request (GET /progression/level_access/<season>?account_id=...) is parsed by
 * OnGetLevelAccessComplete as an INTEGER payload (the level the player may access): an object failed the parse, and the client
 * forwarded an uninitialised level (11 on 16 Oct) to the hub. 0 = no access. Every other progression request is
 * {personal_progression: int32, guild_progression: int32} (OnGetProgressionComplete).
 */
export function GauntletProgressionPayload(firstSegment: string): { personal_progression: number; guild_progression: number } | number {
    return firstSegment.toLowerCase() === "level_access" ? 0 : { personal_progression: 0, guild_progression: 0 };
}

/** GET /rewards/guild/<season>/<user>: an INTEGER payload, the guild reward level (OnGetGuildRewardsLevelComplete). */
export function GauntletGuildRewardsPayload(): number {
    return 0;
}

/**
 * GET /leaderboard/get_leaderboard/...: payload is an ARRAY of {guild_name, guild_nameplate, level, remaining_sec}
 * (OnGetLeaderboardComplete; its Serialize checks the payload is a JSON array). `{entries: []}` failed the parse, and the client
 * left ~70 ms after the hub replicated the leaderboard (16 Oct). An empty board.
 * GET /rewards/personal/... keeps `{}`: its payload is an object keyed by level number, so `{}` is a valid empty map.
 */
export function GauntletLeaderboardPayload(): unknown[] {
    return [];
}
