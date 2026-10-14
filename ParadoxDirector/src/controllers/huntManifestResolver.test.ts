/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] The shared hunt manifest resolver (shared/hunt-manifest) over small synthetic tables. No game data:
// this file runs in the public CI. The real tables are checked by huntManifestParity.gamedata.test.ts.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    CreateHuntResolver,
    EvaluateTagQuery,
    GetCurrentTrialsWeek,
    HUNT_TABLE_FILES,
    LoadHuntTables,
    ParseTrialsRotationMinutes,
    TransformExpectedPlayerArgs
} from "../../../shared/hunt-manifest";

const WEEK_MS = 7 * 24 * 60 * 60_000;
const NONE_BEHEMOTH = { SpecificBehemoth: { BehemothAsset: { AssetPathName: "None" } } };
const BOSS_BEHEMOTH = { SpecificBehemoth: { BehemothAsset: { AssetPathName: "/Game/Monsters/test/boss_bp.boss_bp_C" } } };
const MAP = (asset: string) => [{ MapAssetName: asset }];

// Tag query "ANY(Hunt.Arena.Easy)" in the raw CatalogExporter shape (tokenStream / tagDictionary as strings).
const EASY_QUERY = { tokenStream: [0, 1, 1, 1, 0], tagDictionary: ["Hunt.Arena.Easy"] };

const MAIN_ROWS: Record<string, any> = {
    MM_Plain: { MapList: MAP("/Game/Maps/test/plain.plain"), GameModeOverride: "", HuntTags: [], ...NONE_BEHEMOTH },
    MM_Boss: { MapList: MAP("/Game/Maps/test/boss.boss"), GameModeOverride: "", ...BOSS_BEHEMOTH },
    CR19_MatchmakerHunt_ShatteredIsles_TrainingDojo: {
        MapList: MAP("/Game/Maps/islands/dojo/training_dojo_persistent.training_dojo_persistent"),
        GameModeOverride: "BPGM_ArchonTrainingGrounds",
        SpecificBehemoth: { BehemothAsset: { AssetPathName: "/Game/Monsters/dummy/dummy_fulgar_bp.dummy_fulgar_bp_C" } }
    },
    MatchmakerHunt_StoryMission_Linnea_01: { MapList: MAP("/Game/Maps/test/story.story"), GameModeOverride: "", ...BOSS_BEHEMOTH },
    NoMapRow: { MapList: MAP("Engine/Maps/none"), GameModeOverride: "", ...NONE_BEHEMOTH }
};

const ARENA_EASY_ROWS: Record<string, any> = {
    Arena_MatchmakerHunt_Easy_001: { HuntTags: ["Hunt.Arena.Easy"], MapList: MAP("/Game/Maps/arena/a1.a1"), GameModeOverride: "", ...NONE_BEHEMOTH },
    Arena_MatchmakerHunt_Easy_002: { HuntTags: ["Hunt.Arena.Easy.Week"], MapList: MAP("/Game/Maps/arena/a2.a2"), GameModeOverride: "", ...NONE_BEHEMOTH },
    Arena_MatchmakerHunt_Hard_001: { HuntTags: ["Hunt.Arena.Hard"], MapList: MAP("/Game/Maps/arena/h1.h1"), GameModeOverride: "", ...NONE_BEHEMOTH }
};

const PLAYER_ROWS: Record<string, any> = {
    Plain_Hunt: { MatchmakerHuntIDs: [{ RowName: "MM_Plain" }] },
    Boss_Hunt: { MatchmakerHuntIDs: [{ RowName: "MM_Boss" }] },
    Training_Hunt: { MatchmakerHuntIDs: [{ RowName: "CR19_MatchmakerHunt_ShatteredIsles_TrainingDojo" }] },
    Story_Hunt: { MatchmakerHuntIDs: [{ RowName: "MatchmakerHunt_StoryMission_Linnea_01" }] },
    Dangling_Hunt: { MatchmakerHuntIDs: [{ RowName: "NoSuchRow" }] },
    Unmapped_Hunt: { MatchmakerHuntIDs: [{ RowName: "NoMapRow" }] },
    Trials_Hunt: {
        MatchmakerHuntIDs: [],
        MatchmakerHuntsByTag: [{ MatchmakerTable: { ObjectName: "DataTable'arena_easy_matchmaker_hunts'" }, HuntTags: [EASY_QUERY] }]
    }
};

function Tables() {
    return {
        playerRows: PLAYER_ROWS,
        matchmakerRows: MAIN_ROWS,
        matchmakerSources: [
            { name: "matchmaker_hunts_table", rows: MAIN_ROWS },
            { name: "arena_easy_matchmaker_hunts", rows: ARENA_EASY_ROWS },
            { name: "arena_hard_matchmaker_hunts", rows: {} },
            { name: "arena_elite_matchmaker_hunts", rows: {} },
            { name: "arena_hard_matchmaker_hunts_new", rows: {} },
            { name: "arena_elite_matchmaker_hunts_new", rows: {} }
        ]
    };
}

// The first candidate wins every random pick; the clock is the caller's.
function Resolver(options: { now?: number; missing?: string[] } = {}) {
    return CreateHuntResolver({
        tables: Tables(),
        randomInt: (min: number) => min,
        now: () => options.now ?? 0,
        onMissingHunt: (id: string) => options.missing?.push(id)
    });
}

function Capture() {
    const warnings: string[] = [];
    const infos: string[] = [];
    return { warnings, infos, log: { info: (m: string) => infos.push(m), warn: (m: string) => warnings.push(m), error: () => {} } };
}

// [2026-10-14 M1] The tag query evaluator, token by token (layout in shared/hunt-manifest/index.js).
test("EvaluateTagQuery: ANY, ALL, NONE, nesting and prefix-aware matching", () => {
    const Any = { QueryTokenStream: [0, 1, 1, 1, 0], TagDictionary: [{ TagName: "Hunt.Arena.Easy" }] };
    assert.equal(EvaluateTagQuery(Any, ["Hunt.Arena.Easy"]), true);
    assert.equal(EvaluateTagQuery(Any, ["Hunt.Arena.Easy.Week"]), true, "a child tag satisfies its parent query");
    assert.equal(EvaluateTagQuery(Any, ["Hunt.Arena.Hard"]), false);
    assert.equal(EvaluateTagQuery(Any, ["Hunt.Arena.EasyX"]), false, "prefix matching is on whole segments");

    const All = { tokenStream: [0, 1, 2, 2, 0, 1], tagDictionary: ["A", "B"] };
    assert.equal(EvaluateTagQuery(All, ["A"]), false);
    assert.equal(EvaluateTagQuery(All, ["A", "B"]), true);

    const None = { tokenStream: [0, 1, 3, 1, 0], tagDictionary: ["Hunt.Arena.Easy"] };
    assert.equal(EvaluateTagQuery(None, ["Hunt.Arena.Hard"]), true);
    assert.equal(EvaluateTagQuery(None, ["Hunt.Arena.Easy"]), false);

    // ALL( ANY(A), NONE(B) ): expression type 5 over two nested tag expressions.
    const Nested = { tokenStream: [0, 1, 5, 2, 1, 1, 0, 3, 1, 1], tagDictionary: ["A", "B"] };
    assert.equal(EvaluateTagQuery(Nested, ["A"]), true);
    assert.equal(EvaluateTagQuery(Nested, ["A", "B"]), false);

    // No root expression, an unknown expression type, a truncated stream and a missing stream all match nothing.
    assert.equal(EvaluateTagQuery({ tokenStream: [0, 0, 1, 1, 0], tagDictionary: ["A"] }, ["A"]), false);
    assert.equal(EvaluateTagQuery({ tokenStream: [0, 1, 9, 1, 0], tagDictionary: ["A"] }, ["A"]), false);
    assert.equal(EvaluateTagQuery({ tokenStream: [0, 1, 1, 1], tagDictionary: ["A"] }, ["A"]), false);
    assert.equal(EvaluateTagQuery({}, ["A"]), false);
});

test("the trials week is the UTC rotation bucket, three digits, wrapping at 181", () => {
    assert.equal(GetCurrentTrialsWeek(0), "001");
    assert.equal(GetCurrentTrialsWeek(WEEK_MS), "002");
    assert.equal(GetCurrentTrialsWeek(WEEK_MS * 181), "001", "the bucket wraps after 181 rows");
    assert.equal(GetCurrentTrialsWeek(30 * 60_000, 30), "002", "a 30-minute interval buckets on its own length");
});

test("TRIALS_ROTATION_MINUTES: the default is one week; an invalid value warns and falls back", () => {
    const Quiet = Capture();
    assert.equal(ParseTrialsRotationMinutes(undefined, Quiet.log), 7 * 24 * 60);
    assert.equal(ParseTrialsRotationMinutes("30", Quiet.log), 30);
    assert.deepEqual(Quiet.warnings, []);
    assert.equal(ParseTrialsRotationMinutes("0", Quiet.log), 7 * 24 * 60);
    assert.equal(ParseTrialsRotationMinutes("600000", Quiet.log), 7 * 24 * 60);
    assert.equal(ParseTrialsRotationMinutes("soon", Quiet.log), 7 * 24 * 60);
    assert.equal(Quiet.warnings.length, 3);
    assert.match(Quiet.warnings[0], /invalid TRIALS_ROTATION_MINUTES='0'; using 10080/);
});

test("expected-player strings are uid:hunt pairs joined by commas", () => {
    assert.equal(TransformExpectedPlayerArgs([]), "");
    assert.equal(TransformExpectedPlayerArgs([
        { playerUid: "a", playerHuntId: "H" },
        { playerUid: "b", playerHuntId: "H" }
    ]), "a:H,b:H");
});

test("a plain manifest carries the map, the Behemoth (or NO_BEHEMOTH) and the party", () => {
    const Resolver1 = Resolver();
    assert.deepEqual(Resolver1.ResolveManifest("Plain_Hunt", ["acc-1"]), {
        huntId: "Plain_Hunt",
        matchmakerHuntId: "MM_Plain",
        mapPath: "/Game/Maps/test/plain",
        behemothPath: "NO_BEHEMOTH",
        expectedPlayerString: "acc-1:Plain_Hunt"
    });
    assert.equal(Resolver1.ResolveManifest("Boss_Hunt", ["acc-1", "acc-2"]).behemothPath, "/Game/Monsters/test/boss_bp.boss_bp_C");
    assert.equal(Resolver1.ResolveManifest("Boss_Hunt", ["acc-1", "acc-2"]).expectedPlayerString, "acc-1:Boss_Hunt,acc-2:Boss_Hunt");
});

test("an unknown or prototype-named hunt is a missing row, reported once, and never resolves to Object.prototype", () => {
    const Missing: string[] = [];
    const Resolver1 = Resolver({ missing: Missing });
    for (const id of ["No_Such_Hunt", "constructor", "__proto__"]) {
        assert.throws(() => Resolver1.ResolveManifest(id, ["acc-1"]), {
            message: `player_hunts_table has no usable row for HuntId '${id}' (missing row or empty MatchmakerHuntIDs)`
        });
    }
    assert.deepEqual(Missing, ["No_Such_Hunt", "constructor", "__proto__"]);
});

test("the manifest refuses an unresolvable row, an unmapped row and malformed expected-player lists with the Director's messages", () => {
    const Resolver1 = Resolver();
    assert.throws(() => Resolver1.ResolveManifest("Dangling_Hunt", ["acc-1"]),
        /player_hunts_table row 'Dangling_Hunt' has no resolvable 1\.12 MatchmakerHuntIDs/);
    assert.throws(() => Resolver1.ResolveManifest("Unmapped_Hunt", ["acc-1"]),
        /matchmaker_hunts_table row 'NoMapRow' has no valid \/Game\/ map asset path/);
    for (const bad of [[], ["a", "b", "c", "d", "e"], [""], ["a", 7], null, "acc-1"] as unknown[]) {
        assert.throws(() => Resolver1.ResolveManifest("Plain_Hunt", bad as string[]),
            { message: "ExpectedPlayers must contain between one and four account IDs" }, JSON.stringify(bad));
    }
});

test("a tag-routed Trials hunt takes the featured week's row, and falls back to a numbered candidate when none is featured", () => {
    const Featured = Resolver({ now: WEEK_MS });   // bucket 1 -> week 002
    assert.equal(Featured.ResolveManifest("Trials_Hunt", ["acc-1"]).matchmakerHuntId, "Arena_MatchmakerHunt_Easy_002");
    assert.equal(Featured.ResolveManifest("Trials_Hunt", ["acc-1"]).mapPath, "/Game/Maps/arena/a2");

    const Capture1 = Capture();
    const Unfeatured = CreateHuntResolver({
        tables: Tables(), randomInt: (min: number) => min, now: () => 2 * WEEK_MS, log: Capture1.log
    });                                                       // bucket 2 -> week 003, not in the table
    assert.equal(Unfeatured.MatchmakerHuntIdFor("Trials_Hunt"), "Arena_MatchmakerHunt_Easy_001");
    assert.ok(Capture1.warnings.some((line) => /no arena row matched featured week _003/.test(line)));
    assert.ok(Capture1.infos.some((line) => /Trials_Hunt resolved to 2 matchmaker row\(s\) via tag query/.test(line)));
});

test("CountResolvablePlayerHunts counts the rows that resolve, without logging each one", () => {
    const Quiet = Capture();
    const Resolver1 = CreateHuntResolver({ tables: Tables(), randomInt: (min: number) => min, log: Quiet.log });
    // Plain, Boss, Training, Story and Trials resolve; Dangling and Unmapped do not.
    assert.equal(Resolver1.CountResolvablePlayerHunts(), 5);
    assert.deepEqual(Quiet.infos, []);
    assert.deepEqual(Quiet.warnings, []);
});

test("LoadHuntTables reads the seven tables (a BOM is allowed) and refuses a missing or non-DataTable one", () => {
    const Dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-manifest-tables-"));
    try {
        const Files = [HUNT_TABLE_FILES.player, ...HUNT_TABLE_FILES.matchmakerSources.map((source) => source.file)];
        for (const File of Files) {
            const Body = JSON.stringify([{ Type: "DataTable", Rows: { [`Row_${File.replace(/\W/g, "_")}`]: {} } }]);
            fs.writeFileSync(path.join(Dir, File), File === HUNT_TABLE_FILES.player ? "﻿" + Body : Body, "utf8");
        }
        const Loaded = LoadHuntTables(Dir);
        assert.equal(Object.keys(Loaded.playerRows).length, 1);
        assert.equal(Loaded.matchmakerSources.length, 6);
        assert.equal(Loaded.matchmakerRows, Loaded.matchmakerSources[0].rows);

        fs.unlinkSync(path.join(Dir, HUNT_TABLE_FILES.matchmakerSources[2].file));
        assert.throws(() => LoadHuntTables(Dir), /Required hunt table is missing: .*arena_hard_matchmaker_hunts\.json/);

        fs.writeFileSync(path.join(Dir, HUNT_TABLE_FILES.matchmakerSources[2].file), JSON.stringify({ Rows: {} }), "utf8");
        assert.throws(() => LoadHuntTables(Dir), /is not a DataTable export/);
    } finally {
        fs.rmSync(Dir, { recursive: true, force: true });
    }
});
