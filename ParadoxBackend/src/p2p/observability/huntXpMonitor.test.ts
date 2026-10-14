import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { logger } from "../../logger";
import { EconomyMonitorSettings } from "../../diagnostics/economyLedgerMonitor";
import { P2PHuntSessionRecord, P2PRepositoryProvider, UseP2PPersistenceForTest } from "../persistence";
import { InMemoryP2PHuntRepository } from "../persistence/memory/InMemoryP2PHuntRepository";
import { EndP2PHuntSession } from "../controllers/p2pHostLifecycle";
import {
    AggregateHuntXp,
    BuildHuntXpSummaries,
    HostXpRow,
    HuntMinutes,
    HuntXpSink,
    HuntXpSource,
    HuntXpSummary,
    MonitorHuntXp,
    ScheduleHuntXpMonitor,
    UseHuntXpMonitorForTest,
    XpFamilyOf,
    XpFlagLine,
    XpLine,
    XpPerMinute,
} from "./huntXpMonitor";

// The per-hunt XP monitor against injected reads and writes (no MongoDB), plus the real end of a hunt (EndP2PHuntSession) in the
// in-memory P2P repositories, which must schedule the report after it commits.

const SETTINGS: EconomyMonitorSettings = {
    enabled: true, platinumDailyCreditFlag: 5000, platinumDailySpendFlag: 5000, seasonalCoinDailyFlag: 1000, xpPerMinuteFlag: 2000,
};
const HOST = "host-1";
const ALICE = "alice-1";
const BOB = "bob-1";
const SESSION = "hunt-xp-1";

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-10-14T10:00:00Z");

function Xp(member: string, track: string, amount: number): HostXpRow {
    return { targetUserId: member, summary: { track, amount } };
}

function HuntRecord(overrides: Partial<P2PHuntSessionRecord> = {}): P2PHuntSessionRecord {
    return {
        sessionId: SESSION, generation: 1, state: "COMPLETED", stateVersion: 3, partyId: "party-1", partyRevision: 1,
        huntDefinitionId: "IslandA", build: 1, bridgeProtocol: 1, virtualPort: 1, hostAccountId: HOST, hostSteamId: "h", bridgeInstanceId: "b",
        roster: [{ accountId: ALICE, admissionState: "ADMITTED" }, { accountId: BOB, admissionState: "ADMITTED" }] as any,
        createdAt: iso(T0), expiresAt: iso(T0 + 3_600_000), terminalAt: iso(T0 + 5 * 60_000 + 30_000), realmId: "realm-7",
        completionReason: "CLEAN_END", ...overrides,
    } as P2PHuntSessionRecord;
}

async function Capture(body: () => Promise<void>): Promise<{ info: string[]; warn: string[] }> {
    const Lines = { info: [] as string[], warn: [] as string[] };
    const Originals = { info: (logger as any).info, warn: (logger as any).warn };
    (logger as any).info = (...args: unknown[]) => { Lines.info.push(String(args[0])); };
    (logger as any).warn = (...args: unknown[]) => { Lines.warn.push(String(args[0])); };
    try {
        await body();
    } finally {
        (logger as any).info = Originals.info;
        (logger as any).warn = Originals.warn;
    }
    return Lines;
}

function Source(hunt: P2PHuntSessionRecord | undefined, rows: HostXpRow[], runningAt?: string): HuntXpSource {
    return {
        findHunt: async () => hunt,
        listXpRows: async () => rows,
        runningAt: async () => runningAt,
    };
}

function Sink(written: HuntXpSummary[], fail = false): HuntXpSink {
    return {
        write: async (summary) => {
            if (fail) throw new Error("sink down");
            written.push(summary);
        },
    };
}

afterEach(() => {
    UseHuntXpMonitorForTest(undefined);
    UseP2PPersistenceForTest(undefined);
});

test("a track belongs to the weapon, player, Hunt Pass or prestige family; anything else is other", () => {
    assert.equal(XpFamilyOf("ExperienceTrack_PlayerLevel"), "player");
    assert.equal(XpFamilyOf("ExperienceTrack_Weapon_Axe"), "weapon");
    assert.equal(XpFamilyOf("PrestigeTrack_Weapon_Axe"), "prestige");
    assert.equal(XpFamilyOf("season43"), "huntPass");
    assert.equal(XpFamilyOf("MasteryTrack_Blades"), "other");
    assert.equal(XpFamilyOf(undefined), "other");
});

test("the rows are summed per member and family; a row with no usable amount still counts as a grant", () => {
    const Totals = AggregateHuntXp([
        Xp(ALICE, "ExperienceTrack_Weapon_Axe", 98),
        Xp(ALICE, "ExperienceTrack_PlayerLevel", 98),
        Xp(ALICE, "season43", 9),
        Xp(ALICE, "ExperienceTrack_Weapon_Axe", 100),
        Xp(BOB, "PrestigeTrack_Weapon_Axe", 1),
        { targetUserId: BOB, summary: { track: "ExperienceTrack_Weapon_Axe", amount: "lots" } },
    ]);
    assert.deepEqual(Totals.get(ALICE), { member: ALICE, weapon: 198, player: 98, huntPass: 9, prestige: 0, other: 0, grants: 4 });
    assert.deepEqual(Totals.get(BOB), { member: BOB, weapon: 0, player: 0, huntPass: 0, prestige: 1, other: 0, grants: 2 });
});

test("a hunt's minutes run from its first RUNNING transition to its end, and a rate counts a sub-minute hunt as one minute", () => {
    assert.equal(HuntMinutes(iso(T0), iso(T0 + 330_000)), 5.5);
    assert.equal(HuntMinutes(undefined, iso(T0 + 330_000)), 0, "a hunt that never ran");
    assert.equal(HuntMinutes(iso(T0 + 60_000), iso(T0)), 0, "an end before the start");
    assert.equal(XpPerMinute({ weapon: 98, player: 98 }, 0.2), 196, "a sub-minute hunt is one minute");
    assert.equal(XpPerMinute({ weapon: 4000, player: 0 }, 2), 2000);
});

test("one summary per roster member, and a member the rows name who is not on the roster is still reported", () => {
    const Summaries = BuildHuntXpSummaries({
        hunt: HuntRecord(),
        rows: [Xp(ALICE, "ExperienceTrack_Weapon_Axe", 1500), Xp(ALICE, "ExperienceTrack_PlayerLevel", 500), Xp("stranger-9", "season43", 4)],
        runningAt: iso(T0), endedAt: iso(T0 + 5 * 60_000), now: new Date(T0 + 6 * 60_000), limitPerMinute: 2000,
    });
    assert.deepEqual(Summaries.map((Summary) => Summary.member), [ALICE, BOB, "stranger-9"]);
    const Alice = Summaries[0];
    assert.equal(Alice._id, `${SESSION}:${ALICE}`);
    assert.equal(Alice.host, HOST);
    assert.equal(Alice.realmId, "realm-7");
    assert.equal(Alice.reason, "CLEAN_END");
    assert.equal(Alice.minutes, 5);
    assert.equal(Alice.perMinute, 400, "2000 weapon + player XP over five minutes");
    assert.equal(Alice.flagged, false);
    assert.equal(Alice.ttlAt.getTime() - (T0 + 6 * 60_000), 400 * 24 * 60 * 60 * 1000, "kept about 400 days");
    assert.equal(Summaries[1].grants, 0, "a roster member with no XP is still reported");
});

test("a member whose weapon + player XP per minute is above the limit is flagged, and the lines are in the spec's form", () => {
    const Summaries = BuildHuntXpSummaries({
        hunt: HuntRecord(), rows: [Xp(ALICE, "ExperienceTrack_Weapon_Axe", 6000), Xp(ALICE, "ExperienceTrack_PlayerLevel", 4000)],
        runningAt: iso(T0), endedAt: iso(T0 + 2 * 60_000), now: new Date(T0), limitPerMinute: 2000,
    });
    assert.equal(Summaries[0].flagged, true, "10000 XP in two minutes is 5000 a minute");
    assert.equal(XpLine(Summaries[0]),
        `[XpMon] hunt=${SESSION} realm=realm-7 host=${HOST} member=${ALICE} minutes=2.0 weapon=6000 player=4000 huntPass=0 prestige=0 grants=2 perMinute=5000 state=COMPLETED`);
    assert.equal(XpFlagLine(Summaries[0], 2000),
        `[XpMon] FLAG hunt=${SESSION} realm=realm-7 host=${HOST} member=${ALICE} perMinute=5000 limit=2000 minutes=2.0 weapon=6000 player=4000 grants=2`);
});

test("a hunt that is terminal is reported once: its lines, a FLAG where due, and the summary rows", async () => {
    const Written: HuntXpSummary[] = [];
    UseHuntXpMonitorForTest({
        source: Source(HuntRecord({ terminalAt: iso(T0 + 2 * 60_000) }), [Xp(ALICE, "ExperienceTrack_Weapon_Axe", 6000), Xp(ALICE, "ExperienceTrack_PlayerLevel", 4000)], iso(T0)),
        sink: Sink(Written),
    });
    let Summaries: HuntXpSummary[] = [];
    const Lines = await Capture(async () => { Summaries = await MonitorHuntXp(SESSION, new Date(T0 + 2 * 60_000), SETTINGS); });
    assert.equal(Summaries.length, 2);
    assert.deepEqual(Written.map((Summary) => Summary.member), [ALICE, BOB]);
    assert.equal(Lines.info.filter((Line) => Line.startsWith("[XpMon] hunt=")).length, 2, "one line per member");
    assert.equal(Lines.warn.filter((Line) => Line.startsWith(`[XpMon] FLAG hunt=${SESSION} realm=realm-7 host=${HOST} member=${ALICE}`)).length, 1);
    assert.deepEqual(await MonitorHuntXp(SESSION, new Date(T0 + 3 * 60_000), SETTINGS), [], "a second report of the same hunt is not written");
    assert.equal(Written.length, 2);
});

test("a hunt that is still running, and a realm hub (which has no XP), are not reported", async () => {
    const Written: HuntXpSummary[] = [];
    UseHuntXpMonitorForTest({ source: Source(HuntRecord({ state: "RUNNING", terminalAt: undefined }), []), sink: Sink(Written) });
    assert.deepEqual(await MonitorHuntXp(SESSION, new Date(T0), SETTINGS), []);
    UseHuntXpMonitorForTest({ source: Source(HuntRecord({ sessionKind: "REALM_HUB", hubKind: "RAMSGATE" } as any), []), sink: Sink(Written) });
    assert.deepEqual(await MonitorHuntXp(SESSION, new Date(T0), SETTINGS), []);
    assert.equal(Written.length, 0);
});

test("an aborted hunt is reported too, and a switched-off monitor reads nothing", async () => {
    const Written: HuntXpSummary[] = [];
    UseHuntXpMonitorForTest({ source: Source(HuntRecord({ state: "ABORTED", failureReason: "HOST_LEASE_LOST" }), [], iso(T0)), sink: Sink(Written) });
    const Summaries = await MonitorHuntXp(SESSION, new Date(T0 + 60_000), SETTINGS);
    assert.equal(Summaries[0].state, "ABORTED");
    assert.equal(Summaries[0].reason, "CLEAN_END", "the completion reason wins over the failure reason when both are set");
    UseHuntXpMonitorForTest({
        source: { findHunt: async () => { throw new Error("must not read"); }, listXpRows: async () => [], runningAt: async () => undefined },
        sink: Sink(Written),
    });
    assert.deepEqual(await MonitorHuntXp(SESSION, new Date(T0), { ...SETTINGS, enabled: false }), []);
});

test("a summary the sink refuses is logged at warn and the report still returns", async () => {
    UseHuntXpMonitorForTest({ source: Source(HuntRecord(), [Xp(ALICE, "season43", 9)], iso(T0)), sink: Sink([], true) });
    let Summaries: HuntXpSummary[] = [];
    const Lines = await Capture(async () => { Summaries = await MonitorHuntXp(SESSION, new Date(T0 + 60_000), SETTINGS); });
    assert.equal(Summaries.length, 2);
    assert.ok(Lines.warn.some((Line) => Line.includes("summary not stored") && Line.includes("sink down")));
});

test("scheduling the report never throws into the caller, even when reading the hunt fails", async () => {
    UseHuntXpMonitorForTest({
        source: { findHunt: async () => { throw new Error("read down"); }, listXpRows: async () => [], runningAt: async () => undefined },
        sink: Sink([]),
    });
    let Lines: { info: string[]; warn: string[] } = { info: [], warn: [] };
    Lines = await Capture(async () => {
        assert.doesNotThrow(() => ScheduleHuntXpMonitor(SESSION));
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.ok(Lines.warn.some((Line) => Line.includes("not monitored") && Line.includes("read down")));
});

test("the end of a hunt schedules its report after the end is committed (EndP2PHuntSession)", async () => {
    const Hunts = new InMemoryP2PHuntRepository();
    await Hunts.createHunt(HuntRecord({ state: "RUNNING", terminalAt: undefined, completionReason: undefined, guardCompletionMode: "END_OF_HUNT", trustTier: 0 } as any));
    UseP2PPersistenceForTest({
        p2pHunts: Hunts,
        parties: { findById: async () => undefined, setActivity: async () => undefined, appendEvent: async () => undefined },
    } as unknown as P2PRepositoryProvider);
    const Written: HuntXpSummary[] = [];
    UseHuntXpMonitorForTest({
        source: {
            findHunt: (id) => Hunts.findHunt(id),
            listXpRows: async () => [Xp(ALICE, "ExperienceTrack_Weapon_Axe", 98), Xp(ALICE, "ExperienceTrack_PlayerLevel", 98)],
            runningAt: async () => iso(T0),
        },
        sink: Sink(Written),
    });
    const Ended = await Capture(async () => {
        const Result = await EndP2PHuntSession(SESSION, 1, "PARTY_RETURNED_TO_HUB", { allowedStates: ["RUNNING"], actorType: "SYSTEM" });
        assert.ok(Result, "the running hunt ends");
        assert.ok(["COMPLETED", "ABORTED"].includes(Result.record.state));
        for (let Attempt = 0; Attempt < 100 && Written.length < 2; Attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.deepEqual(Written.map((Summary) => Summary.member).sort(), [ALICE, BOB].sort());
    assert.equal(Written.find((Summary) => Summary.member === ALICE)?.weapon, 98);
    assert.ok(Ended.info.some((Line) => Line.startsWith(`[XpMon] hunt=${SESSION} `) && Line.includes(`member=${ALICE} `)));
});
