import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import test from "node:test";
import express from "express";
import { RenderMetrics, ResetMetricsForTests } from "../../observability/metrics";
import {
    AggregateHostRouteSamples,
    HostRouteCensus,
    HostRouteOf,
    HostRouteRow,
    HostRouteStatusClass,
    NormalizeHostRouteSample,
    ReadHostRouteCensusEnabled,
    SummarizeHostRoutes
} from "./hostRouteCensus";

// [2026-10-14 realms wave 2] The host route census: the pure aggregation, the minute flush on a fake timer, the switch, and the
// middleware on real requests (a stand-in authentication sets AuthData the way security/hostRuntimeAuth.ts does).

/** A timer that only fires when the test says so. */
class FakeTimers {
    readonly active: Array<{ callback: () => void; ms: number; unrefCalls: number }> = [];
    readonly setInterval = (callback: () => void, ms: number): unknown => {
        const timer = { callback, ms, unrefCalls: 0, unref: (): void => { timer.unrefCalls += 1; } };
        this.active.push(timer);
        return timer;
    };
    readonly clearInterval = (handle: unknown): void => {
        const index = this.active.findIndex((timer) => timer === handle);
        if (index >= 0) this.active.splice(index, 1);
    };
    fire(): void {
        for (const timer of [...this.active]) timer.callback();
    }
}

function Census(enabled = true, lines: string[] = [], timers = new FakeTimers()): { census: HostRouteCensus; timers: FakeTimers; lines: string[] } {
    const census = new HostRouteCensus({
        enabled, log: (line) => { lines.push(line); }, setInterval: timers.setInterval, clearInterval: timers.clearInterval
    });
    return { census, timers, lines };
}

async function Settled(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400 && !condition(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

// ----- the pure parts -----

test("status classes: the hundreds digit, and other for a code outside 100-599", () => {
    assert.equal(HostRouteStatusClass(200), "2xx");
    assert.equal(HostRouteStatusClass(409), "4xx");
    assert.equal(HostRouteStatusClass(503), "5xx");
    assert.equal(HostRouteStatusClass(0), "other");
    assert.equal(HostRouteStatusClass(99), "other");
    assert.equal(HostRouteStatusClass(600), "other");
    assert.equal(HostRouteStatusClass(Number.NaN), "other");
});

test("a sample is counted as a bounded label set: an odd method is OTHER, an odd kind is unknown, a missing hub kind is null", () => {
    assert.deepEqual(NormalizeHostRouteSample({ method: "PROPFIND", route: "/x", statusCode: 200, sessionKind: "REALM_HUB", hubKind: "RAMSGATE" }),
        { method: "OTHER", route: "/x", status: "2xx", sessionKind: "REALM_HUB", hubKind: "RAMSGATE" });
    assert.deepEqual(NormalizeHostRouteSample({ method: "GET", route: "", statusCode: 200 }),
        { method: "GET", route: "(no route)", status: "2xx", sessionKind: "unknown", hubKind: null });
    assert.equal(NormalizeHostRouteSample({ method: "GET", route: "/y", statusCode: 200, sessionKind: "player 123/abc" }).sessionKind, "unknown");
    assert.equal(NormalizeHostRouteSample({ method: "GET", route: "/".repeat(161), statusCode: 200 }).route, "(no route)");
});

test("the route label is the Express pattern with the router's mount path, never a URL", () => {
    assert.equal(HostRouteOf({ route: { path: "/inventory/:userId" }, baseUrl: "" }), "/inventory/:userId");
    assert.equal(HostRouteOf({ route: { path: "/:huntId/lease" }, baseUrl: "/mystic/v1/hunts" }), "/mystic/v1/hunts/:huntId/lease");
    assert.equal(HostRouteOf({ route: undefined, baseUrl: "" }), "(no route)");
    assert.equal(HostRouteOf({ route: { path: /^\/regex/ }, baseUrl: "" }), "(pattern)");
});

test("samples merge by method, route, status class and kinds; the summary sorts by count and caps the rows", () => {
    const rows = AggregateHostRouteSamples([
        { method: "GET", route: "/a", statusCode: 200 },
        { method: "GET", route: "/a", statusCode: 204 },
        { method: "GET", route: "/a", statusCode: 404 },
        { method: "POST", route: "/a", statusCode: 200, sessionKind: "REALM_HUB", hubKind: "TRAINING" }
    ]);
    assert.equal(rows.length, 3);
    assert.equal(rows.find((row) => row.method === "GET" && row.status === "2xx")?.count, 2);
    const summary = SummarizeHostRoutes(rows, 60);
    assert.deepEqual(summary?.routes.map((row) => row.count), [2, 1, 1]);
    assert.equal(summary?.total, 4);
    assert.equal(summary?.windowSeconds, 60);
    assert.equal(summary?.omittedRows, 0);

    assert.equal(SummarizeHostRoutes([], 60), undefined, "an idle window has no summary");
    const many: HostRouteRow[] = [1, 2, 3, 4, 5].map((count) => ({
        method: "GET", route: `/r${count}`, status: "2xx", sessionKind: "unknown", hubKind: null, count
    }));
    const capped = SummarizeHostRoutes(many, 60, 3);
    assert.deepEqual(capped?.routes.map((row) => row.count), [5, 4, 3]);
    assert.equal(capped?.omittedRows, 2);
    assert.equal(capped?.total, 15, "the total counts every row, shown or not");
});

test("ties in the summary are ordered by key, so the line is stable", () => {
    const rows: HostRouteRow[] = [
        { method: "POST", route: "/b", status: "2xx", sessionKind: "unknown", hubKind: null, count: 1 },
        { method: "GET", route: "/a", status: "2xx", sessionKind: "unknown", hubKind: null, count: 1 }
    ];
    assert.deepEqual(SummarizeHostRoutes(rows, 60)?.routes.map((row) => row.method), ["GET", "POST"]);
});

// ----- the window and its flush (fake timer) -----

test("one summary line per window with traffic; the timer starts with the first count and is unref'd", () => {
    const { census, timers, lines } = Census();
    assert.equal(timers.active.length, 0, "no timer before traffic");
    census.record({ method: "GET", route: "/inventory/:userId", statusCode: 200 });
    census.record({ method: "GET", route: "/inventory/:userId", statusCode: 200 });
    census.record({ method: "POST", route: "/progression/:userId/:track", statusCode: 409, sessionKind: "REALM_HUB", hubKind: "RAMSGATE" });
    assert.equal(timers.active.length, 1);
    assert.equal(timers.active[0]!.ms, 60_000);
    assert.equal(timers.active[0]!.unrefCalls, 1);
    assert.equal(lines.length, 0, "nothing is logged mid-window");

    timers.fire();
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.startsWith("[HostRoute] summary "));
    assert.deepEqual(JSON.parse(lines[0]!.slice("[HostRoute] summary ".length)), {
        windowSeconds: 60,
        total: 3,
        routes: [
            { method: "GET", route: "/inventory/:userId", status: "2xx", sessionKind: "unknown", hubKind: null, count: 2 },
            { method: "POST", route: "/progression/:userId/:track", status: "4xx", sessionKind: "REALM_HUB", hubKind: "RAMSGATE", count: 1 }
        ],
        omittedRows: 0
    });

    timers.fire();
    assert.equal(lines.length, 1, "an idle window logs nothing");
    census.record({ method: "GET", route: "/x", statusCode: 200 });
    timers.fire();
    assert.equal(lines.length, 2, "the next window starts from zero");
    assert.match(lines[1]!, /"total":1,/);
});

test("stop logs the open window and stops the timer; a later count starts a new one", () => {
    const { census, timers, lines } = Census();
    census.record({ method: "GET", route: "/x", statusCode: 200 });
    census.stop();
    assert.equal(lines.length, 1, "the open window is logged");
    assert.equal(timers.active.length, 0);
    census.stop();
    assert.equal(lines.length, 1, "stop again is harmless");
    census.record({ method: "GET", route: "/x", statusCode: 200 });
    assert.equal(timers.active.length, 1, "a count after stop starts the timer again");
});

test("peek reads the window without clearing it", () => {
    const { census, lines } = Census();
    census.record({ method: "GET", route: "/x", statusCode: 200 });
    assert.equal(census.peek()?.total, 1);
    assert.equal(census.peek()?.total, 1);
    assert.equal(lines.length, 0);
});

// ----- the switch -----

test("MYSTICPARADOX_HOST_ROUTE_CENSUS: on unless it is off, 0, false or no", () => {
    assert.equal(ReadHostRouteCensusEnabled({}), true);
    assert.equal(ReadHostRouteCensusEnabled({ MYSTICPARADOX_HOST_ROUTE_CENSUS: "on" }), true);
    assert.equal(ReadHostRouteCensusEnabled({ MYSTICPARADOX_HOST_ROUTE_CENSUS: "off" }), false);
    assert.equal(ReadHostRouteCensusEnabled({ MYSTICPARADOX_HOST_ROUTE_CENSUS: " OFF " }), false);
    assert.equal(ReadHostRouteCensusEnabled({ MYSTICPARADOX_HOST_ROUTE_CENSUS: "0" }), false);
    assert.equal(ReadHostRouteCensusEnabled({ MYSTICPARADOX_HOST_ROUTE_CENSUS: "false" }), false);
    assert.equal(ReadHostRouteCensusEnabled({ MYSTICPARADOX_HOST_ROUTE_CENSUS: "no" }), false);
});

test("disabled: nothing is counted or logged, no timer starts, and the middleware attaches no listener", () => {
    const { census, timers, lines } = Census(false);
    census.record({ method: "GET", route: "/x", statusCode: 200 });
    assert.equal(census.peek(), undefined);
    census.stop();
    assert.equal(timers.active.length, 0);
    assert.equal(lines.length, 0);

    const finishListeners: Array<() => void> = [];
    const res = { on: (event: string, listener: () => void) => { if (event === "finish") finishListeners.push(listener); } };
    let passed = false;
    census.middleware()({ headers: { "x-mystic-host-capability": "value" } } as never, res as never, () => { passed = true; });
    assert.equal(passed, true, "the request always continues");
    assert.equal(finishListeners.length, 0);
});

// ----- the middleware on real requests -----

test("the middleware counts only the host runtime's answered requests, by route pattern, status and session kind", async () => {
    ResetMetricsForTests();
    const { census, lines } = Census();
    const app = express();
    app.use(census.middleware());
    // Stands in for security/hostRuntimeAuth.ts: a request with the host header is a host runtime's and carries its session kind.
    app.use((req, res, next) => {
        if (req.headers["x-mystic-host-capability"] !== undefined) {
            (req as unknown as { AuthData: unknown }).AuthData = { IsPlayerHostRuntime: true, IsGameserver: false };
            res.locals.hostRouteSession = { sessionKind: "REALM_HUB", hubKind: "RAMSGATE" };
        }
        next();
    });
    app.get("/inventory/:userId", (_req, res) => { res.status(200).send("ok"); });
    app.post("/progression/:userId/:track", (_req, res) => { res.status(409).send("no"); });
    const server = await new Promise<Server>((resolve) => { const listening: Server = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const host = { "x-mystic-host-capability": "capability-value-that-must-not-be-logged" };
    try {
        await fetch(`${base}/inventory/account-abc-123`, { headers: host });
        await fetch(`${base}/inventory/account-def-456`, { headers: host });
        await fetch(`${base}/progression/account-ghi/PrestigeTrack_Weapon_X`, { method: "POST", headers: host });
        await fetch(`${base}/nowhere/at-all`, { headers: host });
        await fetch(`${base}/inventory/account-plain`); // a player's own request: not the host runtime's
    } finally {
        server.close();
    }
    await Settled(() => census.peek()?.total === 4);

    const summary = census.peek();
    assert.equal(summary?.total, 4);
    assert.deepEqual(summary?.routes.map((row) => [row.method, row.route, row.status, row.count]), [
        ["GET", "/inventory/:userId", "2xx", 2],
        ["GET", "(no route)", "4xx", 1],
        ["POST", "/progression/:userId/:track", "4xx", 1]
    ]);
    assert.ok(summary?.routes.every((row) => row.sessionKind === "REALM_HUB" && row.hubKind === "RAMSGATE"));
    const text = JSON.stringify(summary);
    for (const secret of ["account-abc-123", "account-plain", "capability-value", "nowhere", "PrestigeTrack"]) {
        assert.equal(text.includes(secret), false, `the summary carries no ${secret}`);
    }
    assert.match(RenderMetrics(), /mysticparadox_host_route_requests_total\{method="GET",status="2xx"\} 2/);
    assert.equal(lines.length, 0, "the window has not closed");
    census.flush();
    assert.equal(lines.length, 1);
});
