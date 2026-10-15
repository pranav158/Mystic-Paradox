/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The admin player-log routes over HTTP (controllers/adminPlayerLogs.ts): the list and its query checks, one file (its type,
// ?download=1 and the refusals), and the delete with its audit record and the case where the audit write fails. The requests are signed as the
// manager signs them, through the real admin router, against a SQLite realm and a temporary upload root.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import express from "express";
import { UsePersistenceForTest } from "../persistence";
import { NewTestDirectory, OpenTestRealm, RemoveTestDirectory, TestRealm } from "../persistence/sqlite/testSupport";
import { adminRouter } from "../routes/admin";
import { CaptureAdminRawBody, ManagerOperatorSignature } from "../security/managerOperator";
import { UsePlayerLogsRootForTest } from "./adminPlayerLogs";

const SECRET = "player-logs-manager-secret-0123456789abcdef";
const OPERATOR = "555444333222111000";
const ENV_KEYS = ["MYSTICPARADOX_MANAGER_ADMIN", "MYSTICPARADOX_MANAGER_OPERATOR_SECRET"] as const;
const SAVED_ENV = new Map<string, string | undefined>();

const ACCOUNT = "4f6a2d1e-0000-4000-8000-000000000001";
const OTHER = "4f6a2d1e-0000-4000-8000-000000000002";
const OLD = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW = "bbbbbbbb-1111-2222-3333-444444444444";
const OTHER_SESSION = "eeeeeeee-1111-2222-3333-444444444444";

let Realm: TestRealm;
let Server: http.Server;
let Port = 0;
let Seq = 0;
let Root = "";

interface Reply {
    status: number;
    text: string;
    json: any;
    headers: http.IncomingHttpHeaders;
}

function SetEnv(values: Record<string, string>): void {
    for (const Key of ENV_KEYS) {
        if (!SAVED_ENV.has(Key)) SAVED_ENV.set(Key, process.env[Key]);
    }
    Object.assign(process.env, values);
}

function Send(method: string, target: string, headers: Record<string, string>, body?: Buffer): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: "127.0.0.1", port: Port, path: target, method, headers, agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json: any;
                try {
                    json = text.length > 0 ? JSON.parse(text) : undefined;
                } catch {
                    json = undefined;
                }
                resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
            });
        });
        request.on("error", reject);
        request.setTimeout(5000, () => request.destroy(new Error(`no answer: ${method} ${target}`)));
        if (body !== undefined) request.write(body);
        request.end();
    });
}

/** A target with a fresh `case` parameter: the manager signature is its own nonce, so no two requests may sign the same target. */
function Target(pathname: string, query = ""): string {
    Seq += 1;
    return `${pathname}?${query ? `${query}&` : ""}case=${Seq}`;
}

/** The headers the manager sends: operator id, timestamp and the HMAC over method, target, time, operator and body hash. */
function Signed(method: string, target: string, body?: Buffer): Record<string, string> {
    const Timestamp = String(Date.now());
    const BodyHash = crypto.createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex");
    const Canonical = [method, target, Timestamp, OPERATOR, BodyHash].join("\n");
    const Headers: Record<string, string> = {
        "x-paradox-operator-id": OPERATOR,
        "x-paradox-operator-name": "Pranav",
        "x-paradox-operator-timestamp": Timestamp,
        "x-paradox-operator-signature": ManagerOperatorSignature(SECRET, Canonical)
    };
    if (body !== undefined) {
        Headers["content-type"] = "application/json";
        Headers["content-length"] = String(body.length);
    }
    return Headers;
}

async function Admin(method: string, pathname: string, query = "", json?: unknown): Promise<Reply> {
    const Path = Target(pathname, query);
    const Body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    return Send(method, Path, Signed(method, Path, Body), Body);
}

function ExpectError(reply: Reply, status: number, code: string): void {
    assert.equal(reply.status, status, reply.text);
    assert.equal(reply.json?.error?.code, code, reply.text);
}

function WriteSession(userId: string, sessionId: string, lastUploadedAt: string, files: Record<string, string>): void {
    const Dir = path.join(Root, userId, sessionId);
    fs.mkdirSync(Dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(Dir, name), content);
    fs.writeFileSync(path.join(Dir, ".uploaded-at.json"), `${JSON.stringify({ lastUploadedAt })}\n`);
}

before(async () => {
    SetEnv({ MYSTICPARADOX_MANAGER_ADMIN: "on", MYSTICPARADOX_MANAGER_OPERATOR_SECRET: SECRET });
    Realm = OpenTestRealm("player-logs-routes");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    Root = NewTestDirectory("player-logs-routes-root");
    UsePlayerLogsRootForTest(Root);
    const App = express();
    App.use(express.json({ verify: CaptureAdminRawBody }));
    App.use("/", adminRouter);
    Server = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        Server.once("listening", () => resolve());
        Server.once("error", reject);
    });
    Port = (Server.address() as AddressInfo).port;
});

after(async () => {
    UsePlayerLogsRootForTest(undefined);
    UsePersistenceForTest(undefined);
    await new Promise<void>((resolve) => Server.close(() => resolve()));
    await Realm.cleanup();
    RemoveTestDirectory(Root);
    for (const Key of ENV_KEYS) {
        const Previous = SAVED_ENV.get(Key);
        if (Previous === undefined) delete process.env[Key];
        else process.env[Key] = Previous;
    }
});

beforeEach(() => {
    // Each test starts from the same three sessions: two for ACCOUNT (OLD, NEW) and one for OTHER.
    fs.rmSync(Root, { recursive: true, force: true });
    fs.mkdirSync(Root, { recursive: true });
    WriteSession(ACCOUNT, OLD, "2026-06-01T10:00:00.000Z", { "launcher.log": "old line\n", "metadata.json": "{\"v\":1}" });
    WriteSession(ACCOUNT, NEW, "2026-10-10T10:00:00.000Z", { "launcher.log": "new line\n" });
    WriteSession(OTHER, OTHER_SESSION, "2026-09-01T10:00:00.000Z", { "runtime-mysticparadox_dll_port8790.log": "runtime\n" });
});

// ---- list ----

test("the list is newest first across accounts, with nextBefore null on the last page", async () => {
    const Reply1 = await Admin("GET", "/admin/v1/player-logs");
    assert.equal(Reply1.status, 200, Reply1.text);
    assert.deepEqual(Reply1.json.sessions.map((session: any) => session.launchSessionId), [NEW, OTHER_SESSION, OLD]);
    assert.equal(Reply1.json.nextBefore, null);
    const Old = Reply1.json.sessions[2];
    assert.equal(Old.userId, ACCOUNT);
    assert.equal(Old.uploadedAt, "2026-06-01T10:00:00.000Z");
    assert.deepEqual(Old.files, [{ name: "launcher.log", size: 9 }, { name: "metadata.json", size: 7 }]);
    assert.equal(Old.totalBytes, 16);
    assert.equal(Reply1.headers["cache-control"], "no-store");
});

test("paging with limit and before walks the list without repeating a session", async () => {
    const Seen: string[] = [];
    let Before: string | undefined;
    for (let Page = 0; Page < 5; Page += 1) {
        const Query = Before === undefined ? "limit=1" : `limit=1&before=${encodeURIComponent(Before)}`;
        const Reply1 = await Admin("GET", "/admin/v1/player-logs", Query);
        assert.equal(Reply1.status, 200, Reply1.text);
        for (const session of Reply1.json.sessions) Seen.push(session.launchSessionId);
        if (Reply1.json.nextBefore === null) break;
        Before = Reply1.json.nextBefore;
    }
    assert.deepEqual(Seen, [NEW, OTHER_SESSION, OLD]);
});

test("the userId filter lists one account's sessions", async () => {
    const Reply1 = await Admin("GET", "/admin/v1/player-logs", `userId=${ACCOUNT}`);
    assert.equal(Reply1.status, 200);
    assert.deepEqual(Reply1.json.sessions.map((session: any) => session.launchSessionId), [NEW, OLD]);
});

test("the list refuses a bad limit, a bad before, a repeated or unsafe userId", async () => {
    for (const Query of ["limit=0", "limit=201", "limit=ten", "limit=1.5", "before=yesterday", "before=2026-10-15", "userId=..", "userId=a%2Fb"]) {
        ExpectError(await Admin("GET", "/admin/v1/player-logs", Query), 400, "PLAYER_LOGS_QUERY");
    }
    ExpectError(await Admin("GET", "/admin/v1/player-logs", "userId=a&userId=b"), 400, "PLAYER_LOGS_QUERY");
});

test("the list needs the manager's signature (or a session cookie): an unsigned request is refused", async () => {
    const Reply1 = await Send("GET", Target("/admin/v1/player-logs"), {});
    assert.equal(Reply1.status, 401);
    assert.equal(Reply1.json?.error?.code, "ADMIN_UNAUTHORIZED");
});

// ---- one file ----

test("a file is served as text, metadata.json as JSON, and only ?download=1 adds the attachment header", async () => {
    const Log = await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/${OLD}/launcher.log`);
    assert.equal(Log.status, 200, Log.text);
    assert.equal(Log.text, "old line\n");
    assert.equal(Log.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(Log.headers["content-disposition"], undefined);
    assert.equal(Log.headers["x-content-type-options"], "nosniff");

    const Meta = await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/${OLD}/metadata.json`);
    assert.equal(Meta.status, 200);
    assert.equal(Meta.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(Meta.json.v, 1);

    const Download = await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/${OLD}/launcher.log`, "download=1");
    assert.equal(Download.status, 200);
    assert.equal(Download.headers["content-disposition"], "attachment; filename=\"launcher.log\"");

    ExpectError(await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/${OLD}/launcher.log`, "download=yes"), 400, "PLAYER_LOGS_QUERY");
});

test("a file read refuses a name that is not the launcher's, a traversal attempt, and a missing file or session", async () => {
    ExpectError(await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/${OLD}/.uploaded-at.json`), 400, "PLAYER_LOG_NAME_REFUSED");
    ExpectError(await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/${OLD}/secret.txt`), 400, "PLAYER_LOG_NAME_REFUSED");
    ExpectError(await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/..%2F..%2Fsecret/launcher.log`), 400, "PLAYER_LOG_PATH");
    ExpectError(await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/${OLD}/..%2F..%2Fsecret.log`), 400, "PLAYER_LOG_PATH");
    ExpectError(await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/cccccccc-0000-0000-0000-000000000000/launcher.log`), 404, "PLAYER_LOG_NOT_FOUND");
    ExpectError(await Admin("GET", `/admin/v1/player-logs/${ACCOUNT}/${NEW}/metadata.json`), 404, "PLAYER_LOG_NOT_FOUND");
});

// ---- delete ----

test("a delete needs a reason of 8 to 200 characters and removes nothing without one", async () => {
    ExpectError(await Admin("DELETE", `/admin/v1/player-logs/${ACCOUNT}/${OLD}`, "", {}), 400, "PLAYER_LOG_REASON");
    ExpectError(await Admin("DELETE", `/admin/v1/player-logs/${ACCOUNT}/${OLD}`, "", { reason: "short1" }), 400, "PLAYER_LOG_REASON");
    ExpectError(await Admin("DELETE", `/admin/v1/player-logs/${ACCOUNT}/${OLD}`, "", { reason: "x".repeat(201) }), 400, "PLAYER_LOG_REASON");
    assert.equal(fs.existsSync(path.join(Root, ACCOUNT, OLD)), true, "the session is still there");
});

test("a delete removes the session and writes the player_logs.delete audit record; a second delete finds nothing", async () => {
    const Reason = "Tester asked for the upload to be removed";
    const Reply1 = await Admin("DELETE", `/admin/v1/player-logs/${ACCOUNT}/${OLD}`, "", { reason: Reason });
    assert.equal(Reply1.status, 200, Reply1.text);
    assert.equal(Reply1.json.deleted, true);
    assert.equal(Reply1.json.files, 2);
    assert.equal(Reply1.json.totalBytes, 16);
    assert.equal(fs.existsSync(path.join(Root, ACCOUNT, OLD)), false);
    assert.equal(fs.existsSync(path.join(Root, ACCOUNT, NEW)), true, "the other session is untouched");

    const Audit = await Realm.repos.admin.listAudit(ACCOUNT, 0, 20);
    const Record = Audit.records.find((entry) => entry.action === "player_logs.delete");
    assert.ok(Record, "the audit record exists");
    assert.equal(Record.targetUserId, ACCOUNT);
    assert.equal(Record.actorUserId, `manager:${OPERATOR}`);
    assert.equal(Record.reason, Reason);
    assert.equal(Record.requestId, Reply1.json.requestId);
    assert.deepEqual(Record.newState, { deleted: true });
    assert.equal((Record.oldState as any).launchSessionId, OLD);
    assert.equal((Record.oldState as any).files.length, 2);

    const Again = await Admin("DELETE", `/admin/v1/player-logs/${ACCOUNT}/${OLD}`, "", { reason: Reason });
    ExpectError(Again, 404, "PLAYER_LOG_NOT_FOUND");
    const AfterAgain = await Realm.repos.admin.listAudit(ACCOUNT, 0, 20);
    assert.equal(AfterAgain.records.filter((entry) => entry.action === "player_logs.delete").length, 1, "a refused delete writes no audit record");
});

test("when the audit record cannot be written, the answer says so (500) and the session stays removed", async () => {
    const Admin_ = Realm.repos.admin;
    const Original = Admin_.appendAudit.bind(Admin_);
    Admin_.appendAudit = async () => { throw new Error("audit store unavailable"); };
    try {
        const Reply1 = await Admin("DELETE", `/admin/v1/player-logs/${OTHER}/${OTHER_SESSION}`, "", { reason: "Removed after a support request" });
        ExpectError(Reply1, 500, "PLAYER_LOG_AUDIT_FAILED");
        assert.ok(typeof Reply1.json.requestId === "string");
        assert.equal(fs.existsSync(path.join(Root, OTHER, OTHER_SESSION)), false, "the removal happened, and the answer says the audit failed");
    } finally {
        Admin_.appendAudit = Original;
    }
});
