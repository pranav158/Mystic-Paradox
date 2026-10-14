/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GetGuardCompletionMode, ResolvePlayerHostedLaunchManifest } from "./huntLaunchManifest";

test("multi-encounter manifests require an end-of-hunt finality signal", () => {
    assert.equal(ResolvePlayerHostedLaunchManifest("ShatteredIsles_IslandA", ["player-a"]).guardCompletionMode, "END_OF_HUNT");
    assert.equal(ResolvePlayerHostedLaunchManifest("CR19_PlayerHunt_Escalation_Glitter_Hard", ["player-a"]).guardCompletionMode, "END_OF_HUNT");
    assert.equal(ResolvePlayerHostedLaunchManifest("CR19_PlayerHunt_Arena_Hard", ["player-a"]).guardCompletionMode, "FIRST_DEFEAT");
});

test("the player-hosted manifest is the shared launch manifest plus the frozen Guard mode", () => {
    const Manifest = ResolvePlayerHostedLaunchManifest("ShatteredIsles_IslandA", ["player-a", "player-b"]);
    assert.equal(Manifest.huntId, "ShatteredIsles_IslandA");
    assert.equal(Manifest.expectedPlayerString, "player-a:ShatteredIsles_IslandA,player-b:ShatteredIsles_IslandA");
    assert.ok(Manifest.mapPath.startsWith("/Game/Maps/"));
});

// The 10 BPGM_ArchonStoryMissions rows of the 1.14.7 matchmaker table (2026-10-11).
const STORY_MISSION_ROWS = [
    "11A_MatchmakerHunt_StoryMission_01_Terramane",
    "11A_MatchmakerHunt_StoryMission_02_Sally_Terrogg",
    "MatchmakerHunt_Event_Dark_Harvest_01",
    "MatchmakerHunt_Event_Dark_Harvest_Hard_01",
    "MatchmakerHunt_Event_Ramsgiving_01",
    "MatchmakerHunt_Event_Ramsgiving_02",
    "MatchmakerHunt_Event_Snowball_Fight_Test_00",
    "MatchmakerHunt_Event_Anniversary_01",
    "MatchmakerHunt_Event_Anniversary_02",
    "MatchmakerHunt_StoryMission_Linnea_01"
];

test("story missions end only at EndOfHuntStarted, even if a row named a fixed Behemoth", () => {
    for (const Row of STORY_MISSION_ROWS) {
        assert.equal(GetGuardCompletionMode(Row, undefined), "END_OF_HUNT", Row);
        assert.equal(GetGuardCompletionMode(Row, "/Game/Monsters/test/test_bp.test_bp_C"), "END_OF_HUNT", Row);
    }
    assert.equal(ResolvePlayerHostedLaunchManifest("11A_PlayerHunt_StoryMission_01_Terramane", ["player-a"]).guardCompletionMode, "END_OF_HUNT");
    assert.equal(ResolvePlayerHostedLaunchManifest("PlayerHunt_StoryMission_Linnea_01", ["player-a"]).guardCompletionMode, "END_OF_HUNT");
});

test("the Training Grounds resolve to the no-reward mode and launch without a forced Behemoth", () => {
    assert.equal(GetGuardCompletionMode("CR19_MatchmakerHunt_ShatteredIsles_TrainingDojo",
        "/Game/Monsters/dummy/dummy_fulgar_bp.dummy_fulgar_bp_C"), "NO_COMPLETION");
    const Manifest = ResolvePlayerHostedLaunchManifest("ShatteredIsles_TrainingDojo", ["player-a"]);
    assert.equal(Manifest.guardCompletionMode, "NO_COMPLETION");
    assert.equal(Manifest.behemothPath, "NO_BEHEMOTH");
    assert.equal(Manifest.mapPath, "/Game/Maps/islands/dojo/training_dojo_persistent");
    assert.equal(Manifest.matchmakerHuntId, "CR19_MatchmakerHunt_ShatteredIsles_TrainingDojo");
});

test("a pursuit with a fixed Behemoth still closes at the first defeat", () => {
    assert.equal(GetGuardCompletionMode("CR19_MatchmakerHunt_Fulgar", "/Game/Monsters/fulgar/fulgar_normal_bp.fulgar_normal_bp_C"), "FIRST_DEFEAT");
});
