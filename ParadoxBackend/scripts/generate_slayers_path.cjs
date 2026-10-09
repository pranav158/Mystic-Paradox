#!/usr/bin/env node
/*
 * generate_slayers_path.cjs — rebuild game-data/slayers_path.json from the live 1.12 export.
 *
 * WHY THIS EXISTS
 * ---------------
 * The served baseline graph was a stale 1.4.4-era snapshot: 317 nodes against the client's 508.
 * 263 node ids the client renders did not exist server-side at all, and the ids did not even match
 * (served "Aetherdrive_Tonic" vs the real table's "Aetherdrive_Tonic_Unlock").
 *
 * The client draws the tree from its OWN local DataTable, so every node was visible and clickable.
 * The server only knew 317 of them. Unlocking a node the baseline did not contain produced state
 * nothing could act on, so every unlock criterion keyed on a missing node could never be satisfied:
 *
 *   Trials greyed out                    gate: Slayer_11              <- was missing
 *   Grenade/Pylon/Tonic purchases locked gate: Slayer_11              <- was missing
 *   Grim Onslaught not craftable         gate: WeaponTypeGA_Spc_00    <- was missing
 *   Island S/T/U activities              gate: AirshipUpgrades_Islands_*  <- were missing
 *
 * (Confirmed against activity_unlock_criteria.jsonl, which shows nearly every unlock in the game is
 * gated on a player-journey node.)
 *
 * SOURCE: Items_Analysis/slayers_path_1_12/player_journey_nodes.jsonl — the live table captured with
 * CatalogExporter EXPORT_SLAYERS_PATH=1. Regenerate that capture before re-running this if the game
 * updates.
 *
 * USAGE
 *   node scripts/generate_slayers_path.cjs          # dry run: prints the diff, writes nothing
 *   node scripts/generate_slayers_path.cjs --apply  # writes game-data/slayers_path.json (with backup)
 */

const fs = require("node:fs");
const path = require("node:path");

const APPLY = process.argv.includes("--apply");

// [1.14.7 2026-10-08] Reads the 1.14.7 export by default; --source=1_12 regenerates from the 1.12 capture.
const SourceArg = process.argv.find((Arg) => Arg.startsWith("--source="));
const SourceVersion = SourceArg ? SourceArg.slice("--source=".length) : "1_14_7";
const ExportPath = path.resolve(__dirname, `../../Items_Analysis/slayers_path_${SourceVersion}/player_journey_nodes.jsonl`);
const TargetPath = path.resolve(__dirname, "../game-data/slayers_path.json");

function Fail(Message){
    console.error(`ERROR: ${Message}`);
    process.exit(1);
}

if(!fs.existsSync(ExportPath)) Fail(`export not found at ${ExportPath} — run CatalogExporter with EXPORT_SLAYERS_PATH=1 first`);
if(!fs.existsSync(TargetPath)) Fail(`target not found at ${TargetPath}`);

const LiveRows = fs.readFileSync(ExportPath, "utf8")
    .replace(/^﻿/, "")
    .trim()
    .split("\n")
    .filter((Line) => Line.trim().length > 0)
    .map((Line, Index) => {
        try { return JSON.parse(Line); }
        catch { Fail(`malformed JSON on line ${Index + 1} of the export`); }
    });

const Existing = JSON.parse(fs.readFileSync(TargetPath, "utf8").replace(/^﻿/, ""));
const ExistingNodes = Existing?.payload?.nodes;
if(ExistingNodes == undefined) Fail("existing slayers_path.json has no payload.nodes — refusing to guess at the shape");

// The served node shape, matched exactly to what the client already accepts. node_status 0 = locked;
// a player's own unlocks are merged over this baseline by SavePlayerJourney at runtime.
const NextNodes = {};
for(const Row of LiveRows){
    const NodeId = Row.nodeId;
    if(typeof NodeId !== "string" || NodeId.length === 0) continue;
    NextNodes[NodeId] = { node_id: NodeId, node_status: 0, objectives: [] };
}

const ExistingIds = new Set(Object.keys(ExistingNodes));
const NextIds = new Set(Object.keys(NextNodes));

const Added = [...NextIds].filter((Id) => !ExistingIds.has(Id)).sort();
// Ids the OLD baseline had that the live table does not. These are 1.4.4 leftovers / renamed nodes.
const Dropped = [...ExistingIds].filter((Id) => !NextIds.has(Id)).sort();

console.log(`existing baseline : ${ExistingIds.size} nodes`);
console.log(`live 1.12 table   : ${NextIds.size} nodes`);
console.log(`  added   : ${Added.length}`);
console.log(`  dropped : ${Dropped.length}  (1.4.4 leftovers / renamed)`);

// The gates that were failing — this is the whole point of the change.
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

// Preserve the envelope exactly — only payload.nodes is replaced. update_version is left as-is so the
// stale-write guard in SavePlayerJourney keeps its existing semantics.
const Output = {
    ...Existing,
    payload: { ...Existing.payload, nodes: NextNodes }
};

const Stamp = new Date().toISOString().replace(/[:.]/g, "-");
const BackupPath = `${TargetPath}.${Stamp}.bak`;
fs.copyFileSync(TargetPath, BackupPath);
fs.writeFileSync(TargetPath, JSON.stringify(Output, null, 2), "utf8");

console.log(`\nBacked up: ${path.basename(BackupPath)}`);
console.log(`Wrote    : ${path.basename(TargetPath)}  (${NextIds.size} nodes)`);
console.log(`\nRestart the metagame, then verify in game that Trials, Grim Onslaught crafting and`);
console.log(`Island S/T/U activities unlock. Existing characters may need to re-unlock renamed nodes.`);
