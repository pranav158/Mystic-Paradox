import assert from "node:assert/strict";
import test from "node:test";
import { logger } from "../logger";
import {
    CollectHuntPassRewardIds,
    CreditSourceOf,
    EconomyScope,
    FlagCrossed,
    FormatGrantedItems,
    IsHuntPassRewardId,
    IsPlatinumMovement,
    LogToken,
    NewEconomyLedger,
    ReadEconomyMonitorSettings,
    UseEconomyRollupStoreForTest,
    WaitForEconomyRollups,
} from "./economyLedgerMonitor";

// The monitor is pure apart from its rollup store, which these tests replace with a stub (no MongoDB, no SQLite).

const SETTINGS = {
    enabled: true,
    platinumDailyCreditFlag: 5000,
    platinumDailySpendFlag: 5000,
    seasonalCoinDailyFlag: 1000,
    xpPerMinuteFlag: 2000,
};

// A synthetic progression: one pass track (rank rewards pay Platinum and a token), a weapon track (prestige reward only).
const PROGRESSION = {
    payload: {
        paths: [
            {
                progression_id: "season43",
                free_rewards: [{ rank_id: 1, stacked_items: [{ catalog_id: "CURRENCY_PLATINUM_UNIV", quantity: 4 }] }],
                premium_rewards: [{ rank_id: 2, stacked_items: [{ catalog_id: "TOKEN_HUNTPASS_EXTRA", quantity: 1 }] }],
                prestige: { free_rewards: { stacked_items: [{ catalog_id: "CURRENCY_PJM_PRESTIGE_FILLED", quantity: 1 }] } },
            },
            {
                progression_id: "ExperienceTrack_Weapon_Axe",
                free_rewards: [{ rank_id: 1, stacked_items: [{ catalog_id: "EJ_AXE_EMOTE", quantity: 1 }] }],
                prestige: { premium_rewards: { stacked_items: [{ catalog_id: "CURRENCY_PRESTIGE_AXE", quantity: 1 }] } },
            },
        ],
    },
};
const REWARD_IDS = CollectHuntPassRewardIds(PROGRESSION);

/** Captures the monitor's info and warn lines while `body` runs. */
async function CaptureLogs(body: () => Promise<void> | void): Promise<{ info: string[]; warn: string[] }> {
    const Captured = { info: [] as string[], warn: [] as string[] };
    const Originals = { info: (logger as any).info, warn: (logger as any).warn };
    (logger as any).info = (...args: unknown[]) => { Captured.info.push(String(args[0])); };
    (logger as any).warn = (...args: unknown[]) => { Captured.warn.push(String(args[0])); };
    try {
        await body();
    } finally {
        (logger as any).info = Originals.info;
        (logger as any).warn = Originals.warn;
    }
    return Captured;
}

test("the monitor reads its switch and thresholds from the environment, with the owner's defaults", async () => {
    assert.deepEqual(ReadEconomyMonitorSettings({}), SETTINGS);
    for (const Off of ["off", "OFF", "0", "false", "no"]) {
        assert.equal(ReadEconomyMonitorSettings({ MYSTICPARADOX_ECONOMY_MONITOR: Off }).enabled, false, Off);
    }
    assert.equal(ReadEconomyMonitorSettings({ MYSTICPARADOX_ECONOMY_MONITOR: "on" }).enabled, true);
    const Custom = ReadEconomyMonitorSettings({
        MYSTICPARADOX_PLAT_DAILY_FLAG: "120",
        MYSTICPARADOX_PLAT_DAILY_SPEND_FLAG: "340",
        MYSTICPARADOX_SEASONAL_COIN_DAILY_FLAG: "0",
        MYSTICPARADOX_XP_PER_MINUTE_FLAG: "900",
    });
    assert.deepEqual(Custom, { enabled: true, platinumDailyCreditFlag: 120, platinumDailySpendFlag: 340, seasonalCoinDailyFlag: 0, xpPerMinuteFlag: 900 });
    // A value that is not a non-negative number falls back to its default (and says so once, at startup).
    const Bad = await CaptureLogs(() => {
        assert.equal(ReadEconomyMonitorSettings({ MYSTICPARADOX_PLAT_DAILY_FLAG: "lots" }).platinumDailyCreditFlag, 5000);
        assert.equal(ReadEconomyMonitorSettings({ MYSTICPARADOX_PLAT_DAILY_FLAG: "-3" }).platinumDailyCreditFlag, 5000);
    });
    assert.equal(Bad.warn.length, 2);
});

test("Hunt Pass rewards come from the pass tracks' rank rewards and every track's prestige rewards, not other rewards", () => {
    assert.ok(REWARD_IDS.has("CURRENCY_PLATINUM_UNIV"), "a pass rank reward");
    assert.ok(REWARD_IDS.has("TOKEN_HUNTPASS_EXTRA"), "a pass premium reward");
    assert.ok(REWARD_IDS.has("CURRENCY_PJM_PRESTIGE_FILLED"), "a pass prestige reward");
    assert.ok(REWARD_IDS.has("CURRENCY_PRESTIGE_AXE"), "a weapon track's prestige reward");
    assert.ok(!REWARD_IDS.has("EJ_AXE_EMOTE"), "a weapon track's ordinary reward is not a Hunt Pass reward");
    assert.equal(CollectHuntPassRewardIds(undefined).size, 0, "no game data means no catalogue ids");
});

test("the fixed Hunt Pass currencies, tokens and the catalogue's pass rewards are Hunt Pass rewards; other items are not", () => {
    for (const Id of ["CURRENCY_SEASONAL_COIN", "CURRENCY_S13_COIN", "CURRENCY_S20_DAILY", "TOKEN_HUNTPASS_PRESTIGE_S08A",
        "CONTAINER_CORE_PRESTIGE_01", "CURRENCY_PLATINUM_UNIV"]) {
        assert.equal(IsHuntPassRewardId(Id, REWARD_IDS), true, Id);
    }
    for (const Id of ["CURRENCY_NOTES", "BREAK_LERAWR_HIDE", "DYE_BABYBLUE_DURABLE", "EJ_AXE_EMOTE"]) {
        assert.equal(IsHuntPassRewardId(Id, REWARD_IDS), false, Id);
    }
});

test("a Platinum id is any of its buckets or the aggregate; nothing else is Platinum", () => {
    assert.equal(IsPlatinumMovement("CURRENCY_PLATINUM"), true);
    assert.equal(IsPlatinumMovement("CURRENCY_PLATINUM_UNIV"), true);
    assert.equal(IsPlatinumMovement("CURRENCY_PLATINUM_NOT_A_BUCKET"), false);
    assert.equal(IsPlatinumMovement("CURRENCY_NOTES"), false);
});

test("the source of a credit: a challenge-funded coin is a quest, a store or operator grant keeps its source, a Hunt Pass reward is Hunt Pass", () => {
    const Gameserver: EconomyScope = { source: "INVENTORY_GAMESERVER" };
    const Host: EconomyScope = { source: "INVENTORY_HOST" };
    assert.equal(CreditSourceOf("CURRENCY_SEASONAL_COIN", Gameserver, true, REWARD_IDS), "QUEST");
    assert.equal(CreditSourceOf("CURRENCY_PLATINUM_UNIV", { source: "STORE", storeSkuId: "X" }, false, REWARD_IDS), "STORE");
    assert.equal(CreditSourceOf("CURRENCY_PLATINUM_UNIV", { source: "OPERATOR" }, false, REWARD_IDS), "OPERATOR");
    assert.equal(CreditSourceOf("CURRENCY_PLATINUM_UNIV", Gameserver, false, REWARD_IDS), "HUNT_PASS");
    assert.equal(CreditSourceOf("CURRENCY_NOTES", Gameserver, false, REWARD_IDS), "INVENTORY_GAMESERVER");
    assert.equal(CreditSourceOf("CURRENCY_NOTES", Host, false, REWARD_IDS), "INVENTORY_HOST");
});

test("the for= list names what a transaction granted, eight items at most, then the rest counted", () => {
    assert.equal(FormatGrantedItems([]), "-");
    assert.equal(FormatGrantedItems([{ catalogId: "COSMETIC_X", quantity: 1 }, { catalogId: "CURRENCY_Y", quantity: 500 }]),
        "COSMETIC_X:1,CURRENCY_Y:500");
    const Ten = Array.from({ length: 10 }, (_, Index) => ({ catalogId: `ITEM_${Index}`, quantity: Index + 1 }));
    assert.equal(FormatGrantedItems(Ten), "ITEM_0:1,ITEM_1:2,ITEM_2:3,ITEM_3:4,ITEM_4:5,ITEM_5:6,ITEM_6:7,ITEM_7:8,+2 more");
});

test("an id that could forge a log line is quoted, a simple one is printed as it is", () => {
    assert.equal(LogToken("player-1"), "player-1");
    assert.equal(LogToken(undefined), "-");
    const Forged = LogToken("bad\n[PlatMon] credit user=victim");
    assert.ok(!Forged.includes("\n"));
    assert.equal(Forged.startsWith("\""), true);
});

test("a flag fires on the write that takes a day's total over its threshold, not on the writes after it", () => {
    assert.equal(FlagCrossed(6000, 1500, 5000), true, "4500 -> 6000 crosses 5000");
    assert.equal(FlagCrossed(7000, 1000, 5000), false, "6000 -> 7000 was already over");
    assert.equal(FlagCrossed(5000, 1000, 5000), false, "exactly the threshold is not over it");
    assert.equal(FlagCrossed(120, 120, 0), true, "a zero threshold flags the first credit");
});

test("a switched-off monitor makes no ledger, so nothing is logged or rolled up", async () => {
    const Rows: unknown[] = [];
    UseEconomyRollupStoreForTest({ addToRollup: async (...args: unknown[]) => { Rows.push(args); return {}; } } as any);
    try {
        assert.equal(NewEconomyLedger({ userId: "p", scope: { source: "OTHER" }, granted: [], settings: { ...SETTINGS, enabled: false } }), undefined);
    } finally {
        UseEconomyRollupStoreForTest(undefined);
    }
    assert.equal(Rows.length, 0);
});

test("a transaction's credit, spend and Hunt Pass reward are logged in the spec's formats and rolled up per account, day and source", async () => {
    const Rows: Array<{ key: any; increments: Record<string, number>; ttl: Date }> = [];
    UseEconomyRollupStoreForTest({
        addToRollup: async (key, increments, ttl) => { Rows.push({ key, increments, ttl }); return {}; },
    });
    try {
        const Logs = await CaptureLogs(async () => {
            const Ledger = NewEconomyLedger({ userId: "player-1", transactionId: "txn-1", scope: { source: "INVENTORY_GAMESERVER" },
                granted: [{ catalogId: "BREAK_X", quantity: 2 }], settings: SETTINGS, rewardIds: REWARD_IDS })!;
            Ledger.recordPlatinumCredit("CURRENCY_PLATINUM_UNIV", 500, 500);
            Ledger.recordPlatinumSpend(120, 380);
            Ledger.recordReward("TOKEN_HUNTPASS_EXTRA", 1);
            Ledger.commit(new Date("2026-10-14T12:00:00Z"));
            await WaitForEconomyRollups();
        });
        assert.deepEqual(Logs.info, [
            "[PlatMon] credit user=player-1 amount=500 balanceAfter=500 source=HUNT_PASS ref=txn-1",
            "[PlatMon] spend user=player-1 amount=120 balanceAfter=380 source=INVENTORY_GAMESERVER for=BREAK_X:2 session=- host=- ref=txn-1",
            "[HuntPassMon] reward user=player-1 item=TOKEN_HUNTPASS_EXTRA amount=1 source=HUNT_PASS ref=txn-1",
        ]);
        const Platinum = Rows.find((Row) => Row.key.currency === "CURRENCY_PLATINUM");
        assert.deepEqual(Platinum?.key, { userId: "player-1", day: "2026-10-14", currency: "CURRENCY_PLATINUM" });
        assert.deepEqual(Platinum?.increments, {
            credited: 500, count: 2, "bySource.HUNT_PASS.credited": 500, "bySource.HUNT_PASS.count": 1,
            debited: 120, "bySource.INVENTORY_GAMESERVER.debited": 120, "bySource.INVENTORY_GAMESERVER.count": 1,
            "byItem.BREAK_X.count": 1, "byItem.BREAK_X.debited": 120,
        });
        const Reward = Rows.find((Row) => Row.key.currency === "TOKEN_HUNTPASS_EXTRA");
        assert.deepEqual(Reward?.increments, { credited: 1, count: 1, "bySource.HUNT_PASS.credited": 1, "bySource.HUNT_PASS.count": 1 });
        const Ttl = Platinum!.ttl.getTime() - Date.parse("2026-10-14T12:00:00Z");
        assert.equal(Ttl, 400 * 24 * 60 * 60 * 1000, "kept 400 days");
    } finally {
        UseEconomyRollupStoreForTest(undefined);
    }
});

test("a store purchase's spend names its SKU in for= and in the item rollup", async () => {
    const Rows: Array<{ increments: Record<string, number> }> = [];
    UseEconomyRollupStoreForTest({ addToRollup: async (_key, increments) => { Rows.push({ increments }); return {}; } });
    try {
        const Logs = await CaptureLogs(async () => {
            const Ledger = NewEconomyLedger({ userId: "player-2", transactionId: "txn-store", scope: { source: "STORE", storeSkuId: "SKU_BUNDLE_9" },
                granted: [{ catalogId: "COSMETIC_X", quantity: 1 }], settings: SETTINGS, rewardIds: REWARD_IDS })!;
            Ledger.recordPlatinumSpend(1000, 250);
            Ledger.commit(new Date("2026-10-14T09:00:00Z"));
            await WaitForEconomyRollups();
        });
        assert.deepEqual(Logs.info, ["[PlatMon] spend user=player-2 amount=1000 balanceAfter=250 source=STORE for=SKU_BUNDLE_9 session=- host=- ref=txn-store"]);
        assert.equal(Rows[0].increments["byItem.SKU_BUNDLE_9.debited"], 1000);
        assert.equal(Rows[0].increments["bySource.STORE.debited"], 1000);
    } finally {
        UseEconomyRollupStoreForTest(undefined);
    }
});

test("a host's spend names its session and host, and the Platinum day total flags once when it crosses", async () => {
    const Totals = { debited: 0 };
    UseEconomyRollupStoreForTest({
        addToRollup: async (_key, increments) => {
            Totals.debited += increments.debited ?? 0;
            return { debited: Totals.debited };
        },
    });
    try {
        const Logs = await CaptureLogs(async () => {
            const Settings = { ...SETTINGS, platinumDailySpendFlag: 100 };
            for (const [Txn, Amount] of [["t1", 60], ["t2", 60], ["t3", 60]] as const) {
                const Ledger = NewEconomyLedger({ userId: "player-3", transactionId: Txn, settings: Settings, rewardIds: REWARD_IDS,
                    scope: { source: "INVENTORY_HOST", p2pSessionId: "hunt-7", hostAccountId: "host-9" }, granted: [] })!;
                Ledger.recordPlatinumSpend(Amount, 0);
                Ledger.commit(new Date("2026-10-14T20:00:00Z"));
                await WaitForEconomyRollups();
            }
        });
        assert.ok(Logs.info.includes("[PlatMon] spend user=player-3 amount=60 balanceAfter=0 source=INVENTORY_HOST for=- session=hunt-7 host=host-9 ref=t1"));
        const Flags = Logs.warn.filter((Line) => Line.startsWith("[PlatMon] FLAG spend"));
        assert.equal(Flags.length, 1, "120 crosses 100 once; the third write is still over and is not flagged again");
        assert.match(Flags[0], /debited=120 threshold=100/);
    } finally {
        UseEconomyRollupStoreForTest(undefined);
    }
});

test("a season coin day total over its threshold is flagged as a Hunt Pass event", async () => {
    UseEconomyRollupStoreForTest({ addToRollup: async () => ({ credited: 1200 }) });
    try {
        const Logs = await CaptureLogs(async () => {
            const Ledger = NewEconomyLedger({ userId: "player-4", transactionId: "t-coin", scope: { source: "INVENTORY_GAMESERVER" },
                granted: [], settings: SETTINGS, rewardIds: REWARD_IDS })!;
            Ledger.recordReward("CURRENCY_SEASONAL_COIN", 1200, false);
            Ledger.commit(new Date("2026-10-14T10:00:00Z"));
            await WaitForEconomyRollups();
        });
        assert.ok(Logs.warn.some((Line) => Line.startsWith("[HuntPassMon] FLAG user=player-4 day=2026-10-14 item=CURRENCY_SEASONAL_COIN credited=1200")));
    } finally {
        UseEconomyRollupStoreForTest(undefined);
    }
});

test("a failing rollup never throws into the grant: commit returns, the failure is logged at warn", async () => {
    UseEconomyRollupStoreForTest({ addToRollup: async () => { throw new Error("store down"); } });
    try {
        const Logs = await CaptureLogs(async () => {
            const Ledger = NewEconomyLedger({ userId: "player-5", transactionId: "t-fail", scope: { source: "INVENTORY_GAMESERVER" },
                granted: [], settings: SETTINGS, rewardIds: REWARD_IDS })!;
            Ledger.recordPlatinumCredit("CURRENCY_PLATINUM_UNIV", 10, 10);
            assert.doesNotThrow(() => Ledger.commit());
            await WaitForEconomyRollups();
        });
        assert.ok(Logs.info.some((Line) => Line.startsWith("[PlatMon] credit user=player-5 amount=10")), "the credit line is still written");
        assert.ok(Logs.warn.some((Line) => Line.includes("rollup not stored user=player-5") && Line.includes("store down")));
    } finally {
        UseEconomyRollupStoreForTest(undefined);
    }
});

test("a ledger with nothing in it logs nothing and writes no rollup", async () => {
    let Writes = 0;
    UseEconomyRollupStoreForTest({ addToRollup: async () => { Writes++; return {}; } });
    try {
        const Logs = await CaptureLogs(async () => {
            NewEconomyLedger({ userId: "player-6", scope: { source: "OTHER" }, granted: [], settings: SETTINGS, rewardIds: REWARD_IDS })!.commit();
            await WaitForEconomyRollups();
        });
        assert.deepEqual(Logs.info, []);
        assert.equal(Writes, 0);
    } finally {
        UseEconomyRollupStoreForTest(undefined);
    }
});
