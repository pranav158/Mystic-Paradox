import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { DEFAULT_GAMESERVER_REQUESTS_PER_MINUTE, DEFAULT_REQUESTS_PER_MINUTE, RequestRateLimitOptions } from "./rateLimit";

function request(port: number, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: "/probe", method: "GET", headers }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end();
    });
}

async function withLimitedApp(environment: NodeJS.ProcessEnv, run: (port: number) => Promise<void>): Promise<void> {
    const application = express();
    application.use(rateLimit(RequestRateLimitOptions(environment)));
    application.get("/probe", (_req, res) => { res.status(200).send("ok"); });
    const server = application.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
    });
    try {
        await run((server.address() as AddressInfo).port);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

const GameserverHeader = { "x-mysticparadox-gameserver-apikey": "any-value" };

test("request budget defaults, overrides and ignores invalid values", () => {
    const req = (headers: Record<string, string>) => ({ headers, ip: "203.0.113.7" }) as any;
    const limit = (environment: NodeJS.ProcessEnv, headers: Record<string, string> = {}) =>
        (RequestRateLimitOptions(environment).limit as (req: any, res: any) => number)(req(headers), {});

    assert.equal(limit({}), DEFAULT_REQUESTS_PER_MINUTE);
    assert.equal(limit({}, GameserverHeader), DEFAULT_GAMESERVER_REQUESTS_PER_MINUTE);
    assert.equal(limit({ MYSTICPARADOX_RATE_LIMIT_PER_MINUTE: " 50 " }), 50);
    assert.equal(limit({ MYSTICPARADOX_GAMESERVER_RATE_LIMIT_PER_MINUTE: "900" }, GameserverHeader), 900);
    for (const invalid of ["0", "-5", "1.5", "lots", ""]) {
        assert.equal(limit({ MYSTICPARADOX_RATE_LIMIT_PER_MINUTE: invalid }), DEFAULT_REQUESTS_PER_MINUTE);
    }

    const key = RequestRateLimitOptions({}).keyGenerator as (req: any, res: any) => string;
    assert.equal(key(req({}), {}), "client:203.0.113.7");
    assert.equal(key(req(GameserverHeader), {}), "gameserver:203.0.113.7");
});

test("client and gameserver calls from one address use separate budgets", async () => {
    await withLimitedApp({ MYSTICPARADOX_RATE_LIMIT_PER_MINUTE: "2", MYSTICPARADOX_GAMESERVER_RATE_LIMIT_PER_MINUTE: "3" }, async (port) => {
        assert.deepEqual([await request(port), await request(port), await request(port)], [200, 200, 429]);
        const gameserver = [];
        for (let index = 0; index < 4; index++) gameserver.push(await request(port, GameserverHeader));
        assert.deepEqual(gameserver, [200, 200, 200, 429]);
    });
});

test("MYSTICPARADOX_RATE_LIMIT=off disables the budget", async () => {
    await withLimitedApp({ MYSTICPARADOX_RATE_LIMIT: "off", MYSTICPARADOX_RATE_LIMIT_PER_MINUTE: "1" }, async (port) => {
        assert.deepEqual([await request(port), await request(port), await request(port)], [200, 200, 200]);
    });
});
