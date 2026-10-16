import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express, { NextFunction, Request, Response } from "express";
import { MountRealmsModule, StopRealmsSweeper } from "./index";
import { InMemoryRealmPresenceRepository, InMemoryRealmsRepository } from "./persistence/InMemoryRealmsRepository";
import { LauncherApiError, SendLauncherError } from "./realmErrors";
import { CreateRealmsService } from "./realmsService";
import { CreateRealmsRouter } from "./routes/realmsLauncher";

/*
 * The realms API over HTTP, with the real router, parsers and service on an in-memory repository. The launcher
 * sign-in itself (HasLauncherAuth) needs MongoDB, so the tests mount the router behind a stand-in that reads the account
 * from the x-test-user header and answers the launcher's 401 envelope without one.
 */

const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const KEY_A = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==";
const NAMES = new Map([["host-1", "Hosty"], ["friend-1", "Friendly"], ["friend-2", "Pal"]]);

interface Harness {
    port: number;
    repo: InMemoryRealmsRepository;
    clock: { now: number };
    close: () => Promise<void>;
}

function FakeAuth(req: Request, res: Response, next: NextFunction) {
    const user = req.headers["x-test-user"];
    if (typeof user !== "string") {
        SendLauncherError(res, new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required."));
        return;
    }
    (req as any).LauncherAuthData = { userId: user };
    next();
}

async function Start(resolveUsername?: (username: string) => Promise<string | undefined>): Promise<Harness> {
    const repo = new InMemoryRealmsRepository();
    const clock = { now: T0 };
    let counter = 0;
    const service = CreateRealmsService({
        repository: repo,
        presence: new InMemoryRealmPresenceRepository(),
        displayNames: async (ids) => new Map(ids.filter((id) => NAMES.has(id)).map((id) => [id, NAMES.get(id)!])),
        now: () => clock.now,
        isRateLimited: () => false,
        generateRealmId: () => `realm-${++counter}`,
        resolveUsername
    });
    const app = express();
    app.use(express.json());
    app.use("/", CreateRealmsRouter({ service, auth: FakeAuth, guards: { hosting: (_req, _res, next) => next(), active: (_req, _res, next) => next() } }));
    app.use((_req, res) => { res.status(404).send(); });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
    });
    return {
        port: (server.address() as AddressInfo).port,
        repo,
        clock,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
}

interface Reply {
    status: number;
    headers: http.IncomingHttpHeaders;
    json: any;
}

function Call(port: number, method: string, path: string, user: string | undefined, body?: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (user !== undefined) headers["x-test-user"] = user;
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload !== undefined) headers["content-type"] = "application/json";
        const request = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => {
                let json: any;
                try { json = text.length > 0 ? JSON.parse(text) : undefined; } catch { json = text; }
                resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
            });
        });
        request.on("error", reject);
        // A request that never answers fails the test with its own name instead of hanging the run.
        request.setTimeout(5000, () => request.destroy(new Error(`no answer: ${method} ${path}`)));
        if (payload !== undefined) request.write(payload);
        request.end();
    });
}

function ExpectError(reply: Reply, status: number, code: string): void {
    assert.equal(reply.status, status, JSON.stringify(reply.json));
    assert.equal(reply.json.error.code, code, JSON.stringify(reply.json));
    assert.equal(typeof reply.json.error.message, "string");
    assert.equal(typeof reply.json.error.requestId, "string");
    assert.deepEqual(Object.keys(reply.json), ["error"]);
}

const BASE = "/launcher/v1/realms";

// [2026-10-15] Join requests and adding players by username, over HTTP.
// The resolver matches case-insensitively, as the production one does.
const NAMED = async (name: string) => (name.toLowerCase() === "friendly" ? "friend-1" : undefined);

test("join requests over HTTP: the host lists, approves and denies them; anyone else gets the host routes' not-found", async () => {
    const H = await Start(NAMED);
    try {
        await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: KEY_A });
        ExpectError(await Call(H.port, "POST", `${BASE}/join`, "friend-1", { name: "friends" }), 409, "REALM_JOIN_REQUESTED");

        const listed = await Call(H.port, "GET", `${BASE}/mine/requests`, "host-1");
        assert.equal(listed.status, 200);
        assert.deepEqual(Object.keys(listed.json), ["requests"]);
        assert.equal(listed.json.requests.length, 1);
        assert.deepEqual(Object.keys(listed.json.requests[0]).sort(), ["accountId", "at", "displayName"]);
        assert.equal(listed.json.requests[0].accountId, "friend-1");
        assert.equal(listed.json.requests[0].displayName, "Friendly");
        assert.equal((await Call(H.port, "GET", `${BASE}/mine`, "host-1")).json.hosted.joinRequestCount, 1);

        ExpectError(await Call(H.port, "GET", `${BASE}/mine/requests`, "friend-2"), 404, "REALM_NOT_FOUND");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/requests/friend-1/approve`, "friend-2"), 404, "REALM_NOT_FOUND");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/requests/friend-1/deny`, "friend-2"), 404, "REALM_NOT_FOUND");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/add`, "friend-2", { username: "Friendly" }), 404, "REALM_NOT_FOUND");

        const denied = await Call(H.port, "POST", `${BASE}/mine/requests/friend-1/deny`, "host-1");
        assert.equal(denied.status, 200);
        assert.deepEqual(denied.json, { accountId: "friend-1", status: "DENIED" });
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/requests/friend-1/deny`, "host-1"), 404, "REALM_REQUEST_NOT_FOUND");

        ExpectError(await Call(H.port, "POST", `${BASE}/join`, "friend-1", { name: "friends" }), 409, "REALM_JOIN_REQUESTED");
        const approved = await Call(H.port, "POST", `${BASE}/mine/requests/friend-1/approve`, "host-1");
        assert.equal(approved.status, 200);
        assert.deepEqual(approved.json, { accountId: "friend-1", status: "APPROVED" });
        assert.deepEqual((await Call(H.port, "GET", `${BASE}/mine/requests`, "host-1")).json.requests, []);

        const joined = await Call(H.port, "POST", `${BASE}/join`, "friend-1", { name: "friends" });
        assert.equal(joined.status, 200);
        assert.equal(joined.json.joined, false);
        assert.equal(joined.json.realm.membership, "MEMBER");
    } finally {
        await H.close();
        StopRealmsSweeper();
    }
});

test("the host adds a player by username over HTTP: 200 with added, 404 for an unknown name, 400 for a bad body", async () => {
    const H = await Start(NAMED);
    try {
        await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: KEY_A });
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/add`, "host-1", {}), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/add`, "host-1", { username: 7 }), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/add`, "host-1", { username: "   " }), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/add`, "host-1", { username: "a\nb" }), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/add`, "host-1", { username: "nobody" }), 404, "REALM_PLAYER_NOT_FOUND");

        const added = await Call(H.port, "POST", `${BASE}/mine/members/add`, "host-1", { username: "  Friendly " });
        assert.equal(added.status, 200);
        assert.deepEqual(added.json, { accountId: "friend-1", displayName: "Friendly", added: true });
        const again = await Call(H.port, "POST", `${BASE}/mine/members/add`, "host-1", { username: "friendly" });
        assert.deepEqual(again.json, { accountId: "friend-1", displayName: "Friendly", added: false });

        const joined = await Call(H.port, "POST", `${BASE}/join`, "friend-1", { name: "friends" });
        assert.equal(joined.status, 200, "the added player joins without an invite");
    } finally {
        await H.close();
        StopRealmsSweeper();
    }
});

test("every route needs a launcher sign-in and answers the launcher error envelope without one", async () => {
    const H = await Start();
    try {
        for (const [method, path] of [
            ["POST", BASE], ["GET", `${BASE}/mine`], ["GET", `${BASE}/listed`], ["GET", `${BASE}/by-name/friends`],
            ["GET", `${BASE}/invite/ABCDEFGHJK`], ["POST", `${BASE}/join`], ["POST", `${BASE}/by-name/friends/leave`],
            ["POST", `${BASE}/mine/settings`], ["POST", `${BASE}/mine/invites`], ["GET", `${BASE}/mine/invites`],
            ["POST", `${BASE}/mine/invites/ABCDEFGHJK/revoke`], ["POST", `${BASE}/mine/members/x/kick`],
            ["POST", `${BASE}/mine/members/x/ban`], ["POST", `${BASE}/mine/members/x/unban`],
            ["POST", `${BASE}/mine/heartbeat`], ["POST", `${BASE}/mine/release`], ["POST", `${BASE}/presence/heartbeat`],
            ["GET", `${BASE}/mine/requests`], ["POST", `${BASE}/mine/requests/x/approve`], ["POST", `${BASE}/mine/requests/x/deny`],
            ["POST", `${BASE}/mine/members/add`],
            ["POST", `${BASE}/presence/leave`], ["GET", `${BASE}/presence`], ["GET", `${BASE}/nope`]
        ]) {
            ExpectError(await Call(H.port, method, path, undefined, method === "POST" ? {} : undefined), 401, "AUTH_UNAUTHORIZED");
        }
        assert.equal(H.repo.realms.size, 0);
    } finally {
        await H.close();
    }
});

test("claiming a realm answers 201 with the host's view, and no response is cacheable", async () => {
    const H = await Start();
    try {
        const reply = await Call(H.port, "POST", BASE, "host-1", { name: "Friends-Realm", hostPublicKey: KEY_A });
        assert.equal(reply.status, 201);
        assert.equal(reply.headers["cache-control"], "no-store");
        const realm = reply.json.realm;
        assert.equal(realm.name, "friends-realm");
        assert.equal(realm.joinPolicy, "INVITE_ONLY");
        assert.equal(realm.listed, false);
        assert.equal(realm.membership, "HOST");
        assert.equal(realm.host.displayName, "Hosty");
        assert.equal(realm.members.length, 1);
        assert.deepEqual(realm.bans, []);

        const mine = await Call(H.port, "GET", `${BASE}/mine`, "host-1");
        assert.equal(mine.status, 200);
        assert.equal(mine.json.hosted.name, "friends-realm");
        assert.deepEqual(mine.json.memberOf, []);
        assert.equal((await Call(H.port, "GET", `${BASE}/mine`, "friend-1")).json.hosted, null);
    } finally {
        await H.close();
    }
});

test("claiming a realm is validated field by field", async () => {
    const H = await Start();
    try {
        ExpectError(await Call(H.port, "POST", BASE, "host-1", { name: "ab", hostPublicKey: KEY_A }), 400, "REALM_NAME_INVALID");
        ExpectError(await Call(H.port, "POST", BASE, "host-1", { name: "-bad-", hostPublicKey: KEY_A }), 400, "REALM_NAME_INVALID");
        ExpectError(await Call(H.port, "POST", BASE, "host-1", { name: { $ne: "x" }, hostPublicKey: KEY_A }), 400, "REALM_NAME_INVALID");
        ExpectError(await Call(H.port, "POST", BASE, "host-1", { name: "Official", hostPublicKey: KEY_A }), 400, "REALM_NAME_RESERVED");
        ExpectError(await Call(H.port, "POST", BASE, "host-1", { name: "friends" }), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: "short" }), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: KEY_A, listed: "true" }), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: KEY_A, joinPolicy: "OPEN" }), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "POST", BASE, "host-1", [1, 2, 3]), 400, "REALM_VALIDATION_FAILED");
        assert.equal(H.repo.realms.size, 0);

        assert.equal((await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: KEY_A })).status, 201);
        ExpectError(await Call(H.port, "POST", BASE, "host-2", { name: "friends", hostPublicKey: KEY_A }), 409, "REALM_NAME_TAKEN");
        ExpectError(await Call(H.port, "POST", BASE, "host-1", { name: "second", hostPublicKey: KEY_A }), 409, "REALM_ALREADY_EXISTS");
    } finally {
        await H.close();
    }
});

test("a realm looked up by name shows public information only, with the ownership flag when a key is sent", async () => {
    const H = await Start();
    try {
        await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: KEY_A, version: "0.2.128" });
        const reply = await Call(H.port, "GET", `${BASE}/by-name/FRIENDS`, "friend-1");
        assert.equal(reply.status, 200);
        assert.deepEqual(Object.keys(reply.json.realm).sort(), [
            "host", "hostPublicKey", "hubReady", "invited", "joinPolicy", "listed", "memberCount", "membership", "name", "online", "playerCount",
            "realmId", "requested", "serving", "version"
        ]);
        assert.deepEqual(reply.json.realm.host, { displayName: "Hosty" });
        assert.ok(!/\d{1,3}(\.\d{1,3}){3}/.test(JSON.stringify(reply.json)));

        const same = await Call(H.port, "GET", `${BASE}/by-name/friends?knownHostKey=${encodeURIComponent(KEY_A)}`, "friend-1");
        assert.equal(same.json.realm.ownershipChanged, false);
        const other = await Call(H.port, "GET", `${BASE}/by-name/friends?knownHostKey=${encodeURIComponent("Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2Rl")}`, "friend-1");
        assert.equal(other.json.realm.ownershipChanged, true);

        ExpectError(await Call(H.port, "GET", `${BASE}/by-name/nothing-here`, "friend-1"), 404, "REALM_NOT_FOUND");
        ExpectError(await Call(H.port, "GET", `${BASE}/by-name/official`, "friend-1"), 404, "REALM_NOT_FOUND");
        ExpectError(await Call(H.port, "GET", `${BASE}/by-name/a_b`, "friend-1"), 400, "REALM_NAME_INVALID");
        ExpectError(await Call(H.port, "GET", `${BASE}/by-name/friends?knownHostKey=bad%20key`, "friend-1"), 400, "REALM_VALIDATION_FAILED");
    } finally {
        await H.close();
    }
});

test("a whole realm lifecycle: invite, preview, join, list, kick, ban, unban, heartbeat, leave, release", async () => {
    const H = await Start();
    try {
        await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: KEY_A });

        // Invite-only: no invite, no entry.
        ExpectError(await Call(H.port, "POST", `${BASE}/join`, "friend-1", { name: "friends" }), 409, "REALM_JOIN_REQUESTED");

        const created = await Call(H.port, "POST", `${BASE}/mine/invites`, "host-1", { maxUses: 2, expiresInHours: 24 });
        assert.equal(created.status, 201);
        const code: string = created.json.invite.code;
        assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
        assert.equal(created.json.invite.state, "USABLE");
        assert.deepEqual((await Call(H.port, "GET", `${BASE}/mine/invites`, "host-1")).json.invites.map((invite: any) => invite.code), [code]);
        ExpectError(await Call(H.port, "GET", `${BASE}/mine/invites`, "friend-1"), 404, "REALM_NOT_FOUND");

        // The code is read from a screenshot or a chat: lower case and a hyphen are fine.
        const spoken = `${code.slice(0, 5)}-${code.slice(5)}`.toLowerCase();
        const preview = await Call(H.port, "GET", `${BASE}/invite/${spoken}`, "friend-1");
        assert.equal(preview.status, 200);
        assert.equal(preview.json.realm.name, "friends");
        assert.equal(H.repo.invites.get(code)!.uses, 0);
        ExpectError(await Call(H.port, "GET", `${BASE}/invite/not-a-code`, "friend-1"), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "GET", `${BASE}/invite/ZZZZZZZZZZ`, "friend-1"), 404, "REALM_INVITE_INVALID");

        const joined = await Call(H.port, "POST", `${BASE}/join`, "friend-1", { inviteCode: spoken, knownHostKey: KEY_A });
        assert.equal(joined.status, 200);
        assert.equal(joined.json.joined, true);
        assert.equal(joined.json.realm.membership, "MEMBER");
        assert.equal(H.repo.invites.get(code)!.uses, 1);
        assert.deepEqual((await Call(H.port, "GET", `${BASE}/mine`, "friend-1")).json.memberOf.map((realm: any) => realm.name), ["friends"]);

        // The host's panel: members with names, and the join count.
        const panel = (await Call(H.port, "GET", `${BASE}/mine`, "host-1")).json.hosted;
        assert.deepEqual(panel.members.map((member: any) => [member.accountId, member.displayName, member.role]), [["host-1", "Hosty", "HOST"], ["friend-1", "Friendly", "MEMBER"]]);

        // Kick: the member is out but can use the invite again; the host cannot kick themselves.
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/host-1/kick`, "host-1", {}), 400, "REALM_INVALID_TARGET");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/friend-1/kick`, "friend-2", {}), 404, "REALM_NOT_FOUND");
        const kicked = await Call(H.port, "POST", `${BASE}/mine/members/friend-1/kick`, "host-1", {});
        assert.deepEqual(kicked.json, { accountId: "friend-1", status: "KICKED" });
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/friend-1/kick`, "host-1", {}), 404, "REALM_NOT_MEMBER");
        assert.equal((await Call(H.port, "POST", `${BASE}/join`, "friend-1", { inviteCode: code })).json.joined, true);

        // Ban: out, and refused even with the invite, even in a PUBLIC realm; unban lets them back.
        const banned = await Call(H.port, "POST", `${BASE}/mine/members/friend-1/ban`, "host-1", { reason: "griefing" });
        assert.deepEqual(banned.json, { accountId: "friend-1", status: "BANNED", changed: true });
        ExpectError(await Call(H.port, "POST", `${BASE}/join`, "friend-1", { inviteCode: code }), 403, "REALM_BANNED");
        const settings = await Call(H.port, "POST", `${BASE}/mine/settings`, "host-1", { joinPolicy: "PUBLIC", listed: true });
        assert.equal(settings.json.realm.joinPolicy, "PUBLIC");
        assert.equal(settings.json.realm.listed, true);
        assert.equal(settings.json.realm.bans[0].reason, "griefing");
        ExpectError(await Call(H.port, "POST", `${BASE}/join`, "friend-1", { name: "friends" }), 403, "REALM_BANNED");
        const unbanned = await Call(H.port, "POST", `${BASE}/mine/members/friend-1/unban`, "host-1", {});
        assert.deepEqual(unbanned.json, { accountId: "friend-1", status: "UNBANNED", changed: true });
        assert.equal((await Call(H.port, "POST", `${BASE}/join`, "friend-1", { name: "friends" })).json.joined, true);

        // The listing and the heartbeat.
        assert.deepEqual((await Call(H.port, "GET", `${BASE}/listed`, "friend-2")).json.realms.map((realm: any) => [realm.name, realm.online]), [["friends", false]]);
        const beat = await Call(H.port, "POST", `${BASE}/mine/heartbeat`, "host-1", { version: "0.2.128" });
        assert.equal(beat.status, 200);
        assert.equal(beat.json.online, true);
        assert.equal(beat.json.ttlSeconds, 90);
        assert.equal(beat.json.onlineUntil, new Date(T0 + 90_000).toISOString());
        assert.equal((await Call(H.port, "GET", `${BASE}/by-name/friends`, "friend-2")).json.realm.online, true);
        H.clock.now = T0 + 90_000;
        assert.equal((await Call(H.port, "GET", `${BASE}/by-name/friends`, "friend-2")).json.realm.online, false);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/heartbeat`, "friend-1", {}), 404, "REALM_NOT_FOUND");

        // Revoking an invite, leaving and releasing.
        const revoked = await Call(H.port, "POST", `${BASE}/mine/invites/${code}/revoke`, "host-1", {});
        assert.equal(revoked.json.invite.state, "REVOKED");
        ExpectError(await Call(H.port, "POST", `${BASE}/by-name/friends/leave`, "host-1", {}), 409, "REALM_HOST_CANNOT_LEAVE");
        assert.deepEqual((await Call(H.port, "POST", `${BASE}/by-name/friends/leave`, "friend-1", {})).json, { left: true });
        ExpectError(await Call(H.port, "POST", `${BASE}/by-name/friends/leave`, "friend-1", {}), 404, "REALM_NOT_MEMBER");
        assert.deepEqual((await Call(H.port, "POST", `${BASE}/mine/release`, "host-1")).json, { released: true });
        ExpectError(await Call(H.port, "GET", `${BASE}/by-name/friends`, "friend-1"), 404, "REALM_NOT_FOUND");
        assert.equal(H.repo.invites.size, 0);
    } finally {
        await H.close();
    }
});

test("an old host key at join time is answered with the ownership error, and the join does not happen", async () => {
    const H = await Start();
    try {
        await Call(H.port, "POST", BASE, "host-1", { name: "open-house", hostPublicKey: KEY_A, joinPolicy: "PUBLIC" });
        const reply = await Call(H.port, "POST", `${BASE}/join`, "friend-1", { name: "open-house", knownHostKey: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2Rl" });
        ExpectError(reply, 409, "REALM_OWNER_CHANGED");
        assert.equal(H.repo.realms.get("realm-1")!.members.length, 1);
    } finally {
        await H.close();
    }
});

test("settings, invites, heartbeat, bans, joins and listings reject malformed input", async () => {
    const H = await Start();
    try {
        await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: KEY_A });
        const V = "REALM_VALIDATION_FAILED";
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/settings`, "host-1", {}), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/settings`, "host-1", { listed: "yes" }), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/settings`, "host-1", { joinPolicy: "NOPE" }), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/invites`, "host-1", { maxUses: 0 }), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/invites`, "host-1", { maxUses: "5" }), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/invites`, "host-1", { expiresInHours: 9999 }), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/heartbeat`, "host-1", { online: "no" }), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/heartbeat`, "host-1", { version: "not a version" }), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/friend-1/ban`, "host-1", { reason: "x".repeat(201) }), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/${encodeURIComponent("$ne")}/kick`, "host-1", {}), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/members/${encodeURIComponent("a b")}/ban`, "host-1", {}), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/invites/short/revoke`, "host-1", {}), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/join`, "friend-1", {}), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/join`, "friend-1", { inviteCode: "ABCDEFGHIK" }), 400, V);
        ExpectError(await Call(H.port, "POST", `${BASE}/join`, "friend-1", { name: "friends", inviteCode: { $ne: "x" } }), 400, V);
        ExpectError(await Call(H.port, "GET", `${BASE}/listed?limit=0`, "friend-1"), 400, V);
        ExpectError(await Call(H.port, "GET", `${BASE}/listed?limit=51`, "friend-1"), 400, V);
        ExpectError(await Call(H.port, "GET", `${BASE}/listed?offset=-1`, "friend-1"), 400, V);
        ExpectError(await Call(H.port, "GET", `${BASE}/listed?limit=1&limit=2`, "friend-1"), 400, V);
        // Nothing above changed anything.
        const realm = H.repo.realms.get("realm-1")!;
        assert.equal(realm.joinPolicy, "INVITE_ONLY");
        assert.equal(realm.listed, false);
        assert.equal(realm.bans.length, 0);
        assert.equal(H.repo.invites.size, 0);
        assert.equal(realm.lastOnlineAt, undefined);
    } finally {
        await H.close();
    }
});

test("an unknown route under the prefix answers the launcher envelope", async () => {
    const H = await Start();
    try {
        ExpectError(await Call(H.port, "GET", `${BASE}/nope`, "host-1"), 404, "NOT_FOUND");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/delete-everything`, "host-1", {}), 404, "NOT_FOUND");
        // Other prefixes are untouched by this router.
        assert.equal((await Call(H.port, "GET", "/launcher/v1/somewhere-else", "host-1")).status, 404);
    } finally {
        await H.close();
    }
});

test("an unexpected failure is answered as INTERNAL without leaking its message", async () => {
    const repo = new InMemoryRealmsRepository();
    repo.findByHost = async () => { throw new Error("mongo exploded: secret-connection-detail"); };
    const service = CreateRealmsService({
        repository: repo,
        presence: new InMemoryRealmPresenceRepository(),
        displayNames: async () => new Map(),
        isRateLimited: () => false
    });
    const app = express();
    app.use(express.json());
    app.use("/", CreateRealmsRouter({ service, auth: FakeAuth, guards: { hosting: (_req, _res, next) => next(), active: (_req, _res, next) => next() } }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
        const reply = await Call((server.address() as AddressInfo).port, "GET", `${BASE}/mine`, "host-1");
        ExpectError(reply, 500, "INTERNAL");
        assert.ok(!JSON.stringify(reply.json).includes("secret-connection-detail"));
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("the module is mounted only when MYSTICPARADOX_REALMS_MODULE is on, true or 1", async () => {
    for (const [env, mounted] of [
        [{}, false],
        [{ MYSTICPARADOX_REALMS_MODULE: "off" }, false],
        [{ MYSTICPARADOX_REALMS_MODULE: "yes" }, false],
        [{ MYSTICPARADOX_REALMS_MODULE: "on" }, true],
        [{ MYSTICPARADOX_REALMS_MODULE: "TRUE" }, true],
        [{ MYSTICPARADOX_REALMS_MODULE: "1" }, true]
    ] as Array<[NodeJS.ProcessEnv, boolean]>) {
        const app = express();
        assert.equal(MountRealmsModule(app, env), mounted, JSON.stringify(env));
        app.use((_req, res) => { res.status(404).send("fallthrough"); });
        const server = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server.once("listening", () => resolve()));
        try {
            const reply = await Call((server.address() as AddressInfo).port, "GET", `${BASE}/mine`, undefined);
            if (mounted) {
                // The real launcher auth answers 401 before any database access when there is no bearer token.
                assert.equal(reply.status, 401, JSON.stringify(env));
                assert.equal(reply.json.error.code, "AUTH_UNAUTHORIZED");
            } else {
                assert.equal(reply.status, 404, JSON.stringify(env));
            }
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            StopRealmsSweeper();
        }
    }
});

test("player invites over HTTP: the host invites by username, the player lists, declines or accepts, the host cancels", async () => {
    const H = await Start(async (name) => ({ friendly: "friend-1", pal: "friend-2" } as Record<string, string>)[name.toLowerCase()]);
    try {
        await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: KEY_A });
        const invited = await Call(H.port, "POST", `${BASE}/mine/player-invites`, "host-1", { username: "Friendly" });
        assert.equal(invited.status, 201);
        assert.deepEqual(invited.json, { accountId: "friend-1", displayName: "Friendly", status: "INVITED" });
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/player-invites`, "host-1", {}), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/player-invites`, "friend-2", { username: "friendly" }), 404, "REALM_NOT_FOUND");

        const mine = await Call(H.port, "GET", `${BASE}/mine`, "host-1");
        assert.deepEqual(mine.json.hosted.playerInvites.map((invite: { accountId: string }) => invite.accountId), ["friend-1"]);
        const list = await Call(H.port, "GET", `${BASE}/player-invites`, "friend-1");
        assert.equal(list.status, 200);
        assert.deepEqual(list.json.invites.map((invite: { realm: { name: string; invited: boolean } }) => [invite.realm.name, invite.realm.invited]), [["friends", true]]);

        const accepted = await Call(H.port, "POST", `${BASE}/player-invites/friends/accept`, "friend-1", {});
        assert.equal(accepted.status, 200);
        assert.equal(accepted.json.realm.membership, "MEMBER");
        ExpectError(await Call(H.port, "POST", `${BASE}/player-invites/friends/accept`, "friend-1", {}), 404, "REALM_PLAYER_INVITE_NOT_FOUND");

        await Call(H.port, "POST", `${BASE}/mine/player-invites`, "host-1", { username: "pal" });
        assert.deepEqual((await Call(H.port, "POST", `${BASE}/player-invites/friends/decline`, "friend-2", {})).json, { declined: true });
        await Call(H.port, "POST", `${BASE}/mine/player-invites`, "host-1", { username: "pal" });
        assert.deepEqual((await Call(H.port, "POST", `${BASE}/mine/player-invites/friend-2/cancel`, "host-1", {})).json, { accountId: "friend-2", status: "CANCELLED" });
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/player-invites/friend-2/cancel`, "host-1", {}), 404, "REALM_PLAYER_INVITE_NOT_FOUND");
        ExpectError(await Call(H.port, "POST", `${BASE}/player-invites/a_b/decline`, "friend-2", {}), 400, "REALM_NAME_INVALID");
    } finally {
        await H.close();
    }
});
