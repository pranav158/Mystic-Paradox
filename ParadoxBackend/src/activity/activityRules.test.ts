/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    ACTIVITY_HUNT_GRACE_MS,
    ACTIVITY_HUNT_MAX_MS,
    ACTIVITY_SESSION_GAP_MS,
    ActivitySettings,
    ActivityTtlAt,
    AdvancePlaytime,
    ClassifyLauncherBuild,
    DailyFlagCandidates,
    DayOf,
    DayStartMs,
    HuntLootWindow,
    InventoryIncrements,
    IsIgnoredActivitySource,
    KillTokenName,
    MinutesBetween,
    ParseLauncherBuildReport,
    ReadActivitySettings,
    SafeKey
} from "./activityRules";

// [2026-10-14] Activity monitor rules (pure). Nothing here touches a database; times are plain numbers and ISO text.

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const MINUTE = 60 * 1000;

const SETTINGS: ActivitySettings = {
    enabled: true,
    killsPerHourFlag: 90,
    rewardsPerHourFlag: 600,
    platinumDailyCreditFlag: 5000,
    platinumDailySpendFlag: 5000,
    seasonalCoinDailyFlag: 1000,
    xpPerMinuteFlag: 2000
};

test("the session gap: the first touch starts a session, a touch within the gap adds its minutes, a longer gap starts another", () => {
    const First = AdvancePlaytime(undefined, T0);
    assert.equal(First.sessionStarted, true);
    assert.equal(First.segments.length, 0);

    const Close = AdvancePlaytime(T0, T0 + 5 * 1000);
    assert.equal(Close.sessionStarted, false);
    assert.equal(Close.segments.length, 1);
    assert.equal(Close.segments[0].day, "2026-10-14");
    assert.ok(Math.abs(Close.segments[0].minutes - 5 / 60) < 1e-9);

    const AtGap = AdvancePlaytime(T0, T0 + ACTIVITY_SESSION_GAP_MS);
    assert.equal(AtGap.sessionStarted, false, "a gap of exactly the limit still counts as playtime");

    const Beyond = AdvancePlaytime(T0, T0 + ACTIVITY_SESSION_GAP_MS + 1);
    assert.equal(Beyond.sessionStarted, true, "a longer gap ends the session");
    assert.equal(Beyond.segments.length, 0, "the stale interval is not playtime");
});

test("an out-of-order or duplicate touch adds nothing and starts nothing", () => {
    const Same = AdvancePlaytime(T0, T0);
    assert.deepEqual({ started: Same.sessionStarted, segments: Same.segments.length }, { started: false, segments: 0 });
    const Earlier = AdvancePlaytime(T0, T0 - MINUTE);
    assert.deepEqual({ started: Earlier.sessionStarted, segments: Earlier.segments.length }, { started: false, segments: 0 });
});

test("playtime that crosses UTC midnight is split between the two days", () => {
    const Last = Date.parse("2026-10-14T23:58:30.000Z");
    const Step = AdvancePlaytime(Last, Last + 2 * MINUTE);
    assert.deepEqual(Step.segments.map((Segment) => Segment.day), ["2026-10-14", "2026-10-15"]);
    assert.ok(Math.abs(Step.segments[0].minutes - 1.5) < 1e-9);
    assert.ok(Math.abs(Step.segments[1].minutes - 0.5) < 1e-9);
});

test("day arithmetic: the UTC day, its start, and the retention of 400 days from it", () => {
    assert.equal(DayOf(T0), "2026-10-14");
    assert.equal(DayStartMs("2026-10-14"), Date.parse("2026-10-14T00:00:00.000Z"));
    assert.equal(ActivityTtlAt("2026-10-14").toISOString(), new Date(DayStartMs("2026-10-14") + 400 * 24 * 60 * 60 * 1000).toISOString());
});

test("minutes between two instants: zero when a bound is missing or the span is not positive", () => {
    assert.equal(MinutesBetween("2026-10-14T12:00:00.000Z", "2026-10-14T12:30:00.000Z"), 30);
    assert.equal(MinutesBetween(undefined, "2026-10-14T12:30:00.000Z"), 0);
    assert.equal(MinutesBetween("2026-10-14T12:30:00.000Z", "2026-10-14T12:00:00.000Z"), 0);
});

test("safe keys and kill tokens: dots and odd characters never reach a field name; the Behemoth is the token suffix", () => {
    assert.equal(SafeKey("CURRENCY_SEASONAL_COIN"), "CURRENCY_SEASONAL_COIN");
    assert.equal(SafeKey("a.b"), "OTHER");
    assert.equal(SafeKey("$bad"), "OTHER");
    assert.equal(KillTokenName("TOKEN_KILL_COUNT_LERAWR_BETA"), "LERAWR_BETA");
    assert.equal(KillTokenName("TOKEN_KILL_COUNT_SNOWFLAKE_NORMAL"), "SNOWFLAKE_NORMAL");
    assert.equal(KillTokenName("CURRENCY_PLATINUM"), undefined);
});

test("the operator test source is the only one the monitor ignores", () => {
    assert.equal(IsIgnoredActivitySource("OPERATOR_TEST"), true);
    assert.equal(IsIgnoredActivitySource("OPERATOR"), false);
    assert.equal(IsIgnoredActivitySource("INVENTORY_GAMESERVER"), false);
    assert.equal(IsIgnoredActivitySource(undefined), false);
});

test("inventory increments: kills by Behemoth, non-kill items by source, currency in and out, Platinum spent per item", () => {
    const Totals = InventoryIncrements({
        source: "INVENTORY_GAMESERVER",
        granted: [
            { catalogId: "TOKEN_KILL_COUNT_LERAWR_BETA", quantity: 2 },
            { catalogId: "MATERIAL_HIDE", quantity: 5 },
            { catalogId: "CURRENCY_SEASONAL_COIN", quantity: 3 }
        ],
        currencyCredits: [{ catalogId: "CURRENCY_SEASONAL_COIN", amount: 3 }],
        currencyDebits: [{ catalogId: "CURRENCY_PLATINUM", amount: 100 }, { catalogId: "CURRENCY_NOTES", amount: 40 }]
    });
    assert.equal(Totals.kills, 2);
    assert.equal(Totals.rewards, 8);
    assert.equal(Totals.increments["kills.LERAWR_BETA"], 2);
    assert.equal(Totals.increments["itemsGained.INVENTORY_GAMESERVER"], 8);
    assert.equal(Totals.increments["currency.CURRENCY_SEASONAL_COIN.credited"], 3);
    assert.equal(Totals.increments["currency.CURRENCY_PLATINUM.debited"], 100);
    assert.equal(Totals.increments["currency.CURRENCY_NOTES.debited"], 40);
    // Platinum spent is 100 (CURRENCY_NOTES is not Platinum); the transaction granted two items, so each carries the whole spend.
    assert.equal(Totals.increments["platinumSpendsByItem.MATERIAL_HIDE"], 100);
    assert.equal(Totals.increments["platinumSpendsByItem.CURRENCY_SEASONAL_COIN"], 100);
    assert.equal(Totals.increments["platinumSpendsByItem.LERAWR_BETA"], undefined, "kill tokens are not bought items");
});

test("a store purchase attributes its Platinum to the SKU, not to the items it granted", () => {
    const Totals = InventoryIncrements({
        source: "STORE",
        storeSkuId: "single_exchange_slot_2",
        granted: [{ catalogId: "exchange_slot_2", quantity: 1 }],
        currencyCredits: [],
        currencyDebits: [{ catalogId: "CURRENCY_PLATINUM", amount: 1000 }]
    });
    assert.equal(Totals.increments["platinumSpendsByItem.single_exchange_slot_2"], 1000);
    assert.equal(Totals.increments["platinumSpendsByItem.exchange_slot_2"], undefined);
});

test("a transaction with no Platinum spend records no spend entries and no zero counters", () => {
    const Totals = InventoryIncrements({ source: "OTHER", granted: [{ catalogId: "X", quantity: 0 }], currencyCredits: [], currencyDebits: [] });
    assert.deepEqual(Totals.increments, {});
    assert.equal(Totals.rewards, 0);
});

test("daily flags: each existing threshold, and the rate flags only with enough playtime", () => {
    const Quiet = DailyFlagCandidates({ playtimeMinutes: 120, currency: { CURRENCY_PLATINUM: { credited: 100, debited: 0 } } }, SETTINGS);
    assert.deepEqual(Quiet, []);

    const Rich = DailyFlagCandidates({
        playtimeMinutes: 120,
        currency: {
            CURRENCY_PLATINUM: { credited: 6000, debited: 6000 },
            CURRENCY_NOTES: { credited: 9000, debited: 9000 },
            CURRENCY_SEASONAL_COIN: { credited: 1500, debited: 0 }
        }
    }, SETTINGS).map((Flag) => Flag.kind).sort();
    assert.deepEqual(Rich, ["PLATINUM_CREDIT_DAY", "PLATINUM_SPEND_DAY", "SEASONAL_COIN_DAY"]);

    // 120 kills in 120 minutes is 60 an hour: under the 90 threshold. 200 kills in 120 minutes is 100 an hour: over it.
    assert.equal(DailyFlagCandidates({ playtimeMinutes: 120, kills: { A: 120 } }, SETTINGS).length, 0);
    assert.deepEqual(DailyFlagCandidates({ playtimeMinutes: 120, kills: { A: 200 } }, SETTINGS).map((Flag) => Flag.kind), ["KILLS_PER_HOUR"]);

    // Ten minutes of playtime: rate flags are not judged, whatever the counts.
    assert.deepEqual(DailyFlagCandidates({ playtimeMinutes: 10, kills: { A: 500 }, xp: { season43: 999999 } }, SETTINGS), []);

    // XP per minute over the threshold.
    const Xp = DailyFlagCandidates({ playtimeMinutes: 30, xp: { season43: 61000 } }, SETTINGS).map((Flag) => Flag.kind);
    assert.deepEqual(Xp, ["XP_PER_MINUTE"]);

    const Rewards = DailyFlagCandidates({ playtimeMinutes: 60, itemsGained: { INVENTORY_GAMESERVER: 700 } }, SETTINGS).map((Flag) => Flag.kind);
    assert.deepEqual(Rewards, ["REWARDS_PER_HOUR"]);
});

test("the hunt window for a kill grant: started within the hunt maximum, ended within the grace", () => {
    const Window = HuntLootWindow(T0);
    assert.equal(Window.atIso, new Date(T0).toISOString());
    assert.equal(Window.notBeforeIso, new Date(T0 - ACTIVITY_HUNT_MAX_MS).toISOString());
    assert.equal(Window.graceFloorIso, new Date(T0 - ACTIVITY_HUNT_GRACE_MS).toISOString());
});

test("settings from the environment: on by default, off only for an explicit off, thresholds from the environment", () => {
    const Default = ReadActivitySettings({});
    assert.equal(Default.enabled, true);
    assert.equal(Default.killsPerHourFlag, 90);
    assert.equal(Default.rewardsPerHourFlag, 600);
    assert.equal(Default.platinumDailyCreditFlag, 5000);
    assert.equal(Default.xpPerMinuteFlag, 2000);

    for (const Value of ["off", "0", "false", "NO"]) {
        assert.equal(ReadActivitySettings({ MYSTICPARADOX_ACTIVITY_MONITOR: Value }).enabled, false, Value);
    }
    assert.equal(ReadActivitySettings({ MYSTICPARADOX_ACTIVITY_MONITOR: "on" }).enabled, true);

    const Tuned = ReadActivitySettings({ MYSTICPARADOX_KILLS_PER_HOUR_FLAG: "30", MYSTICPARADOX_PLAT_DAILY_FLAG: "123",
        MYSTICPARADOX_REWARDS_PER_HOUR_FLAG: "not-a-number" });
    assert.equal(Tuned.killsPerHourFlag, 30);
    assert.equal(Tuned.platinumDailyCreditFlag, 123);
    assert.equal(Tuned.rewardsPerHourFlag, 600, "a bad value keeps the default");
});

// [2026-10-15] UNOFFICIAL_LAUNCHER: what the launcher reports about itself at Play, against the pinned build and the served version.
test("a launcher build report needs a plain version and a 64-hex sha256; anything else is treated as absent", () => {
    const Sha = "AB".repeat(32);
    assert.deepEqual(ParseLauncherBuildReport({ version: "0.1.65", sha256: Sha }), { version: "0.1.65", sha256: "ab".repeat(32) });
    for (const Bad of [undefined, null, "x", [], { version: "0.1", sha256: Sha }, { version: "0.1.65", sha256: "ab" },
        { version: 165, sha256: Sha }, { version: "0.1.65 ", sha256: Sha }]) {
        assert.equal(ParseLauncherBuildReport(Bad), undefined, JSON.stringify(Bad));
    }
});

test("a launcher build is official when Guard pins its hash, outdated on an older version, unofficial otherwise", () => {
    const Pinned = "d3".repeat(32);
    const Report = (version: string, sha256: string) => ({ version, sha256 });
    assert.equal(ClassifyLauncherBuild(Report("0.1.64", Pinned), Pinned, "0.1.64"), "official");
    assert.equal(ClassifyLauncherBuild(Report("0.1.64", Pinned), Pinned.toUpperCase(), "0.1.64"), "official");
    // An earlier official build until it updates itself.
    assert.equal(ClassifyLauncherBuild(Report("0.1.63", "e1".repeat(32)), Pinned, "0.1.64"), "outdated");
    // Self-built or repackaged: the served version or newer with another hash.
    assert.equal(ClassifyLauncherBuild(Report("0.1.64", "ff".repeat(32)), Pinned, "0.1.64"), "unofficial");
    assert.equal(ClassifyLauncherBuild(Report("0.1.70", "ff".repeat(32)), Pinned, "0.1.64"), "unofficial");
    // Without a served launcher feed the version cannot excuse it.
    assert.equal(ClassifyLauncherBuild(Report("0.1.63", "ff".repeat(32)), Pinned, undefined), "unofficial");
    // Nothing reported, or nothing pinned (a server without a Guard manifest): unknown, never a flag.
    assert.equal(ClassifyLauncherBuild(undefined, Pinned, "0.1.64"), "unknown");
    assert.equal(ClassifyLauncherBuild(Report("0.1.64", "ff".repeat(32)), undefined, "0.1.64"), "unknown");
});
