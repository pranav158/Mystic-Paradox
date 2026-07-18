#!/usr/bin/env node
/*
 * Copyright (C) 2026 MysticFox / Pranav Karande
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 *
 * generate_ladyluck_store.cjs — build game-data/ladyluck_store.json (the Trials/Arena reward shop)
 * from a locally captured/exported source.
 *
 * SOURCE (place under game-data/raw/, or set PARADOX_GAME_DATA_RAW_DIR):
 *   ladyluck_store.source.json
 *
 * Assembled from YOUR OWN game installation — from CatalogExporter EXPORT_DROP_TABLES / catalog
 * output, or captured from the live store response. It is NOT shipped in this repository.
 * See docs/GENERATING_GAME_DATA.md.
 *
 * The backend consumes an array of store entries (verified in src/controllers/store.ts):
 *   [ { id, displayName, displayPriority, prices:[{currencyId,price}], maxAllowed, tags:[],
 *       items:[{catalogId,quantity,instanced}], duplicateInstancedItems:[] }, ... ]
 *
 * USAGE
 *   node scripts/generate_ladyluck_store.cjs           # dry run: validates, writes nothing
 *   node scripts/generate_ladyluck_store.cjs --apply   # writes game-data/ladyluck_store.json
 */

const fs = require("node:fs");
const path = require("node:path");

const APPLY = process.argv.includes("--apply");

const RawDir = process.env.PARADOX_GAME_DATA_RAW_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_RAW_DIR)
    : path.resolve(__dirname, "../game-data/raw");
const OutDir = process.env.PARADOX_GAME_DATA_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_DIR)
    : path.resolve(__dirname, "../game-data");

const SourcePath = path.join(RawDir, "ladyluck_store.source.json");
const TargetPath = path.join(OutDir, "ladyluck_store.json");

function Fail(Message){
    console.error(`ERROR: ${Message}`);
    process.exit(1);
}

if(!fs.existsSync(SourcePath)){
    Fail(`source not found at ${SourcePath}\n` +
        `Provide the store payload from your own installation (see docs/GENERATING_GAME_DATA.md).`);
}

let Source;
try {
    Source = JSON.parse(fs.readFileSync(SourcePath, "utf8").replace(/^\uFEFF/, ""));
} catch (err) {
    Fail(`source is not valid JSON: ${String(err)}`);
}

if(!Array.isArray(Source)) Fail("source must be a JSON array of store entries.");

const Problems = [];
const Output = Source.map((Entry, Index) => {
    if(!Entry || typeof Entry.id !== "string") Problems.push(`entry ${Index}: missing string "id"`);
    if(!Array.isArray(Entry.items)) Problems.push(`entry ${Index} (${Entry?.id}): missing items[]`);
    if(!Array.isArray(Entry.prices)) Problems.push(`entry ${Index} (${Entry?.id}): missing prices[]`);
    return {
        id: Entry.id,
        displayName: Entry.displayName ?? "",
        displayDescription: Entry.displayDescription ?? "",
        displayPriority: Entry.displayPriority ?? 0,
        prices: Entry.prices ?? [],
        maxAllowed: Entry.maxAllowed ?? 0,
        tags: Entry.tags ?? [],
        items: Entry.items ?? [],
        duplicateInstancedItems: Entry.duplicateInstancedItems ?? [],
    };
});

console.log(`store entries : ${Output.length}`);
console.log(`mode          : ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}`);
if(Problems.length){
    console.log(`\nVALIDATION PROBLEMS (${Problems.length}):`);
    for(const P of Problems.slice(0, 15)) console.log(`  ${P}`);
    if(Problems.length > 15) console.log(`  ...and ${Problems.length - 15} more`);
    Fail("refusing to proceed until the source entries are well-formed.");
}

if(!APPLY){
    console.log(`\nDry run complete. Nothing written.`);
    process.exit(0);
}

fs.mkdirSync(OutDir, { recursive: true });
if(fs.existsSync(TargetPath)){
    const Stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(TargetPath, `${TargetPath}.${Stamp}.bak`);
}
fs.writeFileSync(TargetPath, JSON.stringify(Output, null, 2), "utf8");
console.log(`\nWrote ${path.basename(TargetPath)} (${Output.length} entries)`);
