/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";

/*
 * [2026-10-15] The Slayer Link routes of routes/friends.ts (social-prod: POST /slayerlink/availability and GET /slayerlink/status_good)
 * over HTTP, with the auth middleware (x-test-role picks the caller) and the logger replaced before the router is first required.
 * The payload builders are checked directly as well.
 */

const Quiet = () => undefined;
function Fake(modulePath: string, exports: Record<string, unknown>): void {
    const Resolved = require.resolve(modulePath);
    require.cache[Resolved] = { id: Resolved, filename: Resolved, loaded: true, exports, children: [], paths: [] } as unknown as NodeJS.Module;
}
Fake("../logger", { logger: { level: "silent", trace: Quiet, debug: Quiet, info: Quiet, warn: Quiet, error: Quiet, fatal: Quiet, child: () => ({}) }, ApplyDiagnosticsLogProfile: Quiet });
Fake("../middleware/HasParadoxBackendAuth", {
    HasParadoxBackendAuth: (req: any, res: any, next: () => void) => {
        if (req.headers["x-test-role"] === undefined) { res.status(401).send(); return; }
        req.AuthData = { userId: "player-1" };
        next();
    },
});

let Listening: Server;
let Port = 0;
let Friends: typeof import("./friends");

before(async () => {
    Friends = require("./friends");
    const App = express();
    App.use(express.json());
    App.use(Friends.friendsRouter);
    Listening = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { Listening.once("listening", () => resolve()); Listening.once("error", reject); });
    Port = (Listening.address() as AddressInfo).port;
});

after(async () => {
    await new Promise<void>((resolve) => Listening.close(() => resolve()));
});

function Send(method: string, path: string, role: string | undefined, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const Headers: Record<string, string> = {};
        if (role !== undefined) Headers["x-test-role"] = role;
        const Payload = body === undefined ? undefined : JSON.stringify(body);
        if (Payload !== undefined) Headers["content-type"] = "application/json";
        const Req = http.request({ hostname: "127.0.0.1", port: Port, path, method, headers: Headers }, (res) => {
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

test("the availability payload answers every well-formed account as not available and drops anything else", () => {
    assert.deepEqual(Friends.SlayerLinkAvailabilityPayload({ account_ids: ["XQBF5VHGFJHR5AUILEPYI55MUQ", "", 7, "PLNTNCL7PNFUHBRPEBVSTAZ47A"] }), {
        availability: [
            { account_id: "XQBF5VHGFJHR5AUILEPYI55MUQ", available: false },
            { account_id: "PLNTNCL7PNFUHBRPEBVSTAZ47A", available: false },
        ],
    });
    assert.deepEqual(Friends.SlayerLinkAvailabilityPayload({ account_ids: "not a list" }), { availability: [] });
    assert.deepEqual(Friends.SlayerLinkAvailabilityPayload(undefined), { availability: [] });
    assert.deepEqual(Friends.SlayerLinkAvailabilityPayload({ account_ids: ["x".repeat(129)] }), { availability: [] }, "an id over 128 characters is dropped");
    const Many = Array.from({ length: Friends.SLAYER_LINK_MAX_ACCOUNTS + 40 }, (_, Index) => `ACCOUNT${Index}`);
    assert.equal(Friends.SlayerLinkAvailabilityPayload({ account_ids: Many }).availability.length, Friends.SLAYER_LINK_MAX_ACCOUNTS);
});

test("the status payload is the captured shape with no invites and no links", () => {
    assert.deepEqual(Friends.SlayerLinkStatusPayload(), {
        config: { invite_expiry_hours: 48, link_duration_hours: 168 },
        invites: [],
        links: [],
    });
});

test("POST /slayerlink/availability and GET /slayerlink/status_good answer the usual envelope to a signed-in caller", async () => {
    const Availability = await Send("POST", "/slayerlink/availability", "player", { account_ids: ["XQBF5VHGFJHR5AUILEPYI55MUQ"] });
    assert.equal(Availability.status, 200);
    assert.deepEqual(Availability.json, {
        code: null, message: "OK", payload: { availability: [{ account_id: "XQBF5VHGFJHR5AUILEPYI55MUQ", available: false }] },
    });
    const Status = await Send("GET", "/slayerlink/status_good", "player");
    assert.equal(Status.status, 200);
    assert.deepEqual(Status.json, { code: null, message: "OK", payload: Friends.SlayerLinkStatusPayload() });
    assert.equal((await Send("POST", "/slayerlink/availability", undefined, { account_ids: [] })).status, 401);
    assert.equal((await Send("GET", "/slayerlink/status_good", undefined)).status, 401);
});
