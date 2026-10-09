import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { metricsRouter } from "./metrics";

function request(port: number, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: "/internal/v1/metrics", method: "GET", headers }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
    });
}

test("metrics endpoint is loopback-only without a token and bearer-authenticated with one", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousToken = process.env.MYSTICPARADOX_METRICS_TOKEN;
    const application = express();
    application.use(metricsRouter);
    const server = application.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address != undefined && typeof address === "object");
    const port = (address as import("node:net").AddressInfo).port;
    try {
        process.env.NODE_ENV = "development";
        delete process.env.MYSTICPARADOX_METRICS_TOKEN;
        assert.equal((await request(port)).status, 200);

        process.env.MYSTICPARADOX_METRICS_TOKEN = "route-test-token";
        assert.equal((await request(port)).status, 401);
        const authorized = await request(port, { authorization: "Bearer route-test-token" });
        assert.equal(authorized.status, 200);
        assert.match(authorized.body, /mysticparadox_service_ready/);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (previousNodeEnv == undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
        if (previousToken == undefined) delete process.env.MYSTICPARADOX_METRICS_TOKEN; else process.env.MYSTICPARADOX_METRICS_TOKEN = previousToken;
    }
});
