import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express, { NextFunction, Request, Response } from "express";
import { IsRealmsSweeperRunning, StartRealmsSweeper, StopRealmsSweeper } from "./index";
import { LauncherApiError, SendLauncherError } from "./realmErrors";
import { CreateRealmsRouter } from "./routes/realmsLauncher";
import { SetupRealms, T0 } from "./realmsTestKit";

// The 2026-10-13 hub design routes over HTTP: /launcher/v1/realms/presence/* and the host heartbeat's hosting block, with the real
// router, parsers and service on in-memory repositories (the launcher sign-in is a stand-in reading x-test-user).

const BASE = "/launcher/v1/realms";
const iso = (ms: number) => new Date(ms).toISOString();

function FakeAuth(req: Request, res: Response, next: NextFunction) {
    const user = req.headers["x-test-user"];
    if (typeof user !== "string") {
        SendLauncherError(res, new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required."));
        return;
    }
    (req as any).LauncherAuthData = { userId: user };
    next();
}

async function Start() {
    const kit = SetupRealms();
    const app = express();
    app.use(express.json());
    app.use("/", CreateRealmsRouter({ service: kit.service, auth: FakeAuth, guards: { hosting: (_req, _res, next) => next(), active: (_req, _res, next) => next() } }));
    app.use((_req, res) => { res.status(404).send(); });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
    });
    return { ...kit, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; json: any }

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
        request.setTimeout(5000, () => request.destroy(new Error(`no answer: ${method} ${path}`)));
        if (payload !== undefined) request.write(payload);
        request.end();
    });
}

function ExpectError(reply: Reply, status: number, code: string): void {
    assert.equal(reply.status, status, JSON.stringify(reply.json));
    assert.equal(reply.json.error.code, code, JSON.stringify(reply.json));
    assert.deepEqual(Object.keys(reply.json), ["error"]);
}

test("presence routes: a player with no realm context gets null from all three calls", async () => {
    const H = await Start();
    try {
        const status = await Call(H.port, "GET", `${BASE}/presence`, "friend-1");
        assert.equal(status.status, 200);
        assert.equal(status.headers["cache-control"], "no-store");
        assert.deepEqual(status.json, { realm: null, expiresAt: null });
        assert.deepEqual((await Call(H.port, "POST", `${BASE}/presence/heartbeat`, "friend-1", {})).json, { realm: null, expiresAt: null });
        assert.deepEqual((await Call(H.port, "POST", `${BASE}/presence/leave`, "friend-1", {})).json, { left: true });
    } finally {
        await H.close();
    }
});

test("presence routes: heartbeat keeps the context alive and describes the realm, leave ends it", async () => {
    const H = await Start();
    try {
        const realm = await H.create("host-1", "friends");
        await H.service.bindPresence("friend-1", realm.realmId); // what the game login does
        assert.deepEqual((await Call(H.port, "GET", `${BASE}/presence`, "friend-1")).json, {
            realm: { name: "friends", serving: false, hubReady: false, hostOnline: false },
            expiresAt: iso(T0 + 120_000)
        });

        await H.serve("host-1", realm.realmId);
        H.clock.now = T0 + 31_000; // past the 30 s write window of a touch (coalescing), so this heartbeat extends the row
        const beat = await Call(H.port, "POST", `${BASE}/presence/heartbeat`, "friend-1"); // no body at all
        assert.equal(beat.status, 200);
        assert.deepEqual(beat.json, {
            realm: { name: "friends", serving: true, hubReady: true, hostOnline: true },
            expiresAt: iso(T0 + 31_000 + 120_000)
        });
        assert.equal((await Call(H.port, "GET", `${BASE}/presence`, "friend-1")).json.expiresAt, iso(T0 + 151_000));

        // Another account's context is its own.
        assert.deepEqual((await Call(H.port, "GET", `${BASE}/presence`, "friend-2")).json, { realm: null, expiresAt: null });

        assert.deepEqual((await Call(H.port, "POST", `${BASE}/presence/leave`, "friend-1", {})).json, { left: true });
        assert.deepEqual((await Call(H.port, "GET", `${BASE}/presence`, "friend-1")).json, { realm: null, expiresAt: null });
        assert.equal(H.presence.rows.size, 0);
    } finally {
        await H.close();
    }
});

test("the presence routes sit before the catch-all: sub-paths nobody defined still answer NOT_FOUND in the envelope", async () => {
    const H = await Start();
    try {
        ExpectError(await Call(H.port, "GET", `${BASE}/presence/nope`, "friend-1"), 404, "NOT_FOUND");
        ExpectError(await Call(H.port, "POST", `${BASE}/presence/heartbeat/extra`, "friend-1", {}), 404, "NOT_FOUND");
        ExpectError(await Call(H.port, "GET", `${BASE}/presence/heartbeat`, "friend-1"), 404, "NOT_FOUND");
        ExpectError(await Call(H.port, "POST", `${BASE}/presence`, "friend-1", {}), 404, "NOT_FOUND");
    } finally {
        await H.close();
    }
});

test("the host heartbeat accepts a hosting block, rejects a bad one without changing anything, and keeps its response shape", async () => {
    const H = await Start();
    try {
        const created = await Call(H.port, "POST", BASE, "host-1", { name: "friends", hostPublicKey: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==" });
        assert.equal(created.status, 201);
        const realmId = created.json.realm.realmId;

        const beat = await Call(H.port, "POST", `${BASE}/mine/heartbeat`, "host-1", { hosting: { maxServers: 3, maxPlayers: 20, afkSeconds: 900 } });
        assert.equal(beat.status, 200);
        assert.deepEqual(Object.keys(beat.json).sort(), ["lastOnlineAt", "online", "onlineUntil", "ttlSeconds", "version"]);
        assert.deepEqual(H.repo.realms.get(realmId)!.hosting, {
            maxServers: 3, maxPlayers: 20, afkSeconds: 900, hubState: "NONE", trainingState: "NONE", activeServers: 0, updatedAt: iso(T0)
        });

        const V = "REALM_VALIDATION_FAILED";
        for (const hosting of [{ maxServers: 9, maxPlayers: 20 }, { maxServers: 3, maxPlayers: 65 }, { maxServers: 3 }, "lots", { maxServers: 3, maxPlayers: 20, afkSeconds: 9000 }]) {
            ExpectError(await Call(H.port, "POST", `${BASE}/mine/heartbeat`, "host-1", { hosting }), 400, V);
        }
        assert.equal(H.repo.realms.get(realmId)!.hosting!.maxServers, 3, "the refused heartbeats changed nothing");

        // A heartbeat from someone who hosts nothing is still refused as before, with or without a hosting block.
        ExpectError(await Call(H.port, "POST", `${BASE}/mine/heartbeat`, "friend-1", { hosting: { maxServers: 1, maxPlayers: 1 } }), 404, "REALM_NOT_FOUND");
    } finally {
        await H.close();
    }
});

test("the realm lookups and listing carry serving, hubReady and playerCount", async () => {
    const H = await Start();
    try {
        const realm = await H.create("host-1", "friends", { listed: true });
        await H.serve("host-1", realm.realmId);
        await H.service.bindPresence("friend-1", realm.realmId);
        const listed = await Call(H.port, "GET", `${BASE}/listed`, "friend-2");
        assert.deepEqual(
            listed.json.realms.map((entry: any) => [entry.name, entry.online, entry.serving, entry.hubReady, entry.playerCount]),
            [["friends", true, true, true, 1]]
        );
        const looked = await Call(H.port, "GET", `${BASE}/by-name/friends`, "friend-2");
        assert.deepEqual([looked.json.realm.serving, looked.json.realm.hubReady, looked.json.realm.playerCount], [true, true, 1]);
        const mine = await Call(H.port, "GET", `${BASE}/mine`, "host-1");
        assert.deepEqual([mine.json.hosted.serving, mine.json.hosted.hubReady, mine.json.hosted.playerCount], [true, true, 1]);
        assert.ok(!/\d{1,3}(\.\d{1,3}){3}/.test(JSON.stringify(mine.json)), "still no address anywhere");
    } finally {
        await H.close();
    }
});

test("the sweeper starts once, can be stopped, and does not keep the process alive", async () => {
    StopRealmsSweeper();
    assert.equal(IsRealmsSweeperRunning(), false);
    const kit = SetupRealms();
    let sweeps = 0;
    const service = () => ({ ...kit.service, sweepLapsedHosts: async () => { sweeps += 1; return 0; } }) as typeof kit.service;
    StartRealmsSweeper(service, 10);
    StartRealmsSweeper(service, 10); // a second start changes nothing
    assert.equal(IsRealmsSweeperRunning(), true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    StopRealmsSweeper();
    assert.equal(IsRealmsSweeperRunning(), false);
    const seen = sweeps;
    assert.ok(seen >= 2 && seen <= 12, `ran ${seen} times in 80 ms at a 10 ms interval, from one timer`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sweeps, seen, "stopped means stopped");
});

test("a sweep that throws is logged and the sweeper carries on", async () => {
    StopRealmsSweeper();
    let calls = 0;
    const service = () => ({ sweepLapsedHosts: async () => { calls += 1; throw new Error("mongo unavailable"); } }) as never;
    StartRealmsSweeper(service, 10);
    await new Promise((resolve) => setTimeout(resolve, 80));
    StopRealmsSweeper();
    assert.ok(calls >= 2, `kept sweeping after a failure (${calls})`);
});
