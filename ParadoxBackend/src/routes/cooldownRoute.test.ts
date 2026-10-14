/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import express, { NextFunction, Request, Response } from "express";
import { StartCooldownHandlers, StartCooldownOptions } from "../controllers/cooldowns";
import { CooldownStatePayload, MergeCooldownState, MergeHostCooldownState } from "../cooldownState";
import type { ExtensionHttpResponse, HostWriteKind, HostWriteRecordInput } from "../extensions/p2p";
import { CooldownStateRecord } from "../persistence/mapping/domainTypes";

// The default hostWrites hooks come from the P2P extension; the dedicated-only build (no p2p module) refuses every host
// write. Pin that build here so the default-hooks test below does not depend on whether src/p2p exists.
process.env.MYSTICPARADOX_P2P_MODULE = "off";

/*
 * PUT /cooldown/:userId/:cooldownId (StartCooldownEndpoint) over HTTP, with the real handler chain from
 * controllers/cooldowns.ts. systemRouter itself needs MongoDB (API-key auth, the cooldown store), so the test mounts the
 * same handlers behind a stand-in auth middleware and an in-memory store.
 */

const SERVER_NOW = "2026-10-10T18:00:00.000Z";
const SPROUT = "58E91700491B00FA7DB373809E250E45";

interface Harness {
    port: number;
    store: Map<string, CooldownStateRecord>;
    authCalls: string[];
    batchCalls: string[];
    hostCalls: { authorize: { kind: HostWriteKind; target: string }[]; records: HostWriteRecordInput[] };
    close: () => Promise<void>;
}

// x-test-role: "gs" -> a dedicated server (IsGameserver), "player" -> a player bearer, "host" -> a player-host runtime
// (IsPlayerHostRuntime, never IsGameserver), absent -> 401.
function FakeAuth(authCalls: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        authCalls.push(req.path);
        const Role = req.headers["x-test-role"];
        if (Role === "gs") (req as any).AuthData = { IsGameserver: true };
        else if (Role === "player") (req as any).AuthData = { userId: "player-1" };
        else if (Role === "host") (req as any).AuthData = { IsPlayerHostRuntime: true, IsGameserver: false, userId: "host-1", RuntimeRosterAccountIds: ["host-1", "player-1"] };
        else {
            res.status(401).send();
            return;
        }
        next();
    };
}

async function Start(options: Partial<StartCooldownOptions> = {}, hostDenial?: ExtensionHttpResponse): Promise<Harness> {
    const Store = new Map<string, CooldownStateRecord>();
    const AuthCalls: string[] = [];
    const BatchCalls: string[] = [];
    const HostCalls: Harness["hostCalls"] = { authorize: [], records: [] };
    const Handlers = StartCooldownHandlers(FakeAuth(AuthCalls), {
        persistence: true,
        noPlayerUserId: "INVALID",
        now: () => SERVER_NOW,
        // Mirrors controllers/cooldowns.ts SaveCooldowns on an in-memory store: hostRules picks the later-only merge.
        save: async (userId, body, saveOptions) => {
            if (saveOptions?.hostRules === true) {
                const { record, changes } = MergeHostCooldownState(userId, Store.get(userId), body, SERVER_NOW);
                Store.set(userId, record);
                return { payload: CooldownStatePayload(record), record, changes };
            }
            const Record = MergeCooldownState(userId, Store.get(userId), body, SERVER_NOW);
            Store.set(userId, Record);
            return { payload: CooldownStatePayload(Record), record: Record };
        },
        hostWrites: {
            authorize: async (_req, kind, target) => { HostCalls.authorize.push({ kind, target }); return hostDenial; },
            record: async (_req, write) => { HostCalls.records.push(write); },
        },
        ...options,
    });

    const App = express();
    App.use(express.json());
    // Worst case on purpose: the single-id route is registered BEFORE the batch route, so "/cooldown/batch/<uid>"
    // reaches the batch route only through the handlers' own skip.
    App.put("/cooldown/:userId/:cooldownId", ...Handlers);
    App.put("/cooldown/batch/:userId", (req, res) => {
        BatchCalls.push(String(req.params.userId));
        res.status(200).json({ code: null, message: "OK", payload: { batch: true } });
    });
    App.use((req, res) => { res.status(404).send(); });

    const Server = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        Server.once("listening", () => resolve());
        Server.once("error", reject);
    });
    return {
        port: (Server.address() as AddressInfo).port,
        store: Store,
        authCalls: AuthCalls,
        batchCalls: BatchCalls,
        hostCalls: HostCalls,
        close: () => new Promise<void>((resolve) => Server.close(() => resolve())),
    };
}

function Put(port: number, path: string, role: string | undefined, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const Headers: Record<string, string> = {};
        if (role !== undefined) Headers["x-test-role"] = role;
        const Payload = body === undefined ? undefined : JSON.stringify(body);
        if (Payload !== undefined) Headers["content-type"] = "application/json";
        const Req = http.request({ hostname: "127.0.0.1", port, path, method: "PUT", headers: Headers }, (res) => {
            let Text = "";
            res.setEncoding("utf8");
            res.on("data", (Chunk) => { Text += Chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: Text.length > 0 ? JSON.parse(Text) : undefined }));
        });
        Req.on("error", reject);
        if (Payload !== undefined) Req.write(Payload);
        Req.end();
    });
}

test("the batch route keeps /cooldown/batch/<uid>, and the single-id handlers skip it before auth", async () => {
    const H = await Start();
    try {
        const Result = await Put(H.port, "/cooldown/batch/player-1", "gs", { cooldowns: [] });
        assert.equal(Result.status, 200);
        assert.deepEqual(Result.json.payload, { batch: true });
        assert.deepEqual(H.batchCalls, ["player-1"]);
        assert.deepEqual(H.authCalls, []);
        assert.equal(H.store.size, 0);
    } finally {
        await H.close();
    }
});

test("a gameserver harvest stores the id at the backend's own time and answers the id -> date map", async () => {
    const H = await Start();
    try {
        H.store.set("player-1", MergeCooldownState("player-1", undefined, { cooldowns: [{ cooldown_id: "season43", cooldown_started_date: "2026-10-22T17:00:00.000Z" }] }, SERVER_NOW));
        // The game sends no body; one that tries to backdate the harvest is ignored.
        const Result = await Put(H.port, `/cooldown/player-1/${SPROUT}`, "gs", { cooldowns: [{ cooldown_id: SPROUT, cooldown_started_date: "2020-01-01T00:00:00.000Z" }] });
        assert.equal(Result.status, 200);
        assert.deepEqual(Result.json, { code: null, message: "OK", payload: { season43: "2026-10-22T17:00:00.000Z", [SPROUT]: SERVER_NOW } });
        assert.deepEqual(CooldownStatePayload(H.store.get("player-1")), { season43: "2026-10-22T17:00:00.000Z", [SPROUT]: SERVER_NOW });

        // Without any body, as the hub really sends it.
        const Second = await Put(H.port, "/cooldown/player-2/6B4A2B51AAAABBBBCCCCDDDDEEEEFFFF", "gs");
        assert.equal(Second.status, 200);
        assert.deepEqual(Second.json.payload, { "6B4A2B51AAAABBBBCCCCDDDDEEEEFFFF": SERVER_NOW });
    } finally {
        await H.close();
    }
});

test("a player cannot start a cooldown (403) and nothing is stored", async () => {
    const H = await Start();
    try {
        const Result = await Put(H.port, `/cooldown/player-1/${SPROUT}`, "player");
        assert.equal(Result.status, 403);
        assert.equal(H.store.size, 0);
        assert.equal((await Put(H.port, `/cooldown/player-1/${SPROUT}`, undefined)).status, 401);
    } finally {
        await H.close();
    }
});

test("a malformed cooldown id is rejected with 400", async () => {
    const H = await Start();
    try {
        for (const Id of ["bad%20id", "bad%21", encodeURIComponent("a\nb"), "x".repeat(201)]) {
            const Result = await Put(H.port, `/cooldown/player-1/${Id}`, "gs");
            assert.equal(Result.status, 400, Id);
            assert.deepEqual(Result.json, { code: null, message: "Bad Request", payload: {} });
        }
        assert.equal((await Put(H.port, `/cooldown/player-1/${"x".repeat(200)}`, "gs")).status, 200);
        assert.equal((await Put(H.port, "/cooldown/player-1/GRANT_DAILY.x:y-z", "gs")).status, 200);
    } finally {
        await H.close();
    }
});

test("nothing stored means no 2xx: persistence off -> 503, the INVALID sentinel -> 400", async () => {
    let Saves = 0;
    const Off = await Start({ persistence: false, save: async () => { Saves++; throw new Error("must not save"); } });
    try {
        const Result = await Put(Off.port, `/cooldown/player-1/${SPROUT}`, "gs");
        assert.equal(Result.status, 503);
        assert.deepEqual(Result.json.payload, {});
        assert.equal(Saves, 0);
    } finally {
        await Off.close();
    }

    const On = await Start();
    try {
        const Result = await Put(On.port, `/cooldown/INVALID/${SPROUT}`, "gs");
        assert.equal(Result.status, 400);
        assert.equal(On.store.size, 0);
    } finally {
        await On.close();
    }
});

// ---- host writes (2026-10-13 realms S3) ----------------------------------------------------------------------------

test("a host starts a cooldown through the hooks: authorized for COOLDOWN and the target, stored at the backend's time, tagged", async () => {
    const H = await Start();
    try {
        const Result = await Put(H.port, `/cooldown/player-1/${SPROUT}`, "host");
        assert.equal(Result.status, 200);
        assert.deepEqual(Result.json, { code: null, message: "OK", payload: { [SPROUT]: SERVER_NOW } });
        assert.deepEqual(H.hostCalls.authorize, [{ kind: "COOLDOWN", target: "player-1" }]);
        assert.equal(H.hostCalls.records.length, 1);
        const Tag = H.hostCalls.records[0];
        assert.equal(Tag.kind, "COOLDOWN");
        assert.equal(Tag.targetUserId, "player-1");
        assert.equal(Tag.summary.route, "start");
        assert.equal(Tag.summary.id, SPROUT);
        assert.equal(Tag.summary.startedAt, SERVER_NOW);
        assert.equal(Tag.summary.addedCount, 1);
        assert.equal(Tag.summary.keptLaterCount, 0);
        assert.deepEqual(CooldownStatePayload(H.store.get("player-1")), { [SPROUT]: SERVER_NOW });
    } finally {
        await H.close();
    }
});

test("a host cannot move a stored cooldown earlier: a later stored date stays, the answer is the stored map, the attempt is tagged", async () => {
    const H = await Start();
    try {
        H.store.set("player-1", MergeCooldownState("player-1", undefined, { cooldowns: [{ cooldown_id: "GRANT_DAILY_X", cooldown_started_date: "2026-10-11T18:00:00.000Z" }] }, SERVER_NOW));
        // A stored start later than the backend's now (a future-dated gate): starting it "now" would move it earlier.
        H.store.set("player-1", MergeCooldownState("player-1", H.store.get("player-1"), { cooldowns: [{ cooldown_id: "season43", cooldown_started_date: "2026-10-22T17:00:00.000Z" }] }, SERVER_NOW));
        const Result = await Put(H.port, "/cooldown/player-1/season43", "host");
        assert.equal(Result.status, 200);
        assert.deepEqual(Result.json.payload, { GRANT_DAILY_X: "2026-10-11T18:00:00.000Z", season43: "2026-10-22T17:00:00.000Z" });
        assert.equal(CooldownStatePayload(H.store.get("player-1")).season43, "2026-10-22T17:00:00.000Z");
        assert.equal(H.hostCalls.records.length, 1);
        assert.equal(H.hostCalls.records[0].summary.keptLaterCount, 1);
        assert.deepEqual(H.hostCalls.records[0].summary.keptLater, [{ id: "season43", stored: "2026-10-22T17:00:00.000Z", attempted: SERVER_NOW }]);

        // A gameserver, by contrast, sets it to the backend's now as before.
        const Gs = await Put(H.port, "/cooldown/player-1/season43", "gs");
        assert.equal(Gs.json.payload.season43, SERVER_NOW);
    } finally {
        await H.close();
    }
});

test("a host cannot start a cooldown dated more than 48 hours ahead of the backend's clock: nothing stored, the refusal is tagged", async () => {
    // [2026-10-13 realms S3 limits] The route stamps the backend's own now, so this only happens when the two clocks differ (the
    // merge here still reads SERVER_NOW); the host rule then refuses it like a far-future batch entry.
    const Ahead = "2026-10-20T18:00:00.000Z";
    const H = await Start({ now: () => Ahead });
    try {
        const Result = await Put(H.port, `/cooldown/player-1/${SPROUT}`, "host");
        assert.equal(Result.status, 200);
        assert.deepEqual(Result.json.payload, {});
        assert.equal(H.store.get("player-1")?.entries.length, 0);
        assert.equal(H.hostCalls.records.length, 1);
        assert.equal(H.hostCalls.records[0].summary.refusedFutureCount, 1);
        assert.equal(H.hostCalls.records[0].summary.addedCount, 0);
        // A dedicated server's start at the same date is stored as before.
        const Gs = await Put(H.port, `/cooldown/player-1/${SPROUT}`, "gs");
        assert.deepEqual(Gs.json.payload, { [SPROUT]: Ahead });
    } finally {
        await H.close();
    }
});

test("a host the hooks refuse gets the hook's own answer and nothing is stored or tagged", async () => {
    const Denial = { status: 403, body: { code: "P2P_HOST_WRITE_DENIED", message: "This host may not write this player's state.", payload: null } };
    const H = await Start({}, Denial);
    try {
        const Result = await Put(H.port, `/cooldown/stranger/${SPROUT}`, "host");
        assert.equal(Result.status, 403);
        assert.deepEqual(Result.json, Denial.body);
        assert.deepEqual(H.hostCalls.authorize, [{ kind: "COOLDOWN", target: "stranger" }]);
        assert.deepEqual(H.hostCalls.records, []);
        assert.equal(H.store.size, 0);
    } finally {
        await H.close();
    }
});

test("a host request that would store nothing never reaches the hooks: malformed id 400, sentinel 400, persistence off 503", async () => {
    const H = await Start();
    try {
        assert.equal((await Put(H.port, "/cooldown/player-1/bad%20id", "host")).status, 400);
        assert.equal((await Put(H.port, `/cooldown/INVALID/${SPROUT}`, "host")).status, 400);
        assert.deepEqual(H.hostCalls.authorize, []);
        assert.equal(H.store.size, 0);
    } finally {
        await H.close();
    }
    const Off = await Start({ persistence: false });
    try {
        assert.equal((await Put(Off.port, `/cooldown/player-1/${SPROUT}`, "host")).status, 503);
        assert.deepEqual(Off.hostCalls.authorize, []);
    } finally {
        await Off.close();
    }
});

test("a dedicated server and a player never touch the host hooks, and a player is still refused", async () => {
    const H = await Start();
    try {
        assert.equal((await Put(H.port, `/cooldown/player-1/${SPROUT}`, "gs")).status, 200);
        assert.equal((await Put(H.port, `/cooldown/player-1/${SPROUT}`, "player")).status, 403);
        assert.deepEqual(H.hostCalls.authorize, []);
        assert.deepEqual(H.hostCalls.records, []);
    } finally {
        await H.close();
    }
});

test("without the P2P module the default hooks refuse a host write (dedicated-only build)", async () => {
    const H = await Start({ hostWrites: undefined });
    try {
        const Result = await Put(H.port, `/cooldown/player-1/${SPROUT}`, "host");
        assert.equal(Result.status, 403);
        assert.equal(Result.json.code, "forbidden");
        assert.equal(H.store.size, 0);
    } finally {
        await H.close();
    }
});
