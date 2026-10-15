/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { ReleaseGate } from "../observability/releaseGates";
import { ActivePlayGate, CreateReleaseGatesHandler, CreateReleaseGatesRouter, HasForwardingHeader } from "./releaseGates";

const AllOk: ReleaseGate[] = [{ name: "guard_mode", ok: true, detail: "mode=observe (default)" }];
const OneBad: ReleaseGate[] = [...AllOk, { name: "no_legacy_env_keys", ok: false, detail: "1 MYSTPAX_ key(s): MYSTPAX_X" }];

interface FakeResponse {
    statusCode: number;
    body: unknown;
    sent: boolean;
    status(code: number): FakeResponse;
    json(body: unknown): FakeResponse;
    send(): FakeResponse;
}

function FakeResponse(): FakeResponse {
    const Response: FakeResponse = {
        statusCode: 200,
        body: undefined,
        sent: false,
        status(code) { Response.statusCode = code; return Response; },
        json(body) { Response.body = body; return Response; },
        send() { Response.sent = true; return Response; }
    };
    return Response;
}

function FakeRequest(remoteAddress: string | undefined, headers: Record<string, string> = {}) {
    return { socket: { remoteAddress }, headers };
}

async function Invoke(remoteAddress: string | undefined, collect: () => Promise<ReleaseGate[]>,
    headers: Record<string, string> = {}): Promise<{ response: FakeResponse; collected: boolean }> {
    let collected = false;
    const handler = CreateReleaseGatesHandler(async () => { collected = true; return collect(); });
    const response = FakeResponse();
    await handler(FakeRequest(remoteAddress, headers) as any, response as any);
    return { response, collected };
}

test("a non-loopback peer gets 404 and no gate is collected", async () => {
    for (const peer of ["203.0.113.7", "::ffff:203.0.113.7", undefined]) {
        const { response, collected } = await Invoke(peer, async () => AllOk);
        assert.equal(response.statusCode, 404);
        assert.equal(response.sent, true);
        assert.equal(response.body, undefined);
        assert.equal(collected, false);
    }
});

test("a loopback peer that carries a forwarding header (a proxied request) gets 404", async () => {
    for (const header of ["x-forwarded-for", "x-real-ip", "forwarded"]) {
        const { response, collected } = await Invoke("127.0.0.1", async () => AllOk, { [header]: "203.0.113.7" });
        assert.equal(response.statusCode, 404);
        assert.equal(collected, false);
    }
    assert.equal(HasForwardingHeader({ "x-forwarded-for": "1.2.3.4" }), true);
    assert.equal(HasForwardingHeader({ host: "localhost" }), false);
});

test("a loopback peer gets 200 with the aggregate body when every gate is ok, 503 when one is not", async () => {
    const Ok = await Invoke("::1", async () => AllOk);
    assert.equal(Ok.response.statusCode, 200);
    assert.deepEqual(Ok.response.body, { ok: true, gates: AllOk });

    const Bad = await Invoke("127.0.0.1", async () => OneBad);
    assert.equal(Bad.response.statusCode, 503);
    assert.equal((Bad.response.body as { ok: boolean }).ok, false);
    assert.equal((Bad.response.body as { gates: unknown[] }).gates.length, 2);
});

test("a collector that throws gives 503 with one generic gate and no error text", async () => {
    const Failed = await Invoke("127.0.0.1", async () => { throw new Error("mongodb://user:pw@host"); });
    assert.equal(Failed.response.statusCode, 503);
    const Body = JSON.stringify(Failed.response.body);
    assert.equal(Body.includes("mongodb://"), false);
    assert.equal((Failed.response.body as { ok: boolean }).ok, false);
});

test("served on a real loopback socket: 200 for the local caller, 404 when a forwarding header is sent", async () => {
    const application = express();
    application.use("/", CreateReleaseGatesRouter(async () => AllOk));
    const server = application.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
    });
    try {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const base = `http://127.0.0.1:${port}/health/release-gates`;

        const Local = await fetch(base);
        assert.equal(Local.status, 200);
        assert.deepEqual(await Local.json(), { ok: true, gates: AllOk });

        const Proxied = await fetch(base, { headers: { "x-forwarded-for": "203.0.113.7" } });
        assert.equal(Proxied.status, 404);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

// [2026-10-15] Never restart mid-hunt: a release is held while anyone is in game, unless the emergency file is there.
test("the active-play gate holds a release while anyone is in game, unless the override file says otherwise", () => {
    assert.deepEqual(ActivePlayGate(0, false), { name: "no_active_play", ok: true, detail: "nobody in game" });
    const Held = ActivePlayGate(2, false);
    assert.equal(Held.ok, false);
    assert.ok(Held.detail.includes("2 player(s) in game") && Held.detail.includes("RELEASE_DURING_PLAY.allow"), Held.detail);
    const Allowed = ActivePlayGate(1, true);
    assert.equal(Allowed.ok, true);
    assert.ok(Allowed.detail.includes("let through"), Allowed.detail);
});
