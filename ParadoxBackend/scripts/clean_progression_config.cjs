#!/usr/bin/env node
/*
 * Copyright (C) 2026 MysticFox / Pranav Karande
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 *
 * clean_progression_config.cjs - remove the non-1.14.7 leftovers from game-data/progression_config.json (2026-10-10).
 *
 * The served config is the 2.1.1 (Awakening) capture with the 1.14.7 player curve swapped in. Every 1.14.7 hunt server
 * logs these entries on boot:
 *   d24_season1    the Awakening pass: "[d24_season1 rank 1] Can't find catalog id CURRENCY_WEAPONXP_SMALL" (7 of its
 *                  14 reward ids are not in the 1.14.7 catalogue; no hunt_pass_season_table row names it)
 *   single_track   "[single_track rank 1] Can't find catalog id CURRENCY_SEASON_13" (also EJ_HP13A_ANCIENT_02)
 *   season14b      "Found rewards for rank_id 51 but could not find a corresponding requirement": requirements are
 *                  rank_id 0..50, free_rewards has an extra rank_id 51 row. season14b IS a 1.14.7 table row, so only
 *                  reward rows whose rank_id has no requirement row are removed; the path stays.
 * All three passes are clamped to have ended when served (routes/system.ts WidenHuntPassWindows), so this only stops the
 * errors. Absent entries are skipped, so a second run changes nothing.
 *
 * Before applying, the script scans src/, scripts/ and game-data/*.json (other than the progression configs) for the
 * removed ids. A game-data reference, or a code line that is neither a comment nor in a test, blocks --apply.
 *
 * USAGE
 *   node scripts/clean_progression_config.cjs            # dry run: prints what would be removed, writes nothing
 *   node scripts/clean_progression_config.cjs --apply    # writes it, after a timestamped .bak copy
 */

const fs = require("node:fs");
const path = require("node:path");

const APPLY = process.argv.includes("--apply");
const REMOVED_PATH_IDS = ["d24_season1", "single_track"];
const ORPHAN_REWARD_PATH_IDS = ["season14b"];
const REWARD_LISTS = ["free_rewards", "premium_rewards"];

const BackendRoot = path.resolve(__dirname, "..");
const GameDataDir = process.env.PARADOX_GAME_DATA_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_DIR)
    : path.join(BackendRoot, "game-data");
const TargetPath = path.join(GameDataDir, "progression_config.json");

function Fail(Message) {
    console.error(`ERROR: ${Message}`);
    process.exit(1);
}

function ListFiles(Dir, Accept) {
    if (!fs.existsSync(Dir)) return [];
    const Found = [];
    for (const Entry of fs.readdirSync(Dir, { withFileTypes: true })) {
        const Full = path.join(Dir, Entry.name);
        if (Entry.isDirectory()) {
            if (Entry.name !== "node_modules") Found.push(...ListFiles(Full, Accept));
        } else if (Entry.isFile() && Accept(Entry.name)) {
            Found.push(Full);
        }
    }
    return Found;
}

// Every line in the backend that names a removed path id. `blocking` = game data, or code that is neither a comment
// nor a test (a test that names the id to prove it is refused or unknown keeps passing without the path).
function ScanReferences() {
    const Pattern = new RegExp(`\\b(${REMOVED_PATH_IDS.join("|")})\\b`);
    const Code = [
        ...ListFiles(path.join(BackendRoot, "src"), (Name) => /\.(ts|js|cjs|mjs)$/.test(Name)),
        ...ListFiles(path.join(BackendRoot, "scripts"), (Name) => /\.(ts|js|cjs|mjs)$/.test(Name)),
    ].filter((File) => path.resolve(File) !== path.resolve(__filename));
    const Data = ListFiles(GameDataDir, (Name) => Name.endsWith(".json") && !Name.startsWith("progression_config"));
    const Hits = [];
    for (const File of [...Code, ...Data]) {
        const IsData = Data.includes(File);
        const Lines = fs.readFileSync(File, "utf8").split(/\r?\n/);
        Lines.forEach((Line, Index) => {
            if (!Pattern.test(Line)) return;
            const Trimmed = Line.trim();
            const IsComment = !IsData && (Trimmed.startsWith("//") || Trimmed.startsWith("*") || Trimmed.startsWith("/*"));
            const IsTest = !IsData && /\.test\.[cm]?[jt]s$/.test(File);
            Hits.push({
                file: path.relative(BackendRoot, File).replace(/\\/g, "/"),
                line: Index + 1,
                kind: IsData ? "game-data" : IsComment ? "comment" : IsTest ? "test" : "code",
                text: Trimmed.slice(0, 160),
            });
        });
    }
    return Hits.map((Hit) => ({ ...Hit, blocking: Hit.kind === "game-data" || Hit.kind === "code" }));
}

function Describe(PathEntry) {
    const Requirements = Array.isArray(PathEntry.requirements) ? PathEntry.requirements.length : 0;
    const RewardRows = REWARD_LISTS.map((Key) => `${Key}=${Array.isArray(PathEntry[Key]) ? PathEntry[Key].length : 0}`).join(" ");
    const Prestige = (PathEntry.prestige?.free_rewards?.stacked_items ?? []).map((Item) => `${Item.catalog_id} x${Item.quantity}`).join(", ");
    return `requirements=${Requirements} ${RewardRows} window=${PathEntry.start_date ?? "-"}..${PathEntry.end_date ?? "-"}`
        + ` premium=${PathEntry.premium_gating_entitlement ?? "-"} prestige=[${Prestige}]`;
}

if (!fs.existsSync(TargetPath)) Fail(`not found: ${TargetPath}`);
const Text = fs.readFileSync(TargetPath, "utf8");
const Bom = Text.startsWith("﻿") ? "﻿" : "";
const Eol = Text.includes("\r\n") ? "\r\n" : "\n";
const Indent = (Text.replace(/^﻿/, "").match(/^\{\r?\n( +|\t)"/) ?? [])[1] ?? 2;
let Config;
try {
    Config = JSON.parse(Text.replace(/^﻿/, ""));
} catch (Err) {
    Fail(`${TargetPath} is not valid JSON: ${String(Err)}`);
}
const Paths = Config?.payload?.paths;
if (!Array.isArray(Paths)) Fail("no payload.paths[] array");

console.log(`file   : ${TargetPath}`);
console.log(`mode   : ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}`);
console.log(`paths  : ${Paths.length}`);

const Removals = [];
for (const Id of REMOVED_PATH_IDS) {
    const Index = Paths.findIndex((Entry) => Entry?.progression_id === Id);
    if (Index < 0) {
        console.log(`\n[path] ${Id}: already absent`);
        continue;
    }
    console.log(`\n[path] ${Id}: REMOVE (index ${Index}) ${Describe(Paths[Index])}`);
    Removals.push(() => Paths.splice(Paths.findIndex((Entry) => Entry?.progression_id === Id), 1));
}

for (const Id of ORPHAN_REWARD_PATH_IDS) {
    const Entry = Paths.find((Candidate) => Candidate?.progression_id === Id);
    if (Entry === undefined) {
        console.log(`\n[rewards] ${Id}: path absent, nothing to check`);
        continue;
    }
    const RankIds = new Set((Entry.requirements ?? []).map((Requirement) => Requirement?.rank_id));
    let Orphans = 0;
    for (const Key of REWARD_LISTS) {
        const List = Array.isArray(Entry[Key]) ? Entry[Key] : [];
        for (const Reward of List.filter((Row) => !RankIds.has(Row?.rank_id))) {
            Orphans++;
            console.log(`\n[rewards] ${Id}.${Key}: REMOVE rank_id ${Reward?.rank_id} (requirements cover rank_id ${Math.min(...RankIds)}..${Math.max(...RankIds)}): ${JSON.stringify(Reward)}`);
        }
        if (List.some((Row) => !RankIds.has(Row?.rank_id))) {
            Removals.push(() => { Entry[Key] = List.filter((Row) => RankIds.has(Row?.rank_id)); });
        }
    }
    if (Orphans === 0) console.log(`\n[rewards] ${Id}: no reward row without a requirement row`);
}

const References = ScanReferences();
console.log(`\n[references] ${References.length} line(s) in src/, scripts/ and game-data/*.json name ${REMOVED_PATH_IDS.join(" / ")}:`);
for (const Hit of References) {
    console.log(`  ${Hit.blocking ? "BLOCKING" : "ok      "} ${Hit.kind.padEnd(9)} ${Hit.file}:${Hit.line}  ${Hit.text}`);
}
const Blocking = References.filter((Hit) => Hit.blocking);

if (Removals.length === 0) {
    console.log("\nNothing to remove; the file is already clean. Nothing written.");
    process.exit(0);
}
if (!APPLY) {
    console.log(`\nDry run complete: ${Removals.length} change(s) pending${Blocking.length > 0 ? `, ${Blocking.length} blocking reference(s)` : ""}. Nothing written.`);
    process.exit(0);
}
if (Blocking.length > 0) Fail(`${Blocking.length} blocking reference(s) above; resolve them before --apply.`);

for (const Remove of Removals) Remove();
const Stamp = new Date().toISOString().replace(/[:.]/g, "-");
const BackupPath = `${TargetPath}.${Stamp}.bak`;
fs.copyFileSync(TargetPath, BackupPath);
const Output = Bom + JSON.stringify(Config, null, Indent).replace(/\n/g, Eol) + Eol;
fs.writeFileSync(TargetPath, Output, "utf8");

const Check = JSON.parse(fs.readFileSync(TargetPath, "utf8").replace(/^﻿/, ""));
console.log(`\nBackup : ${BackupPath}`);
console.log(`Wrote  : ${path.basename(TargetPath)} (${Check.payload.paths.length} paths, ${Removals.length} change(s))`);
