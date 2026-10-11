/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CreateSerialGate, DEFAULT_HUB_BACKOFF_MS, DEFAULT_HUB_STABLE_UPTIME_MS, HubSupervisor, HubSupervisorOptions } from "./hubSupervisor";

type FakeHub = { id: number; alive: boolean };
type FakeTimer = { fn: () => void; ms: number; cancelled: boolean };

function Deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const CurrentOf = (supervisor: HubSupervisor<FakeHub>): FakeHub | undefined => supervisor.current;

const Flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// A supervisor on a fake clock and fake timers. `outcomes` decides each start: a hub, an error, or a deferred.
function Harness(outcomes: Array<"ok" | "fail" | Promise<FakeHub>>, extra: Partial<HubSupervisorOptions<FakeHub>> = {}) {
    let clock = 1_000_000;
    let nextId = 1;
    const timers: FakeTimer[] = [];
    const logs: string[] = [];
    let starts = 0;
    const supervisor = new HubSupervisor<FakeHub>({
        label: "test_hub",
        start: async () => {
            const outcome = outcomes[starts++] ?? "ok";
            if (outcome === "fail") throw new Error("did not report ready");
            if (outcome === "ok") return { id: nextId++, alive: true };
            return outcome;
        },
        isAlive: (hub) => hub.alive,
        now: () => clock,
        setTimer: (fn, ms) => {
            const timer: FakeTimer = { fn, ms, cancelled: false };
            timers.push(timer);
            return { cancel: () => { timer.cancelled = true; } };
        },
        log: (_level, message) => { logs.push(message); },
        ...extra
    });
    return {
        supervisor,
        timers,
        logs,
        get starts() { return starts; },
        advance(ms: number) { clock += ms; },
        live: () => timers.filter((timer) => !timer.cancelled),
        // Fires the newest live timer after moving the clock to its due time.
        async fire() {
            const timer = timers.filter((t) => !t.cancelled).pop();
            assert.ok(timer, "expected an armed retry timer");
            timer.cancelled = true;
            clock += timer.ms;
            timer.fn();
            await Flush();
        }
    };
}

test("a failed start arms the retry timer and the retry actually starts the hub", async () => {
    const h = Harness(["fail", "ok"]);
    const first = await h.supervisor.ensure("boot");
    assert.equal(first, undefined);
    assert.equal(h.starts, 1);
    assert.equal(h.supervisor.pending, false);
    assert.equal(h.live().length, 1, "the first design armed 0 timers here");
    assert.equal(h.live()[0].ms, 5_000);
    assert.equal(h.supervisor.retryArmed, true);

    await h.fire();
    assert.equal(h.starts, 2);
    assert.ok(h.supervisor.current);
    assert.equal(h.supervisor.current!.alive, true);
    assert.equal(h.live().length, 0);
});

test("repeated failed starts back off 5, 15, 30, 60, 120, 300 s and stay capped at 300 s", async () => {
    const h = Harness(Array(8).fill("fail"));
    await h.supervisor.ensure("boot");
    const delays = [h.live()[0].ms];
    for (let i = 0; i < 7; i++) {
        await h.fire();
        delays.push(h.live()[0].ms);
    }
    assert.deepEqual(delays, [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    assert.equal(h.starts, 8);
});

test("a failed restart after a crash is retried by its timer (exit -> fail -> retry -> up)", async () => {
    const h = Harness(["ok", "fail", "ok"]);
    const hub = await h.supervisor.ensure("boot");
    assert.ok(hub);
    h.advance(200_000);                       // stable run
    hub!.alive = false;
    h.supervisor.onExit(hub!, "exit code=3");
    await Flush();
    assert.equal(h.starts, 2, "a stable exit restarts at once");
    assert.equal(h.supervisor.current, undefined);
    assert.equal(h.live().length, 1);
    await h.fire();
    assert.equal(h.starts, 3);
    assert.ok(h.supervisor.current);
});

test("concurrent ensure() callers share one start", async () => {
    const pending = Deferred<FakeHub>();
    const h = Harness([pending.promise]);
    const a = h.supervisor.ensure("boot");
    const b = h.supervisor.ensure("request");
    const c = h.supervisor.ensure("watchdog");
    h.supervisor.tick();
    await Flush();
    assert.equal(h.starts, 1);
    assert.equal(h.supervisor.pending, true);
    const hub = { id: 42, alive: true };
    pending.resolve(hub);
    assert.equal(await a, hub);
    assert.equal(await b, hub);
    assert.equal(await c, hub);
    assert.equal(h.starts, 1);
    assert.equal(h.supervisor.pending, false);
});

test("an exit after a stable run restarts at once without a timer", async () => {
    const h = Harness(["ok", "ok"]);
    const hub = (await h.supervisor.ensure("boot"))!;
    h.advance(120_000);
    hub.alive = false;
    h.supervisor.onExit(hub, "exit code=0");
    await Flush();
    assert.equal(h.starts, 2);
    assert.equal(h.timers.length, 0);
    assert.notEqual(h.supervisor.current, hub);
    assert.equal(h.supervisor.failureCount, 0);
});

test("a crash loop backs off and requests cannot skip the backoff", async () => {
    const h = Harness(["ok", "ok"]);
    const hub = (await h.supervisor.ensure("boot"))!;
    h.advance(10_000);
    hub.alive = false;
    h.supervisor.onExit(hub, "exit code=3");
    await Flush();
    assert.equal(h.starts, 1, "no immediate start after an early exit");
    assert.equal(h.live().length, 1);
    assert.equal(h.live()[0].ms, 5_000);
    h.advance(1_000);
    assert.equal(await h.supervisor.ensure("request"), undefined);
    assert.equal(h.starts, 1);
    assert.equal(h.live().length, 1, "the request re-uses the armed timer");
    await h.fire();
    assert.equal(h.starts, 2);
    assert.ok(h.supervisor.current);
});

test("an exit of a hub that is not current is ignored", async () => {
    const h = Harness(["ok"]);
    const hub = (await h.supervisor.ensure("boot"))!;
    h.supervisor.onExit({ id: 999, alive: false }, "late exit of a killed failed start");
    await Flush();
    assert.equal(h.starts, 1);
    assert.equal(h.supervisor.current, hub);
    assert.equal(h.timers.length, 0);
});

test("watchdog and exit event in the same pass restart once", async () => {
    const h = Harness(["ok", "ok"]);
    const hub = (await h.supervisor.ensure("boot"))!;
    h.advance(300_000);
    hub.alive = false;
    h.supervisor.tick();
    h.supervisor.onExit(hub, "exit code=3");
    await Flush();
    assert.equal(h.starts, 2);
    assert.notEqual(h.supervisor.current, hub);
});

test("tick() retries a missing hub once its backoff is due and never doubles a start in flight", async () => {
    const pending = Deferred<FakeHub>();
    const h = Harness(["fail", pending.promise]);
    await h.supervisor.ensure("boot");
    h.supervisor.tick();
    await Flush();
    assert.equal(h.starts, 1, "backoff not due yet");
    h.advance(5_000);
    h.supervisor.tick();
    await Flush();
    assert.equal(h.starts, 2);
    h.supervisor.tick();
    await Flush();
    assert.equal(h.starts, 2, "a start is in flight");
    pending.resolve({ id: 7, alive: true });
    await Flush();
    assert.equal(h.supervisor.current?.id, 7);
});

test("an exit reported while a start is in flight adds no failure", async () => {
    const pending = Deferred<FakeHub>();
    const h = Harness(["ok", pending.promise]);
    const hub = (await h.supervisor.ensure("boot"))!;
    h.advance(300_000);
    hub.alive = false;
    void h.supervisor.ensure("request");       // dead current, cleared here, start begins
    await Flush();
    assert.equal(h.starts, 2);
    h.supervisor.onExit(hub, "late exit event");
    assert.equal(h.supervisor.failureCount, 0);
    pending.resolve({ id: 8, alive: true });
    await Flush();
    assert.equal(h.supervisor.current?.id, 8);
    assert.equal(h.supervisor.failureCount, 0);
});

test("a hub that is dead when its start resolves counts as a failed start", async () => {
    const h = Harness([Promise.resolve({ id: 5, alive: false }), "ok"]);
    assert.equal(await h.supervisor.ensure("boot"), undefined);
    assert.equal(h.supervisor.current, undefined);
    assert.equal(h.live().length, 1);
    await h.fire();
    assert.equal(CurrentOf(h.supervisor)?.alive, true);   // re-read through a call: the assert above narrowed the getter
});

test("a start that throws synchronously still clears the in-flight state", async () => {
    let calls = 0;
    const h = Harness([], {
        start: () => { calls++; if (calls === 1) throw new Error("spawn EINVAL"); return Promise.resolve({ id: 1, alive: true }); }
    });
    assert.equal(await h.supervisor.ensure("boot"), undefined);
    assert.equal(h.supervisor.pending, false);
    assert.equal(h.live().length, 1);
    await h.fire();
    assert.equal(calls, 2);
    assert.ok(h.supervisor.current);
});

test("two supervisors sharing a gate never start at once, also after a rejected start", async () => {
    const gate = CreateSerialGate();
    const first = Deferred<FakeHub>();
    const second = Deferred<FakeHub>();
    const order: string[] = [];
    const make = (label: string, d: ReturnType<typeof Deferred<FakeHub>>) => new HubSupervisor<FakeHub>({
        label,
        start: () => gate(() => { order.push(`${label}:begin`); return d.promise.finally(() => order.push(`${label}:end`)); }),
        isAlive: (hub) => hub.alive,
        setTimer: () => ({ cancel: () => {} })
    });
    const ramsgate = make("ramsgate", first);
    const dojo = make("dojo", second);
    const a = ramsgate.ensure("boot");
    const b = dojo.ensure("boot");
    await Flush();
    assert.deepEqual(order, ["ramsgate:begin"]);
    first.reject(new Error("timeout"));
    assert.equal(await a, undefined);
    await Flush();
    assert.deepEqual(order, ["ramsgate:begin", "ramsgate:end", "dojo:begin"]);
    second.resolve({ id: 2, alive: true });
    assert.equal((await b)?.id, 2);
});

test("start() receives the ensure() reason, so gameservers.ts can tell the boot start from a restart", async () => {
    const reasons: string[] = [];
    const h = Harness([], { start: async (reason) => { reasons.push(reason); return { id: reasons.length, alive: true }; } });
    const hub = await h.supervisor.ensure("boot");
    h.advance(DEFAULT_HUB_STABLE_UPTIME_MS);
    h.supervisor.onExit(hub!, "exit code=0");
    await Flush();
    assert.deepEqual(reasons, ["boot", "exit: exit code=0"]);
});

test("the default clock is monotonic (performance.now), not the wall clock", async () => {
    const supervisor = new HubSupervisor<FakeHub>({
        label: "clock_hub",
        start: async () => { throw new Error("did not report ready"); },
        isAlive: (hub) => hub.alive,
        setTimer: () => ({ cancel: () => {} })
    });
    const before = performance.now();
    await supervisor.ensure("boot");
    const due = supervisor.nextAttemptDueAt;
    assert.ok(due >= before + DEFAULT_HUB_BACKOFF_MS[0] && due <= performance.now() + DEFAULT_HUB_BACKOFF_MS[0], `due=${due}`);
    supervisor.dispose();
});
