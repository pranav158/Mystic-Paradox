import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DAY_MS } from "../legal/retentionPolicy";
import { NewTestDirectory, RemoveTestDirectory } from "../persistence/sqlite/testSupport";
import {
    ExpiredServerLogArchives,
    RotateServerLogAtStart,
    ServerLogArchiveName,
    ServerLogRetentionDays,
    ShouldRotateServerLog
} from "./logFileRotation";

// [2026-10-14] Server log retention (Privacy Policy section 5). The files live in a temporary folder under .test-sqlite; nothing here
// touches debug/metagame/metagame.log.

const NOW = Date.parse("2026-10-14T12:30:05.000Z");
const EARLIER_TODAY = NOW - 60_000;
const YESTERDAY = Date.parse("2026-10-13T23:59:00.000Z");

test("every server start archives a previous log that has content, including a same-day restart", () => {
    assert.equal(ShouldRotateServerLog({ size: 1 }), true);
    assert.equal(ShouldRotateServerLog({ size: 1000 }), true);
    assert.equal(ShouldRotateServerLog({ size: 0 }), false);
});

test("archive names are the UTC date and time, Windows-safe, and never reuse a taken name", () => {
    assert.equal(ServerLogArchiveName(NOW, () => false), "metagame-20261014-123005.log");
    const Taken = new Set(["metagame-20261014-123005.log", "metagame-20261014-123005-2.log"]);
    assert.equal(ServerLogArchiveName(NOW, (name) => Taken.has(name)), "metagame-20261014-123005-3.log");
});

test("only archive files older than the retention period are chosen; other names are never", () => {
    const Old = NOW - 91 * DAY_MS;
    const Fresh = NOW - 10 * DAY_MS;
    const Entries = [
        { name: "metagame-20260701-010101.log", mtimeMs: Old },
        { name: "metagame-20261001-010101.log", mtimeMs: Fresh },
        { name: "metagame.log", mtimeMs: Old },
        { name: "metagame-notes.log", mtimeMs: Old },
        { name: "metagame-20260701-010101.txt", mtimeMs: Old },
        { name: "other.log", mtimeMs: Old }
    ];
    assert.deepEqual(ExpiredServerLogArchives(Entries, NOW, 90), ["metagame-20260701-010101.log"]);
    assert.deepEqual(ExpiredServerLogArchives(Entries, NOW, 365), []);
});

test("MYSTICPARADOX_LOG_RETENTION_DAYS is a whole number of days of at least 1, 90 otherwise", () => {
    assert.equal(ServerLogRetentionDays({} as NodeJS.ProcessEnv), 90);
    assert.equal(ServerLogRetentionDays({ MYSTICPARADOX_LOG_RETENTION_DAYS: "30" } as NodeJS.ProcessEnv), 30);
    assert.equal(ServerLogRetentionDays({ MYSTICPARADOX_LOG_RETENTION_DAYS: " 7 " } as NodeJS.ProcessEnv), 7);
    for (const Bad of ["", "0", "-5", "1.5", "soon"]) {
        assert.equal(ServerLogRetentionDays({ MYSTICPARADOX_LOG_RETENTION_DAYS: Bad } as NodeJS.ProcessEnv), 90, Bad);
    }
});

test("a due live log is archived before it is reopened, and expired archives are deleted", () => {
    const Dir = NewTestDirectory("log-rotation");
    try {
        const Live = path.join(Dir, "metagame.log");
        fs.writeFileSync(Live, "previous run\n");
        fs.utimesSync(Live, new Date(YESTERDAY), new Date(YESTERDAY));

        const Expired = "metagame-20260601-000000.log";
        fs.writeFileSync(path.join(Dir, Expired), "old");
        fs.utimesSync(path.join(Dir, Expired), new Date(NOW - 100 * DAY_MS), new Date(NOW - 100 * DAY_MS));
        const Kept = "metagame-20261012-000000.log";
        fs.writeFileSync(path.join(Dir, Kept), "recent");
        fs.utimesSync(path.join(Dir, Kept), new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS));
        fs.writeFileSync(path.join(Dir, "metagame-notes.txt"), "not a log");
        fs.utimesSync(path.join(Dir, "metagame-notes.txt"), new Date(NOW - 200 * DAY_MS), new Date(NOW - 200 * DAY_MS));

        const Result = RotateServerLogAtStart(Live, NOW, 90);
        assert.equal(Result.rotatedTo, "metagame-20261014-123005.log");
        assert.equal(fs.existsSync(Live), false, "the live name is free for the new run");
        assert.equal(fs.readFileSync(path.join(Dir, Result.rotatedTo!), "utf8"), "previous run\n");
        assert.deepEqual(Result.deleted, [Expired]);
        assert.equal(fs.existsSync(path.join(Dir, Kept)), true);
        assert.equal(fs.existsSync(path.join(Dir, "metagame-notes.txt")), true);
    } finally {
        RemoveTestDirectory(Dir);
    }
});

test("a same-day restart archives the earlier run too; an empty log or no log at all is left alone", () => {
    const Dir = NewTestDirectory("log-rotation-same-day");
    try {
        const Live = path.join(Dir, "metagame.log");
        assert.deepEqual(RotateServerLogAtStart(Live, NOW, 90), { deleted: [] }, "no log yet");
        fs.writeFileSync(Live, "");
        assert.deepEqual(RotateServerLogAtStart(Live, NOW, 90), { deleted: [] }, "empty log");
        fs.writeFileSync(Live, "earlier today\n");
        fs.utimesSync(Live, new Date(EARLIER_TODAY), new Date(EARLIER_TODAY));
        const Result = RotateServerLogAtStart(Live, NOW, 90);
        assert.equal(Result.rotatedTo, "metagame-20261014-123005.log");
        assert.equal(fs.readFileSync(path.join(Dir, Result.rotatedTo!), "utf8"), "earlier today\n");
        assert.equal(fs.existsSync(Live), false);
    } finally {
        RemoveTestDirectory(Dir);
    }
});
