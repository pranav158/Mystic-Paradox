/*
 * Runs every *.test.ts under src/ with the Node test runner. Files named *.gamedata.test.ts check the real game
 * data in game-data/ (or PARADOX_GAME_DATA_DIR); when any of it is missing, as in a fresh public checkout or
 * its CI, those files are skipped and listed. See game-data/README.md for generating the data.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const Root = path.join(__dirname, "..");
const GameDataDir = process.env.PARADOX_GAME_DATA_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_DIR)
    : path.join(Root, "game-data");
const GameDataFiles = [
    "player_hunts_table.json",
    "matchmaker_hunts_table.json",
    "arena_easy_matchmaker_hunts.json",
    "arena_hard_matchmaker_hunts.json",
    "arena_elite_matchmaker_hunts.json",
    "arena_hard_matchmaker_hunts_new.json",
    "arena_elite_matchmaker_hunts_new.json",
];

function ListTests(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...ListTests(full));
        else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(path.relative(Root, full));
    }
    return found;
}

const All = ListTests(path.join(Root, "src")).sort();
const Missing = GameDataFiles.filter((name) => !fs.existsSync(path.join(GameDataDir, name)));
const Run = Missing.length > 0 ? All.filter((file) => !file.endsWith(".gamedata.test.ts")) : All;
if (Run.length < All.length) {
    console.log(`[tests] skipping ${All.length - Run.length} game-data test files; ${GameDataDir} lacks ${Missing.join(", ")}:`);
    for (const file of All.filter((file) => !Run.includes(file))) console.log(`[tests]   ${file}`);
}

// With no files, node --test would fall back to its default search (which includes compiled build output).
if (Run.length === 0) {
    console.log("[tests] nothing to run");
    process.exit(0);
}
const Result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...Run], { cwd: Root, stdio: "inherit" });
process.exit(Result.status === null ? 1 : Result.status);
