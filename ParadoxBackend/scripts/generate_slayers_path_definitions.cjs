#!/usr/bin/env node
/*
 * generate_slayers_path_definitions.cjs — rebuild game-data/slayers_path_definitions.json from the live
 * player_journey_table export (CatalogExporter EXPORT_SLAYERS_PATH=1).
 *
 * The definitions are what controllers/slayersPath.ts grants from (rewards) and reads edges/costs from.
 * They were first written by hand as a projection of the 1.12 export; this script is that projection made
 * repeatable: a node is listed only when it has child nodes, currency costs or item rewards, and each of
 * those keys (plus autoUnlockIfParentUnlocked when true) appears only when non-empty. Running it with
 * --source=1_12 reproduces the hand-written file byte for byte.
 *
 * USAGE
 *   node scripts/generate_slayers_path_definitions.cjs                 # dry run against the 1.14.7 export
 *   node scripts/generate_slayers_path_definitions.cjs --source=1_12   # dry run against the 1.12 export
 *   node scripts/generate_slayers_path_definitions.cjs --apply         # write game-data/slayers_path_definitions.json
 */

const fs = require("node:fs");
const path = require("node:path");

const APPLY = process.argv.includes("--apply");
const SourceArg = process.argv.find((Arg) => Arg.startsWith("--source="));
const SourceVersion = SourceArg ? SourceArg.slice("--source=".length) : "1_14_7";
const ExportPath = path.resolve(__dirname, `../../Items_Analysis/slayers_path_${SourceVersion}/player_journey_nodes.jsonl`);
const TargetPath = path.resolve(__dirname, "../game-data/slayers_path_definitions.json");

function Fail(Message){
    console.error(`ERROR: ${Message}`);
    process.exit(1);
}

if(!fs.existsSync(ExportPath)) Fail(`export not found at ${ExportPath} — run CatalogExporter with EXPORT_SLAYERS_PATH=1 first`);

const Rows = fs.readFileSync(ExportPath, "utf8")
    .replace(/^﻿/, "")
    .split("\n")
    .filter((Line) => Line.trim().length > 0)
    .map((Line, Index) => {
        try { return JSON.parse(Line); }
        catch { Fail(`malformed JSON on line ${Index + 1} of the export`); }
    });

const Next = {};
for(const Row of Rows){
    if(typeof Row.nodeId !== "string" || Row.nodeId.length === 0) continue;
    const ChildNodes = (Row.childNodes ?? []).filter((Id) => typeof Id === "string" && Id.length > 0 && Id !== "None");
    const CurrencyCosts = (Row.currencyCosts ?? [])
        .filter((Cost) => Cost && typeof Cost.currency === "string" && Cost.currency !== "None")
        .map((Cost) => ({ amount: Cost.amount, currency: Cost.currency }));
    const Rewards = (Row.rewards ?? [])
        .map((Reward) => Reward?.itemId)
        .filter((Id) => typeof Id === "string" && Id.length > 0 && Id !== "None");
    if(ChildNodes.length === 0 && CurrencyCosts.length === 0 && Rewards.length === 0) continue;

    // Keys in alphabetical order, as in the original file.
    const Def = {};
    if(Row.autoUnlockIfParentUnlocked === true) Def.autoUnlockIfParentUnlocked = true;
    if(ChildNodes.length > 0) Def.childNodes = ChildNodes;
    if(CurrencyCosts.length > 0) Def.currencyCosts = CurrencyCosts;
    if(Rewards.length > 0) Def.rewards = Rewards;
    Next[Row.nodeId] = Def;
}

// Node ids in code-point order and no trailing newline, as in the original file.
const Sorted = Object.fromEntries(Object.keys(Next).sort().map((Id) => [Id, Next[Id]]));
const NextJson = JSON.stringify(Sorted, null, 1);
const Existing = fs.existsSync(TargetPath) ? JSON.parse(fs.readFileSync(TargetPath, "utf8").replace(/^﻿/, "")) : {};
const ExistingJson = fs.existsSync(TargetPath) ? fs.readFileSync(TargetPath, "utf8").replace(/\r\n/g, "\n") : "";

const Added = Object.keys(Next).filter((Id) => !(Id in Existing)).sort();
const Removed = Object.keys(Existing).filter((Id) => !(Id in Next)).sort();
const Changed = Object.keys(Next).filter((Id) => Id in Existing && JSON.stringify(Existing[Id]) !== JSON.stringify(Next[Id])).sort();

console.log(`source  : slayers_path_${SourceVersion} (${Rows.length} nodes)`);
console.log(`existing: ${Object.keys(Existing).length} definitions; next: ${Object.keys(Next).length}`);
console.log(`  added   : ${Added.length}${Added.length ? "  " + Added.join(", ") : ""}`);
console.log(`  removed : ${Removed.length}${Removed.length ? "  " + Removed.join(", ") : ""}`);
console.log(`  changed : ${Changed.length}${Changed.length ? "  " + Changed.join(", ") : ""}`);
console.log(`  identical bytes: ${NextJson === ExistingJson}`);

if(!APPLY){
    console.log(`\nDry run. Nothing written. Re-run with --apply to write.`);
    process.exit(0);
}
fs.writeFileSync(TargetPath, NextJson, "utf8");
console.log(`\nWrote ${path.basename(TargetPath)}. Restart the metagame to load it.`);
