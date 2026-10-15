/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The admin view of the uploaded launcher logs (services/playerLogs.ts): the listing and its paging, the reads and their
// refusals, the links that are never followed, and the delete. Each test writes its own folders under a temporary root.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { NewTestDirectory, RemoveTestDirectory } from "../persistence/sqlite/testSupport";
import {
    DeletePlayerLogSession,
    ListPlayerLogSessions,
    PLAYER_LOG_FILE_MAX_BYTES,
    PlayerLogFileBytes,
    PlayerLogRefusal,
    ReadPlayerLogFile
} from "./playerLogs";

const ACCOUNT = "4f6a2d1e-0000-4000-8000-000000000001";
const OTHER = "4f6a2d1e-0000-4000-8000-000000000002";
const OLD_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW_SESSION = "bbbbbbbb-1111-2222-3333-444444444444";
const SAME_A = "cccccccc-1111-2222-3333-444444444444";
const SAME_B = "dddddddd-1111-2222-3333-444444444444";
const OTHER_SESSION = "eeeeeeee-1111-2222-3333-444444444444";

const T_OLD = "2026-06-01T10:00:00.000Z";
const T_SAME = "2026-09-01T10:00:00.000Z";
const T_NEW = "2026-10-10T10:00:00.000Z";

type Files = Record<string, string | Buffer>;

function WriteSession(root: string, userId: string, sessionId: string, lastUploadedAt: string | undefined, files: Files = { "launcher.log": "line one\n" }): string {
    const Dir = path.join(root, userId, sessionId);
    fs.mkdirSync(Dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(Dir, name), content);
    if (lastUploadedAt !== undefined) fs.writeFileSync(path.join(Dir, ".uploaded-at.json"), `${JSON.stringify({ lastUploadedAt })}\n`);
    return Dir;
}

/** A symbolic link (a junction for a folder on Windows, which needs no privilege), or false when the system refuses one. */
function TryLink(target: string, link: string, type: "dir" | "file"): boolean {
    try {
        fs.symlinkSync(target, link, type === "dir" ? "junction" : "file");
        return true;
    } catch {
        return false;
    }
}

function IsRefusal(value: unknown): value is PlayerLogRefusal {
    return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function AsFile(value: unknown): PlayerLogFileBytes {
    assert.ok(!IsRefusal(value), `expected the file, got a refusal: ${JSON.stringify(value)}`);
    return value as PlayerLogFileBytes;
}

function Expect(value: unknown, status: number, code: string): void {
    assert.ok(IsRefusal(value), `expected a refusal, got ${JSON.stringify(value)}`);
    assert.equal(value.status, status, JSON.stringify(value));
    assert.equal(value.code, code, JSON.stringify(value));
}

test("the list is newest first across accounts, with only the launcher's files and their sizes", () => {
    const Root = NewTestDirectory("player-logs-list");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, T_OLD, { "launcher.log": "abc", "metadata.json": "{}", "notes.txt": "not ours" });
        WriteSession(Root, OTHER, NEW_SESSION, T_NEW, { "runtime-mysticparadox_dll_port8790.log": "12345" });

        const Page = ListPlayerLogSessions(Root, { limit: 50 });
        assert.deepEqual(Page.sessions.map((session) => [session.userId, session.launchSessionId]), [[OTHER, NEW_SESSION], [ACCOUNT, OLD_SESSION]]);
        assert.equal(Page.nextBefore, null, "a page that holds every session has no next page");
        assert.equal(Page.sessions[0].uploadedAt, T_NEW);
        assert.deepEqual(Page.sessions[0].files, [{ name: "runtime-mysticparadox_dll_port8790.log", size: 5 }]);
        assert.equal(Page.sessions[0].totalBytes, 5);
        assert.deepEqual(Page.sessions[1].files, [{ name: "launcher.log", size: 3 }, { name: "metadata.json", size: 2 }], "notes.txt and the marker are not listed");
        assert.equal(Page.sessions[1].totalBytes, 5);
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("the userId filter reads one account only, and an unsafe account id lists nothing", () => {
    const Root = NewTestDirectory("player-logs-filter");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, T_OLD);
        WriteSession(Root, OTHER, NEW_SESSION, T_NEW);
        assert.deepEqual(ListPlayerLogSessions(Root, { userId: ACCOUNT, limit: 50 }).sessions.map((session) => session.launchSessionId), [OLD_SESSION]);
        assert.deepEqual(ListPlayerLogSessions(Root, { userId: "..", limit: 50 }).sessions, []);
        assert.deepEqual(ListPlayerLogSessions(Root, { userId: "a/b", limit: 50 }).sessions, []);
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("paging walks every session exactly once, and a page never splits sessions that share an upload time", () => {
    const Root = NewTestDirectory("player-logs-paging");
    try {
        // Four sessions: one newest, two that share the same upload time, one oldest.
        WriteSession(Root, ACCOUNT, OLD_SESSION, T_OLD);
        WriteSession(Root, ACCOUNT, SAME_A, T_SAME);
        WriteSession(Root, OTHER, SAME_B, T_SAME);
        WriteSession(Root, ACCOUNT, NEW_SESSION, T_NEW);

        const Seen: string[] = [];
        let Before: number | undefined;
        let Pages = 0;
        for (;;) {
            const Page = ListPlayerLogSessions(Root, { limit: 2, before: Before });
            Pages += 1;
            assert.ok(Pages < 10, "paging must end");
            for (const session of Page.sessions) Seen.push(session.launchSessionId);
            if (Page.nextBefore === null) break;
            Before = Date.parse(Page.nextBefore);
        }
        assert.equal(new Set(Seen).size, 4, `every session once: ${Seen.join(",")}`);
        assert.equal(Seen.length, 4);
        assert.equal(Seen[0], NEW_SESSION);
        assert.equal(Seen[3], OLD_SESSION);
        assert.equal(Pages, 2, "the two same-time sessions land on the same page");
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("the before cursor keeps only the sessions uploaded strictly earlier", () => {
    const Root = NewTestDirectory("player-logs-before");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, T_OLD);
        WriteSession(Root, ACCOUNT, SAME_A, T_SAME);
        WriteSession(Root, ACCOUNT, NEW_SESSION, T_NEW);
        const Page = ListPlayerLogSessions(Root, { limit: 50, before: Date.parse(T_SAME) });
        assert.deepEqual(Page.sessions.map((session) => session.launchSessionId), [OLD_SESSION]);
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("reading returns the bytes as text, and metadata.json as JSON", () => {
    const Root = NewTestDirectory("player-logs-read");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, T_OLD, { "launcher.log": "hello launcher\n", "metadata.json": "{\"v\":1}" });
        const Log = AsFile(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, "launcher.log"));
        assert.equal(Log.bytes.toString("utf8"), "hello launcher\n");
        assert.equal(Log.contentType, "text/plain; charset=utf-8");
        const Meta = AsFile(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, "metadata.json"));
        assert.equal(Meta.contentType, "application/json; charset=utf-8");
        assert.equal(Meta.name, "metadata.json");
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("reads refuse unsafe segments, names that are not the launcher's, and sessions or files that are missing", () => {
    const Root = NewTestDirectory("player-logs-refuse");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, T_OLD, { "launcher.log": "x" });
        Expect(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, "../../secret.log"), 400, "PLAYER_LOG_PATH");
        Expect(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, ".."), 400, "PLAYER_LOG_PATH");
        Expect(ReadPlayerLogFile(Root, ACCOUNT, "..", "launcher.log"), 400, "PLAYER_LOG_PATH");
        Expect(ReadPlayerLogFile(Root, "a/b", OLD_SESSION, "launcher.log"), 400, "PLAYER_LOG_PATH");
        Expect(ReadPlayerLogFile(Root, ACCOUNT, "not-a-session!", "launcher.log"), 400, "PLAYER_LOG_PATH");
        Expect(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, ".uploaded-at.json"), 400, "PLAYER_LOG_NAME_REFUSED");
        Expect(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, "secret.txt"), 400, "PLAYER_LOG_NAME_REFUSED");
        Expect(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, "runtime-mysticparadox_dll_port.log"), 400, "PLAYER_LOG_NAME_REFUSED");
        Expect(ReadPlayerLogFile(Root, ACCOUNT, NEW_SESSION, "launcher.log"), 404, "PLAYER_LOG_NOT_FOUND");
        Expect(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, "metadata.json"), 404, "PLAYER_LOG_NOT_FOUND");
        Expect(ReadPlayerLogFile(path.join(Root, "missing-root"), ACCOUNT, OLD_SESSION, "launcher.log"), 404, "PLAYER_LOG_NOT_FOUND");
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("a file above the admin view's limit is refused with 413, and one at the limit is served", () => {
    const Root = NewTestDirectory("player-logs-size");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, T_OLD, { "launcher.log": Buffer.alloc(PLAYER_LOG_FILE_MAX_BYTES + 1, 0x61) });
        Expect(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, "launcher.log"), 413, "PLAYER_LOG_TOO_LARGE");
        WriteSession(Root, ACCOUNT, NEW_SESSION, T_NEW, { "launcher.log": Buffer.alloc(PLAYER_LOG_FILE_MAX_BYTES, 0x61) });
        assert.equal(AsFile(ReadPlayerLogFile(Root, ACCOUNT, NEW_SESSION, "launcher.log")).bytes.length, PLAYER_LOG_FILE_MAX_BYTES);
    } finally {
        RemoveTestDirectory(Root);
    }
});

test("a session folder that is a link is neither listed nor read nor deleted through the link", (t) => {
    const Root = NewTestDirectory("player-logs-link-dir");
    const Outside = NewTestDirectory("player-logs-link-target");
    try {
        WriteSession(Outside, OTHER, OTHER_SESSION, T_NEW, { "launcher.log": "outside" });
        fs.mkdirSync(path.join(Root, ACCOUNT), { recursive: true });
        if (!TryLink(path.join(Outside, OTHER, OTHER_SESSION), path.join(Root, ACCOUNT, OLD_SESSION), "dir")) {
            t.skip("this system refuses to create a folder link");
            return;
        }
        assert.deepEqual(ListPlayerLogSessions(Root, { limit: 50 }).sessions, [], "the linked folder is not listed");
        Expect(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, "launcher.log"), 404, "PLAYER_LOG_NOT_FOUND");
        Expect(DeletePlayerLogSession(Root, ACCOUNT, OLD_SESSION), 404, "PLAYER_LOG_NOT_FOUND");
        assert.equal(fs.readFileSync(path.join(Outside, OTHER, OTHER_SESSION, "launcher.log"), "utf8"), "outside", "the target is untouched");
    } finally {
        RemoveTestDirectory(Root);
        RemoveTestDirectory(Outside);
    }
});

test("a file that is a link is not listed and not served", (t) => {
    const Root = NewTestDirectory("player-logs-link-file");
    const Outside = NewTestDirectory("player-logs-link-file-target");
    try {
        const Dir = WriteSession(Root, ACCOUNT, OLD_SESSION, T_OLD, { "metadata.json": "{}" });
        fs.writeFileSync(path.join(Outside, "secret.txt"), "outside");
        if (!TryLink(path.join(Outside, "secret.txt"), path.join(Dir, "launcher.log"), "file")) {
            t.skip("this system refuses to create a file link");
            return;
        }
        assert.deepEqual(ListPlayerLogSessions(Root, { limit: 50 }).sessions[0].files.map((file) => file.name), ["metadata.json"]);
        Expect(ReadPlayerLogFile(Root, ACCOUNT, OLD_SESSION, "launcher.log"), 404, "PLAYER_LOG_NOT_FOUND");
    } finally {
        RemoveTestDirectory(Root);
        RemoveTestDirectory(Outside);
    }
});

test("delete removes that session folder, reports what it held, and leaves the other sessions alone", () => {
    const Root = NewTestDirectory("player-logs-delete");
    try {
        WriteSession(Root, ACCOUNT, OLD_SESSION, T_OLD, { "launcher.log": "12345", "metadata.json": "{}" });
        WriteSession(Root, ACCOUNT, NEW_SESSION, T_NEW);
        const Removed = DeletePlayerLogSession(Root, ACCOUNT, OLD_SESSION);
        assert.ok(!IsRefusal(Removed));
        assert.equal(Removed.session.uploadedAt, T_OLD);
        assert.deepEqual(Removed.session.files, [{ name: "launcher.log", size: 5 }, { name: "metadata.json", size: 2 }]);
        assert.equal(Removed.session.totalBytes, 7);
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, OLD_SESSION)), false);
        assert.equal(fs.existsSync(path.join(Root, ACCOUNT, NEW_SESSION)), true);
        Expect(DeletePlayerLogSession(Root, ACCOUNT, OLD_SESSION), 404, "PLAYER_LOG_NOT_FOUND");
        Expect(DeletePlayerLogSession(Root, "../x", OLD_SESSION), 400, "PLAYER_LOG_PATH");
    } finally {
        RemoveTestDirectory(Root);
    }
});
