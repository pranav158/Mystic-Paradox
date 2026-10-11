/*
 * [2026-10-10] "npm run clean": deletes dist/ so tsc cannot leave orphaned output behind (see ensure-build-fresh.cjs).
 *
 * Not a bare fs.rmSync("dist", { recursive: true }): on Windows a RUNNING Director keeps some of its dist files
 * undeletable (measured 10 Oct: EPERM on dist/server.js, dist/runtimeUpdater.js and dist/vendor/*.json while the
 * local stack ran). rmSync then aborted halfway, "npm run build" stopped before tsc, and dist was left half
 * deleted - the next start would have failed. This removes what it can, lists what it could not, and always lets
 * tsc run; tsc can still overwrite a locked file in place. A locked ORPHAN survives until the Director stops, and
 * the next prestart check reports it.
 */
const fs = require("fs");
const path = require("path");

const Dist = path.join(__dirname, "..", "dist");
const Locked = [];

function Remove(target) {
    let stat;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (stat.isDirectory()) {
        for (const name of fs.readdirSync(target)) Remove(path.join(target, name));
        try { fs.rmdirSync(target); } catch { /* not empty: it holds a locked file */ }
        return;
    }
    try {
        fs.unlinkSync(target);
    } catch (error) {
        if (error && (error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES")) Locked.push(path.relative(Dist, target));
        else throw error;
    }
}

Remove(Dist);
if (Locked.length > 0) {
    console.warn(`[clean] ${Locked.length} file(s) in dist/ are in use (is the Director running?) and were left for tsc to overwrite: ${Locked.slice(0, 10).map((rel) => rel.replace(/\\/g, "/")).join(", ")}${Locked.length > 10 ? ", ..." : ""}`);
}
