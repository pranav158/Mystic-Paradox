/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AuditHuntLaunchCoverage, ResolveHuntLaunchManifest, ValidateHuntTableData } from "./gameservers";
import { loadGameData } from "../gameData/loader";

const PlayerHuntTable = loadGameData<any>("player_hunts_table.json");

const LEGACY_UNRESOLVED_EXPEDITIONS = [
    "CR19_PlayerHunt_Expedition_Island02",
    "CR19_PlayerHunt_Expedition_Island03",
    "CR19_PlayerHunt_Expedition_Island04",
    "CR19_PlayerHunt_Expedition_Island05",
    "CR19_PlayerHunt_Expedition_Island06",
    "CR19_PlayerHunt_Expedition_Island07",
    "CR19_PlayerHunt_Expedition_Island08"
];

test("all current launch-table destinations are audited and stale rows are explicit", () => {
    const Coverage = AuditHuntLaunchCoverage();
    // 1.14.7 import: 161 exported rows + 7 older vendored rows the 1.14.7 export no longer contains.
    assert.equal(Coverage.totalPlayerHunts, 168);
    assert.equal(Coverage.resolvablePlayerHunts, 161);
    assert.deepEqual(Coverage.unresolvedPlayerHunts, LEGACY_UNRESOLVED_EXPEDITIONS);
    // 572 without the 1.14.7 arena_{hard,elite}_matchmaker_hunts_new tables (22 rows each).
    assert.ok(Coverage.referencedMatchmakerRows >= 600, "Trials auxiliary rows, including the 1.14.7 _new tables, must be included");
    assert.ok(Coverage.uniqueMapAssets.length >= 39, "all mapped gameplay destinations must be visible");
    assert.ok(Coverage.gameModeOverrides.includes("(map/default)"));
    assert.deepEqual(Coverage.maxPlayerValues, [4, 12]);
});

test("representative map and mode families freeze valid launch manifests", () => {
    for (const HuntId of [
        "ShatteredIsles_IslandA",
        "ShatteredIsles_IslandU",
        "CR19_PlayerHunt_Escalation_Glitter_Hard",
        "CR19_PlayerHunt_Arena_Hard",
        "11A_PlayerHunt_StoryMission_01_Terramane"
    ]) {
        const Manifest = ResolveHuntLaunchManifest(HuntId, ["player-a", "player-b"]);
        assert.equal(Manifest.huntId, HuntId);
        assert.ok(Manifest.mapPath.startsWith("/Game/Maps/"));
        assert.ok(Manifest.matchmakerHuntId.length > 0);
        assert.equal(Manifest.expectedPlayerString, `player-a:${HuntId},player-b:${HuntId}`);
    }
});


test("MatchmakingGameType is stored by name, never as a version-ambiguous number", () => {
    // 1.14.7 inserted Gauntlet = 9 and moved FTUE 9 -> 10, so a bare number means different things per build.
    for (const [RowName, Row] of Object.entries(PlayerHuntTable[0].Rows as Record<string, any>)) {
        if (Row.MatchmakingGameType === undefined) continue;
        assert.match(String(Row.MatchmakingGameType), /^EMatchmakingGameType::[A-Za-z]+$/, RowName);
    }
});

test("table consistency audit remains clean", () => {
    const Result = ValidateHuntTableData();
    assert.deepEqual(Result.problems, []);
});
