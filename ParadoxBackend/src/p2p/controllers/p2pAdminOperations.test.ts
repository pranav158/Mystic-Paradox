import assert from "node:assert/strict";
import test from "node:test";
import { MonitorHuntTiming } from "./p2pAdminOperations";

// [2026-10-15] Hunt start and active playtime for the admin monitor (MonitorHuntTiming).
const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const SESSION = "hunt_7f21c";

function transition(toState: string, minutes: number, generation = 1, sessionId = SESSION) {
    return { sessionId, generation, toState, at: at(minutes) };
}

test("a session that never ran has no start and no playtime", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 1, state: "FENCED", terminalAt: at(20) }, [
        transition("HOST_READY", -5),
        transition("ADMITTING", -4),
    ]);
    assert.equal(timing.startedAt, null);
    assert.equal(timing.activePlaytimeMs, null);
    assert.deepEqual(timing.unknownFields, ["startedAt", "activePlaytime", "repeatedRespawnKills", "behemothIdentity"]);
});

test("a session that never ran and has no transitions at all stays unfilled", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 1, state: "RUNNING" }, []);
    assert.equal(timing.startedAt, null);
    assert.equal(timing.activePlaytimeMs, null);
});

test("a hunt still running measures playtime up to now", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 1, state: "RUNNING", terminalAt: null },
        [transition("HOST_READY", -2), transition("RUNNING", 0)], T0 + 5 * 60_000);
    assert.equal(timing.startedAt, at(0));
    assert.equal(timing.activePlaytimeMs, 5 * 60_000);
    assert.deepEqual(timing.unknownFields, ["repeatedRespawnKills", "behemothIdentity"]);
});

test("an ended hunt measures playtime to its terminalAt, not to now", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 1, state: "COMPLETED", terminalAt: at(12) },
        [transition("RUNNING", 2)], T0 + 90 * 60_000);
    assert.equal(timing.startedAt, at(2));
    assert.equal(timing.activePlaytimeMs, 10 * 60_000);
    assert.deepEqual(timing.unknownFields, ["repeatedRespawnKills", "behemothIdentity"]);
});

test("a transition from another generation is ignored", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 2, state: "COMPLETED", terminalAt: at(30) }, [
        transition("RUNNING", -60, 1),
        transition("RUNNING", 4, 2),
    ]);
    assert.equal(timing.startedAt, at(4));
    assert.equal(timing.activePlaytimeMs, 26 * 60_000);
});

test("a generation with no RUNNING transition of its own is not started by an older generation", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 2, state: "FENCED", terminalAt: at(30) },
        [transition("RUNNING", 0, 1)]);
    assert.equal(timing.startedAt, null);
    assert.equal(timing.activePlaytimeMs, null);
});

test("a transition from another session is ignored", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 1, state: "COMPLETED", terminalAt: at(30) },
        [transition("RUNNING", 1, 1, "hunt_other")]);
    assert.equal(timing.startedAt, null);
});

test("SUSPECT -> RUNNING returns do not move the start: the earliest RUNNING wins, whatever the row order", () => {
    const rows = [
        transition("RUNNING", 9),
        transition("SUSPECT", 7),
        transition("RUNNING", 8),
        transition("RUNNING", 3),
        transition("SUSPECT", 5),
        transition("RUNNING", 6),
    ];
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 1, state: "RUNNING", terminalAt: null }, rows,
        T0 + 15 * 60_000);
    assert.equal(timing.startedAt, at(3));
    assert.equal(timing.activePlaytimeMs, 12 * 60_000);
});

test("playtime is never negative when the end is before the start", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 1, state: "COMPLETED", terminalAt: at(1) },
        [transition("RUNNING", 5)]);
    assert.equal(timing.startedAt, at(5));
    assert.equal(timing.activePlaytimeMs, 0);
});

test("an ended hunt with no terminalAt keeps playtime unavailable instead of growing with the clock", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 1, state: "COMPLETED", terminalAt: null },
        [transition("RUNNING", 0)], T0 + 60 * 60_000);
    assert.equal(timing.startedAt, at(0));
    assert.equal(timing.activePlaytimeMs, null);
    assert.ok(timing.unknownFields.includes("activePlaytime"));
    assert.ok(!timing.unknownFields.includes("startedAt"));
});

test("an unparseable transition time is skipped", () => {
    const timing = MonitorHuntTiming({ sessionId: SESSION, generation: 1, state: "COMPLETED", terminalAt: at(10) }, [
        { sessionId: SESSION, generation: 1, toState: "RUNNING", at: "not-a-date" },
        transition("RUNNING", 4),
    ]);
    assert.equal(timing.startedAt, at(4));
    assert.equal(timing.activePlaytimeMs, 6 * 60_000);
});
