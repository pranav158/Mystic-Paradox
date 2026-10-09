/*
 * [2026-10-05] Prestart build-freshness guard.
 *
 * "npm run start" runs build/server.js, and nothing in the start path rebuilds it. A stale build once
 * served the old unconditional-400 GET /inventory/:userId/ route for hours: every dedicated hub's phantom
 * player failed its inventory fetch, the hub left its map right after Listen, and the DeployServer
 * respawned it on a ~60s loop. Source was correct the whole time - only the compiled output was old.
 *
 * [2026-10-08] Compares each source file with its OWN output instead of the newest file of each tree.
 * The newest-vs-newest check missed a stale or missing output whenever any other build file was newer.
 * Mapping (tsconfig rootDir "src" -> outDir "build"; game data is read from game-data/ at runtime, not built):
 *   src/<rel>.ts (not .d.ts)  -> build/<rel>.js       must exist and be at least as new
 *   other src/<rel>.json      -> build/<rel>.json     checked only when tsc emitted it (imported JSON)
 *   package.json, tsconfig.json                       must not be newer than build/server.js
 * A normal start stays instant; any stale or missing output triggers one full "npm run build".
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const Root = path.join(__dirname, "..");
const SrcDir = path.join(Root, "src");
const BuildDir = path.join(Root, "build");

function MtimeOrZero(file) {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function ListFiles(dir) {
    const files = [];
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) files.push(full);
        }
    }
    return files;
}

function FindStaleReason() {
    const Entry = path.join(BuildDir, "server.js");
    const EntryMtime = MtimeOrZero(Entry);
    if (EntryMtime === 0) return "build/server.js is missing";

    for (const config of ["package.json", "tsconfig.json"]) {
        if (MtimeOrZero(path.join(Root, config)) > EntryMtime) return config + " is newer than build/server.js";
    }

    for (const src of ListFiles(SrcDir)) {
        const rel = path.relative(SrcDir, src);
        let out = null;
        let required = true;
        if (src.endsWith(".d.ts")) {
            continue;
        } else if (src.endsWith(".ts")) {
            out = path.join(BuildDir, rel.slice(0, -3) + ".js");
        } else if (src.endsWith(".json")) {
            out = path.join(BuildDir, rel);
            required = false;
        } else {
            continue;
        }
        const OutMtime = MtimeOrZero(out);
        if (OutMtime === 0) {
            if (required) return "missing output for src/" + rel.replace(/\\/g, "/");
            continue;
        }
        if (MtimeOrZero(src) > OutMtime) return "src/" + rel.replace(/\\/g, "/") + " is newer than its output";
    }
    return null;
}

const Reason = FindStaleReason();
if (Reason === null) {
    console.log("[build-fresh] build/ is up to date (every source file has a current output) - starting as-is");
    process.exit(0);
}
console.log("[build-fresh] build/ is STALE (" + Reason + ") - rebuilding before start");

const Npm = process.platform === "win32" ? "npm.cmd" : "npm";
const Result = spawnSync(Npm, ["run", "build"], { cwd: Root, stdio: "inherit", shell: process.platform === "win32" });
if (Result.status !== 0) {
    console.error("[build-fresh] build failed (exit " + Result.status + ") - refusing to start a stale build");
    process.exit(Result.status === null ? 1 : Result.status);
}
console.log("[build-fresh] rebuild complete");
