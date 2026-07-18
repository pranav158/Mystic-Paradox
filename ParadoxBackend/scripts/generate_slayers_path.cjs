#!/usr/bin/env node


const fs = require("node:fs");
const path = require("node:path");

const APPLY = process.argv.includes("--apply");

const ExportPath = process.env.PARADOX_GAME_DATA_RAW_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_RAW_DIR, "player_journey_nodes.jsonl")
    : path.resolve(__dirname, "../game-data/raw/player_journey_nodes.jsonl");
const TargetPath = process.env.PARADOX_GAME_DATA_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_DIR, "slayers_path.json")
    : path.resolve(__dirname, "../game-data/slayers_path.json");

function Fail(Message){
    console.error(`ERROR: ${Message}`);
    process.exit(1);
}

if(!fs.existsSync(ExportPath)) Fail(`export not found at ${ExportPath} — run CatalogExporter with EXPORT_SLAYERS_PATH=1 first, then copy player_journey_nodes.jsonl into game-data/raw/`);

const LiveRows = fs.readFileSync(ExportPath, "utf8")
    .replace(/^﻿/, "")
    .trim()
    .split("\n")
    .filter((Line) => Line.trim().length > 0)
    .map((Line, Index) => {
        try { return JSON.parse(Line); }
        catch { Fail(`malformed JSON on line ${Index + 1} of the export`); }
    });

const Existing = fs.existsSync(TargetPath)
    ? JSON.parse(fs.readFileSync(TargetPath, "utf8").replace(/^﻿/, ""))
    : { code: null, message: "OK", payload: { nodes: {} } };
const ExistingNodes = Existing?.payload?.nodes;
if(ExistingNodes == undefined) Fail("existing slayers_path.json has no payload.nodes — refusing to guess at the shape");



const NextNodes = {};
for(const Row of LiveRows){
    const NodeId = Row.nodeId;
    if(typeof NodeId !== "string" || NodeId.length === 0) continue;
    NextNodes[NodeId] = { node_id: NodeId, node_status: 0, objectives: [] };
}

const ExistingIds = new Set(Object.keys(ExistingNodes));
const NextIds = new Set(Object.keys(NextNodes));

const Added = [...NextIds].filter((Id) => !ExistingIds.has(Id)).sort();

const Dropped = [...ExistingIds].filter((Id) => !NextIds.has(Id)).sort();

console.log(`existing baseline : ${ExistingIds.size} nodes`);
console.log(`live 1.12 table   : ${NextIds.size} nodes`);
console.log(`  added   : ${Added.length}`);
console.log(`  dropped : ${Dropped.length}  (1.4.4 leftovers / renamed)`);


const CriticalGates = [
    "Slayer_09", "Slayer_10", "Slayer_11",
    "WeaponTypeGA_Spc_00", "WeaponTypeEB_Spc_00", "WeaponTypeCB_Spc_00",
    "AirshipUpgrades_Islands_S", "AirshipUpgrades_Islands_T", "AirshipUpgrades_Islands_U",
    "Escalation.Hard.Unlock", "Lantern.Unlock"
];
console.log(`\ncritical unlock gates:`);
for(const Gate of CriticalGates){
    const Before = ExistingIds.has(Gate) ? "present" : "MISSING";
    const After  = NextIds.has(Gate) ? "present" : "MISSING";
    console.log(`  ${Gate.padEnd(30)} before=${Before.padEnd(8)} after=${After}`);
}

if(Dropped.length > 0){
    console.log(`\nsample dropped ids (stored player unlocks keyed on these become orphans —`);
    console.log(`SavePlayerJourney merges stored over baseline, so they persist harmlessly but read as locked):`);
    for(const Id of Dropped.slice(0, 10)) console.log(`  ${Id}`);
    if(Dropped.length > 10) console.log(`  ...and ${Dropped.length - 10} more`);
}

if(!APPLY){
    console.log(`\nDry run. Nothing written. Re-run with --apply to commit.`);
    process.exit(0);
}



const Output = {
    ...Existing,
    payload: { ...Existing.payload, nodes: NextNodes }
};

const Stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.mkdirSync(path.dirname(TargetPath), { recursive: true });
if(fs.existsSync(TargetPath)){
    const BackupPath = `${TargetPath}.${Stamp}.bak`;
    fs.copyFileSync(TargetPath, BackupPath);
    console.log(`\nBacked up: ${path.basename(BackupPath)}`);
}
fs.writeFileSync(TargetPath, JSON.stringify(Output, null, 2), "utf8");
console.log(`\nRestart the metagame, then verify in game that Trials, Grim Onslaught crafting and`);
console.log(`Island S/T/U activities unlock. Existing characters may need to re-unlock renamed nodes.`);
