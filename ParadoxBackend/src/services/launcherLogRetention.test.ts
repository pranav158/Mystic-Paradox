import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DAY_MS } from "../legal/retentionPolicy";
import { NewTestDirectory, RemoveTestDirectory } from "../persistence/sqlite/testSupport";
import {
    ExpiredUploadedLogSessions,
    ListUploadedLogSessions,
    RemoveUploadedLogSessions,
    RemoveUploadedLogsOfAccount
} from "./launcherLogRetention";

// [2026-10-14] Uploaded launcher logs (routes/launcherLogs.ts layout: <root>/<accountId>/<launchSessionId>/files, .uploaded-at.json beside
// them). The folders live under a temporary folder in .test-sqlite.

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const ACCOUNT = "4f6a2d1e-0000-4000-8000-000000000001";
const OTHER = "4f6a2d1e-0000-4000-8000-000000000002";
const OLD_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW_SESSION = "bbbbbbbb-1111-2222-3333-444444444444";
const UNRECORDED = "cccccccc-1111-2222-3333-444444444444";

function WriteSession(root: string, userId: string, sessionId: string, lastUploadedAt: string | undefined): string {
    const Dir = path.join(root, userId, sessionId);
    fs.mkdirSync(Dir, { recursive: true });
    fs.writeFileSync(path.join(Dir, "launcher.log"), "log\n");
    if (lastUploadedAt !== undefined) {
        fs.writeFileSync(path.join(Dir, ".uploaded-at.json"), `${JSON.stringify({ lastUploadedAt })}\n`);
    }
    return Dir;
}

test("uploaded sessions are listed by their last upload; folders without plain names are ignored", () => {
    const Root = NewTestDirectory("launcher-logs");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, "2026-06-01T10:00:00.000Z");
        WriteSession(Root, ACCOUNT, NEW_SESSION, "2026-10-10T10:00:00.000Z");
        WriteSession(Root, OTHER, "not-a-session!", "2026-06-01T10:00:00.000Z");
        fs.mkdirSync(path.join(Root, "not a user"), { recursive: true });
        fs.writeFileSync(path.join(Root, "loose-file.txt"), "x");

        const Listed = ListUploadedLogSessions(Root).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
        assert.deepEqual(Listed.map((session) => [session.userId, session.sessionId]), [[ACCOUNT, OLD_SESSION], [ACCOUNT, NEW_SESSION]]);
        assert.equal(Listed[0].uploadedAtMs, Date.parse("2026-06-01T10:00:00.000Z"));
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("sessions whose last upload is past the retention period are expired; a session without a record uses its folder time", () => {
    const Root = NewTestDirectory("launcher-logs-expiry");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, "2026-06-01T10:00:00.000Z");
        WriteSession(Root, ACCOUNT, NEW_SESSION, "2026-10-10T10:00:00.000Z");
        const Unrecorded = WriteSession(Root, OTHER, UNRECORDED, undefined);
        const Ancient = new Date(NOW - 120 * DAY_MS);
        fs.utimesSync(Unrecorded, Ancient, Ancient);

        const Expired = ExpiredUploadedLogSessions(ListUploadedLogSessions(Root), NOW, 90).map((session) => session.sessionId).sort();
        assert.deepEqual(Expired, [OLD_SESSION, UNRECORDED].sort());
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("removing sessions deletes their folders only", () => {
    const Root = NewTestDirectory("launcher-logs-remove");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, "2026-06-01T10:00:00.000Z");
        WriteSession(Root, ACCOUNT, NEW_SESSION, "2026-10-10T10:00:00.000Z");
        const Expired = ExpiredUploadedLogSessions(ListUploadedLogSessions(Root), NOW, 90);
        assert.equal(RemoveUploadedLogSessions(Expired), 1);
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, OLD_SESSION)), false);
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, NEW_SESSION)), true);
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("an account's uploads are removed with the account, and an id that is not a plain folder name is refused", () => {
    const Root = NewTestDirectory("launcher-logs-account");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, "2026-06-01T10:00:00.000Z");
        WriteSession(Root, ACCOUNT, NEW_SESSION, "2026-10-10T10:00:00.000Z");
        WriteSession(Root, OTHER, NEW_SESSION, "2026-10-10T10:00:00.000Z");

        for (const Bad of ["..", "../" + OTHER, "a/b", "", "a b"]) {
            assert.throws(() => RemoveUploadedLogsOfAccount(Root, Bad), /plain folder name/, JSON.stringify(Bad));
        }
        assert.equal(fs.existsSync(path.join(Root, OTHER, NEW_SESSION)), true, "other accounts are never touched");

        assert.equal(RemoveUploadedLogsOfAccount(Root, ACCOUNT), 2);
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT)), false);
        assert.equal(RemoveUploadedLogsOfAccount(Root, ACCOUNT), 0, "removing twice is harmless");
        assert.equal(fs.existsSync(path.join(Root, OTHER, NEW_SESSION)), true);
    } finally {
        RemoveTestDirectory(Root);
    }
});
