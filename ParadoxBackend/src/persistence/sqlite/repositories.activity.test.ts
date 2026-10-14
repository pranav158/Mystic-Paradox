/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { ActivityFlagRecord, ActivityHuntRecord, SlayersPathUnlockRecord } from "../contracts/ActivityRepository";
import { OpenTestRealm } from "./testSupport";

// [2026-10-14] The SQLite provider's activity repository on a real (temporary) database: the same contract the MongoDB repository
// keeps. Every assertion reads a plain value.

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });
function Realm(label: string) {
    const Opened = OpenTestRealm(label);
    Cleanups.push(Opened.cleanup);
    return Opened;
}

const TTL = new Date("2027-11-18T00:00:00.000Z");

function Hunt(id: string, userId: string, startedAt: string, extra: Partial<ActivityHuntRecord> = {}): ActivityHuntRecord {
    return { _id: id, userId, role: "participant", kind: "dedicated", huntId: "ShatteredIsles_IslandA", huntRef: id, startedAt, kills: 0, ttlAt: TTL, ...extra };
}

test("daily counters: dotted paths add up atomically and the row comes back as it is after the write", async () => {
    const { repos } = Realm("activity-daily");
    const First = await repos.activity.addToDaily({ userId: "u1", day: "2026-10-14" },
        { playtimeMinutes: 10, "kills.LERAWR_BETA": 2, "currency.CURRENCY_PLATINUM.debited": 300 }, TTL);
    assert.equal(First._id, "u1:2026-10-14");
    assert.equal(First.playtimeMinutes, 10);

    const Second = await repos.activity.addToDaily({ userId: "u1", day: "2026-10-14" },
        { playtimeMinutes: 5, "kills.LERAWR_BETA": 1, "kills.SNOWFLAKE_NORMAL": 4, "currency.CURRENCY_PLATINUM.debited": 50 }, TTL);
    assert.equal(Second.playtimeMinutes, 15);
    assert.equal(Second.kills.LERAWR_BETA, 3);
    assert.equal(Second.kills.SNOWFLAKE_NORMAL, 4);
    assert.equal(Second.currency.CURRENCY_PLATINUM.debited, 350);
    assert.equal(Second.userId, "u1");
    assert.equal(Second.day, "2026-10-14");
});

test("daily rows: one account's rows in a range, oldest first; the range across accounts; the limit", async () => {
    const { repos } = Realm("activity-range");
    for (const Day of ["2026-10-13", "2026-10-14", "2026-10-16"]) {
        await repos.activity.addToDaily({ userId: "u2", day: Day }, { sessions: 1 }, TTL);
    }
    await repos.activity.addToDaily({ userId: "u3", day: "2026-10-14" }, { sessions: 2 }, TTL);
    const Own = await repos.activity.findDailyRows("u2", "2026-10-13", "2026-10-15", 10);
    assert.deepEqual(Own.map((Row) => Row.day), ["2026-10-13", "2026-10-14"]);
    const Everyone = await repos.activity.findDailyRowsInRange("2026-10-14", "2026-10-14", 10);
    assert.deepEqual(Everyone.map((Row) => Row.userId).sort(), ["u2", "u3"]);
    const Capped = await repos.activity.findDailyRowsInRange("2026-10-13", "2026-10-16", 2);
    assert.equal(Capped.length, 2);
});

test("hunt rows: an insert happens once, a hunt ends once, kills accumulate, and the lookups honour the window", async () => {
    const { repos } = Realm("activity-hunts");
    const Started = "2026-10-14T12:00:00.000Z";
    assert.equal(await repos.activity.insertHuntIfAbsent(Hunt("dedicated:u4:ref-a", "u4", Started)), true);
    assert.equal(await repos.activity.insertHuntIfAbsent(Hunt("dedicated:u4:ref-a", "u4", Started)), false);

    const Open = await repos.activity.findOpenDedicatedHunts("u4");
    assert.deepEqual(Open.map((Row) => Row._id), ["dedicated:u4:ref-a"]);

    await repos.activity.addHuntKills("dedicated:u4:ref-a", 2);
    await repos.activity.addHuntKills("dedicated:u4:ref-a", 1);
    assert.equal((await repos.activity.findHunt("dedicated:u4:ref-a"))?.kills, 3);

    // Covered: started within the window and open (or ended at or after the grace floor).
    const Covering = await repos.activity.findDedicatedHuntsCovering("u4", "2026-10-14T12:30:00.000Z", "2026-10-14T06:00:00.000Z", "2026-10-14T12:20:00.000Z");
    assert.equal(Covering.length, 1);
    const Outside = await repos.activity.findDedicatedHuntsCovering("u4", "2026-10-14T12:30:00.000Z", "2026-10-14T13:00:00.000Z", "2026-10-14T12:20:00.000Z");
    assert.equal(Outside.length, 0, "started before the window");

    assert.equal(await repos.activity.closeHuntIfOpen("dedicated:u4:ref-a", { endedAt: "2026-10-14T12:10:00.000Z", endReason: "RETURNED", result: "completed" }), true);
    assert.equal(await repos.activity.closeHuntIfOpen("dedicated:u4:ref-a", { endedAt: "2026-10-14T12:11:00.000Z", endReason: "LEFT", result: "abandoned" }), false);
    const Closed = await repos.activity.findHunt("dedicated:u4:ref-a");
    assert.equal(Closed?.endedAt, "2026-10-14T12:10:00.000Z");
    assert.equal(Closed?.result, "completed");
    assert.equal((await repos.activity.findOpenDedicatedHunts("u4")).length, 0);

    const Ended = await repos.activity.findDedicatedHuntsCovering("u4", "2026-10-14T12:30:00.000Z", "2026-10-14T06:00:00.000Z", "2026-10-14T12:20:00.000Z");
    assert.equal(Ended.length, 0, "ended before the grace floor");
    const Recent = await repos.activity.findHuntsForAccount("u4", 10);
    assert.equal(Recent.length, 1);
});

test("unlocks: once per node, newest first", async () => {
    const { repos } = Realm("activity-unlocks");
    const Unlock = (node: string, at: string): SlayersPathUnlockRecord => ({ _id: `u5:${node}`, userId: "u5", nodeId: node, unlockedAt: at, source: "gameserver", ttlAt: TTL });
    assert.equal(await repos.activity.insertUnlockIfAbsent(Unlock("node-a", "2026-10-14T10:00:00.000Z")), true);
    assert.equal(await repos.activity.insertUnlockIfAbsent(Unlock("node-a", "2026-10-14T11:00:00.000Z")), false);
    assert.equal(await repos.activity.insertUnlockIfAbsent(Unlock("node-b", "2026-10-14T12:00:00.000Z")), true);
    const Listed = await repos.activity.findUnlocksForAccount("u5", 10);
    assert.deepEqual(Listed.map((Row) => Row.nodeId), ["node-b", "node-a"]);
    assert.equal(Listed[1].unlockedAt, "2026-10-14T10:00:00.000Z", "the first unlock time is kept");
});

test("flags: once per id, paged by status, and acknowledged once (the acknowledgement keeps its first author and time)", async () => {
    const { repos } = Realm("activity-flags");
    const Flag = (id: string, userId: string, createdAt: string): ActivityFlagRecord => ({
        _id: id, kind: "KILLS_PER_HOUR", severity: "review", userId, day: "2026-10-14", detail: "kills=30", status: "open", createdAt, ttlAt: TTL
    });
    assert.equal(await repos.activity.insertFlagIfAbsent(Flag("KILLS_PER_HOUR:f1:2026-10-14", "f1", "2026-10-14T12:00:00.000Z")), true);
    assert.equal(await repos.activity.insertFlagIfAbsent(Flag("KILLS_PER_HOUR:f1:2026-10-14", "f1", "2026-10-14T13:00:00.000Z")), false);
    assert.equal(await repos.activity.insertFlagIfAbsent(Flag("LOOT_WITHOUT_HUNT:f2:2026-10-14", "f2", "2026-10-14T14:00:00.000Z")), true);

    const Open = await repos.activity.listFlags("open", 0, 10);
    assert.equal(Open.total, 2);
    assert.deepEqual(Open.records.map((Row) => Row._id), ["LOOT_WITHOUT_HUNT:f2:2026-10-14", "KILLS_PER_HOUR:f1:2026-10-14"]);
    const Page = await repos.activity.listFlags("all", 1, 1);
    assert.equal(Page.total, 2);
    assert.equal(Page.records.length, 1);

    const Acked = await repos.activity.acknowledgeFlag("LOOT_WITHOUT_HUNT:f2:2026-10-14", { actorUserId: "op-1", at: "2026-10-14T15:00:00.000Z", note: "checked" });
    assert.equal(Acked?.status, "acknowledged");
    assert.equal(Acked?.acknowledgedBy, "op-1");
    assert.equal(Acked?.note, "checked");
    const Again = await repos.activity.acknowledgeFlag("LOOT_WITHOUT_HUNT:f2:2026-10-14", { actorUserId: "op-2", at: "2026-10-14T16:00:00.000Z" });
    assert.equal(Again?.acknowledgedBy, "op-1");
    assert.equal(Again?.acknowledgedAt, "2026-10-14T15:00:00.000Z");
    assert.equal(await repos.activity.acknowledgeFlag("missing:flag", { actorUserId: "op-1", at: "2026-10-14T15:00:00.000Z" }), undefined);
    assert.equal((await repos.activity.listFlags("open", 0, 10)).total, 1);
    assert.equal((await repos.activity.findFlagsForAccount("f2", 10)).length, 1);
});

test("the retention purge removes activity rows whose ttlAt has passed and keeps the rest", async () => {
    const { repos, db } = Realm("activity-ttl");
    await repos.activity.addToDaily({ userId: "u6", day: "2025-01-01" }, { sessions: 1 }, new Date("2026-01-01T00:00:00.000Z"));
    await repos.activity.addToDaily({ userId: "u6", day: "2026-10-14" }, { sessions: 1 }, TTL);
    const Removed = await db.purgeExpired("2026-10-14T00:00:00.000Z");
    assert.equal(Removed.playerActivityDaily, 1);
    assert.deepEqual((await repos.activity.findDailyRows("u6", "2025-01-01", "2026-12-31", 10)).map((Row) => Row.day), ["2026-10-14"]);
});

test("the ledgers' recent rows for one account: empty for an account without rows", async () => {
    const { repos } = Realm("activity-ledgers");
    assert.deepEqual(await repos.inventoryTransactions.listRecentForUser("nobody", 10), []);
    assert.deepEqual(await repos.progressionGrants.listRecentForUser("nobody", 10), []);
});
