/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Request, Response } from "express";
import type { RepositoryProvider, UnitOfWork } from "../persistence";
import { UsePersistenceForTest } from "../persistence";
import {
    AcknowledgeActivityFlag,
    GetActivityOverview,
    GetActivityPlayer,
    IsActiveRow,
    ListActivityFlags,
    OverviewDays,
    PlayerTimeline,
    PlayerTotals
} from "./adminActivity";

// [2026-10-14] The activity monitor's admin reads and the flag review. Plain values only: the fake repositories hold a few rows each.

after(() => UsePersistenceForTest(undefined));

function FakeResponse(): Response & { code?: number; body?: any } {
    const Res: any = {
        code: undefined,
        body: undefined,
        status(code: number) { Res.code = code; return Res; },
        json(body: unknown) { Res.body = body; return Res; }
    };
    return Res;
}

function Request_(query: Record<string, unknown> = {}, params: Record<string, string> = {}, body: unknown = undefined, adminUserId = "op-1"): Request {
    return { query, params, body, ip: "127.0.0.1", AdminAuth: { account: { userId: adminUserId } } } as unknown as Request;
}

const DAY1 = { _id: "a:2026-10-13", userId: "a", day: "2026-10-13", playtimeMinutes: 30, sessions: 1, huntsStarted: { dedicated: 1 },
    huntsCompleted: { dedicated: 1 }, kills: { LERAWR_BETA: 3 }, currency: { CURRENCY_PLATINUM: { credited: 100, debited: 0 } }, ttlAt: new Date() };
const DAY2 = { _id: "b:2026-10-13", userId: "b", day: "2026-10-13", playtimeMinutes: 0, sessions: 0, kills: {}, ttlAt: new Date() };
const DAY3 = { _id: "a:2026-10-14", userId: "a", day: "2026-10-14", playtimeMinutes: 10, sessions: 1, kills: { LERAWR_BETA: 1 },
    currency: { CURRENCY_PLATINUM: { credited: 50, debited: 20 } }, ttlAt: new Date() };

test("a day's active players are the accounts with playtime or a session; every day of the range appears", () => {
    const Days = OverviewDays("2026-10-13", "2026-10-15", [DAY1, DAY2, DAY3]);
    assert.deepEqual(Days.map((Day) => Day.day), ["2026-10-13", "2026-10-14", "2026-10-15"]);
    assert.equal(Days[0].activePlayers, 1, "b had no playtime or session");
    assert.equal(Days[0].playtimeMinutes, 30);
    assert.equal(Days[0].huntsStarted.dedicated, 1);
    assert.equal(Days[0].kills.LERAWR_BETA, 3);
    assert.equal(Days[0].currency.CURRENCY_PLATINUM.credited, 100);
    assert.equal(Days[1].activePlayers, 1);
    assert.equal(Days[1].currency.CURRENCY_PLATINUM.debited, 20);
    assert.equal(Days[2].activePlayers, 0);
    assert.equal(Days[2].playtimeMinutes, 0);
});

test("a player's totals add its rows, and an activity row is active on playtime or a session alone", () => {
    const Totals = PlayerTotals([DAY1, DAY3]);
    assert.equal(Totals.playtimeMinutes, 40);
    assert.equal(Totals.sessions, 2);
    assert.equal(Totals.kills.LERAWR_BETA, 4);
    assert.equal(Totals.huntsCompleted.dedicated, 1);
    assert.equal(IsActiveRow({ sessions: 1, playtimeMinutes: 0 }), true);
    assert.equal(IsActiveRow({ playtimeMinutes: 0.5 }), true);
    assert.equal(IsActiveRow({ kills: { X: 9 } }), false);
});

test("the timeline merges hunts, unlocks, flags, ledger rows and XP grants, newest first, without account secrets", () => {
    const Timeline = PlayerTimeline({
        hunts: [{ _id: "h1", userId: "a", role: "participant", kind: "dedicated", huntId: "H", huntRef: "r", startedAt: "2026-10-14T10:00:00.000Z", kills: 1, ttlAt: new Date() }],
        unlocks: [{ _id: "a:n1", userId: "a", nodeId: "n1", unlockedAt: "2026-10-14T11:00:00.000Z", source: "host", ttlAt: new Date() }],
        flags: [{ _id: "F", kind: "KILLS_PER_HOUR", severity: "review", userId: "a", day: "2026-10-14", detail: "d", status: "open",
            createdAt: "2026-10-14T09:00:00.000Z", ttlAt: new Date() }],
        ledger: [{ transactionId: "t-1", characterId: "c-1", status: "completed", createdAt: "2026-10-14T08:00:00.000Z",
            completedAt: "2026-10-14T12:00:00.000Z", economySource: "INVENTORY_GAMESERVER", userId: "a", result: { secret: 1 } }],
        grants: [{ grantId: "g-1", progressionId: "season43", amount: 50, createdAt: "2026-10-14T07:00:00.000Z" }]
    });
    assert.deepEqual(Timeline.map((Entry) => Entry.type), ["inventory", "slayersPathUnlock", "hunt", "flag", "xp"]);
    assert.equal(Timeline[0].detail.economySource, "INVENTORY_GAMESERVER");
    assert.equal(Timeline[1].detail.nodeId, "n1");
    const Text = JSON.stringify(Timeline);
    assert.equal(Text.includes("secret"), false, "the stored result is never shown");
    assert.equal(Text.includes("\"userId\""), false);
});

test("range validation: bad dates, a reversed range and a range over the retention are refused before any read", async () => {
    const Cases: Array<[Record<string, unknown>, string]> = [
        [{ from: "2026-13-01" }, "ACTIVITY_RANGE_INVALID"],
        [{ from: "2026-10-14", to: "2026-10-01" }, "ACTIVITY_RANGE_INVALID"],
        [{ from: "2024-01-01", to: "2026-10-14" }, "ACTIVITY_RANGE_TOO_LONG"]
    ];
    for (const [Query, Code] of Cases) {
        const Res = FakeResponse();
        await GetActivityOverview(Request_(Query), Res);
        assert.equal(Res.code, 400, JSON.stringify(Query));
        assert.equal(Res.body.error.code, Code, JSON.stringify(Query));
    }
});

test("the overview answers from the store with every day of the range", async () => {
    const Calls: unknown[][] = [];
    const Store = { findDailyRowsInRange: async (...Args: unknown[]) => { Calls.push(Args); return [DAY1, DAY3]; } };
    UsePersistenceForTest({ repos: { activity: Store } as unknown as RepositoryProvider, uow: {} as unknown as UnitOfWork });
    const Res = FakeResponse();
    await GetActivityOverview(Request_({ from: "2026-10-13", to: "2026-10-14" }), Res);
    assert.equal(Res.code, undefined, "200 by default");
    assert.deepEqual(Calls[0].slice(0, 2), ["2026-10-13", "2026-10-14"]);
    assert.equal(Res.body.days.length, 2);
    assert.equal(Res.body.truncated, false);
    assert.equal(Res.body.days[1].activePlayers, 1);
});

test("the player view answers with the account's days, totals, unlocks, hunts, flags and timeline", async () => {
    const Empty = async () => [];
    const Store = {
        findDailyRows: async () => [{ ...DAY1 }],
        findHuntsForAccount: Empty,
        findUnlocksForAccount: Empty,
        findFlagsForAccount: Empty
    };
    UsePersistenceForTest({ repos: { activity: Store, inventoryTransactions: { listRecentForUser: Empty }, progressionGrants: { listRecentForUser: Empty } } as unknown as RepositoryProvider, uow: {} as unknown as UnitOfWork });
    const Res = FakeResponse();
    await GetActivityPlayer(Request_({ from: "2026-10-13", to: "2026-10-13" }, { userId: "a" }), Res);
    assert.equal(Res.body.userId, "a");
    assert.equal(Res.body.days.length, 1);
    assert.equal(Res.body.days[0]._id, undefined, "ids and expiry stay in the store");
    assert.equal(Res.body.days[0].userId, undefined);
    assert.equal(Res.body.totals.playtimeMinutes, 30);
    assert.deepEqual(Res.body.timeline, []);
});

test("the flag list refuses an unknown status and pages the open flags by default", async () => {
    const Bad = FakeResponse();
    await ListActivityFlags(Request_({ status: "nope" }), Bad);
    assert.equal(Bad.code, 400);

    const Seen: unknown[][] = [];
    UsePersistenceForTest({ repos: { activity: { listFlags: async (...Args: unknown[]) => { Seen.push(Args); return { records: [], total: 0 }; } } } as unknown as RepositoryProvider, uow: {} as unknown as UnitOfWork });
    const Ok = FakeResponse();
    await ListActivityFlags(Request_({ page: "2", limit: "10" }), Ok);
    assert.equal(Ok.body.status, "open");
    assert.deepEqual(Seen[0], ["open", 10, 10]);
});

test("acknowledging a flag: the body must say acknowledged:true; a missing flag is 404; an open one is acknowledged and audited", async () => {
    const Flag = { _id: "KILLS_PER_HOUR:a:2026-10-14", kind: "KILLS_PER_HOUR", severity: "review", userId: "a", day: "2026-10-14", detail: "d",
        status: "open", createdAt: "2026-10-14T09:00:00.000Z", ttlAt: new Date() };
    const Audit: Array<Record<string, unknown>> = [];
    let Current: Record<string, any> | undefined = { ...Flag };
    const Store = {
        findFlag: async (Id: string) => (Id === Current?._id ? { ...Current } : undefined),
        acknowledgeFlag: async (Id: string, by: { actorUserId: string; at: string; note?: string }) => {
            if (Current === undefined || Id !== Current._id) return undefined;
            if (Current.status === "open") Current = { ...Current, status: "acknowledged", acknowledgedBy: by.actorUserId, acknowledgedAt: by.at, note: by.note };
            return { ...Current };
        }
    };
    UsePersistenceForTest({ repos: { activity: Store, admin: { appendAudit: async (Record: Record<string, unknown>) => { Audit.push(Record); } } } as unknown as RepositoryProvider,
        uow: {} as unknown as UnitOfWork });

    const NoBody = FakeResponse();
    await AcknowledgeActivityFlag(Request_({}, { id: Flag._id }, { acknowledged: false }), NoBody);
    assert.equal(NoBody.code, 400);

    const Missing = FakeResponse();
    await AcknowledgeActivityFlag(Request_({}, { id: "nope" }, { acknowledged: true }), Missing);
    assert.equal(Missing.code, 404);

    const Done = FakeResponse();
    await AcknowledgeActivityFlag(Request_({}, { id: Flag._id }, { acknowledged: true, note: "  checked  " }, "op-7"), Done);
    assert.equal(Done.code, undefined);
    assert.equal(Done.body.flag.status, "acknowledged");
    assert.equal(Done.body.flag.acknowledgedBy, "op-7");
    assert.equal(Done.body.flag.note, "checked");
    assert.equal(Audit.length, 1);
    assert.equal(Audit[0].action, "activity.flag.acknowledge");
    assert.equal(Audit[0].actorUserId, "op-7");
    assert.equal(Audit[0].targetUserId, "a");
    assert.deepEqual(Audit[0].oldState, { status: "open" });
    assert.deepEqual(Audit[0].newState, { status: "acknowledged" });

    const Again = FakeResponse();
    await AcknowledgeActivityFlag(Request_({}, { id: Flag._id }, { acknowledged: true }, "op-8"), Again);
    assert.equal(Again.body.flag.acknowledgedBy, "op-7", "the first acknowledgement keeps its author");
    assert.equal(Audit.length, 1, "a repeat acknowledgement is not audited again");
});
