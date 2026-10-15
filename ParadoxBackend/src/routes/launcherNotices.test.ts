/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The launcher notices over HTTP: the public GET (shape, cache header, the active items only, the empty set and one log line on a
// store read error) and the manager's GET and PUT through the real admin router, signed as the manager signs them (the manager operator
// credential, security/managerOperator.ts). Checked: the version conflict, the refusals and their field names, the audit record, the rollback
// of a save whose audit record fails, and the refusal of an unsigned request.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express from "express";
import { UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { CaptureAdminRawBody, ManagerOperatorSignature } from "../security/managerOperator";
import { logger } from "../logger";
import { launcherAuthRouter } from "./launcherAuth";
import { adminRouter } from "./admin";

const SECRET = "launcher-notices-manager-secret-0123456789";
const OPERATOR = "555444333222111000";
const ENV_KEYS = ["MYSTICPARADOX_MANAGER_ADMIN", "MYSTICPARADOX_MANAGER_OPERATOR_SECRET"] as const;
const SAVED_ENV = new Map<string, string | undefined>();

let Realm: TestRealm;
let Server: http.Server;
let Port = 0;
let Seq = 0;

const HOUR = 60 * 60_000;

function NextMidnightUtc(now = Date.now()): string {
    const Day = new Date(now);
    return new Date(Date.UTC(Day.getUTCFullYear(), Day.getUTCMonth(), Day.getUTCDate() + 1)).toISOString();
}

/** A request target with a fresh query string: a manager signature is its own nonce, so no two requests may sign the same target. */
function Unique(path: string): string {
    Seq += 1;
    return `${path}?case=${Seq}`;
}

interface Reply { status: number; json: any; headers: http.IncomingHttpHeaders }

function Send(method: string, target: string, headers: Record<string, string>, body?: Buffer): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: "127.0.0.1", port: Port, path: target, method, headers, agent: false }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => {
                let json: any;
                try { json = text.length > 0 ? JSON.parse(text) : undefined; } catch { json = text; }
                resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
            });
        });
        request.on("error", reject);
        request.setTimeout(5000, () => request.destroy(new Error(`no answer: ${method} ${target}`)));
        if (body !== undefined) request.write(body);
        request.end();
    });
}

/** The headers the manager sends for one request: operator id, timestamp, and the HMAC over method, target, time, operator and body hash. */
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

async function Admin(method: string, path: string, json?: unknown): Promise<Reply> {
    const Target = Unique(path);
    const Body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    return Send(method, Target, Signed(method, Target, Body), Body);
}

async function Public(): Promise<Reply> {
    return Send("GET", Unique("/launcher/v1/notices"), {});
}

function ExpectError(reply: Reply, status: number, code: string): void {
    assert.equal(reply.status, status, JSON.stringify(reply.json));
    assert.equal(reply.json?.error?.code, code, JSON.stringify(reply.json));
}

function SetEnv(values: Record<string, string>): void {
    for (const Key of ENV_KEYS) {
        if (!SAVED_ENV.has(Key)) SAVED_ENV.set(Key, process.env[Key]);
    }
    Object.assign(process.env, values);
}

before(async () => {
    SetEnv({ MYSTICPARADOX_MANAGER_ADMIN: "on", MYSTICPARADOX_MANAGER_OPERATOR_SECRET: SECRET });
    Realm = OpenTestRealm("launcher-notices-routes");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    const App = express();
    App.use(express.json({ verify: CaptureAdminRawBody }));
    App.use("/", launcherAuthRouter);
    App.use("/", adminRouter);
    Server = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        Server.once("listening", () => resolve());
        Server.once("error", reject);
    });
    Port = (Server.address() as AddressInfo).port;
});

after(async () => {
    UsePersistenceForTest(undefined);
    await new Promise<void>((resolve) => Server.close(() => resolve()));
    await Realm.cleanup();
    for (const Key of ENV_KEYS) {
        const Previous = SAVED_ENV.get(Key);
        if (Previous === undefined) delete process.env[Key];
        else process.env[Key] = Previous;
    }
});

const Now = Date.now();
const Active = {
    text: "The backend service will restart at {time}.",
    tone: "warning",
    eventAt: NextMidnightUtc(Now),
    showFrom: new Date(Now - HOUR).toISOString(),
    showUntil: new Date(Now + HOUR).toISOString()
};
const Expired = { text: "Last week's notice", tone: "info", showUntil: new Date(Now - HOUR).toISOString() };

// ---- public ----

test("the public read with nothing saved: the empty set, served for 30 seconds", async () => {
    const Reply1 = await Public();
    assert.equal(Reply1.status, 200);
    assert.deepEqual(Reply1.json.announcements, []);
    assert.deepEqual(Reply1.json.tags, []);
    assert.match(Reply1.json.serverTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(Reply1.headers["cache-control"], "public, max-age=30");
    assert.equal(Reply1.json.version, undefined, "the launcher gets no document metadata");
});

test("the public read serves only the items active now, and the admin read keeps the inactive ones", async () => {
    const Put = await Admin("PUT", "/admin/v1/launcher-notices", {
        announcements: [Active, Expired],
        tags: [{ text: "EXPERIMENTAL BUILD", tone: "warning" }],
        expectedVersion: 0,
        reason: "Restart notice and the experimental tag"
    });
    assert.equal(Put.status, 200, JSON.stringify(Put.json));

    const Public1 = await Public();
    assert.equal(Public1.status, 200);
    assert.equal(Public1.json.announcements.length, 1);
    assert.equal(Public1.json.announcements[0].text, Active.text);
    assert.equal(Public1.json.announcements[0].eventAt, Active.eventAt);
    assert.equal(Public1.json.announcements[0].tone, "warning");
    assert.match(Public1.json.announcements[0].id, /^[0-9a-f-]{36}$/, "the server assigned the id");
    assert.equal(Public1.json.tags.length, 1);
    assert.equal(Public1.json.tags[0].text, "EXPERIMENTAL BUILD");
    assert.equal(Public1.json.updatedBy, undefined);

    const Admin1 = await Admin("GET", "/admin/v1/launcher-notices");
    assert.equal(Admin1.status, 200);
    assert.equal(Admin1.json.announcements.length, 2, "the expired notice is in the admin view");
});

test("a store read error answers the empty set, and logs once for the failing streak", async () => {
    const Repo = Realm.repos.launcherNotices;
    const Original = Repo.get.bind(Repo);
    const Logged: string[] = [];
    const OriginalError = logger.error.bind(logger);
    (logger as any).error = (message: string) => { Logged.push(String(message)); };
    Repo.get = async () => { throw new Error("store unavailable"); };
    try {
        const First = await Public();
        const Second = await Public();
        assert.equal(First.status, 200);
        assert.equal(Second.status, 200);
        assert.deepEqual(First.json.announcements, []);
        assert.deepEqual(Second.json.tags, []);
        assert.equal(Logged.filter((line) => line.includes("[LauncherNotices]")).length, 1, "one log line for the streak");

        Repo.get = Original;
        assert.equal((await Public()).json.announcements.length, 1, "the next good read serves the notices again");

        Repo.get = async () => { throw new Error("store unavailable again"); };
        await Public();
        assert.equal(Logged.filter((line) => line.includes("[LauncherNotices]")).length, 2, "a new streak logs once more");
    } finally {
        Repo.get = Original;
        (logger as any).error = OriginalError;
    }
});

// ---- manager ----

test("the manager's GET is signed and served as the operator, and a request without a credential is refused", async () => {
    const Reply1 = await Admin("GET", "/admin/v1/launcher-notices");
    assert.equal(Reply1.status, 200);
    assert.equal(Reply1.json.version, 1);
    assert.equal(Reply1.json.updatedBy, `manager:${OPERATOR}`);
    assert.equal(Reply1.headers["cache-control"], "no-store");

    const Anonymous = await Send("GET", Unique("/admin/v1/launcher-notices"), {});
    ExpectError(Anonymous, 401, "ADMIN_UNAUTHORIZED");
    const AnonymousPut = await Send("PUT", Unique("/admin/v1/launcher-notices"), { "content-type": "application/json" },
        Buffer.from(JSON.stringify({ announcements: [], tags: [], expectedVersion: 1, reason: "no credential here" })));
    ExpectError(AnonymousPut, 401, "ADMIN_UNAUTHORIZED");
});

test("a PUT with a stale expectedVersion is 409 NOTICES_VERSION_CONFLICT, carries the current document, and writes nothing", async () => {
    const Auditing = await Realm.repos.admin.listAudit(undefined, 0, 500);
    const Before = Auditing.total;
    const Reply1 = await Admin("PUT", "/admin/v1/launcher-notices", {
        announcements: [], tags: [], expectedVersion: 0, reason: "a stale copy of the page"
    });
    ExpectError(Reply1, 409, "NOTICES_VERSION_CONFLICT");
    assert.equal(Reply1.json.error.current.version, 1);
    assert.equal(Reply1.json.error.current.announcements.length, 2, "the saved set is still there");
    assert.equal((await Realm.repos.admin.listAudit(undefined, 0, 500)).total, Before, "no audit record for a refused save");
});

test("refusals name the field and change nothing: a short reason, a {time} line without eventAt, a missing expectedVersion", async () => {
    const Snapshot = await Admin("GET", "/admin/v1/launcher-notices");

    const ShortReason = await Admin("PUT", "/admin/v1/launcher-notices", {
        announcements: [], tags: [], expectedVersion: 1, reason: "1234567"
    });
    ExpectError(ShortReason, 400, "NOTICES_INVALID");
    assert.match(ShortReason.json.error.message, /reason/);

    const NoEventAt = await Admin("PUT", "/admin/v1/launcher-notices", {
        announcements: [{ text: "Restart at {time}.", tone: "warning" }], tags: [], expectedVersion: 1,
        reason: "A restart notice without its time"
    });
    ExpectError(NoEventAt, 400, "NOTICES_INVALID");
    assert.match(NoEventAt.json.error.message, /announcements\[0\]\.eventAt is required/);

    const NoVersion = await Admin("PUT", "/admin/v1/launcher-notices", {
        announcements: [], tags: [], reason: "Forgot the version entirely"
    });
    ExpectError(NoVersion, 400, "NOTICES_INVALID");
    assert.match(NoVersion.json.error.message, /expectedVersion/);

    const After = await Admin("GET", "/admin/v1/launcher-notices");
    const { serverTime: _NowA, ...Saved } = After.json;
    const { serverTime: _NowB, ...Earlier } = Snapshot.json;
    assert.deepEqual(Saved, Earlier, "nothing changed");
});

test("a valid PUT saves the whole set at the next version and writes one audit record with the reason and the texts", async () => {
    const Current = await Admin("GET", "/admin/v1/launcher-notices");
    const Reason = "Restart notice for the 00:00 UTC maintenance";
    const Put = await Admin("PUT", "/admin/v1/launcher-notices", {
        announcements: [{ text: "The backend service will restart at {time}.", tone: "warning", eventAt: NextMidnightUtc() }],
        tags: [],
        expectedVersion: Current.json.version,
        reason: `   ${Reason}   `
    });
    assert.equal(Put.status, 200, JSON.stringify(Put.json));
    assert.equal(Put.json.version, Current.json.version + 1);
    assert.equal(Put.json.updatedBy, `manager:${OPERATOR}`);
    assert.equal(Put.json.announcements.length, 1);
    assert.match(Put.json.announcements[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.deepEqual(Put.json.tags, []);
    assert.match(Put.json.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const Audit = await Realm.repos.admin.listAudit(undefined, 0, 500);
    const Record = Audit.records.find((entry) => entry.action === "launcher_notices.update" && entry.reason === Reason);
    assert.ok(Record, "the audit record of the save");
    assert.equal(Record.actorUserId, `manager:${OPERATOR}`);
    assert.equal((Record.newState as any).version, Put.json.version);
    assert.equal((Record.newState as any).announcements[0].text, "The backend service will restart at {time}.");
    assert.equal((Record.oldState as any).version, Current.json.version);
    assert.equal(Record.targetUserId, undefined);
});

test("an audit write that fails rolls the save back with it: the version stays where it was", async () => {
    const Before = await Admin("GET", "/admin/v1/launcher-notices");
    const Repo = Realm.repos.admin;
    const Original = Repo.appendAudit.bind(Repo);
    Repo.appendAudit = async () => { throw new Error("audit store unavailable"); };
    try {
        const Reply1 = await Admin("PUT", "/admin/v1/launcher-notices", {
            announcements: [], tags: [{ text: "ROLLED BACK", tone: "info" }], expectedVersion: Before.json.version,
            reason: "This save must not survive"
        });
        assert.equal(Reply1.status, 500, JSON.stringify(Reply1.json));
        assert.equal(Reply1.json.error.code, "INTERNAL");
    } finally {
        Repo.appendAudit = Original;
    }
    const After = await Admin("GET", "/admin/v1/launcher-notices");
    assert.equal(After.json.version, Before.json.version);
    assert.deepEqual(After.json.tags, Before.json.tags);
});
