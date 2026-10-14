/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

"use strict";

// [2026-10-14 M1] The hunt manifest lookup, shared by DeployServer (ParadoxDirector) and the Metagame (ParadoxBackend).
// For a player hunt id and its party it answers which map, Behemoth and expected-player string a server starts with.
// The logic is the Director's ParadoxDirector/src/controllers/gameservers.ts (hunt lookup, tag query, trials rotation),
// moved here so the Metagame can resolve manifests without a DeployServer. ParadoxDirector/game-data/README.md says how the
// tables are made. The player-hosted completion rule (Hunt Guard) is P2P code: it lives in p2p/, which the public export leaves out.
//
// Pure: the module reads nothing but the tables it is given (LoadHuntTables reads them from one folder). The caller
// supplies the logger, the clock and the random source, and receives every missing-hunt sighting through a callback.
// The tables are Phoenix Labs game data and are never copied into this folder.
//
// Differences from the Director's copy, all behaviour-neutral for the hunt ids the client sends:
//   - table lookups read only the table's own keys (a HuntId such as "constructor" used to find Object.prototype);
//   - the clock, the random source, the logger and the missing-hunt callback are injected.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TRIALS_ROTATION_ROW_COUNT = 181;
const DEFAULT_TRIALS_ROTATION_MINUTES = 7 * 24 * 60;
const MAX_TRIALS_ROTATION_MINUTES = 525600;

// The hunt tables by file name. The first matchmaker source is the main table and wins a row-name collision.
// The two *_new Trials tables were added in 1.14.7 (their rows are reached only through tag routing).
const HUNT_TABLE_FILES = Object.freeze({
    player: "player_hunts_table.json",
    matchmakerSources: Object.freeze([
        Object.freeze({ name: "matchmaker_hunts_table", file: "matchmaker_hunts_table.json" }),
        Object.freeze({ name: "arena_easy_matchmaker_hunts", file: "arena_easy_matchmaker_hunts.json" }),
        Object.freeze({ name: "arena_hard_matchmaker_hunts", file: "arena_hard_matchmaker_hunts.json" }),
        Object.freeze({ name: "arena_elite_matchmaker_hunts", file: "arena_elite_matchmaker_hunts.json" }),
        Object.freeze({ name: "arena_hard_matchmaker_hunts_new", file: "arena_hard_matchmaker_hunts_new.json" }),
        Object.freeze({ name: "arena_elite_matchmaker_hunts_new", file: "arena_elite_matchmaker_hunts_new.json" })
    ])
});

const NO_LOG = Object.freeze({ info() {}, warn() {}, error() {} });

function ReadTable(dataDir, fileName) {
    const filePath = path.join(dataDir, fileName);
    if (!fs.existsSync(filePath)) {
        throw new Error(`[hunt-manifest] Required hunt table is missing: ${filePath}`);
    }
    const document = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
    const rows = document?.[0]?.Rows;
    if (rows == null || typeof rows !== "object") {
        throw new Error(`[hunt-manifest] ${filePath} is not a DataTable export (no Rows)`);
    }
    return rows;
}

/** Reads every hunt table from dataDir. Throws when one is missing, as the Director always has. */
function LoadHuntTables(dataDir) {
    const playerRows = ReadTable(dataDir, HUNT_TABLE_FILES.player);
    const matchmakerSources = HUNT_TABLE_FILES.matchmakerSources.map(({ name, file }) => ({ name, rows: ReadTable(dataDir, file) }));
    return { dataDir, playerRows, matchmakerRows: matchmakerSources[0].rows, matchmakerSources };
}

/** The trials rotation interval from TRIALS_ROTATION_MINUTES; an invalid value warns and uses the default. */
function ParseTrialsRotationMinutes(value, log = NO_LOG) {
    const Parsed = Number(value ?? DEFAULT_TRIALS_ROTATION_MINUTES);
    if (!Number.isSafeInteger(Parsed) || Parsed < 1 || Parsed > MAX_TRIALS_ROTATION_MINUTES) {
        log.warn(`[TrialsRotation] invalid TRIALS_ROTATION_MINUTES='${value ?? ""}'; using ${DEFAULT_TRIALS_ROTATION_MINUTES}`);
        return DEFAULT_TRIALS_ROTATION_MINUTES;
    }
    return Parsed;
}

/** The three-digit trials row featured in the UTC bucket that contains nowMs (the DLL uses the same formula). */
function GetCurrentTrialsWeek(nowMs, rotationMinutes = DEFAULT_TRIALS_ROTATION_MINUTES) {
    const Bucket = Math.floor(nowMs / (rotationMinutes * 60_000));
    return String((Bucket % TRIALS_ROTATION_ROW_COUNT) + 1).padStart(3, "0");
}

function TransformExpectedPlayerArgs(ExpectedPlayers) {
    let ToReturn = "";

    for (const Player of ExpectedPlayers) {
        ToReturn = ToReturn + Player.playerUid + ":" + Player.playerHuntId + ",";
    }

    if (ToReturn.length > 0) {
        ToReturn = ToReturn.slice(0, -1); // Remove trailing ','
    }

    return ToReturn;
}

/*
 * Evaluates a serialized FGameplayTagQuery against a row's HuntTags.
 *
 * Token stream layout, matching UE's FQueryEvaluator::Evaluate:
 *   [0] stream version
 *   [1] bHasRootExpression (0 => query matches nothing)
 *   [2] ExprType
 *   ... type-specific payload
 *
 * ExprType: 1=AnyTagsMatch 2=AllTagsMatch 3=NoTagsMatch 4=AnyExprMatch 5=AllExprMatch 6=NoExprMatch.
 * Tag expressions emit a uint8 count then that many 0-based indices into TagDictionary; expression
 * expressions emit a count then that many nested expressions.
 *
 * Verified against the live capture: [0,1,1,1,0] with TagDictionary ["Hunt.Arena.Easy"] decodes to
 * version 0 / hasRoot 1 / AnyTagsMatch / 1 tag / index 0, which is exactly the AutoDescription the
 * game itself emitted (" ANY( Hunt.Arena.Easy )").
 *
 * Tag matching is prefix-aware, as gameplay tags are hierarchical: a row tagged
 * "Hunt.Arena.Easy.Something" satisfies a query for "Hunt.Arena.Easy".
 */
function TagMatches(RowTag, QueryTag) {
    return RowTag === QueryTag || RowTag.startsWith(`${QueryTag}.`);
}

function EvaluateTagQuery(Query, RowTags) {
    // Vendored (FModel) rows say QueryTokenStream; the raw CatalogExporter capture says tokenStream.
    const Stream = Query?.QueryTokenStream ?? Query?.queryTokenStream ?? Query?.tokenStream ?? [];
    const RawDictionary = Query?.TagDictionary ?? Query?.tagDictionary ?? [];

    // The vendored tables store dictionary entries as { TagName }, the raw export as plain strings.
    const Dictionary = RawDictionary.map((Entry) =>
        typeof Entry === "string" ? Entry : Entry?.TagName ?? "");

    if (!Array.isArray(Stream) || Stream.length < 3) return false;

    let Index = 0;
    const Next = () => Stream[Index++];

    Next();                                  // stream version — unused, single version observed
    const HasRootExpression = Next();
    if (!HasRootExpression) return false;

    let Overflowed = false;

    function EvalExpr() {
        if (Index >= Stream.length) { Overflowed = true; return false; }

        const ExprType = Next();

        // Tag-set expressions.
        if (ExprType >= 1 && ExprType <= 3) {
            const NumTags = Next();
            const Tags = [];
            for (let i = 0; i < NumTags; i++) {
                const TagIndex = Next();
                const Tag = Dictionary[TagIndex];
                if (typeof Tag === "string" && Tag.length > 0) Tags.push(Tag);
            }
            const AnyMatched = Tags.some((QueryTag) => RowTags.some((RowTag) => TagMatches(RowTag, QueryTag)));
            const AllMatched = Tags.every((QueryTag) => RowTags.some((RowTag) => TagMatches(RowTag, QueryTag)));

            if (ExprType === 1) return AnyMatched;   // AnyTagsMatch
            if (ExprType === 2) return AllMatched;   // AllTagsMatch
            return !AnyMatched;                      // NoTagsMatch
        }

        // Nested-expression expressions.
        if (ExprType >= 4 && ExprType <= 6) {
            const NumExprs = Next();
            const Results = [];
            for (let i = 0; i < NumExprs; i++) Results.push(EvalExpr());

            if (ExprType === 4) return Results.some(Boolean);    // AnyExprMatch
            if (ExprType === 5) return Results.every(Boolean);   // AllExprMatch
            return !Results.some(Boolean);                       // NoExprMatch
        }

        // Undefined/unknown expression type — refuse rather than guess.
        Overflowed = true;
        return false;
    }

    const Result = EvalExpr();
    return Overflowed ? false : Result;
}

// Only the table's own keys count: a HuntId such as "constructor" must not find Object.prototype.
function OwnRow(Rows, Key) {
    return Rows != undefined && Object.prototype.hasOwnProperty.call(Rows, Key) ? Rows[Key] : undefined;
}

/**
 * Builds the resolver over the given tables. Options:
 *   tables                  the object LoadHuntTables returns (or the same shape built in memory)
 *   log                     { info, warn, error }; defaults to silent
 *   trialsRotationMinutes   the rotation interval (ParseTrialsRotationMinutes); defaults to 7 days
 *   now                     () => epoch ms; defaults to Date.now
 *   randomInt               (min, max) => integer in [min, max); defaults to crypto.randomInt
 *   onMissingHunt           (playerHuntId) => void, called once per request for an absent player hunt row
 */
function CreateHuntResolver(options) {
    const Tables = options.tables;
    let Log = options.log ?? NO_LOG;
    const TrialsRotationMinutes = options.trialsRotationMinutes ?? DEFAULT_TRIALS_ROTATION_MINUTES;
    const Now = options.now ?? (() => Date.now());
    const RandomInt = options.randomInt ?? ((Min, Max) => crypto.randomInt(Min, Max));
    const OnMissingHunt = options.onMissingHunt ?? (() => {});

    /** Looks a matchmaker row up across every registered table. Main table wins on a name collision. */
    function FindMatchmakerRow(MatchmakerHuntId) {
        for (const Source of Tables.matchmakerSources) {
            const Row = OwnRow(Source.rows, MatchmakerHuntId);
            if (Row != undefined) return Row;
        }
        return undefined;
    }

    function GetMatchmakerTableByName(TableName) {
        return Tables.matchmakerSources.find((Source) => Source.name === TableName);
    }

    /** Resolves MatchmakerHuntsByTag into concrete matchmaker row names. */
    function ResolveTagRoutedMatchmakerHuntIds(PlayerHuntId, Row) {
        const Lists = Row?.MatchmakerHuntsByTag;
        if (!Array.isArray(Lists) || Lists.length === 0) return [];

        const Resolved = [];

        for (const List of Lists) {
            // Vendored shape nests the table name inside an ObjectName like "DataTable'arena_easy...'".
            const ObjectName = List?.MatchmakerTable?.ObjectName ?? List?.matchmakerTable ?? "";
            const TableName = ObjectName.includes("'")
                ? ObjectName.split("'")[1]
                : ObjectName;

            const Source = GetMatchmakerTableByName(TableName);
            if (Source == undefined) {
                Log.warn(`[HuntTagRouting] ${PlayerHuntId} references matchmaker table '${TableName}' which is not registered; add it to HUNT_TABLE_FILES in shared/hunt-manifest`);
                continue;
            }

            const Queries = List?.HuntTags ?? List?.queries ?? [];
            if (!Array.isArray(Queries) || Queries.length === 0) continue;

            for (const [RowName, MatchmakerRow] of Object.entries(Source.rows)) {
                const RowTags = MatchmakerRow?.HuntTags ?? [];
                if (!Array.isArray(RowTags) || RowTags.length === 0) continue;

                // A row qualifies if it satisfies every query on the list (queries are ANDed).
                if (Queries.every((Query) => EvaluateTagQuery(Query, RowTags))) Resolved.push(RowName);
            }
        }

        return Resolved;
    }

    /** The matchmaker row a player hunt starts with: a direct reference, else tag routing; random among candidates. */
    function MatchmakerHuntIdFor(PlayerHuntId) {
        const Row = OwnRow(Tables.playerRows, PlayerHuntId);

        // Only a genuinely absent row is a coverage gap. An empty MatchmakerHuntIDs is normal for
        // tag-routed hunts (Trials), which are resolved below.
        if (Row == undefined) {
            OnMissingHunt(PlayerHuntId);
            throw new Error(`player_hunts_table has no usable row for HuntId '${PlayerHuntId}' (missing row or empty MatchmakerHuntIDs)`);
        }

        const DirectMatchmakerHuntIds = Array.isArray(Row.MatchmakerHuntIDs)
            ? Row.MatchmakerHuntIDs
                .map((Entry) => Entry?.RowName)
                .filter((RowName) => typeof RowName === "string" && RowName.length > 0 && FindMatchmakerRow(RowName) != undefined)
            : [];

        // Direct references win; tag routing is the documented fallback, not a supplement.
        let UsableMatchmakerHuntIds = DirectMatchmakerHuntIds;

        let TagRouted = false;
        if (UsableMatchmakerHuntIds.length === 0) {
            UsableMatchmakerHuntIds = ResolveTagRoutedMatchmakerHuntIds(PlayerHuntId, Row);

            if (UsableMatchmakerHuntIds.length > 0) {
                TagRouted = true;
                Log.info(`[HuntTagRouting] ${PlayerHuntId} resolved to ${UsableMatchmakerHuntIds.length} matchmaker row(s) via tag query`);
            }
        }

        if (UsableMatchmakerHuntIds.length === 0) {
            throw new Error(`player_hunts_table row '${PlayerHuntId}' has no resolvable 1.12 MatchmakerHuntIDs`);
        }

        // Arena/Trials rows are tag-routed to every numbered week plus test rows. Random selection diverges
        // from the row advertised by the replicated gameplay schedule. Select the current deterministic UTC
        // bucket instead; the DLL uses the same interval/formula. Non-arena tag-routed hunts remain random.
        if (TagRouted) {
            const ArenaCandidates = UsableMatchmakerHuntIds.filter((Id) =>
                /^Arena_MatchmakerHunt_(?:Easy|Hard|Elite)_\d{3}$/.test(Id)
            );
            if (ArenaCandidates.length > 0) {
                const Week = GetCurrentTrialsWeek(Now(), TrialsRotationMinutes);
                const Pinned = ArenaCandidates.filter((Id) => Id.endsWith(`_${Week}`));
                if (Pinned.length > 0) {
                    const Chosen = Pinned[RandomInt(0, Pinned.length)];
                    Log.info(`[TrialsRotation] interval=${TrialsRotationMinutes}m featured=_${Week} -> ${Chosen}`);
                    return Chosen;
                }
                Log.warn(`[TrialsRotation] no arena row matched featured week _${Week}; falling back to a numbered arena candidate`);
                return ArenaCandidates[RandomInt(0, ArenaCandidates.length)];
            }
        }

        return UsableMatchmakerHuntIds[RandomInt(0, UsableMatchmakerHuntIds.length)];
    }

    function BehemothPathFor(MatchmakerHuntId) {
        const MatchmakerHuntObject = FindMatchmakerRow(MatchmakerHuntId);

        if (MatchmakerHuntObject == undefined) {
            throw new Error(`matchmaker_hunts_table has no row for MatchmakerHuntId '${MatchmakerHuntId}'`);
        }

        const AssetPathName = MatchmakerHuntObject?.SpecificBehemoth?.BehemothAsset?.AssetPathName;

        // Hunting Grounds generate encounters and have no single fixed Behemoth (AssetPathName === "None"):
        // pass NO MonsterClass so the server runs its normal encounter generation instead of forcing one.
        if (AssetPathName == undefined || AssetPathName === "None" || String(AssetPathName).trim().length === 0) {
            return undefined;
        }

        return AssetPathName;
    }

    function MapPathFor(MatchmakerHuntId) {
        const MatchmakerHuntObject = FindMatchmakerRow(MatchmakerHuntId);

        if (MatchmakerHuntObject == undefined || !Array.isArray(MatchmakerHuntObject.MapList) || MatchmakerHuntObject.MapList.length === 0) {
            throw new Error(`matchmaker_hunts_table row '${MatchmakerHuntId}' has no MapList`);
        }

        const UsableMaps = MatchmakerHuntObject.MapList
            .map((Entry) => Entry?.MapAssetName)
            .filter((MapAssetName) => typeof MapAssetName === "string" && MapAssetName.startsWith("/Game/") && MapAssetName.includes("."));
        if (UsableMaps.length === 0) {
            throw new Error(`matchmaker_hunts_table row '${MatchmakerHuntId}' has no valid /Game/ map asset path`);
        }
        const MapAssetName = UsableMaps[RandomInt(0, UsableMaps.length)];
        return MapAssetName.slice(0, MapAssetName.lastIndexOf("."));
    }

    /** Resolves the exact server arguments of a player hunt for these account ids, without starting anything. */
    function ResolveManifest(HuntId, ExpectedPlayers) {
        if (!Array.isArray(ExpectedPlayers) || ExpectedPlayers.length < 1 || ExpectedPlayers.length > 4 ||
            ExpectedPlayers.some((accountId) => typeof accountId !== "string" || accountId.length === 0)) {
            throw new Error("ExpectedPlayers must contain between one and four account IDs");
        }
        const MatchmakerHuntId = MatchmakerHuntIdFor(HuntId);
        const BehemothPath = BehemothPathFor(MatchmakerHuntId) ?? "NO_BEHEMOTH";
        const MapPath = MapPathFor(MatchmakerHuntId);
        const ExpectedPlayerString = TransformExpectedPlayerArgs(ExpectedPlayers.map((PlayerUid) => ({
            playerUid: PlayerUid,
            playerHuntId: HuntId
        })));
        return { huntId: HuntId, matchmakerHuntId: MatchmakerHuntId, mapPath: MapPath, behemothPath: BehemothPath, expectedPlayerString: ExpectedPlayerString };
    }

    /** How many player hunt rows resolve to a manifest (the startup count). Silent: no per-hunt log lines. */
    function CountResolvablePlayerHunts() {
        const Saved = Log;
        Log = NO_LOG;
        try {
            return Object.keys(Tables.playerRows).filter((HuntId) => {
                try {
                    ResolveManifest(HuntId, ["startup-count"]);
                    return true;
                } catch {
                    return false;
                }
            }).length;
        } finally {
            Log = Saved;
        }
    }

    return {
        tables: Tables,
        trialsRotationMinutes: TrialsRotationMinutes,
        FindMatchmakerRow,
        ResolveTagRoutedMatchmakerHuntIds,
        MatchmakerHuntIdFor,
        BehemothPathFor,
        MapPathFor,
        ResolveManifest,
        CountResolvablePlayerHunts
    };
}

module.exports = {
    HUNT_TABLE_FILES,
    DEFAULT_TRIALS_ROTATION_MINUTES,
    TRIALS_ROTATION_ROW_COUNT,
    LoadHuntTables,
    CreateHuntResolver,
    ParseTrialsRotationMinutes,
    GetCurrentTrialsWeek,
    TransformExpectedPlayerArgs,
    EvaluateTagQuery
};
