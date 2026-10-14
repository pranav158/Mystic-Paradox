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
    CooldownList,
    CooldownSaveValidationError,
    CooldownStatePayload,
    IsAuthorizedCooldownReader,
    IsAuthorizedCooldownWriter,
    IsExpiredGatherableCooldown,
    HOST_COOLDOWN_MAX_FUTURE_MS,
    HostCooldownLatestMs,
    IsHostCooldownWriter,
    IsSeasonCooldownId,
    MAX_STORED_COOLDOWNS,
    MergeCooldownState,
    MergeHostCooldownState
} from "./cooldownState";
import { CooldownStateRecord } from "./persistence/mapping/domainTypes";

const USER = "player-1";
const HOUR_MS = 60 * 60 * 1000;

/** A 32-hex gatherable node GUID (the shape UPlayerGatherableComponent sends), unique per index. */
function GatherableId(index: number): string {
    return `58E91700491B00FA${index.toString(16).toUpperCase().padStart(16, "0")}`;
}

function StoredRecord(entries: { id: string; startedDate: string; updatedAt?: string }[]): CooldownStateRecord {
    return {
        userId: USER,
        entries: entries.map((Entry) => ({ id: Entry.id, startedDate: Entry.startedDate, updatedAt: Entry.updatedAt ?? Entry.startedDate })),
        updateVersion: 7,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-10-05T00:00:00.000Z",
    };
}

test("cooldown writes are dedicated-server only; reads are server or same account", () => {
    assert.equal(IsAuthorizedCooldownWriter({ IsGameserver: true }), true);
    assert.equal(IsAuthorizedCooldownWriter({ userId: USER }), false);
    assert.equal(IsAuthorizedCooldownWriter({ IsPlayerHostRuntime: true }), false);
    assert.equal(IsAuthorizedCooldownReader({ IsGameserver: true }, "player-2"), true);
    assert.equal(IsAuthorizedCooldownReader({ userId: USER }, USER), true);
    assert.equal(IsAuthorizedCooldownReader({ userId: USER }, "player-2"), false);
});

test("a player-host runtime reads the cooldowns of its hunt roster only and never writes (B8, 2026-10-11)", () => {
    const Host = { IsPlayerHostRuntime: true, IsGameserver: false, userId: USER, RuntimeRosterAccountIds: [USER, "player-2"] };
    assert.equal(IsAuthorizedCooldownReader(Host, USER), true);
    assert.equal(IsAuthorizedCooldownReader(Host, "player-2"), true);
    assert.equal(IsAuthorizedCooldownReader(Host, "player-3"), false);
    // No roster on the auth data fails closed, even for the runtime's own identity.
    assert.equal(IsAuthorizedCooldownReader({ IsPlayerHostRuntime: true, userId: USER }, USER), false);
    assert.equal(IsAuthorizedCooldownWriter(Host), false);
});

test("an account with no cooldowns is served an empty map", () => {
    assert.deepEqual(CooldownStatePayload(undefined), {});
});

test("a batch (the PUT's list shape) is stored verbatim and served back as an id -> date map", () => {
    // The ids and dates the 1.14.7 server sent on 10 Oct 14:11.
    const Record = MergeCooldownState(USER, undefined, {
        cooldowns: [
            { cooldown_id: "GRANT_PATROL_BOOST_TOKEN", cooldown_started_date: "2026-10-10T00:00:00.000Z" },
            { cooldown_id: "GRANT_DAILY_HEROICPLUS", cooldown_started_date: "2026-10-10T00:00:00.000Z" }
        ]
    }, "2026-10-10T08:41:49.822Z");
    assert.equal(Record.updateVersion, 1);
    assert.deepEqual(CooldownStatePayload(Record), {
        GRANT_PATROL_BOOST_TOKEN: "2026-10-10T00:00:00.000Z",
        GRANT_DAILY_HEROICPLUS: "2026-10-10T00:00:00.000Z"
    });
    assert.deepEqual(CooldownList(Record)[0], { cooldown_id: "GRANT_PATROL_BOOST_TOKEN", cooldown_started_date: "2026-10-10T00:00:00.000Z" });
});

test("a later batch replaces the cooldowns it names and keeps the rest", () => {
    let Record = MergeCooldownState(USER, undefined, {
        cooldowns: [
            { cooldown_id: "season43", cooldown_started_date: "2026-10-22T17:00:00.000Z" },
            { cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-09T17:00:00.000Z" }
        ]
    });
    Record = MergeCooldownState(USER, Record, { cooldowns: [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-10T17:00:00.000Z" }] });
    assert.deepEqual(CooldownStatePayload(Record), { season43: "2026-10-22T17:00:00.000Z", bounty_daily: "2026-10-10T17:00:00.000Z" });
    assert.equal(Record.updateVersion, 2);
});

test("an id that collides with an Object.prototype name is served as plain data", () => {
    const Record = MergeCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "__proto__", cooldown_started_date: "2026-10-10T00:00:00Z" }] });
    const Payload = CooldownStatePayload(Record);
    assert.equal(JSON.stringify(Payload), "{\"__proto__\":\"2026-10-10T00:00:00Z\"}");
});

test("a bare array body is accepted too", () => {
    const Record = MergeCooldownState(USER, undefined, [{ cooldown_id: "X", cooldown_started_date: "2026-10-10T00:00:00Z" }]);
    assert.equal(Record.entries.length, 1);
});

test("malformed cooldown saves are rejected", () => {
    assert.throws(() => MergeCooldownState(USER, undefined, {}), CooldownSaveValidationError);
    assert.throws(() => MergeCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "" , cooldown_started_date: "2026-10-10T00:00:00Z" }] }), CooldownSaveValidationError);
    assert.throws(() => MergeCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "X", cooldown_started_date: "not a date" }] }), CooldownSaveValidationError);
    assert.throws(() => MergeCooldownState(USER, undefined, { cooldowns: new Array(257).fill({ cooldown_id: "X", cooldown_started_date: "2026-10-10T00:00:00Z" }) }), CooldownSaveValidationError);
});

test("only 32-hex gatherable ids older than 48 h count as expired", () => {
    const Now = "2026-10-10T18:00:00.000Z";
    const Old = new Date(Date.parse(Now) - 49 * HOUR_MS).toISOString();
    const Recent = new Date(Date.parse(Now) - 47 * HOUR_MS).toISOString();
    assert.equal(IsExpiredGatherableCooldown("58E91700491B00FA7DB373809E250E45", Old, Now), true);
    assert.equal(IsExpiredGatherableCooldown("58e91700491b00fa7db373809e250e45", Old, Now), true);
    assert.equal(IsExpiredGatherableCooldown("58E91700491B00FA7DB373809E250E45", Recent, Now), false);
    // Named cooldowns and near-miss ids are never pruned, however old.
    for (const Id of ["season43", "bounty_daily", "GRANT_PATROL_BOOST_TOKEN", "58E91700491B00FA7DB373809E250E4", "58E91700491B00FA7DB373809E250E45A", "Z8E91700491B00FA7DB373809E250E45"]) {
        assert.equal(IsExpiredGatherableCooldown(Id, "2020-01-01T00:00:00.000Z", Now), false, Id);
    }
    // An unparsable date keeps the entry (dropping it would report the node available).
    assert.equal(IsExpiredGatherableCooldown("58E91700491B00FA7DB373809E250E45", "not a date", Now), false);
});

test("old gatherable ids are pruned at write time, so they cannot evict long-lived cooldowns from the cap", () => {
    // season43 was written long ago (oldest updatedAt). Without pruning, 1024 newer gatherable rows plus this write
    // would exceed MAX_STORED_COOLDOWNS and the cap would drop season43 first.
    const Now = "2026-10-10T18:00:00.000Z";
    const Previous = StoredRecord([
        { id: "season43", startedDate: "2026-10-22T17:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
        { id: "bounty_daily", startedDate: "2026-10-01T17:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
        ...Array.from({ length: MAX_STORED_COOLDOWNS }, (_, Index) => ({ id: GatherableId(Index), startedDate: "2026-10-05T12:00:00.000Z" })),
    ]);
    const Next = MergeCooldownState(USER, Previous, { cooldowns: [{ cooldown_id: GatherableId(5000), cooldown_started_date: Now }] }, Now);
    assert.deepEqual(CooldownStatePayload(Next), {
        season43: "2026-10-22T17:00:00.000Z",
        bounty_daily: "2026-10-01T17:00:00.000Z",
        [GatherableId(5000)]: Now,
    });
    assert.equal(Next.updateVersion, 8);
    assert.equal(Next.createdAt, "2026-09-01T00:00:00.000Z");
});

test("gatherable ids harvested within 48 h are kept", () => {
    const Now = "2026-10-10T18:00:00.000Z";
    const Yesterday = new Date(Date.parse(Now) - 26 * HOUR_MS).toISOString();
    const AlmostTwoDays = new Date(Date.parse(Now) - 47 * HOUR_MS).toISOString();
    const Previous = StoredRecord([
        { id: GatherableId(1), startedDate: Yesterday },
        { id: GatherableId(2), startedDate: AlmostTwoDays },
        { id: GatherableId(3), startedDate: new Date(Date.parse(Now) - 49 * HOUR_MS).toISOString() },
    ]);
    const Next = MergeCooldownState(USER, Previous, { cooldowns: [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-10T17:00:00.000Z" }] }, Now);
    assert.deepEqual(CooldownStatePayload(Next), {
        [GatherableId(1)]: Yesterday,
        [GatherableId(2)]: AlmostTwoDays,
        bounty_daily: "2026-10-10T17:00:00.000Z",
    });
});

test("the ids a save writes are never pruned, even with an old start date", () => {
    const Now = "2026-10-10T18:00:00.000Z";
    const Previous = StoredRecord([{ id: GatherableId(1), startedDate: "2026-10-01T00:00:00.000Z" }]);
    const Next = MergeCooldownState(USER, Previous, {
        cooldowns: [
            { cooldown_id: GatherableId(1), cooldown_started_date: "2026-10-02T00:00:00.000Z" },
            { cooldown_id: GatherableId(2), cooldown_started_date: "2026-10-03T00:00:00.000Z" },
        ]
    }, Now);
    assert.deepEqual(CooldownStatePayload(Next), {
        [GatherableId(1)]: "2026-10-02T00:00:00.000Z",
        [GatherableId(2)]: "2026-10-03T00:00:00.000Z",
    });
});

// [2026-10-13 realms S3] Host writes: a cooldown may only move later.
const HOST_NOW = "2026-10-13T18:00:00.000Z";

function HostSave(previous: CooldownStateRecord | undefined, cooldowns: { cooldown_id: string; cooldown_started_date: string }[]) {
    return MergeHostCooldownState(USER, previous, { cooldowns }, HOST_NOW);
}

test("a host is recognised only by IsPlayerHostRuntime without IsGameserver, and is still not a dedicated writer", () => {
    const Host = { IsPlayerHostRuntime: true, IsGameserver: false, userId: USER };
    assert.equal(IsHostCooldownWriter(Host), true);
    assert.equal(IsHostCooldownWriter({ IsPlayerHostRuntime: true }), true);
    assert.equal(IsHostCooldownWriter({ IsGameserver: true }), false);
    assert.equal(IsHostCooldownWriter({ IsGameserver: true, IsPlayerHostRuntime: true }), false);
    assert.equal(IsHostCooldownWriter({ userId: USER }), false);
    assert.equal(IsHostCooldownWriter(undefined), false);
    assert.equal(IsAuthorizedCooldownWriter(Host), false);
});

test("a host may add a cooldown, repeat one, and move one later", () => {
    const Previous = StoredRecord([{ id: "bounty_daily", startedDate: "2026-10-12T17:00:00.000Z" }, { id: "GRANT_DAILY_HEROICPLUS", startedDate: "2026-10-12T00:00:00.000Z" }]);
    const { record, changes } = HostSave(Previous, [
        { cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-13T17:00:00.000Z" },      // later
        { cooldown_id: "GRANT_DAILY_HEROICPLUS", cooldown_started_date: "2026-10-12T00:00:00.000Z" }, // equal
        { cooldown_id: "GRANT_PATROL_BOOST_TOKEN", cooldown_started_date: "2026-10-13T00:00:00.000Z" } // new
    ]);
    assert.deepEqual(CooldownStatePayload(record), {
        bounty_daily: "2026-10-13T17:00:00.000Z",
        GRANT_DAILY_HEROICPLUS: "2026-10-12T00:00:00.000Z",
        GRANT_PATROL_BOOST_TOKEN: "2026-10-13T00:00:00.000Z",
    });
    assert.deepEqual(changes, {
        received: 3, unchanged: 1,
        added: [{ id: "GRANT_PATROL_BOOST_TOKEN", to: "2026-10-13T00:00:00.000Z" }], addedCount: 1,
        raised: [{ id: "bounty_daily", from: "2026-10-12T17:00:00.000Z", to: "2026-10-13T17:00:00.000Z" }], raisedCount: 1,
        keptLater: [], keptLaterCount: 0, droppedNew: 0,
        refusedFuture: [], refusedFutureCount: 0,
    });
    assert.equal(record.updateVersion, 8);
    assert.equal(record.createdAt, "2026-09-01T00:00:00.000Z");
});

test("a host cannot move a cooldown earlier: the stored date stays, the rest of the save still applies", () => {
    const Previous = StoredRecord([{ id: "bounty_daily", startedDate: "2026-10-13T17:00:00.000Z" }, { id: "GRANT_DAILY_HEROICPLUS", startedDate: "2026-10-12T00:00:00.000Z" }]);
    const { record, changes } = HostSave(Previous, [
        { cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-01T00:00:00.000Z" },          // reset attempt
        { cooldown_id: "GRANT_DAILY_HEROICPLUS", cooldown_started_date: "2026-10-12T23:59:59.999Z" }, // later, accepted
        { cooldown_id: "season43", cooldown_started_date: "2026-10-22T17:00:00.000Z" },
    ]);
    assert.deepEqual(CooldownStatePayload(record), {
        bounty_daily: "2026-10-13T17:00:00.000Z",
        GRANT_DAILY_HEROICPLUS: "2026-10-12T23:59:59.999Z",
        season43: "2026-10-22T17:00:00.000Z",
    });
    assert.deepEqual(changes.keptLater, [{ id: "bounty_daily", stored: "2026-10-13T17:00:00.000Z", attempted: "2026-10-01T00:00:00.000Z" }]);
    assert.equal(changes.keptLaterCount, 1);
    // One millisecond earlier is already refused.
    const OneMs = HostSave(Previous, [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-13T16:59:59.999Z" }]);
    assert.equal(CooldownStatePayload(OneMs.record).bounty_daily, "2026-10-13T17:00:00.000Z");
    // Dates are compared as instants, whatever their notation: 17:30+01:00 is 16:30Z (earlier), 18:00+01:00 is 17:00Z (equal).
    const Earlier = HostSave(Previous, [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-13T17:30:00+01:00" }]);
    assert.equal(CooldownStatePayload(Earlier.record).bounty_daily, "2026-10-13T17:00:00.000Z");
    assert.equal(Earlier.changes.keptLaterCount, 1);
    const Same = HostSave(Previous, [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-13T18:00:00+01:00" }]);
    assert.equal(Same.changes.unchanged, 1);
    assert.equal(Same.changes.keptLaterCount, 0);
});

test("a host save never deletes a stored cooldown, whether it names it or not", () => {
    const Previous = StoredRecord([{ id: "season43", startedDate: "2026-10-22T17:00:00.000Z" }, { id: "bounty_daily", startedDate: "2026-10-12T17:00:00.000Z" }]);
    assert.deepEqual(CooldownStatePayload(HostSave(Previous, []).record), CooldownStatePayload(Previous));
    assert.deepEqual(CooldownStatePayload(HostSave(Previous, [{ cooldown_id: "other", cooldown_started_date: HOST_NOW }]).record),
        { season43: "2026-10-22T17:00:00.000Z", bounty_daily: "2026-10-12T17:00:00.000Z", other: HOST_NOW });
});

test("duplicates inside one host save are judged in order against what was just accepted", () => {
    const Previous = StoredRecord([{ id: "bounty_daily", startedDate: "2026-10-12T17:00:00.000Z" }]);
    const { record, changes } = HostSave(Previous, [
        { cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-14T00:00:00.000Z" },
        { cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-13T00:00:00.000Z" },  // earlier than the first: refused
        { cooldown_id: "fresh", cooldown_started_date: "2026-10-13T10:00:00.000Z" },
        { cooldown_id: "fresh", cooldown_started_date: "2026-10-13T09:00:00.000Z" },          // earlier than the first: refused
    ]);
    assert.deepEqual(CooldownStatePayload(record), { bounty_daily: "2026-10-14T00:00:00.000Z", fresh: "2026-10-13T10:00:00.000Z" });
    assert.equal(changes.keptLaterCount, 2);
    assert.equal(changes.raisedCount, 1);
    assert.equal(changes.addedCount, 1);
});

test("a host cannot evict stored cooldowns by flooding new ids; the dedicated merge still evicts the oldest", () => {
    // Full store: the long-lived daily gate is also the longest-unwritten entry, which the cap would drop first.
    const Full = StoredRecord([
        { id: "bounty_daily", startedDate: "2026-10-12T17:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" },
        ...Array.from({ length: MAX_STORED_COOLDOWNS - 1 }, (_, Index) => ({ id: `named_${Index}`, startedDate: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" })),
    ]);
    assert.equal(Full.entries.length, MAX_STORED_COOLDOWNS);
    const Flood = Array.from({ length: 50 }, (_, Index) => ({ cooldown_id: `junk_${Index}`, cooldown_started_date: HOST_NOW }));
    const Host = HostSave(Full, Flood);
    assert.equal(Host.record.entries.length, MAX_STORED_COOLDOWNS);
    assert.equal(CooldownStatePayload(Host.record).bounty_daily, "2026-10-12T17:00:00.000Z");
    assert.equal(Host.changes.droppedNew, 50);
    assert.equal(Host.changes.addedCount, 0);
    // The dedicated path is unchanged: new ids push the oldest-written entry (the gate) out.
    const Dedicated = MergeCooldownState(USER, Full, { cooldowns: Flood }, HOST_NOW);
    assert.equal(CooldownStatePayload(Dedicated).bounty_daily, undefined);

    // With room for 3, a host adds 3 of 5 new ids and still keeps everything it had.
    const Nearly = StoredRecord([{ id: "bounty_daily", startedDate: "2026-10-12T17:00:00.000Z" },
        ...Array.from({ length: MAX_STORED_COOLDOWNS - 4 }, (_, Index) => ({ id: `named_${Index}`, startedDate: "2026-10-12T00:00:00.000Z" }))]);
    const Some = HostSave(Nearly, Flood.slice(0, 5));
    assert.equal(Some.changes.addedCount, 3);
    assert.equal(Some.changes.droppedNew, 2);
    assert.equal(Some.record.entries.length, MAX_STORED_COOLDOWNS);
    assert.equal(CooldownStatePayload(Some.record).bounty_daily, "2026-10-12T17:00:00.000Z");
});

test("the change lists are capped but the counts are not, and the previous dates are kept for reversal", () => {
    const Ids = Array.from({ length: 30 }, (_, Index) => `gate_${Index}`);
    const Previous = StoredRecord(Ids.map((Id) => ({ id: Id, startedDate: "2026-10-12T00:00:00.000Z" })));
    const { changes } = HostSave(Previous, Ids.map((Id) => ({ cooldown_id: Id, cooldown_started_date: "2026-10-13T00:00:00.000Z" })));
    assert.equal(changes.raisedCount, 30);
    assert.equal(changes.raised.length, 20);
    assert.deepEqual(changes.raised[0], { id: "gate_0", from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z" });
});

test("a malformed host save is rejected like a dedicated one", () => {
    assert.throws(() => MergeHostCooldownState(USER, undefined, {}), CooldownSaveValidationError);
    assert.throws(() => HostSave(undefined, [{ cooldown_id: "X", cooldown_started_date: "not a date" }]), CooldownSaveValidationError);
});

test("a host save over an unparsable stored date replaces it (nothing to compare against)", () => {
    const Previous = StoredRecord([{ id: "odd", startedDate: "garbage" }]);
    assert.equal(CooldownStatePayload(HostSave(Previous, [{ cooldown_id: "odd", cooldown_started_date: "2026-10-13T00:00:00.000Z" }]).record).odd, "2026-10-13T00:00:00.000Z");
});

// ---- [2026-10-13 realms S3 limits] a host's date may not lie far ahead -----------------------------------------------------
// "May only move later" alone would let a host set any far-future date and lock a friend's daily gate for good. The real
// dates are near: bounty_daily <= 24 h ahead, GRANT_* and sprouts past or now, season43 = the pass window's end.
// HOST_NOW (2026-10-13T18:00Z) lies in the window 2026-07-30T17:00Z .. 2026-10-22T17:00Z.

const WINDOW_END = "2026-10-22T17:00:00.000Z";
const NEXT_WINDOW_END = "2027-01-14T17:00:00.000Z";
const AheadOf = (ms: number) => new Date(Date.parse(HOST_NOW) + ms).toISOString();
const HOURS_48 = 48 * HOUR_MS;

test("season pass ids are recognised by shape; a host may write at most now + 48 h, or the end of the current window for a season id", () => {
    for (const Id of ["season43", "season44", "SEASON43", "season10a"]) assert.equal(IsSeasonCooldownId(Id), true, Id);
    for (const Id of ["season", "seasonal", "season43_extra", "xseason43", "season43\n", "season43 ", "bounty_daily", "GRANT_SEASON43", ""]) assert.equal(IsSeasonCooldownId(Id), false, JSON.stringify(Id));
    assert.equal(HOST_COOLDOWN_MAX_FUTURE_MS, HOURS_48);
    const NowMs = Date.parse(HOST_NOW);
    assert.equal(HostCooldownLatestMs("bounty_daily", NowMs), NowMs + HOURS_48);
    assert.equal(HostCooldownLatestMs("GRANT_DAILY_HEROICPLUS", NowMs), NowMs + HOURS_48);
    assert.equal(HostCooldownLatestMs("season43", NowMs), Date.parse(WINDOW_END));
    // The window end moves with the roll: at the roll itself the new window's end applies; one ms before it, the old one.
    assert.equal(HostCooldownLatestMs("season43", Date.parse(WINDOW_END) - 1), Date.parse(WINDOW_END));
    assert.equal(HostCooldownLatestMs("season43", Date.parse(WINDOW_END)), Date.parse(NEXT_WINDOW_END));
});

test("a host's date more than 48 hours ahead is refused: the stored date stays, the rest of the save applies, the attempt is counted", () => {
    const Previous = StoredRecord([{ id: "bounty_daily", startedDate: "2026-10-12T17:00:00.000Z" }]);
    const { record, changes } = HostSave(Previous, [
        { cooldown_id: "bounty_daily", cooldown_started_date: AheadOf(30 * 24 * HOUR_MS) },   // lock-out attempt on a stored gate
        { cooldown_id: "GRANT_LOCK", cooldown_started_date: AheadOf(HOURS_48 + 1) },          // a new id one ms past the limit
        { cooldown_id: "GRANT_FINE", cooldown_started_date: HOST_NOW },
    ]);
    assert.deepEqual(CooldownStatePayload(record), { bounty_daily: "2026-10-12T17:00:00.000Z", GRANT_FINE: HOST_NOW }, "the refused id was not stored, the stored date stayed");
    assert.equal(changes.refusedFutureCount, 2);
    assert.deepEqual(changes.refusedFuture, [
        { id: "bounty_daily", attempted: AheadOf(30 * 24 * HOUR_MS), latest: AheadOf(HOURS_48), stored: "2026-10-12T17:00:00.000Z" },
        { id: "GRANT_LOCK", attempted: AheadOf(HOURS_48 + 1), latest: AheadOf(HOURS_48) },
    ]);
    assert.equal(changes.addedCount, 1);
    assert.equal(changes.keptLaterCount, 0, "a refusal for lying ahead is not the earlier-than-stored rule");
    assert.equal(record.updateVersion, 8);
});

test("exactly 48 hours ahead is accepted; the real near-future dates are never refused", () => {
    const Previous = StoredRecord([{ id: "bounty_daily", startedDate: "2026-10-12T17:00:00.000Z" }]);
    const { record, changes } = HostSave(Previous, [
        { cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-14T17:00:00.000Z" },          // the next 17:00 UTC: 23 h ahead
        { cooldown_id: "edge", cooldown_started_date: AheadOf(HOURS_48) },
        { cooldown_id: "GRANT_DAILY_HEROICPLUS", cooldown_started_date: "2026-10-13T00:00:00.000Z" },  // a past day start
        { cooldown_id: "58E91700491B00FA7DB373809E250E45", cooldown_started_date: HOST_NOW },          // a sprout, now
    ]);
    assert.equal(changes.refusedFutureCount, 0);
    assert.deepEqual(changes.refusedFuture, []);
    assert.equal(CooldownStatePayload(record).bounty_daily, "2026-10-14T17:00:00.000Z");
    assert.equal(CooldownStatePayload(record).edge, AheadOf(HOURS_48));
    // The limit is on the instant, not the notation: +01:00 spellings of the same two instants.
    const Notation = HostSave(Previous, [
        { cooldown_id: "edge", cooldown_started_date: new Date(Date.parse(HOST_NOW) + HOURS_48).toISOString().replace("T18:00:00.000Z", "T19:00:00+01:00") },
        { cooldown_id: "over", cooldown_started_date: new Date(Date.parse(HOST_NOW) + HOURS_48 + 1000).toISOString().replace("T18:00:01.000Z", "T19:00:01+01:00") },
    ]);
    assert.equal(Notation.changes.refusedFutureCount, 1);
    assert.deepEqual(Notation.changes.refusedFuture.map((Entry) => Entry.id), ["over"]);
});

test("a season id may reach the end of the current window and not a moment past it; other ids stay at 48 hours", () => {
    const { record, changes } = HostSave(undefined, [
        { cooldown_id: "season43", cooldown_started_date: WINDOW_END },                                 // the pass end: allowed
        { cooldown_id: "season44", cooldown_started_date: AheadOf(5 * 24 * HOUR_MS) },                   // mid-window, beyond 48 h: allowed for a season id
        { cooldown_id: "season45", cooldown_started_date: "2026-10-22T17:00:00.001Z" },                  // one ms past the end
        { cooldown_id: "season46", cooldown_started_date: NEXT_WINDOW_END },                             // the next window's end, before the roll
        { cooldown_id: "bounty_daily", cooldown_started_date: AheadOf(5 * 24 * HOUR_MS) },               // the same date for a daily gate: refused
    ]);
    assert.deepEqual(CooldownStatePayload(record), { season43: WINDOW_END, season44: AheadOf(5 * 24 * HOUR_MS) });
    assert.deepEqual(changes.refusedFuture.map((Entry) => Entry.id), ["season45", "season46", "bounty_daily"]);
    assert.equal(changes.refusedFuture[0].latest, WINDOW_END);
    assert.equal(changes.refusedFuture[2].latest, AheadOf(HOURS_48));
});

test("the season limit follows the roll: the new window's end is allowed from the roll on, the old one never lies ahead again", () => {
    const AtRoll = "2026-10-22T17:00:00.000Z";
    const Before = MergeHostCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "season43", cooldown_started_date: NEXT_WINDOW_END }] }, "2026-10-22T16:59:59.999Z");
    assert.equal(Before.changes.refusedFutureCount, 1);
    const After = MergeHostCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "season43", cooldown_started_date: NEXT_WINDOW_END }] }, AtRoll);
    assert.equal(After.changes.refusedFutureCount, 0);
    assert.equal(CooldownStatePayload(After.record).season43, NEXT_WINDOW_END);
    const OldEnd = MergeHostCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "season43", cooldown_started_date: WINDOW_END }] }, "2026-10-23T00:00:00.000Z");
    assert.equal(OldEnd.changes.refusedFutureCount, 0, "a stale server writing the previous window's end writes a past date");
});

test("a far-future date that is already stored is not a refusal when written back; a different one is", () => {
    const Previous = StoredRecord([{ id: "locked", startedDate: "2027-01-01T00:00:00.000Z" }]);   // set by a dedicated server
    const Same = HostSave(Previous, [{ cooldown_id: "locked", cooldown_started_date: "2027-01-01T01:00:00+01:00" }]);
    assert.equal(Same.changes.refusedFutureCount, 0);
    assert.equal(Same.changes.unchanged, 1);
    const Other = HostSave(Previous, [{ cooldown_id: "locked", cooldown_started_date: "2027-06-01T00:00:00.000Z" }]);
    assert.equal(Other.changes.refusedFutureCount, 1);
    assert.equal(CooldownStatePayload(Other.record).locked, "2027-01-01T00:00:00.000Z");
    // Moving it earlier, near, is the existing rule: kept, not a future refusal.
    const Earlier = HostSave(Previous, [{ cooldown_id: "locked", cooldown_started_date: HOST_NOW }]);
    assert.equal(Earlier.changes.refusedFutureCount, 0);
    assert.equal(Earlier.changes.keptLaterCount, 1);
});

test("a refused new id costs no room in a full store", () => {
    const Full = StoredRecord([
        { id: "bounty_daily", startedDate: "2026-10-12T17:00:00.000Z" },
        ...Array.from({ length: MAX_STORED_COOLDOWNS - 1 }, (_, Index) => ({ id: `named_${Index}`, startedDate: "2026-10-12T00:00:00.000Z" })),
    ]);
    const Flood = Array.from({ length: 3 }, (_, Index) => ({ cooldown_id: `junk_${Index}`, cooldown_started_date: AheadOf(HOURS_48 + HOUR_MS) }));
    const { record, changes } = HostSave(Full, Flood);
    assert.equal(changes.refusedFutureCount, 3);
    assert.equal(changes.droppedNew, 0);
    assert.equal(record.entries.length, MAX_STORED_COOLDOWNS);
});

test("duplicates inside one host save are judged in order for the future limit too", () => {
    const Previous = StoredRecord([{ id: "bounty_daily", startedDate: "2026-10-12T17:00:00.000Z" }]);
    const Far = AheadOf(10 * 24 * HOUR_MS);
    const { record, changes } = HostSave(Previous, [
        { cooldown_id: "bounty_daily", cooldown_started_date: Far },                  // refused
        { cooldown_id: "bounty_daily", cooldown_started_date: AheadOf(HOUR_MS) },     // judged against the stored date: raised
        { cooldown_id: "fresh", cooldown_started_date: AheadOf(2 * HOUR_MS) },        // added
        { cooldown_id: "fresh", cooldown_started_date: Far },                         // refused: the accepted one stays
    ]);
    assert.deepEqual(CooldownStatePayload(record), { bounty_daily: AheadOf(HOUR_MS), fresh: AheadOf(2 * HOUR_MS) });
    assert.equal(changes.refusedFutureCount, 2);
    assert.equal(changes.raisedCount, 1);
    assert.equal(changes.addedCount, 1);
});

test("the refusal list is capped but the count is not", () => {
    const Flood = Array.from({ length: 30 }, (_, Index) => ({ cooldown_id: `lock_${Index}`, cooldown_started_date: AheadOf(HOURS_48 + HOUR_MS) }));
    const { record, changes } = HostSave(undefined, Flood);
    assert.equal(changes.refusedFutureCount, 30);
    assert.equal(changes.refusedFuture.length, 20);
    assert.equal(record.entries.length, 0);
});

test("the dedicated merge has no future limit, and a host save with an unreadable clock falls back to the real one", () => {
    const Far = "2099-01-01T00:00:00.000Z";
    assert.equal(CooldownStatePayload(MergeCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "bounty_daily", cooldown_started_date: Far }] }, HOST_NOW)).bounty_daily, Far);
    const Real = Date.now();
    const Result = MergeHostCooldownState(USER, undefined, {
        cooldowns: [{ cooldown_id: "near", cooldown_started_date: new Date(Real + HOUR_MS).toISOString() }, { cooldown_id: "far", cooldown_started_date: new Date(Real + 3 * 24 * HOUR_MS).toISOString() }]
    }, "garbage");
    assert.deepEqual(Object.keys(CooldownStatePayload(Result.record)), ["near"]);
    assert.equal(Result.changes.refusedFutureCount, 1);
});
