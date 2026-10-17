/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { ActivityRepository } from "../persistence/contracts/ActivityRepository";
import {
    CheckKillGrantAgainstHunts,
    FlushActivity,
    PendingActivityKeysForTest,
    RecordChallengeClaimsActivity,
    RecordDedicatedHuntEnds,
    RecordDedicatedHuntStarts,
    RecordInventoryActivity,
    RecordLauncherBuild,
    RecordP2PHuntActivity,
    RecordReforgeActivity,
    RecordSlayersPathUnlocksActivity,
    RecordXpActivity,
    IsGameRecentlyActive,
    RecentlyActiveAccountIds,
    StepFlushLog,
    TouchGameSession,
    UseActivityStoreForTest,
    WaitForActivityWrites
} from "./activityMonitor";
import { ReadActivitySettings, UseActivitySettingsForTest } from "./activityRules";

// [2026-10-14] The activity monitor against an in-memory store (plain values only: every assertion reads a counter, a count or a
// flag's field). The store implements the methods the monitor calls; the rest of the contract is not used here.

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const MINUTE = 60 * 1000;
const DAY = "2026-10-14";

function AddPath(target: Record<string, any>, path: string, amount: number): void {
    const Parts = path.split(".");
    let Node: Record<string, any> = target;
    for (const Part of Parts.slice(0, -1)) {
        if (typeof Node[Part] !== "object" || Node[Part] === null) Node[Part] = {};
        Node = Node[Part];
    }
    const Last = Parts[Parts.length - 1];
    Node[Last] = (Number(Node[Last]) || 0) + amount;
}

class FakeActivityStore {
    readonly daily = new Map<string, Record<string, any>>();
    readonly hunts = new Map<string, Record<string, any>>();
    readonly flags = new Map<string, Record<string, any>>();
    addCalls = 0;
    /** The next this-many addToDaily calls throw (a store that is down). */
    failures = 0;
    /** Every insertHuntIfAbsent throws while this is set. */
    throwOnInsertHunt = false;
    /** Every insertFlagIfAbsent throws while this is set. */
    throwOnInsertFlag = false;

    async addToDaily(key: { userId: string; day: string }, increments: Record<string, number>, ttlAt: Date): Promise<Record<string, any>> {
        this.addCalls++;
        if (this.failures > 0) {
            this.failures--;
            throw new Error("store unavailable");
        }
        const Id = `${key.userId}:${key.day}`;
        const Row = this.daily.get(Id) ?? { _id: Id, userId: key.userId, day: key.day };
        for (const [Path, Amount] of Object.entries(increments)) AddPath(Row, Path, Amount);
        Row.ttlAt = ttlAt;
        this.daily.set(Id, Row);
        return structuredClone(Row);
    }

    async insertHuntIfAbsent(record: Record<string, any>): Promise<boolean> {
        if (this.throwOnInsertHunt) throw new Error("hunt store unavailable");
        if (this.hunts.has(record._id)) return false;
        this.hunts.set(record._id, { ...record });
        return true;
    }

    async findOpenDedicatedHunts(userId: string): Promise<Record<string, any>[]> {
        return [...this.hunts.values()].filter((Hunt) => Hunt.userId === userId && Hunt.kind === "dedicated" && Hunt.endedAt === undefined)
            .map((Hunt) => ({ ...Hunt }));
    }

    async closeHuntIfOpen(id: string, close: { endedAt: string; endReason: string; result: string }): Promise<boolean> {
        const Hunt = this.hunts.get(id);
        if (Hunt === undefined || Hunt.endedAt !== undefined) return false;
        Object.assign(Hunt, { endedAt: close.endedAt, endReason: close.endReason, result: close.result });
        return true;
    }

    async addHuntKills(id: string, kills: number): Promise<void> {
        const Hunt = this.hunts.get(id);
        if (Hunt !== undefined) Hunt.kills = (Hunt.kills ?? 0) + kills;
    }

    async findDedicatedHuntsCovering(userId: string, atIso: string, notBeforeIso: string, graceFloorIso: string): Promise<Record<string, any>[]> {
        return [...this.hunts.values()].filter((Hunt) => Hunt.userId === userId && Hunt.kind === "dedicated"
            && Hunt.startedAt >= notBeforeIso && Hunt.startedAt <= atIso
            && (Hunt.endedAt === undefined || Hunt.endedAt >= graceFloorIso)).map((Hunt) => ({ ...Hunt }));
    }

    async insertFlagIfAbsent(record: Record<string, any>): Promise<boolean> {
        if (this.throwOnInsertFlag) throw new Error("flag store unavailable");
        if (this.flags.has(record._id)) return false;
        this.flags.set(record._id, { ...record });
        return true;
    }
}

function Monitor(store: FakeActivityStore): void {
    UseActivityStoreForTest(store as unknown as ActivityRepository);
}

function Row(store: FakeActivityStore, userId: string, day = DAY): Record<string, any> {
    return store.daily.get(`${userId}:${day}`) ?? {};
}

after(() => {
    UseActivityStoreForTest(undefined);
    UseActivitySettingsForTest(undefined);
});

test("playtime: the first touch starts a session, a touch within the gap adds its minutes, a later one starts another session", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    TouchGameSession("u-play-1", T0);
    TouchGameSession("u-play-1", T0 + 5 * 1000);
    TouchGameSession("u-play-1", T0 + 10 * MINUTE);
    await FlushActivity();
    const Stored = Row(Store, "u-play-1");
    assert.equal(Stored.sessions, 2);
    assert.ok(Math.abs(Number(Stored.playtimeMinutes) - 5 / 60) < 1e-9, `playtime ${Stored.playtimeMinutes}`);
    await WaitForActivityWrites();
});

test("counters are batched: several events for one account and day are one write", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    RecordXpActivity("u-batch-1", "season43", 10, T0);
    RecordXpActivity("u-batch-1", "season43", 10, T0 + 1000);
    RecordXpActivity("u-batch-1", "season43", 10, T0 + 2000);
    assert.equal(PendingActivityKeysForTest(), 1);
    assert.equal(Store.addCalls, 0, "nothing is written until the flush");
    await FlushActivity();
    assert.equal(Store.addCalls, 1);
    assert.equal(Row(Store, "u-batch-1").xp.season43, 30);
    await WaitForActivityWrites();
});

test("the operator test source is ignored: no counters, no write", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    RecordInventoryActivity({
        userId: "u-test-1",
        atMs: T0,
        source: "OPERATOR_TEST",
        granted: [{ catalogId: "MATERIAL_HIDE", quantity: 9 }],
        currencyCredits: [{ catalogId: "CURRENCY_PLATINUM", amount: 10000 }],
        currencyDebits: []
    });
    assert.equal(PendingActivityKeysForTest(), 0);
    await WaitForActivityWrites();
    assert.equal(Store.addCalls, 0);
    assert.equal(Store.daily.size, 0);
});

test("the no-player sentinel is never counted", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    TouchGameSession("INVALID", T0);
    RecordXpActivity("INVALID", "season43", 10, T0);
    assert.equal(PendingActivityKeysForTest(), 0);
    await WaitForActivityWrites();
    assert.equal(Store.daily.size, 0);
});

test("a failed write keeps its counts for the next flush", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    Store.failures = 1;
    RecordReforgeActivity("u-retry-1", T0);
    await FlushActivity();
    assert.equal(Store.daily.size, 0);
    assert.equal(PendingActivityKeysForTest(), 1, "the failed batch is kept");
    await FlushActivity();
    assert.equal(Row(Store, "u-retry-1").reforges, 1);
    assert.equal(PendingActivityKeysForTest(), 0);
    await WaitForActivityWrites();
});

test("a kill grant without an open dedicated hunt raises LOOT_WITHOUT_HUNT once; with one, it counts on the hunt", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    await RecordDedicatedHuntStarts(["u-loot-1"], "ShatteredIsles_IslandA", "ref-loot-1", T0);

    await CheckKillGrantAgainstHunts("u-loot-2", T0, 1);
    await CheckKillGrantAgainstHunts("u-loot-2", T0 + MINUTE, 1);
    const Flags = [...Store.flags.values()].filter((Flag) => Flag.userId === "u-loot-2");
    assert.equal(Flags.length, 1);
    assert.equal(Flags[0].kind, "LOOT_WITHOUT_HUNT");
    assert.equal(Flags[0].severity, "high");
    assert.equal(Flags[0].status, "open");
    assert.equal(Flags[0].day, DAY);

    await CheckKillGrantAgainstHunts("u-loot-1", T0 + 2 * MINUTE, 2);
    assert.equal(Store.hunts.get("dedicated:u-loot-1:ref-loot-1")?.kills, 2);
    assert.equal([...Store.flags.values()].filter((Flag) => Flag.userId === "u-loot-1").length, 0);
    await WaitForActivityWrites();
});

test("a kill grant is covered by a hunt that ended within the grace only", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    await RecordDedicatedHuntStarts(["u-grace-1"], "ShatteredIsles_IslandA", "ref-grace-1", T0);
    await RecordDedicatedHuntEnds(["u-grace-1"], "RETURNED", T0 + 10 * MINUTE);

    await CheckKillGrantAgainstHunts("u-grace-1", T0 + 15 * MINUTE, 1);
    assert.equal(Store.hunts.get("dedicated:u-grace-1:ref-grace-1")?.kills, 1, "15 minutes after the hunt, inside the 10-minute grace of its end");
    assert.equal([...Store.flags.values()].filter((Flag) => Flag.userId === "u-grace-1").length, 0);

    await CheckKillGrantAgainstHunts("u-grace-1", T0 + 30 * MINUTE, 1);
    assert.equal(Store.hunts.get("dedicated:u-grace-1:ref-grace-1")?.kills, 1, "20 minutes after the end is outside the grace");
    assert.equal([...Store.flags.values()].filter((Flag) => Flag.userId === "u-grace-1").length, 1);
    await WaitForActivityWrites();
});

test("a dedicated hunt ends once: completed with a kill, abandoned without, and a repeated end changes nothing", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    await RecordDedicatedHuntStarts(["u-end-1", "u-end-2"], "ShatteredIsles_IslandA", "ref-end-1", T0);
    await CheckKillGrantAgainstHunts("u-end-1", T0 + MINUTE, 1);
    await RecordDedicatedHuntEnds(["u-end-1", "u-end-2"], "RETURNED", T0 + 5 * MINUTE);
    await RecordDedicatedHuntEnds(["u-end-1", "u-end-2"], "RETURNED", T0 + 6 * MINUTE);
    await FlushActivity();

    assert.equal(Store.hunts.get("dedicated:u-end-1:ref-end-1")?.result, "completed");
    assert.equal(Store.hunts.get("dedicated:u-end-2:ref-end-1")?.result, "abandoned");
    assert.equal(Store.hunts.get("dedicated:u-end-2:ref-end-1")?.endReason, "RETURNED");
    assert.equal(Row(Store, "u-end-1").huntsStarted.dedicated, 1);
    assert.equal(Row(Store, "u-end-1").huntsCompleted.dedicated, 1);
    assert.equal(Row(Store, "u-end-1").huntsAbandoned, undefined);
    assert.equal(Row(Store, "u-end-2").huntsStarted.dedicated, 1);
    assert.equal(Row(Store, "u-end-2").huntsAbandoned.dedicated, 1);
    await WaitForActivityWrites();
});

test("a P2P hunt records each participant once and the host's hosting minutes", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    const Input = {
        sessionId: "s-p2p-1",
        huntId: "ShatteredIsles_IslandA",
        kind: "playerHosted" as const,
        hostAccountId: "h-1",
        participants: ["p-1", "p-2"],
        state: "COMPLETED",
        runningAtIso: new Date(T0).toISOString(),
        createdAtIso: new Date(T0 - 5 * MINUTE).toISOString(),
        endedAtIso: new Date(T0 + 30 * MINUTE).toISOString()
    };
    await RecordP2PHuntActivity(Input);
    await RecordP2PHuntActivity(Input);
    await FlushActivity();

    for (const Player of ["p-1", "p-2"]) {
        assert.equal(Row(Store, Player).huntsStarted.playerHosted, 1, Player);
        assert.equal(Row(Store, Player).huntsCompleted.playerHosted, 1, Player);
    }
    assert.equal(Row(Store, "h-1").huntsHosted, 1);
    assert.equal(Row(Store, "h-1").hostingMinutes, 30);
    assert.equal(Row(Store, "h-1").huntsStarted, undefined, "the host is not a participant unless it is in the roster");
    assert.equal(Store.hunts.get("p2p:s-p2p-1:p-1:participant")?.result, "completed");
    // [2026-10-15] The host row names the result as the participants do (it had none).
    assert.equal(Store.hunts.get("p2p:s-p2p-1:h-1:host")?.result, "completed");
    await WaitForActivityWrites();
});

test("a P2P hunt that did not complete gives the host and the participants the same abandoned result", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    await RecordP2PHuntActivity({ sessionId: "s-p2p-2", huntId: "ShatteredIsles_IslandA", kind: "realm", hostAccountId: "h-2",
        participants: ["p-3"], state: "CANCELLED", runningAtIso: new Date(T0).toISOString(),
        createdAtIso: new Date(T0 - 5 * MINUTE).toISOString(), endedAtIso: new Date(T0 + 10 * MINUTE).toISOString() });
    await FlushActivity();
    assert.equal(Store.hunts.get("p2p:s-p2p-2:h-2:host")?.result, "abandoned");
    assert.equal(Store.hunts.get("p2p:s-p2p-2:p-3:participant")?.result, "abandoned");
    await WaitForActivityWrites();
});

test("the [Activity] flush line is counts only, at most once a minute, and only for a pass that wrote something", () => {
    const Start = { lastLoggedAtMs: 0, accountDays: 0, counters: 0 };
    const Quiet = StepFlushLog(Start, { accountDays: 0, counters: 0 }, T0);
    assert.equal(Quiet.line, undefined, "a pass that wrote nothing logs nothing");
    assert.deepEqual(Quiet.state, Start);

    const First = StepFlushLog(Start, { accountDays: 2, counters: 7 }, T0);
    assert.equal(First.line, "[Activity] flushed accountDays=2 counters=7");
    assert.ok(!/u-|h-|p-|d{8}-/.test(First.line ?? ""), "no account id in the line");

    const Within = StepFlushLog(First.state, { accountDays: 1, counters: 3 }, T0 + 30 * 1000);
    assert.equal(Within.line, undefined, "no second line inside the minute");
    const Later = StepFlushLog(Within.state, { accountDays: 1, counters: 4 }, T0 + 61 * 1000);
    assert.equal(Later.line, "[Activity] flushed accountDays=2 counters=7", "the counts since the last line are reported at the next line");
    assert.deepEqual(Later.state, { lastLoggedAtMs: T0 + 61 * 1000, accountDays: 0, counters: 0 });
});

test("a rate over its threshold raises one review flag per account, kind and day", async () => {
    UseActivitySettingsForTest({ ...ReadActivitySettings({}), killsPerHourFlag: 60 });
    const Store = new FakeActivityStore();
    Monitor(Store);
    // Eleven touches two minutes apart: twenty minutes of playtime. Thirty kills in twenty minutes is ninety an hour.
    for (let Step = 0; Step <= 10; Step++) TouchGameSession("u-rate-1", T0 + Step * 2 * MINUTE);
    RecordInventoryActivity({
        userId: "u-rate-1",
        atMs: T0,
        source: "INVENTORY_HOST",
        granted: [{ catalogId: "TOKEN_KILL_COUNT_SHADOWCAT_NORMAL", quantity: 30 }],
        currencyCredits: [],
        currencyDebits: []
    });
    await FlushActivity();
    await FlushActivity();
    const Flags = [...Store.flags.values()].filter((Flag) => Flag.userId === "u-rate-1");
    assert.equal(Flags.length, 1);
    assert.equal(Flags[0]._id, `KILLS_PER_HOUR:u-rate-1:${DAY}`);
    assert.equal(Flags[0].severity, "review");
    assert.ok(String(Flags[0].detail).includes("kills=30"), Flags[0].detail);
    await WaitForActivityWrites();
});

test("with the monitor switched off nothing is counted, queued or written", async () => {
    UseActivitySettingsForTest({ ...ReadActivitySettings({ MYSTICPARADOX_ACTIVITY_MONITOR: "off" }) });
    const Store = new FakeActivityStore();
    Monitor(Store);
    TouchGameSession("u-off-1", T0);
    RecordXpActivity("u-off-1", "season43", 10, T0);
    RecordReforgeActivity("u-off-1", T0);
    RecordChallengeClaimsActivity("u-off-1", 2, T0);
    await RecordDedicatedHuntStarts(["u-off-1"], "ShatteredIsles_IslandA", "ref-off-1", T0);
    await RecordSlayersPathUnlocksActivity("u-off-1", ["node-1"], "gameserver", T0);
    assert.equal(PendingActivityKeysForTest(), 0);
    await WaitForActivityWrites();
    assert.equal(Store.addCalls, 0);
    assert.equal(Store.hunts.size, 0);
    UseActivitySettingsForTest(undefined);
});

test("a failed flag write does not make the counters count twice", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    Store.throwOnInsertFlag = true;
    UseActivitySettingsForTest({ ...ReadActivitySettings({}), xpPerMinuteFlag: 1 });
    TouchGameSession("u-flagfail-1", T0);
    TouchGameSession("u-flagfail-1", T0 + 5 * MINUTE);
    RecordXpActivity("u-flagfail-1", "season43", 500, T0);
    await FlushActivity();
    assert.equal(Row(Store, "u-flagfail-1").xp.season43, 500, "the counters are stored once");
    assert.equal(PendingActivityKeysForTest(), 0, "a failed flag write is not re-queued as counters");
    Store.throwOnInsertFlag = false;
    await FlushActivity();
    assert.equal(Row(Store, "u-flagfail-1").xp.season43, 500, "still 500 after the next flush");
    UseActivitySettingsForTest(undefined);
    await WaitForActivityWrites();
});

test("a store that throws on a hunt insert does not reject the caller", async () => {
    const Store = new FakeActivityStore();
    Store.throwOnInsertHunt = true;
    Monitor(Store);
    await assert.doesNotReject(RecordDedicatedHuntStarts(["u-throw-1"], "ShatteredIsles_IslandA", "ref-throw-1", T0));
    assert.equal(Store.hunts.size, 0);
    await WaitForActivityWrites();
});

test("an unofficial launcher build raises UNOFFICIAL_LAUNCHER once a day; official, outdated and unknown builds raise nothing", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    const Pinned = "d3".repeat(32);
    const Sources = { pinnedLauncherSha256: (channel: string) => (channel === "stable" ? Pinned : undefined), servedLauncherVersion: () => "0.1.64" };
    const Other = "ff".repeat(32);
    assert.equal(await RecordLauncherBuild("u-launcher-1", "stable", { version: "0.1.64", sha256: Pinned }, Sources, T0), "official");
    assert.equal(await RecordLauncherBuild("u-launcher-1", "stable", { version: "0.1.63", sha256: Other }, Sources, T0), "outdated");
    assert.equal(await RecordLauncherBuild("u-launcher-1", "beta", { version: "0.1.64", sha256: Other }, Sources, T0), "unknown");
    assert.equal(await RecordLauncherBuild("u-launcher-1", "stable", undefined, Sources, T0), "unknown");
    assert.equal([...Store.flags.values()].filter((Flag) => Flag.userId === "u-launcher-1").length, 0);

    assert.equal(await RecordLauncherBuild("u-launcher-1", "stable", { version: "0.1.64", sha256: Other }, Sources, T0), "unofficial");
    assert.equal(await RecordLauncherBuild("u-launcher-1", "stable", { version: "0.1.64", sha256: Other }, Sources, T0 + MINUTE), "unofficial");
    const Flags = [...Store.flags.values()].filter((Flag) => Flag.userId === "u-launcher-1");
    assert.equal(Flags.length, 1);
    assert.equal(Flags[0]._id, `UNOFFICIAL_LAUNCHER:u-launcher-1:${DAY}`);
    assert.equal(Flags[0].severity, "high");
    assert.ok(String(Flags[0].detail).includes("launcher 0.1.64 sha256 ffffffffffffffff..."), Flags[0].detail);
    assert.ok(String(Flags[0].detail).includes("pins d3d3d3d3d3d3d3d3..."), Flags[0].detail);
});

test("with the monitor switched off a launcher build is not looked at", async () => {
    UseActivitySettingsForTest({ ...ReadActivitySettings({ MYSTICPARADOX_ACTIVITY_MONITOR: "off" }) });
    const Store = new FakeActivityStore();
    Monitor(Store);
    let Asked = 0;
    const Sources = { pinnedLauncherSha256: () => { Asked += 1; return "d3".repeat(32); }, servedLauncherVersion: () => "0.1.64" };
    assert.equal(await RecordLauncherBuild("u-launcher-off", "stable", { version: "0.1.64", sha256: "ff".repeat(32) }, Sources, T0), "unknown");
    assert.equal(Asked, 0);
    assert.equal(Store.flags.size, 0);
    UseActivitySettingsForTest(undefined);
});

test("the accounts whose game reported in within a window count as online", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    TouchGameSession("u-online-old", T0);
    TouchGameSession("u-online-new", T0 + 90 * 1000);
    const Online = RecentlyActiveAccountIds(60 * 1000, T0 + 100 * 1000);
    assert.ok(Online.includes("u-online-new"), "reported in 10 s ago");
    assert.ok(!Online.includes("u-online-old"), "reported in 100 s ago");
    await WaitForActivityWrites();
});

// [2026-10-16] Matchmaking asks whether a party member's game is running: no game holds an XMPP socket on this backend, so the
// realm presence heartbeat (every 30 s) and the matchmaking heartbeat are the signal. It answers with the monitor off too.
test("a game that reported in within the window counts as running, with the monitor on or off, and drops out after it", async () => {
    const Store = new FakeActivityStore();
    Monitor(Store);
    TouchGameSession("u-party-on", T0);
    assert.equal(IsGameRecentlyActive("u-party-on", 75 * 1000, T0 + 30 * 1000), true, "one heartbeat ago");
    assert.equal(IsGameRecentlyActive("u-party-on", 75 * 1000, T0 + 76 * 1000), false, "past the window: the game closed");
    assert.equal(IsGameRecentlyActive("u-never-seen", 75 * 1000, T0), false);
    await WaitForActivityWrites();   // the monitor-on touch queued a session count

    UseActivitySettingsForTest({ ...ReadActivitySettings({ MYSTICPARADOX_ACTIVITY_MONITOR: "off" }) });
    TouchGameSession("u-party-off", T0);
    assert.equal(IsGameRecentlyActive("u-party-off", 75 * 1000, T0 + 10 * 1000), true, "the monitor's switch does not hide a running game");
    assert.ok(RecentlyActiveAccountIds(75 * 1000, T0 + 10 * 1000).includes("u-party-off"), "nor from the release gate");
    assert.equal(PendingActivityKeysForTest(), 0, "with the monitor off nothing is counted");
    UseActivitySettingsForTest(undefined);
    await WaitForActivityWrites();
});
