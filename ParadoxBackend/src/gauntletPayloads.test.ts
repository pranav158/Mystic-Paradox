/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GAUNTLET_SEASON_ID, GauntletConfigPayload, GauntletGuildRewardsPayload, GauntletLeaderboardPayload, GauntletProgressionPayload } from "./gauntletPayloads";

test("[2026-10-16] the leaderboard answer is an array (an empty board), not an object", () => {
    assert.deepEqual(GauntletLeaderboardPayload(), []);
    assert.equal(Array.isArray(GauntletLeaderboardPayload()), true);
});

// [2026-10-16] The shapes the 1.14.7 client parses; a level-20 account was sent back to the login screen by the old stubs.

test("[2026-10-16] the Gauntlet level-access answer is an integer payload (0 = no access), not an object", () => {
    assert.equal(GauntletProgressionPayload("level_access"), 0);
    assert.equal(GauntletProgressionPayload("LEVEL_ACCESS"), 0, "the route is case-insensitive, so the check is too");
});

test("[2026-10-16] a Gauntlet progression answer is {personal_progression, guild_progression}, with or without a season segment", () => {
    assert.deepEqual(GauntletProgressionPayload("ESC_SEASON_1"), { personal_progression: 0, guild_progression: 0 });
    assert.deepEqual(GauntletProgressionPayload(""), { personal_progression: 0, guild_progression: 0 });
});

test("[2026-10-16] the guild rewards answer is an integer payload", () => {
    assert.equal(GauntletGuildRewardsPayload(), 0);
});

test("[2026-10-16] the season config names the season and a current ISO 8601 window (it used to have no dates: over in year 1)", () => {
    const Now = Date.parse("2026-10-16T08:30:00Z");
    const Config = GauntletConfigPayload(Now);
    assert.equal(Config.gauntlet_id, GAUNTLET_SEASON_ID);
    assert.match(Config.start_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    assert.match(Config.end_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    assert.equal(Date.parse(Config.start_at) <= Now && Now < Date.parse(Config.end_at), true, "the window covers the present");
    assert.equal(Config.end_at, "2026-10-22T17:00:00+00:00", "the served Hunt Pass's window (the hub logged the same end)");
});
