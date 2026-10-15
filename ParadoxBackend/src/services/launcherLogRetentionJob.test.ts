/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The automatic pass over the uploaded launcher logs (services/launcherLogRetention.ts): one pass and its counts, a removal that
// fails, the two timers (unref-ed, one pass shortly after start and then every six hours), the switch, and the rule that the log lines name
// no account and no session. The timers are fakes, so nothing waits.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { NewTestDirectory, RemoveTestDirectory } from "../persistence/sqlite/testSupport";
import {
    PurgeExpiredUploadedLogs,
    ReadUploadedLogRetentionSwitch,
    StartUploadedLogRetention,
    UPLOADED_LOG_RETENTION_FIRST_PASS_MS,
    UPLOADED_LOG_RETENTION_INTERVAL_MS,
    UPLOADED_LOG_RETENTION_SWITCH_KEY,
    UploadedLogRetentionTimers
} from "./launcherLogRetention";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const ACCOUNT = "4f6a2d1e-0000-4000-8000-000000000001";
const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
const RECENT = "bbbbbbbb-1111-2222-3333-444444444444";
const OLDER = "cccccccc-1111-2222-3333-444444444444";

function WriteSession(root: string, sessionId: string, lastUploadedAt: string): string {
    const Dir = path.join(root, ACCOUNT, sessionId);
    fs.mkdirSync(Dir, { recursive: true });
    fs.writeFileSync(path.join(Dir, "launcher.log"), "line\n");
    fs.writeFileSync(path.join(Dir, ".uploaded-at.json"), `${JSON.stringify({ lastUploadedAt })}\n`);
    return Dir;
}

function SeedThree(root: string): void {
    WriteSession(root, OLD, "2026-06-01T10:00:00.000Z");
    WriteSession(root, RECENT, "2026-10-10T10:00:00.000Z");
    WriteSession(root, OLDER, "2026-05-01T10:00:00.000Z");
}

interface FakeTimer {
    kind: "timeout" | "interval";
    ms: number;
    callback: () => void;
    unrefCalled: boolean;
    cleared: boolean;
}

interface FakeHandle {
    timer: FakeTimer;
    unref(): FakeHandle;
}

/** Timers that record what was asked of them and run only when the test calls their callback. */
function FakeTimers(): { timers: UploadedLogRetentionTimers; made: FakeTimer[] } {
    const made: FakeTimer[] = [];
    const handleOf = (timer: FakeTimer): FakeHandle => {
        const handle: FakeHandle = { timer, unref: () => { timer.unrefCalled = true; return handle; } };
        return handle;
    };
    const create = (kind: FakeTimer["kind"], callback: () => void, ms: number): FakeHandle => {
        const timer: FakeTimer = { kind, ms, callback, unrefCalled: false, cleared: false };
        made.push(timer);
        return handleOf(timer);
    };
    const timers: UploadedLogRetentionTimers = {
        setTimeout: (callback, ms) => create("timeout", callback, ms),
        clearTimeout: (handle) => { (handle as FakeHandle).timer.cleared = true; },
        setInterval: (callback, ms) => create("interval", callback, ms),
        clearInterval: (handle) => { (handle as FakeHandle).timer.cleared = true; },
    };
    return { timers, made };
}

test("one pass removes the sessions past the period, keeps the rest, and reports counts only", () => {
    const Root = NewTestDirectory("log-pass");
    try {
        SeedThree(Root);
        const Pass = PurgeExpiredUploadedLogs(Root, NOW, 90);
        assert.deepEqual(Pass, { checked: 3, expired: 2, removed: 2, failed: 0, failureCodes: [] });
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, OLD)), false);
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, OLDER)), false);
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, RECENT)), true);
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("a removal that fails is counted by its error code, and the pass goes on with the rest", () => {
    const Root = NewTestDirectory("log-pass-failure");
    try {
        SeedThree(Root);
        const Pass = PurgeExpiredUploadedLogs(Root, NOW, 90, (dir) => {
            if (dir.endsWith(OLD)) {
                throw Object.assign(new Error(`EBUSY: resource busy, rm '${dir}'`), { code: "EBUSY" });
            }
            fs.rmSync(dir, { recursive: true, force: true });
        });
        assert.deepEqual(Pass, { checked: 3, expired: 2, removed: 1, failed: 1, failureCodes: ["EBUSY"] });
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, OLD)), true, "the session that could not be removed stays");
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, OLDER)), false, "the pass went on to the next one");
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("the switch reads off in any case, keeps blank and on as on, and reports any other value", () => {
    const Key = UPLOADED_LOG_RETENTION_SWITCH_KEY;
    assert.equal(Key, "MYSTICPARADOX_LOG_RETENTION");
    assert.deepEqual(ReadUploadedLogRetentionSwitch({}), { enabled: true, unrecognised: false });
    assert.deepEqual(ReadUploadedLogRetentionSwitch({ [Key]: "" }), { enabled: true, unrecognised: false });
    assert.deepEqual(ReadUploadedLogRetentionSwitch({ [Key]: " On " }), { enabled: true, unrecognised: false });
    assert.deepEqual(ReadUploadedLogRetentionSwitch({ [Key]: "off" }), { enabled: false, unrecognised: false });
    assert.deepEqual(ReadUploadedLogRetentionSwitch({ [Key]: " OFF " }), { enabled: false, unrecognised: false });
    assert.deepEqual(ReadUploadedLogRetentionSwitch({ [Key]: "maybe" }), { enabled: true, unrecognised: true });
});

test("the automatic pass starts two unref-ed timers: one pass about a minute after start, then every six hours", () => {
    const Root = NewTestDirectory("log-job-timers");
    try {
        WriteSession(Root, OLD, "2026-06-01T10:00:00.000Z");
        const Lines: string[] = [];
        const { timers, made } = FakeTimers();
        const Job = StartUploadedLogRetention({ root: Root, log: (line) => Lines.push(line), now: () => NOW, timers }, {});
        assert.ok(Job, "on by default");
        assert.equal(UPLOADED_LOG_RETENTION_FIRST_PASS_MS, 60_000);
        assert.equal(UPLOADED_LOG_RETENTION_INTERVAL_MS, 6 * 60 * 60 * 1000);
        assert.deepEqual(made.map((timer) => [timer.kind, timer.ms]), [["timeout", 60_000], ["interval", 6 * 60 * 60 * 1000]]);
        assert.ok(made.every((timer) => timer.unrefCalled), "neither timer keeps the process alive");
        assert.equal(Lines.length, 1, "one line at start");
        assert.match(Lines[0], /removed 90 days after their last upload; first pass in 60 s, then every 6 h/);

        made[0].callback();
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, OLD)), false, "the expired session was removed by the pass");
        assert.equal(Lines.length, 2);
        assert.equal(Lines[1], "[LogRetention] uploaded launcher logs: checked 1, older than 90 days 1, removed 1, failed 0");
        assert.ok(!Lines.some((line) => line.includes(ACCOUNT) || line.includes(OLD)), "no log line names an account or a session");

        Job.stop();
        assert.ok(made.every((timer) => timer.cleared), "stop clears both timers");
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("MYSTICPARADOX_LOG_RETENTION=off starts no timer and says so once", () => {
    const Lines: string[] = [];
    const { timers, made } = FakeTimers();
    const Job = StartUploadedLogRetention({ root: path.join("does", "not", "exist"), log: (line) => Lines.push(line), timers },
        { [UPLOADED_LOG_RETENTION_SWITCH_KEY]: " OFF " });
    assert.equal(Job, undefined);
    assert.equal(made.length, 0);
    assert.equal(Lines.length, 1);
    assert.match(Lines[0], /automatic purge of uploaded launcher logs is off \(MYSTICPARADOX_LOG_RETENTION=off\)/);
});

test("an unrecognised switch value keeps the purge on and says so before the first line", () => {
    const Root = NewTestDirectory("log-job-switch");
    try {
        const Lines: string[] = [];
        const { timers, made } = FakeTimers();
        const Job = StartUploadedLogRetention({ root: Root, log: (line) => Lines.push(line), timers }, { [UPLOADED_LOG_RETENTION_SWITCH_KEY]: "maybe" });
        assert.ok(Job);
        assert.equal(made.length, 2);
        assert.match(Lines[0], /is neither off nor on; the automatic purge stays on/);
        assert.equal(Lines.length, 2, "the warning, then the start line");
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("a pass that cannot read the root logs one line with the error code and keeps its timers", () => {
    const Root = NewTestDirectory("log-job-unreadable");
    try {
        const NotAFolder = path.join(Root, "file-not-folder");
        fs.writeFileSync(NotAFolder, "x");
        const Lines: string[] = [];
        const { timers, made } = FakeTimers();
        StartUploadedLogRetention({ root: NotAFolder, log: (line) => Lines.push(line), timers }, {});
        made[0].callback();
        assert.equal(Lines.length, 2);
        assert.match(Lines[1], /^\[LogRetention\] uploaded launcher logs: the pass could not run \([A-Z0-9_]+\)$/);
        assert.equal(made.some((timer) => timer.cleared), false, "the timers keep running");
    } finally {
        RemoveTestDirectory(Root);
    }
});
