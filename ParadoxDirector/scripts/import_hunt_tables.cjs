#!/usr/bin/env node
/*
 * import_hunt_tables.cjs — merge a live CatalogExporter EXPORT_HUNTS capture into the vendored hunt tables.
 *
 * WHY
 * ---
 * game-data/{player_hunts_table,matchmaker_hunts_table}.json started as a pre-1.12 FModel snapshot. It
 * stopped at ShatteredIsles_IslandR, so every request for IslandS/T/U died in
 * GetMatchmakerHuntIdFromPlayerHuntId with "no usable row for HuntId". This script closes such gaps
 * from the read-only capture produced by CatalogExporter EXPORT_HUNTS=1 (Items_Analysis/hunts_<ver>/).
 *
 * WHAT DEPLOYSERVER ACTUALLY CONSUMES (verified in src/controllers/gameservers.ts) — the whole
 * reason this importer can be small and strict:
 *   1. PlayerHuntRow.MatchmakerHuntIDs[].RowName          -> GetMatchmakerHuntIdFromPlayerHuntId
 *   2. PlayerHuntRow.MatchmakerHuntsByTag                 -> ResolveTagRoutedMatchmakerHuntIds (Trials):
 *                                                            MatchmakerTable.ObjectName names the vendored
 *                                                            table, HuntTags[] are serialized tag queries
 *   3. MatchmakerRow.MapList[].MapAssetName               -> GetMapPathFromMatchmakerHuntId,
 *                                                            which REQUIRES startsWith("/Game/")
 *   4. MatchmakerRow.SpecificBehemoth.BehemothAsset.AssetPathName
 *                                                        -> GetBehemothPathFromMatchmakerHuntId,
 *                                                            where "None" legitimately means
 *                                                            "generated encounter, pass no
 *                                                             MonsterClass"
 *   5. MatchmakerRow.GameModeOverride / GameModeSpecificData / MaxPlayers -> Guard completion mode, audit
 * Everything else is carried through for fidelity but is not load-bearing. DeployServer never reads
 * MatchmakingType or MatchmakingGameType, nor any schedule table.
 *
 * VERSIONS AND ENUMS
 * ------------------
 * The exporter writes raw enum numbers, and the export folder's hunt_export_manifest.json names the
 * game version. Numbers are decoded with that version's enum table (SDK/Archon_structs.hpp vs
 * SDK_1.12.0_backup/Archon_structs.hpp). Only EMatchmakingGameType moved: 1.14.7 inserted
 * Gauntlet = 9 and pushed FTUE from 9 to 10. A bare number is therefore ambiguous across versions, so
 * MatchmakingGameType is always written as the UE name ("EMatchmakingGameType::Gauntlet"), the same
 * form the FModel snapshot uses for its enums. EMatchmakingType, EHuntBiome and EGatherableTier are
 * identical in both versions and keep the representation the target row already uses (snapshot rows:
 * "EMatchmakingType::Open"; previously imported rows: numbers). An enum number the version's table
 * does not know is a hard error, never passed through.
 *
 * SAFETY POSTURE
 * --------------
 * - DRY RUN BY DEFAULT. Nothing is written without --apply. The dry run reports, per table, the rows
 *   that would be added, the rows whose exported fields differ (and which fields), and vendored rows
 *   the export no longer contains (those are reported and kept, never deleted).
 * - Refuses to import a matchmaker row whose map path is not a /Game/ path. This is not pedantry:
 *   an early capture read the map soft-pointer with .Get(), which returns null for unloaded
 *   assets, and produced 869/869 empty paths; a later one used FName::ToString(), which strips
 *   everything before the last '/'. Both would have written rows that resolve fine here and then
 *   throw at launch. Bad rows are reported and block --apply, never silently degraded.
 * - Additive by default: existing rows are left alone unless --update-existing is passed.
 * - --update-existing MERGES, it does not replace. Only fields the export carries are compared, with
 *   enum/number/handle-aware equality; equal values keep their existing representation, so a row that
 *   did not change is not rewritten. Fields the exporter cannot read (FText names/descriptions,
 *   Unlock/AltUnlock, progress arrays, map atmospheres and gatherables, AdditionalBehemoths, the
 *   snapshot's real ObjectPaths) are preserved. Exported fields a row lacks are inserted next to their
 *   neighbours. Changed rows get a provenance marker (_importedFrom / _updatedFrom).
 * - New rows are inserted in export order next to their neighbours; existing order is untouched.
 * - Output keeps the vendored formatting (2-space JSON, LF, no trailing newline), so diffs stay small.
 * - Timestamped backups of every file it rewrites.
 *
 * USAGE
 *   node scripts/import_hunt_tables.cjs                          # dry run against Items_Analysis/hunts_1_14_7
 *   node scripts/import_hunt_tables.cjs --export hunts_1_12      # another capture (or HUNT_EXPORT_DIR=...);
 *                                                                #   a path, a folder under Items_Analysis, or "1.12"
 *   node scripts/import_hunt_tables.cjs --apply                  # add missing rows / new tables
 *   node scripts/import_hunt_tables.cjs --apply --update-existing
 *   --verbose                                                    # list every changed field of every row
 *
 * A matchmaker table that has no vendored file yet (e.g. arena_hard_matchmaker_hunts_new in 1.14.7) is
 * written as game-data/<table>.json in the same shape as the arena files. DeployServer only sees it
 * once it is imported and registered in MatchmakerTableSources (src/controllers/gameservers.ts).
 */

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------------------------
// Arguments.

const Argv = process.argv.slice(2);
const Args = new Set(Argv);
const APPLY = Args.has("--apply");
const UPDATE_EXISTING = Args.has("--update-existing");
const VERBOSE = Args.has("--verbose");

function OptionValue(Name){
    const Inline = Argv.find((Arg) => Arg.startsWith(`${Name}=`));
    if(Inline != undefined) return Inline.slice(Name.length + 1);
    const At = Argv.indexOf(Name);
    return At >= 0 ? Argv[At + 1] : undefined;
}

const RepoRoot = path.resolve(__dirname, "../..");
const ItemsAnalysisDir = path.join(RepoRoot, "Items_Analysis");
const DEFAULT_EXPORT = "hunts_1_14_7";

/** Accepts an absolute/relative path, a folder name under Items_Analysis, or a bare version ("1.12"). */
function ResolveExportDir(Value){
    if(path.isAbsolute(Value)) return Value;
    const Candidates = [
        path.resolve(process.cwd(), Value),
        path.join(ItemsAnalysisDir, Value),
        path.join(ItemsAnalysisDir, `hunts_${Value.replace(/\./g, "_")}`)
    ];
    return Candidates.find((Candidate) => fs.existsSync(Candidate)) ?? Candidates[1];
}

const ExportDir = ResolveExportDir(OptionValue("--export") ?? process.env.HUNT_EXPORT_DIR ?? DEFAULT_EXPORT);

const VendorDir = process.env.PARADOX_GAME_DATA_DIR ? path.resolve(process.env.PARADOX_GAME_DATA_DIR) : path.resolve(__dirname, "../game-data");
const MAIN_PLAYER_TABLE = "player_hunts_table";
const MAIN_MATCHMAKER_TABLE = "matchmaker_hunts_table";

/** Every vendored file is game-data/<table>.json. */
function VendorPath(TableName){
    return path.join(VendorDir, `${TableName}.json`);
}

// ---------------------------------------------------------------------------------------------
// Enums. Values are index-ordered, copied from the SDK dumps of each build.

const ENUMS = {
    // Only enum that moved between 1.12.0 and 1.14.7: Gauntlet was inserted at 9, FTUE moved 9 -> 10.
    MatchmakingGameType: {
        Prefix: "EMatchmakingGameType",
        AlwaysName: true,
        ByVersion: {
            "1.12.0": ["None", "LegacyHunt", "City", "HuntingGround", "Escalation", "Trial", "TrainingGround", "Mission", "Event", "FTUE"],
            "1.14.7": ["None", "LegacyHunt", "City", "HuntingGround", "Escalation", "Trial", "TrainingGround", "Mission", "Event", "Gauntlet", "FTUE"]
        }
    },
    MatchmakingType: { Prefix: "EMatchmakingType", Values: ["Reserved", "Open", "City"] },
    Biome: { Prefix: "EHuntBiome", Values: ["Moss", "Ice", "Arid"] },
    GatherableTier: { Prefix: "EGatherableTier", Values: ["Tier0", "Tier1", "Tier2", "Tier3", "Tier4"] }
};

const SUPPORTED_VERSIONS = Object.keys(ENUMS.MatchmakingGameType.ByVersion);

const EnumOf = (Field) => Object.hasOwn(ENUMS, Field) ? ENUMS[Field] : undefined;

/**
 * Enum value -> bare name ("Gauntlet"). A raw number is decoded with that version's table; an
 * "EFoo::Bar" string is already version-independent. undefined if the value is not a known member.
 */
function EnumName(Field, Value, Version){
    const Enum = EnumOf(Field);
    if(typeof Value === "string"){
        const Name = Value.includes("::") ? Value.slice(Value.lastIndexOf("::") + 2) : Value;
        const Known = Enum.Values ?? Object.values(Enum.ByVersion).flat();
        return Known.includes(Name) ? Name : undefined;
    }
    if(typeof Value === "number") return (Enum.Values ?? Enum.ByVersion[Version])?.[Value];
    return undefined;
}

/** Version recorded in a row's provenance marker. Snapshot rows predate 1.12 and carry no numeric game types. */
function RowVersion(Row){
    const Marker = Row?._importedFrom ?? Row?._updatedFrom ?? "";
    const Match = /EXPORT_HUNTS (\d+\.\d+\.\d+)/.exec(Marker);
    return Match ? Match[1] : "1.12.0";
}

// ---------------------------------------------------------------------------------------------
// Export reading.

function ReadJsonl(FileName){
    const FullPath = path.join(ExportDir, FileName);
    if(!fs.existsSync(FullPath)) return undefined;

    return fs.readFileSync(FullPath, "utf8")
        .replace(/^﻿/, "")
        .trim()
        .split("\n")
        .filter((Line) => Line.trim().length > 0)
        .map((Line) => JSON.parse(Line));
}

function ReadJson(FullPath){
    return JSON.parse(fs.readFileSync(FullPath, "utf8").replace(/^﻿/, ""));
}

// ---------------------------------------------------------------------------------------------
// Export shape -> vendored shape.

/**
 * DataTable ObjectPaths are not exported (the capture only records table names) and DeployServer never
 * reads them. Reuse the real path wherever the original snapshot recorded one; otherwise fall back to
 * the hunts folder, as earlier imports did.
 */
const KnownObjectPaths = new Map();

function IndexObjectPaths(Value){
    if(Value == undefined || typeof Value !== "object") return;
    if(Array.isArray(Value)){ for(const Item of Value) IndexObjectPaths(Item); return; }
    const Table = TableFromObjectName(Value.ObjectName);
    if(Table != undefined && typeof Value.ObjectPath === "string" && !KnownObjectPaths.has(Table)){
        KnownObjectPaths.set(Table, Value.ObjectPath);
    }
    for(const Child of Object.values(Value)) IndexObjectPaths(Child);
}

function TableFromObjectName(ObjectName){
    const Match = /^DataTable'(.*)'$/.exec(typeof ObjectName === "string" ? ObjectName : "");
    return Match ? Match[1] : undefined;
}

function TableRef(TableName){
    return {
        ObjectName: `DataTable'${TableName}'`,
        ObjectPath: KnownObjectPaths.get(TableName) ?? `Archon/Content/Gameplay/hunts/${TableName}.0`
    };
}

/** UE-style row handle, matching the shape already present in the vendored tables. */
function Handle(TableName, RowName){
    if(!RowName || RowName === "None"){
        return { DataTable: null, RowName: "None" };
    }
    return { DataTable: TableRef(TableName), RowName };
}

function HandleFromExport(Exported){
    if(Exported == undefined) return { DataTable: null, RowName: "None" };
    return Handle(Exported.table, Exported.rowName);
}

/** Collects problems found while converting; any entry blocks --apply. */
const ConversionProblems = [];

function EncodeEnum(Field, RowName, Value){
    const Enum = EnumOf(Field);
    const Name = EnumName(Field, Value, ExportVersion);
    if(Name == undefined){
        ConversionProblems.push(`${RowName}: ${Field}=${JSON.stringify(Value)} is not a ${Enum.Prefix} value in ${ExportVersion}`);
        return Value;
    }
    // Version-sensitive enums are written by name; stable ones keep the importer's numeric form.
    return Enum.AlwaysName ? `${Enum.Prefix}::${Name}` : Value;
}

/** Export tag-routing list -> the FModel shape the snapshot uses (and EvaluateTagQuery reads). */
function ToVendorTagRoutedList(List){
    const TableName = List?.matchmakerTable ?? "";
    return {
        MatchmakerTable: TableName.length > 0 ? TableRef(TableName) : null,
        HuntTags: (List?.queries ?? []).map((Query) => ({
            TokenStreamVersion: Query.tokenStreamVersion ?? 0,
            TagDictionary: (Query.tagDictionary ?? []).map((TagName) => ({ TagName })),
            QueryTokenStream: Query.tokenStream ?? [],
            UserDescription: Query.userDescription ?? "",
            AutoDescription: Query.autoDescription ?? ""
        }))
    };
}

function ToVendorPlayerRow(Row){
    return {
        // Display text is absent by design: the exporter cannot read FText safely (it is a
        // shared-ref to FTextData, and reading it faults). DeployServer never reads these.
        HuntName: { CultureInvariantString: "" },
        HuntDescription: { CultureInvariantString: "" },
        Region: HandleFromExport(Row.region),
        MatchmakerHuntIDs: (Row.matchmakerHuntIDs ?? []).map((Entry) => HandleFromExport(Entry)),
        MatchmakerHuntsByTag: (Row.matchmakerHuntsByTag ?? []).map(ToVendorTagRoutedList),
        MatchmakingType: EncodeEnum("MatchmakingType", Row.rowName, Row.matchmakingType),
        MatchmakingGameType: EncodeEnum("MatchmakingGameType", Row.rowName, Row.matchmakingGameType),
        HuntTags: Row.huntTags ?? [],
        EscalationModeSpecification: HandleFromExport(Row.escalationModeSpecification),
        EscalationPatrolInitialChallengeLevel: Row.escalationPatrolInitialChallengeLevel,
        EscalationPatrolMaxChallengeLevel: Row.escalationPatrolMaxChallengeLevel,
        RecommendedEscalationLevel: Row.recommendedEscalationLevel,
        bHasPortals: Row.hasPortals,
        bHasGlitterEvent: Row.hasGlitterEvent,
        bHasPhaelanxEvent: Row.hasPhaelanxEvent,
        HuntSuccessReward: Row.huntSuccessReward,
        FirstCompletionSuccessReward: Row.firstCompletionSuccessReward,
        TargetedHuntSuccessReward: Row.targetedHuntSuccessReward,
        HuntFailureReward: Row.huntFailureReward,
        TargetedHuntFailureReward: Row.targetedHuntFailureReward,
        MinWeaponSkillLevel: Row.minWeaponSkillLevel,
        RecomendedWeaponSkillLevel: Row.recommendedWeaponSkillLevel,
        IsVisibleWhileLocked: Row.visibleWhileLocked,
        // Provenance marker so a future reader can tell imported rows from the original snapshot.
        _importedFrom: ProvenanceMarker
    };
}

function ToVendorMapEntry(Map, RowName){
    // mapAssetPath is the authoritative /Game/ path read from the soft pointer. mapAssetName is an
    // authored FString that 1.12 leaves empty, kept only as a fallback for older captures.
    const AssetPath = (Map.mapAssetPath && Map.mapAssetPath.length > 0)
        ? Map.mapAssetPath
        : (Map.mapAssetName ?? "");

    return {
        MapName: Map.mapName ?? "",
        MapAssetName: AssetPath,
        Biome: EncodeEnum("Biome", RowName, Map.biome),
        Weighting: Map.weighting
    };
}

function ToVendorBehemoth(Behemoth){
    return {
        BehemothName: Behemoth.behemothName ?? "",
        BehemothAsset: {
            // "None" is meaningful, not missing: GetBehemothPathFromMatchmakerHuntId treats it
            // as "generated encounter, pass no MonsterClass".
            AssetPathName: (Behemoth.behemothAssetPath && Behemoth.behemothAssetPath.length > 0)
                ? Behemoth.behemothAssetPath
                : "None",
            SubPathString: ""
        },
        PowerOverride: Behemoth.powerOverride,
        Weighting: Behemoth.weighting
    };
}

function ToVendorMatchmakerRow(Row){
    return {
        Region: HandleFromExport(Row.region),
        HuntTags: Row.huntTags ?? [],
        HuntThreatLevel: Row.huntThreatLevel,
        GameModeOverride: Row.gameModeOverride ?? "",
        DangerPerSecOverride: Row.dangerPerSecOverride,
        SpecificBehemoth: ToVendorBehemoth(Row.specificBehemoth ?? {}),
        AdditionalBehemoths: [],
        AdditionalSpecificBehemoths: (Row.additionalSpecificBehemoths ?? []).map(ToVendorBehemoth),
        MapMetaData: HandleFromExport(Row.mapMetaData),
        MapList: (Row.mapList ?? []).map((Map) => ToVendorMapEntry(Map, Row.rowName)),
        Modifiers: Row.modifiers ?? [],
        GatherableTier: EncodeEnum("GatherableTier", Row.rowName, Row.gatherableTier),
        MaxPlayers: Row.maxPlayers,
        bIsGeneratedEncounter: Row.isGeneratedEncounter,
        GameModeSpecificData: HandleFromExport(Row.gameModeSpecificData),
        _importedFrom: ProvenanceMarker
    };
}

// ---------------------------------------------------------------------------------------------
// Merge. Compares only what the export carries; keeps the existing representation when equal.

/** Fields the converter emits as placeholders because the exporter cannot read them. Never merged. */
const UNEXPORTED_FIELDS = new Set(["HuntName", "HuntDescription", "AdditionalBehemoths"]);
const PROVENANCE_FIELDS = new Set(["_importedFrom", "_updatedFrom"]);

/**
 * FName-typed fields (per the SDK row structs). FName equality is case-insensitive in UE, and the
 * exporter prints whichever casing the running process's name table registered first
 * ("hm_combustion" vs "HM_COMBUSTION"), so a case-only difference is not a data change and must not
 * churn the vendored row. The existing casing is kept, which also keeps vendored row keys and the
 * handles that point at them in agreement.
 */
const FNAME_FIELDS = new Set([
    "RowName", "HuntTags", "TagName", "Modifiers", "AssetPathName",
    "HuntSuccessReward", "FirstCompletionSuccessReward", "TargetedHuntSuccessReward",
    "HuntFailureReward", "TargetedHuntFailureReward"
]);

const IsObject = (Value) => Value != undefined && typeof Value === "object" && !Array.isArray(Value);
const IsHandle = (Value) => IsObject(Value) && "RowName" in Value && "DataTable" in Value;
const IsObjectRef = (Value) => IsObject(Value) && "ObjectName" in Value && "ObjectPath" in Value;

function HandleKey(Value){
    if(!Value.RowName || Value.RowName === "None") return "None";
    return `${TableFromObjectName(Value.DataTable?.ObjectName) ?? "?"}/${Value.RowName}`.toLowerCase();
}

/** Semantic equality of an existing vendored value (A) and an incoming converted value (B). */
function Same(A, B, Field, Ctx){
    if(EnumOf(Field) != undefined){
        const Left = EnumName(Field, A, Ctx.ExistingVersion);
        return Left != undefined && Left === EnumName(Field, B, ExportVersion);
    }
    if(A === B) return true;
    if(typeof A === "string" && typeof B === "string" && FNAME_FIELDS.has(Field)){
        return A.toLowerCase() === B.toLowerCase();
    }
    if(typeof A === "number" && typeof B === "number"){
        // The exporter prints floats with %f (6 decimals); the snapshot holds full-precision floats.
        return Math.abs(A - B) <= 1e-6 * Math.max(1, Math.abs(A), Math.abs(B));
    }
    if(A == undefined || B == undefined) return A == B;
    if(Array.isArray(A) || Array.isArray(B)){
        return Array.isArray(A) && Array.isArray(B) && A.length === B.length &&
            A.every((Item, Index) => Same(Item, B[Index], Field, Ctx));
    }
    if(IsObject(A) && IsObject(B)){
        if(IsHandle(A) || IsHandle(B)) return IsHandle(A) && IsHandle(B) && HandleKey(A) === HandleKey(B);
        if(IsObjectRef(A) || IsObjectRef(B)) return A.ObjectName === B.ObjectName;
        // Only the incoming (exported) keys are compared: extra snapshot keys are preserved data.
        return Object.keys(B).every((Key) =>
            B[Key] === undefined || UNEXPORTED_FIELDS.has(Key) || (Key in A && Same(A[Key], B[Key], Key, Ctx)));
    }
    return false;
}

/** Stable identity for array elements, so a changed element merges into its predecessor. */
function Identity(Value){
    if(!IsObject(Value)) return undefined;
    // A map is its package: "/Game/.../escalation_island_umbral_00.escalation_island_00" and
    // "...umbral_00.escalation_island_umbral_00" are the same map, and merging (rather than
    // replacing) keeps the snapshot's atmospheres and gatherable distributions.
    if(typeof Value.MapAssetName === "string"){
        const Dot = Value.MapAssetName.lastIndexOf(".");
        return `map:${(Dot > 0 ? Value.MapAssetName.slice(0, Dot) : Value.MapAssetName).toLowerCase()}`;
    }
    if(IsObject(Value.BehemothAsset)) return `behemoth:${String(Value.BehemothAsset.AssetPathName).toLowerCase()}`;
    if(IsObject(Value.MatchmakerTable)) return `table:${Value.MatchmakerTable.ObjectName}`;
    return undefined;
}

/**
 * Inserts NewKey into Keys after its nearest predecessor in ReferenceOrder that is already present
 * (or before its nearest present successor), so additions land next to their neighbours.
 */
function OrderedInsert(Keys, NewKey, ReferenceOrder){
    const RefIndex = ReferenceOrder.indexOf(NewKey);
    if(RefIndex >= 0){
        const Positions = new Map(Keys.map((Key, Index) => [Key, Index]));
        for(let i = RefIndex - 1; i >= 0; i--){
            const At = Positions.get(ReferenceOrder[i]);
            if(At != undefined){ Keys.splice(At + 1, 0, NewKey); return; }
        }
        for(let i = RefIndex + 1; i < ReferenceOrder.length; i++){
            const At = Positions.get(ReferenceOrder[i]);
            if(At != undefined){ Keys.splice(At, 0, NewKey); return; }
        }
    }
    // Never land after the provenance marker.
    const Marker = Keys.findIndex((Key) => PROVENANCE_FIELDS.has(Key));
    if(Marker >= 0) Keys.splice(Marker, 0, NewKey);
    else Keys.push(NewKey);
}

function Rebuild(Keys, Values){
    const Out = {};
    for(const Key of Keys) Out[Key] = Values[Key];
    return Out;
}

/** Merges an incoming value into an existing one that is known to differ. */
function Merge(A, B, Field, Ctx){
    const Enum = EnumOf(Field);
    if(Enum != undefined){
        // Version-sensitive enums are always rewritten by name; stable ones keep the row's style.
        if(Enum.AlwaysName || typeof A !== "string") return B;
        return `${Enum.Prefix}::${EnumName(Field, B, ExportVersion)}`;
    }
    if(IsHandle(A) && IsHandle(B)){
        // Same table: keep the snapshot's real DataTable reference, change only the row.
        if(HandleKey(A) !== "None" && HandleKey(B) !== "None" && A.DataTable?.ObjectName === B.DataTable?.ObjectName){
            return { ...A, RowName: B.RowName };
        }
        return B;
    }
    if(Array.isArray(A) && Array.isArray(B)){
        const Pool = [...A];
        return B.map((Item) => {
            let At = Pool.findIndex((Existing) => Same(Existing, Item, Field, Ctx));
            if(At >= 0) return Pool.splice(At, 1)[0];
            const Id = Identity(Item);
            At = Id == undefined ? -1 : Pool.findIndex((Existing) => Identity(Existing) === Id);
            if(At >= 0) return Merge(Pool.splice(At, 1)[0], Item, Field, Ctx);
            return Item;
        });
    }
    if(IsObject(A) && IsObject(B) && !IsHandle(A) && !IsHandle(B) && !IsObjectRef(B)){
        const Keys = Object.keys(A);
        const Values = { ...A };
        const Order = Object.keys(B);
        for(const [Key, Value] of Object.entries(B)){
            if(Value === undefined || UNEXPORTED_FIELDS.has(Key)) continue;
            if(!(Key in A)){ Values[Key] = Value; OrderedInsert(Keys, Key, Order); continue; }
            if(!Same(A[Key], Value, Key, Ctx)) Values[Key] = Merge(A[Key], Value, Key, Ctx);
        }
        return Rebuild(Keys, Values);
    }
    return B;
}

/** Row-level merge. Returns the merged row and the list of top-level field changes. */
function MergeRow(Existing, Incoming){
    const Ctx = { ExistingVersion: RowVersion(Existing) };
    const Keys = Object.keys(Existing);
    const Values = { ...Existing };
    const Order = Object.keys(Incoming);
    const Changes = [];

    for(const [Key, Value] of Object.entries(Incoming)){
        if(Value === undefined || UNEXPORTED_FIELDS.has(Key) || PROVENANCE_FIELDS.has(Key)) continue;

        if(!(Key in Existing)){
            Values[Key] = Value;
            OrderedInsert(Keys, Key, Order);
            Changes.push(`+${Key}`);
            continue;
        }

        if(Same(Existing[Key], Value, Key, Ctx)){
            // Equal meaning, but a bare MatchmakingGameType number is version-ambiguous: name it.
            if(EnumOf(Key)?.AlwaysName && Existing[Key] !== Value){
                Values[Key] = Value;
                Changes.push(`${Key}(number->name)`);
            }
            continue;
        }

        Values[Key] = Merge(Existing[Key], Value, Key, Ctx);
        Changes.push(Key);
    }

    if(Changes.length > 0){
        if("_importedFrom" in Existing) Values._importedFrom = ProvenanceMarker;
        else {
            if(!("_updatedFrom" in Existing)) Keys.push("_updatedFrom");
            Values._updatedFrom = ProvenanceMarker;
        }
    }

    return { Row: Rebuild(Keys, Values), Changes };
}

// ---------------------------------------------------------------------------------------------

/** The gate that makes this importer safe to run against a half-broken capture. */
function ValidateMatchmakerRow(RowName, Row){
    const Maps = Row.mapList ?? [];
    if(Maps.length === 0) return `${RowName}: no mapList`;

    const Usable = Maps
        .map((Map) => (Map.mapAssetPath && Map.mapAssetPath.length > 0) ? Map.mapAssetPath : Map.mapAssetName)
        .filter((Value) => typeof Value === "string" && Value.startsWith("/Game/"));

    if(Usable.length === 0){
        const Sample = Maps[0]?.mapAssetPath || Maps[0]?.mapAssetName || "(empty)";
        return `${RowName}: no /Game/ map path (got "${Sample}")`;
    }
    return undefined;
}

function Backup(FilePath){
    const Stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const Target = `${FilePath}.${Stamp}.bak`;
    fs.copyFileSync(FilePath, Target);
    return path.basename(Target);
}

function Summarise(Names, Limit = 12){
    if(Names.length === 0) return "";
    const Shown = Names.slice(0, Limit).join(", ");
    return ` -> ${Shown}${Names.length > Limit ? `, ...(+${Names.length - Limit})` : ""}`;
}

function MergeTable(TableName, ExportedRows, Converter, Validator){
    const TablePath = VendorPath(TableName);
    const IsNewFile = !fs.existsSync(TablePath);
    // New tables use the arena files' shape.
    const Table = IsNewFile ? [{ Name: TableName, Type: "DataTable", Rows: {} }] : ReadJson(TablePath);
    const ExistingRows = Table[0].Rows;
    const BeforeCount = Object.keys(ExistingRows).length;

    const Added = [];
    const Updated = [];      // [RowName, Changes[]] — written only with --update-existing
    const Rejected = [];
    let Unchanged = 0;

    const RowKeys = Object.keys(ExistingRows);
    const RowValues = { ...ExistingRows };
    const ExportOrder = ExportedRows.map((Row) => Row.rowName);
    const Exported = new Set(ExportOrder);

    for(const Row of ExportedRows){
        const RowName = Row.rowName;

        if(Validator != undefined){
            const Problem = Validator(RowName, Row);
            if(Problem != undefined){ Rejected.push(Problem); continue; }
        }

        const Incoming = Converter(Row);

        if(!(RowName in ExistingRows)){
            RowValues[RowName] = Incoming;
            OrderedInsert(RowKeys, RowName, ExportOrder);
            Added.push(RowName);
            continue;
        }

        const Merged = MergeRow(ExistingRows[RowName], Incoming);
        if(Merged.Changes.length === 0){ Unchanged++; continue; }

        Updated.push([RowName, Merged.Changes]);
        if(UPDATE_EXISTING) RowValues[RowName] = Merged.Row;
    }

    const VendorOnly = RowKeys.filter((RowName) => !Exported.has(RowName));

    // Vendor-only rows keep their content, but a bare MatchmakingGameType number is still
    // version-ambiguous: decode it with the version in the row's own provenance marker (which is
    // left as is, since the row did not come from this export).
    const Normalised = [];
    for(const RowName of VendorOnly){
        const Row = RowValues[RowName];
        if(typeof Row?.MatchmakingGameType !== "number") continue;
        const Name = EnumName("MatchmakingGameType", Row.MatchmakingGameType, RowVersion(Row));
        if(Name == undefined){
            ConversionProblems.push(`${RowName}: vendored MatchmakingGameType=${Row.MatchmakingGameType} does not decode for ${RowVersion(Row)}`);
            continue;
        }
        Normalised.push(RowName);
        if(UPDATE_EXISTING) RowValues[RowName] = { ...Row, MatchmakingGameType: `${ENUMS.MatchmakingGameType.Prefix}::${Name}` };
    }

    Table[0].Rows = Rebuild(RowKeys, RowValues);
    const WillChange = Added.length > 0 || (UPDATE_EXISTING && (Updated.length > 0 || Normalised.length > 0));

    const FieldCounts = new Map();
    for(const [, Changes] of Updated) for(const Change of Changes) FieldCounts.set(Change, (FieldCounts.get(Change) ?? 0) + 1);
    const FieldSummary = [...FieldCounts.entries()].sort((A, B) => B[1] - A[1]).map(([Field, Count]) => `${Field} x${Count}`).join(", ");

    console.log(`\n=== ${TableName}${IsNewFile ? "  (NEW vendor file)" : ""} ===`);
    console.log(`  vendored rows   : ${BeforeCount}`);
    console.log(`  export rows     : ${ExportedRows.length}`);
    console.log(`  added           : ${Added.length}${Summarise(Added)}`);
    console.log(`  changed         : ${Updated.length}${UPDATE_EXISTING ? "" : " (not written: pass --update-existing)"}${Summarise(Updated.map(([Name]) => Name), 8)}`);
    if(FieldSummary.length > 0) console.log(`    fields        : ${FieldSummary}`);
    if(VERBOSE) for(const [RowName, Changes] of Updated) console.log(`      ${RowName}: ${Changes.join(", ")}`);
    console.log(`  unchanged       : ${Unchanged}`);
    console.log(`  vendor-only     : ${VendorOnly.length} (kept; absent from this export)${Summarise(VendorOnly)}`);
    if(Normalised.length > 0) console.log(`    game type     : ${Normalised.length} vendor-only row(s) with a numeric MatchmakingGameType -> name${UPDATE_EXISTING ? "" : " (not written: pass --update-existing)"}${Summarise(Normalised)}`);
    if(Rejected.length){
        console.log(`  REJECTED        : ${Rejected.length}`);
        for(const Problem of Rejected.slice(0, 10)) console.log(`      ${Problem}`);
        if(Rejected.length > 10) console.log(`      ...and ${Rejected.length - 10} more`);
    }
    console.log(`  rows after      : ${RowKeys.length}`);

    return { TableName, TablePath, IsNewFile, Table, Added, Updated, Normalised, Rejected, VendorOnly, WillChange };
}

// ---------------------------------------------------------------------------------------------

let ExportVersion = "";
let ProvenanceMarker = "";

function Main(){
    if(!fs.existsSync(ExportDir)){
        console.error(`No export found at ${ExportDir}`);
        console.error(`Run CatalogExporter with EXPORT_HUNTS=1 and inject into the CLIENT first.`);
        process.exit(1);
    }

    const ManifestPath = path.join(ExportDir, "hunt_export_manifest.json");
    const Manifest = fs.existsSync(ManifestPath) ? ReadJson(ManifestPath) : undefined;
    ExportVersion = Manifest?.gameVersion ?? "";
    if(!SUPPORTED_VERSIONS.includes(ExportVersion)){
        console.error(`Export ${ExportDir} declares gameVersion '${ExportVersion || "(missing)"}'.`);
        console.error(`Enum numbers can only be decoded for: ${SUPPORTED_VERSIONS.join(", ")}. Add the version's EMatchmakingGameType table first.`);
        process.exit(1);
    }
    ProvenanceMarker = `CatalogExporter EXPORT_HUNTS ${ExportVersion}`;

    const PlayerRows = ReadJsonl("player_hunts.jsonl");
    const MatchmakerRows = ReadJsonl("matchmaker_hunts.jsonl");

    if(PlayerRows == undefined || MatchmakerRows == undefined){
        console.error("Export is missing player_hunts.jsonl or matchmaker_hunts.jsonl.");
        process.exit(1);
    }

    console.log(`Export: ${path.relative(RepoRoot, ExportDir)} (${ExportVersion}, CL ${Manifest.changelist ?? "?"}): ${PlayerRows.length} player rows, ${MatchmakerRows.length} matchmaker rows`);
    console.log(`Mode  : ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}${UPDATE_EXISTING ? " +update-existing" : ""}`);

    // Real ObjectPaths come only from the original FModel snapshot rows (imported rows carry guesses).
    for(const TableName of [MAIN_PLAYER_TABLE, MAIN_MATCHMAKER_TABLE]){
        if(!fs.existsSync(VendorPath(TableName))) continue;
        for(const Row of Object.values(ReadJson(VendorPath(TableName))[0].Rows)){
            if(Row._importedFrom == undefined) IndexObjectPaths(Row);
        }
    }

    // Every matchmaker source table stays its own vendored file. Arena rows share the RowStruct but
    // belong to their own tables, so folding them into matchmaker_hunts_table would invent references
    // that do not exist in the client.
    const MatchmakerByTable = new Map();
    for(const Row of MatchmakerRows){
        const Table = Row.sourceTable || MAIN_MATCHMAKER_TABLE;
        if(!MatchmakerByTable.has(Table)) MatchmakerByTable.set(Table, []);
        MatchmakerByTable.get(Table).push(Row);
    }
    const MatchmakerTables = [MAIN_MATCHMAKER_TABLE, ...[...MatchmakerByTable.keys()].filter((Name) => Name !== MAIN_MATCHMAKER_TABLE).sort()];

    const Results = [MergeTable(MAIN_PLAYER_TABLE, PlayerRows, ToVendorPlayerRow, undefined)];
    for(const TableName of MatchmakerTables){
        Results.push(MergeTable(TableName, MatchmakerByTable.get(TableName) ?? [], ToVendorMatchmakerRow, ValidateMatchmakerRow));
    }

    // Game-type census, decoded with this export's enum table.
    const GameTypes = new Map();
    for(const Row of PlayerRows){
        const Name = EnumName("MatchmakingGameType", Row.matchmakingGameType, ExportVersion) ?? `#${Row.matchmakingGameType}`;
        GameTypes.set(Name, (GameTypes.get(Name) ?? 0) + 1);
    }
    console.log(`\n=== MatchmakingGameType (${ExportVersion} enum) ===`);
    console.log(`  ${[...GameTypes.entries()].map(([Name, Count]) => `${Name} x${Count}`).join(", ")}`);

    // Referential integrity across every matchmaker table as this run leaves it (each Result.Table
    // already holds added rows, and updated rows only under --update-existing).
    const FinalRows = new Map(Results.slice(1).map((Result) => [Result.TableName, Result.Table[0].Rows]));
    const FindRow = (RowName) => [...FinalRows.values()].some((Rows) => Rows[RowName] != undefined);
    const Dangling = [];
    const UnknownTagTables = new Set();
    for(const [RowName, Row] of Object.entries(Results[0].Table[0].Rows)){
        for(const Entry of (Row.MatchmakerHuntIDs ?? [])){
            const Target = Entry?.RowName;
            if(!Target || Target === "None") continue;
            if(!FindRow(Target)) Dangling.push(`${RowName} -> ${Target}`);
        }
        for(const List of (Row.MatchmakerHuntsByTag ?? [])){
            const Table = TableFromObjectName(List?.MatchmakerTable?.ObjectName);
            if(Table != undefined && !FinalRows.has(Table) && !fs.existsSync(VendorPath(Table))) UnknownTagTables.add(`${RowName} -> ${Table}`);
        }
    }

    console.log(`\n=== referential check ===`);
    if(Dangling.length === 0) console.log("  all direct MatchmakerHuntIDs resolve");
    else {
        console.log(`  ${Dangling.length} dangling direct reference(s):`);
        for(const D of Dangling.slice(0, 15)) console.log(`      ${D}`);
        if(Dangling.length > 15) console.log(`      ...and ${Dangling.length - 15} more`);
    }
    if(UnknownTagTables.size === 0) console.log("  every tag-routed MatchmakerTable has a vendored file");
    else for(const Entry of UnknownTagTables) console.log(`  tag-routed table without a vendored file: ${Entry}`);

    const Rejected = Results.flatMap((Result) => Result.Rejected);
    if(ConversionProblems.length > 0){
        console.log(`\n=== enum problems (${ConversionProblems.length}) ===`);
        for(const Problem of ConversionProblems.slice(0, 15)) console.log(`  ${Problem}`);
    }

    if(!APPLY){
        console.log(`\nDry run complete. Nothing written. Re-run with --apply${UPDATE_EXISTING ? " --update-existing" : ""} to commit.`);
        return;
    }

    if(Rejected.length > 0){
        console.error(`\nREFUSING TO WRITE: ${Rejected.length} matchmaker row(s) have no /Game/ map path.`);
        console.error(`GetMapPathFromMatchmakerHuntId requires it, so these rows would resolve and then fail at launch.`);
        console.error(`Re-export with the current HuntExporter (it reads the soft-pointer path via FName::GetRawString).`);
        process.exit(2);
    }
    if(ConversionProblems.length > 0){
        console.error(`\nREFUSING TO WRITE: ${ConversionProblems.length} enum value(s) do not decode for ${ExportVersion}.`);
        process.exit(2);
    }

    console.log("");
    const NewFiles = [];
    for(const Result of Results){
        if(!Result.WillChange) continue;
        if(!Result.IsNewFile) console.log(`Backed up: ${Backup(Result.TablePath)}`);
        // Vendored formatting: 2-space JSON, LF, no trailing newline.
        fs.writeFileSync(Result.TablePath, JSON.stringify(Result.Table, null, 2), "utf8");
        console.log(`Wrote ${path.basename(Result.TablePath)} (${Object.keys(Result.Table[0].Rows).length} rows: +${Result.Added.length}${UPDATE_EXISTING ? `, ~${Result.Updated.length}, game-type names ${Result.Normalised.length}` : ""})`);
        if(Result.IsNewFile) NewFiles.push(Result.TableName);
    }

    if(NewFiles.length > 0){
        console.log(`\nNEW vendor table(s): ${NewFiles.join(", ")}`);
        console.log(`  DeployServer only reads them once they are imported and listed in MatchmakerTableSources`);
        console.log(`  (src/controllers/gameservers.ts).`);
    }

    console.log(`\nDone. Rebuild and restart DeployServer, then check the boot log:`);
    console.log(`  [HuntTableAudit]    problems=0`);
    console.log(`  [HuntLaunchCoverage] resolvable=N/N`);
}

Main();
