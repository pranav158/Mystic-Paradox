/*
 * [2026-10-10] Prestart build-freshness guard for the Director, adapted from ParadoxBackend/scripts/ensure-build-fresh.cjs.
 *
 * "npm run start" runs dist/server.js, and nothing in the start path rebuilt it: the Director had to be rebuilt by
 * hand before every restart. The Metagame learned this the hard way (2026-10-05: a stale build served an old route
 * for hours and its hubs respawned on a ~60 s loop while the source was correct).
 *
 * Mapping (tsconfig rootDir "src" -> outDir "dist"; hunt tables are read from game-data/ at runtime, not built):
 *   src/<rel>.ts (not .d.ts)  -> dist/<rel>.js       must exist and be at least as new
 *   other src/<rel>.json      -> dist/<rel>.json     checked only when tsc emitted it (imported JSON)
 *   package.json, tsconfig.json                      must not be newer than dist/server.js
 * Director addition - orphans: a dist/<rel>.js without src/<rel>.ts (or a dist/<rel>.json without src/<rel>.json)
 * is stale too. tsc never deletes old output, and src/extensions/p2p.ts mounts the P2P routes whenever dist/p2p
 * exists, so a leftover dist/p2p would keep them alive after src/p2p is removed.
 * A normal start stays instant; any stale, missing or orphaned output triggers one full "npm run build" (which
 * cleans dist first).
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const Root = path.join(__dirname, "..");
const SrcDir = path.join(Root, "src");
const BuildDir = path.join(Root, "dist");

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

function Slash(rel) {
    return rel.replace(/\\/g, "/");
}

function FindStaleReason() {
    const Entry = path.join(BuildDir, "server.js");
    const EntryMtime = MtimeOrZero(Entry);
    if (EntryMtime === 0) return "dist/server.js is missing";

    for (const config of ["package.json", "tsconfig.json"]) {
        if (MtimeOrZero(path.join(Root, config)) > EntryMtime) return config + " is newer than dist/server.js";
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
            if (required) return "missing output for src/" + Slash(rel);
            continue;
        }
        if (MtimeOrZero(src) > OutMtime) return "src/" + Slash(rel) + " is newer than its output";
    }

    for (const out of ListFiles(BuildDir)) {
        const rel = path.relative(BuildDir, out);
        let src = null;
        if (out.endsWith(".js")) src = path.join(SrcDir, rel.slice(0, -3) + ".ts");
        else if (out.endsWith(".json")) src = path.join(SrcDir, rel);
        else continue;
        if (!fs.existsSync(src)) return "orphaned output dist/" + Slash(rel) + " has no source";
    }
    return null;
}

const Reason = FindStaleReason();
if (Reason === null) {
    console.log("[build-fresh] dist/ is up to date (every source file has a current output, no orphans) - starting as-is");
    process.exit(0);
}
console.log("[build-fresh] dist/ is STALE (" + Reason + ") - rebuilding before start");

const Npm = process.platform === "win32" ? "npm.cmd" : "npm";
const Result = spawnSync(Npm, ["run", "build"], { cwd: Root, stdio: "inherit", shell: process.platform === "win32" });
if (Result.status !== 0) {
    console.error("[build-fresh] build failed (exit " + Result.status + ") - refusing to start a stale build");
    process.exit(Result.status === null ? 1 : Result.status);
}
console.log("[build-fresh] rebuild complete");
