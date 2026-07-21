#!/usr/bin/env node


const fs = require("node:fs");
const path = require("node:path");

const Args = new Set(process.argv.slice(2));
const APPLY = Args.has("--apply");
const UPDATE_EXISTING = Args.has("--update-existing");


const VendorDir = process.env.PARADOX_GAME_DATA_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_DIR)
    : path.resolve(__dirname, "../game-data");

const ExportDir = process.env.PARADOX_GAME_DATA_RAW_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_RAW_DIR)
    : path.resolve(__dirname, "../game-data/raw");

const PlayerTablePath = path.join(VendorDir, "player_hunts_table.json");
const MatchmakerTablePath = path.join(VendorDir, "matchmaker_hunts_table.json");



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


function Handle(TableName, RowName){
    if(!RowName || RowName === "None"){
        return { DataTable: null, RowName: "None" };
    }
    return {
        DataTable: {
            ObjectName: `DataTable'${TableName}'`,
            ObjectPath: `Archon/Content/Gameplay/hunts/${TableName}.0`
        },
        RowName
    };
}

function HandleFromExport(Exported){
    if(Exported == undefined) return { DataTable: null, RowName: "None" };
    return Handle(Exported.table, Exported.rowName);
}




function ToVendorPlayerRow(Row){
    return {
        
        
        HuntName: { CultureInvariantString: "" },
        HuntDescription: { CultureInvariantString: "" },
        Region: HandleFromExport(Row.region),
        MatchmakerHuntIDs: (Row.matchmakerHuntIDs ?? []).map((Entry) => HandleFromExport(Entry)),
        MatchmakerHuntsByTag: Row.matchmakerHuntsByTag ?? [],
        MatchmakingType: Row.matchmakingType,
        MatchmakingGameType: Row.matchmakingGameType,
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
        
        _importedFrom: "CatalogExporter EXPORT_HUNTS 1.12.0"
    };
}

function ToVendorMapEntry(Map){
    
    
    const AssetPath = (Map.mapAssetPath && Map.mapAssetPath.length > 0)
        ? Map.mapAssetPath
        : (Map.mapAssetName ?? "");

    return {
        MapName: Map.mapName ?? "",
        MapAssetName: AssetPath,
        Biome: Map.biome,
        Weighting: Map.weighting
    };
}

function ToVendorMatchmakerRow(Row){
    const Behemoth = Row.specificBehemoth ?? {};
    return {
        Region: HandleFromExport(Row.region),
        HuntTags: Row.huntTags ?? [],
        HuntThreatLevel: Row.huntThreatLevel,
        GameModeOverride: Row.gameModeOverride ?? "",
        DangerPerSecOverride: Row.dangerPerSecOverride,
        SpecificBehemoth: {
            BehemothName: Behemoth.behemothName ?? "",
            BehemothAsset: {
                
                
                AssetPathName: (Behemoth.behemothAssetPath && Behemoth.behemothAssetPath.length > 0)
                    ? Behemoth.behemothAssetPath
                    : "None",
                SubPathString: ""
            },
            PowerOverride: Behemoth.powerOverride,
            Weighting: Behemoth.weighting
        },
        AdditionalBehemoths: [],
        AdditionalSpecificBehemoths: (Row.additionalSpecificBehemoths ?? []).map((B) => ({
            BehemothName: B.behemothName ?? "",
            BehemothAsset: {
                AssetPathName: (B.behemothAssetPath && B.behemothAssetPath.length > 0) ? B.behemothAssetPath : "None",
                SubPathString: ""
            },
            PowerOverride: B.powerOverride,
            Weighting: B.weighting
        })),
        MapMetaData: HandleFromExport(Row.mapMetaData),
        MapList: (Row.mapList ?? []).map(ToVendorMapEntry),
        Modifiers: Row.modifiers ?? [],
        GatherableTier: Row.gatherableTier,
        MaxPlayers: Row.maxPlayers,
        bIsGeneratedEncounter: Row.isGeneratedEncounter,
        GameModeSpecificData: HandleFromExport(Row.gameModeSpecificData),
        _importedFrom: "CatalogExporter EXPORT_HUNTS 1.12.0"
    };
}




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

function MergeTable(Label, TablePath, ExportedRows, Converter, Validator){
    const Table = fs.existsSync(TablePath)
        ? ReadJson(TablePath)
        : [{ Name: path.basename(TablePath, ".json"), Type: "DataTable", Rows: {} }];
    const Rows = Table[0].Rows;

    const Added = [];
    const Updated = [];
    const Rejected = [];

    for(const Exported of ExportedRows){
        const RowName = Exported.rowName;

        if(Validator != undefined){
            const Problem = Validator(RowName, Exported);
            if(Problem != undefined){ Rejected.push(Problem); continue; }
        }

        const Exists = Rows[RowName] != undefined;
        if(Exists && !UPDATE_EXISTING) continue;

        Rows[RowName] = Converter(Exported);
        (Exists ? Updated : Added).push(RowName);
    }

    console.log(`\n=== ${Label} ===`);
    console.log(`  existing rows : ${Object.keys(Rows).length - Added.length}`);
    console.log(`  to add        : ${Added.length}${Added.length ? " -> " + Added.join(", ") : ""}`);
    if(UPDATE_EXISTING) console.log(`  to update     : ${Updated.length}`);
    if(Rejected.length){
        console.log(`  REJECTED      : ${Rejected.length}`);
        for(const Problem of Rejected.slice(0, 10)) console.log(`      ${Problem}`);
        if(Rejected.length > 10) console.log(`      ...and ${Rejected.length - 10} more`);
    }

    return { Table, Added, Updated, Rejected };
}



function Main(){
    if(!fs.existsSync(ExportDir)){
        console.error(`No export found at ${ExportDir}`);
        console.error(`Run CatalogExporter with EXPORT_HUNTS=1 and inject into the CLIENT first.`);
        process.exit(1);
    }

    const PlayerRows = ReadJsonl("player_hunts.jsonl");
    const MatchmakerRows = ReadJsonl("matchmaker_hunts.jsonl");

    if(PlayerRows == undefined || MatchmakerRows == undefined){
        console.error("Export is missing player_hunts.jsonl or matchmaker_hunts.jsonl.");
        process.exit(1);
    }

    console.log(`Export: ${PlayerRows.length} player rows, ${MatchmakerRows.length} matchmaker rows`);
    console.log(`Mode  : ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}${UPDATE_EXISTING ? " +update-existing" : ""}`);

    
    
    
    const MainMatchmaker = MatchmakerRows.filter((Row) => Row.sourceTable === "matchmaker_hunts_table");
    const ArenaRows = MatchmakerRows.filter((Row) => Row.sourceTable !== "matchmaker_hunts_table");

    const PlayerResult = MergeTable("player_hunts_table", PlayerTablePath, PlayerRows, ToVendorPlayerRow, undefined);
    const MatchmakerResult = MergeTable("matchmaker_hunts_table", MatchmakerTablePath, MainMatchmaker, ToVendorMatchmakerRow, ValidateMatchmakerRow);

    
    const FinalMatchmaker = MatchmakerResult.Table[0].Rows;
    const Dangling = [];
    for(const [RowName, Row] of Object.entries(PlayerResult.Table[0].Rows)){
        for(const Entry of (Row.MatchmakerHuntIDs ?? [])){
            const Target = Entry?.RowName;
            if(!Target || Target === "None") continue;
            if(FinalMatchmaker[Target] == undefined) Dangling.push(`${RowName} -> ${Target}`);
        }
    }

    console.log(`\n=== referential check ===`);
    if(Dangling.length === 0){
        console.log("  all MatchmakerHuntIDs resolve");
    } else {
        console.log(`  ${Dangling.length} dangling reference(s):`);
        for(const D of Dangling.slice(0, 15)) console.log(`      ${D}`);
        if(Dangling.length > 15) console.log(`      ...and ${Dangling.length - 15} more`);
    }

    if(ArenaRows.length > 0){
        const ByTable = {};
        for(const Row of ArenaRows) (ByTable[Row.sourceTable] ??= []).push(Row);
        console.log(`\n=== separate matchmaker tables (written as new vendor files) ===`);
        for(const [Name, Rows] of Object.entries(ByTable)) console.log(`  ${Name}: ${Rows.length} rows`);
    }

    if(!APPLY){
        console.log(`\nDry run complete. Nothing written. Re-run with --apply to commit.`);
        return;
    }

    if(MatchmakerResult.Rejected.length > 0){
        console.error(`\nREFUSING TO WRITE: ${MatchmakerResult.Rejected.length} matchmaker row(s) have no /Game/ map path.`);
        console.error(`GetMapPathFromMatchmakerHuntId requires it, so these rows would resolve and then fail at launch.`);
        console.error(`Re-export with the current HuntExporter (it reads the soft-pointer path via FName::GetRawString).`);
        process.exit(2);
    }

    if(fs.existsSync(PlayerTablePath)) console.log(`\nBacked up: ${Backup(PlayerTablePath)}`);
    if(fs.existsSync(MatchmakerTablePath)) console.log(`Backed up: ${Backup(MatchmakerTablePath)}`);
    fs.mkdirSync(VendorDir, { recursive: true });

    fs.writeFileSync(PlayerTablePath, JSON.stringify(PlayerResult.Table, null, 2), "utf8");
    fs.writeFileSync(MatchmakerTablePath, JSON.stringify(MatchmakerResult.Table, null, 2), "utf8");

    for(const [Name, Rows] of Object.entries(
        ArenaRows.reduce((Acc, Row) => { (Acc[Row.sourceTable] ??= []).push(Row); return Acc; }, {})
    )){
        const Out = [{ Name, Type: "DataTable", Rows: {} }];
        for(const Row of Rows) Out[0].Rows[Row.rowName] = ToVendorMatchmakerRow(Row);
        const Target = path.join(VendorDir, `${Name}.json`);
        fs.writeFileSync(Target, JSON.stringify(Out, null, 2), "utf8");
        console.log(`Wrote ${path.basename(Target)} (${Rows.length} rows)`);
    }

    console.log(`\nDone. Restart DeployServer and check the boot log:`);
    console.log(`  [HuntTableAudit]    problems=0`);
    console.log(`  [HuntTableCoverage] ShatteredIsles_Island: A-U`);
}

Main();
