/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { gameDataPath, tryLoadGameData } from "../gameData/loader";
import fs from "node:fs";
import {
    BuildMasteryObjectiveCheck,
    HostMasteryLimits,
    IsMasteryObjectiveIdShape,
    MasteryCardTrackFor,
    PlanMasteryReport
} from "./masteryReport";

// [2026-10-13 realms S3 limits] A player-hosted server's mastery report is checked against the exported card table
// (game-data/mastery_objectives.json: objectiveIds, cards with their track) and the rank-sum caps of progression_config.json.
// The file is optional (the grammar fallback covers its absence), so these tests skip themselves without it.

const HAVE_FILE = fs.existsSync(gameDataPath("mastery_objectives.json"));
const Data: any = HAVE_FILE ? tryLoadGameData("mastery_objectives.json") : undefined;
const Ids: string[] = Data?.objectiveIds ?? [];
const MasteryIds = Ids.filter((Id) => Id.startsWith("MasteryObjective_"));

test("the real objective list is exact: real ids pass, invented ones fail even when they look right", { skip: !HAVE_FILE }, () => {
    const Check = BuildMasteryObjectiveCheck(Data);
    assert.ok(Check !== undefined);
    assert.ok(Ids.length > 1000, `${Ids.length} ids`);
    for (const Real of [
        "MasteryObjective_Behemoth_Embermane_Kill",              // card objective
        "MasteryObjective_Behemoth_Charrogg_XP",                 // card XP-bar id: reported as an objective, so valid
        "MasteryObjective_Behemoth_Charrogg_PrestigeXP",
        "MasteryObjective_Weapon_CB_Charrogg_XP",                // chain blades code
        "MasteryObjective_Weapon_Hammer_Generic_Damage8",
    ]) {
        assert.equal(Check(Real), true, Real);
    }
    assert.ok(Ids.some((Id) => Id.startsWith("AchievementObjective_")));
    for (const Invented of [
        "MasteryObjective_Behemoth_Embermane_NotARealObjective",
        "MasteryObjective_Weapon_Axe_A_Kill",                    // a unit-test id, not a game one
        "MasteryObjective_Weapon_Zzz_Generic_Kills1",
        "AchievementObjective_Invented_Thing",
    ]) {
        assert.equal(IsMasteryObjectiveIdShape(Invented), true, `${Invented} is shaped like an id, so only the list can refuse it`);
        assert.equal(Check(Invented), false, Invented);
    }
});

test("the grammar fallback accepts every id of the real list, so a missing file never refuses a real objective", { skip: !HAVE_FILE }, () => {
    const Refused = Ids.filter((Id) => !IsMasteryObjectiveIdShape(Id));
    assert.deepEqual(Refused, []);
});

test("every mastery id of the real list maps to the track its card names (CB included), none is unmapped", { skip: !HAVE_FILE }, () => {
    assert.ok(MasteryIds.length > 1000);
    assert.deepEqual(MasteryIds.filter((Id) => MasteryCardTrackFor(Id) === null), []);
    let Checked = 0;
    for (const Card of Data.cards ?? []) {
        for (const Objective of Card.objectives ?? []) {
            Checked++;
            assert.equal(MasteryCardTrackFor(Objective.id), Card.track, Objective.id);
        }
    }
    assert.ok(Checked > 1000, `${Checked} card objectives`);
});

test("the default host limits use the real list and the rank-sum caps of the progression config", { skip: !HAVE_FILE }, () => {
    const Limits = HostMasteryLimits();
    assert.equal(Limits.isKnownObjective("MasteryObjective_Behemoth_Embermane_Kill"), true);
    assert.equal(Limits.isKnownObjective("MasteryObjective_Behemoth_Embermane_NotARealObjective"), false);
    assert.equal(Limits.isKnownObjective("MasteryObjective_Weapon_CB_Charrogg_XP"), true);

    assert.equal(Limits.trackCap?.("MasteryTrack_PlayerLevel"), 1111);
    assert.equal(Limits.trackCap?.("MasteryTrack_Behemoth"), 411);
    for (const Weapon of ["Axe", "ChainBlades", "Hammer", "Repeaters", "Spear", "Strikers", "Sword"]) {
        assert.equal(Limits.trackCap?.(`MasteryTrack_Weapon_${Weapon}`), 115, Weapon);
    }
    assert.equal(Limits.trackCap?.("ExperienceTrack_PlayerLevel"), undefined);        // only mastery tracks are capped here
    assert.equal(Limits.trackCap?.("MasteryTrack_Nonexistent"), undefined);
});

test("a host report of real objectives is applied, an invented one beside it is not", { skip: !HAVE_FILE }, () => {
    const Body = {
        progress_tracks: [{ progression_id: "MasteryTrack_PlayerLevel", progress: 2 }, { progression_id: "MasteryTrack_Weapon_ChainBlades", progress: 1 }, { progression_id: "MasteryTrack_Behemoth", progress: 1 }],
        objectives: [
            { objective_id: "MasteryObjective_Weapon_CB_Charrogg_XP", value: 1, completed_count: 1 },
            { objective_id: "MasteryObjective_Behemoth_Embermane_Kill", value: 1, completed_count: 1 },
            { objective_id: "MasteryObjective_Behemoth_Embermane_NotARealObjective", value: 1, completed_count: 1 },
        ],
    };
    const Plan = PlanMasteryReport(Body, new Map(), HostMasteryLimits());
    assert.deepEqual(Plan.newlyCompleted, ["MasteryObjective_Weapon_CB_Charrogg_XP", "MasteryObjective_Behemoth_Embermane_Kill"]);
    assert.deepEqual(Plan.credits, { MasteryTrack_PlayerLevel: 2, MasteryTrack_Weapon_ChainBlades: 1, MasteryTrack_Behemoth: 1 });
    assert.deepEqual(Plan.unmapped, []);
    assert.deepEqual(Plan.ignored, [{ objectiveId: "MasteryObjective_Behemoth_Embermane_NotARealObjective", reason: "unknown_mastery_id" }]);
});
