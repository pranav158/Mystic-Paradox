/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] The Hunt Guard completion mode of a player-hosted manifest (shared/hunt-manifest/p2p), over small synthetic
// tables. The plain resolution is tested in src/controllers/huntManifestResolver.test.ts.

import assert from "node:assert/strict";
import test from "node:test";

import { CreateHuntResolver } from "../../../shared/hunt-manifest";
import { ResolvePlayerHostedManifest } from "../../../shared/hunt-manifest/p2p/completionMode";

const NONE_BEHEMOTH = { SpecificBehemoth: { BehemothAsset: { AssetPathName: "None" } } };
const BOSS_BEHEMOTH = { SpecificBehemoth: { BehemothAsset: { AssetPathName: "/Game/Monsters/test/boss_bp.boss_bp_C" } } };
const MAP = (asset: string) => [{ MapAssetName: asset }];

const MAIN_ROWS: Record<string, any> = {
    MM_Plain: { MapList: MAP("/Game/Maps/test/plain.plain"), GameModeOverride: "", ...NONE_BEHEMOTH },
    MM_Boss: { MapList: MAP("/Game/Maps/test/boss.boss"), GameModeOverride: "", ...BOSS_BEHEMOTH },
    CR19_MatchmakerHunt_ShatteredIsles_TrainingDojo: {
        MapList: MAP("/Game/Maps/islands/dojo/training_dojo_persistent.training_dojo_persistent"),
        GameModeOverride: "BPGM_ArchonTrainingGrounds",
        SpecificBehemoth: { BehemothAsset: { AssetPathName: "/Game/Monsters/dummy/dummy_fulgar_bp.dummy_fulgar_bp_C" } }
    },
    MatchmakerHunt_StoryMission_Linnea_01: { MapList: MAP("/Game/Maps/test/story.story"), GameModeOverride: "", ...BOSS_BEHEMOTH }
};

const PLAYER_ROWS: Record<string, any> = {
    Plain_Hunt: { MatchmakerHuntIDs: [{ RowName: "MM_Plain" }] },
    Boss_Hunt: { MatchmakerHuntIDs: [{ RowName: "MM_Boss" }] },
    Training_Hunt: { MatchmakerHuntIDs: [{ RowName: "CR19_MatchmakerHunt_ShatteredIsles_TrainingDojo" }] },
    Story_Hunt: { MatchmakerHuntIDs: [{ RowName: "MatchmakerHunt_StoryMission_Linnea_01" }] }
};

const RESOLVER = CreateHuntResolver({
    tables: {
        playerRows: PLAYER_ROWS,
        matchmakerRows: MAIN_ROWS,
        matchmakerSources: [{ name: "matchmaker_hunts_table", rows: MAIN_ROWS }]
    },
    randomInt: (min: number) => min,
    now: () => 0
});

test("the player-hosted manifest freezes the Hunt Guard completion mode", () => {
    const Plain = ResolvePlayerHostedManifest(RESOLVER, "Plain_Hunt", ["acc-1"]);
    assert.equal(Plain.guardCompletionMode, "END_OF_HUNT", "no fixed Behemoth: only the mode's end signal closes it");

    const Boss = ResolvePlayerHostedManifest(RESOLVER, "Boss_Hunt", ["acc-1"]);
    assert.equal(Boss.guardCompletionMode, "FIRST_DEFEAT");
    assert.equal(Boss.behemothPath, "/Game/Monsters/test/boss_bp.boss_bp_C");

    const Story = ResolvePlayerHostedManifest(RESOLVER, "Story_Hunt", ["acc-1"]);
    assert.equal(Story.guardCompletionMode, "END_OF_HUNT", "a story mission is multi-objective even with a fixed Behemoth");

    // The Training Grounds: no-reward, and launched without a forced Behemoth, while the plain manifest keeps its Behemoth.
    const Training = ResolvePlayerHostedManifest(RESOLVER, "Training_Hunt", ["acc-1"]);
    assert.equal(Training.guardCompletionMode, "NO_COMPLETION");
    assert.equal(Training.behemothPath, "NO_BEHEMOTH");
    assert.equal(RESOLVER.ResolveManifest("Training_Hunt", ["acc-1"]).behemothPath, "/Game/Monsters/dummy/dummy_fulgar_bp.dummy_fulgar_bp_C");
});
