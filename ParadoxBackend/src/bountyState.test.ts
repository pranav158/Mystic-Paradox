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
    AcceptedWeeklyStampsMs,
    BountyGroupCounts,
    BountySaveValidationError,
    BountyStatePayload,
    ClampHostObjectiveProgress,
    DefaultDraftData,
    FindFundableSeasonClaim,
    HostBountyWriteSummary,
    InferBountyGroup,
    IsAuthorizedBountyReader,
    IsAuthorizedBountyWriter,
    IsHostBountyWriter,
    IsProtectedClaimedWeekly,
    MAX_HOST_OBJECTIVE_PROGRESS,
    MAX_STORED_BOUNTIES,
    MergeBountyState,
    MergeHostBountyState,
    NewlyClaimedBountyIds,
    ParseWeeklyBountyId,
    PlanHostBountySave,
    WEEKLY_INSTANCES_PER_WINDOW,
    WEEKLY_PREVIOUS_WINDOW_GRACE_MS,
    WeeklyScheduleStampMs,
    UtcDay,
    GameDailyWindowKey,
    DailyChallengeRewardPaid,
    DailyChallengeRewardLimited,
    WithRewardCredit
} from "./bountyState";
import { IsChallengeRewardGrant } from "./controllers/challengeRewards";
import { BountyStateRecord, StoredBounty } from "./persistence/mapping/domainTypes";
import { ACTIVE_SEASON_LENGTH_MS, ActiveSeasonWindowMs } from "./seasonWindow";

const USER = "player-1";
const NOW = "2026-10-10T06:00:00.000Z";
const WEEK = "2026-07-30T17:00:00.000Z";

function Season(id: string, progress = 0, claimed = false, drafted = WEEK) {
    return {
        bounty_id: id, premium_bounty: false, slot_index: 0,
        objectives: [{ objective_id: id.replace(/^\d+_\d+_\d+_/, "").replace(/-season.*$/, ""), progress }],
        drafted_timestamp: drafted, update_version: 0, claimed
    };
}

function Daily(id: string, drafted: string, progress = 0, claimed = false) {
    return { bounty_id: id, premium_bounty: false, slot_index: 0, objectives: [{ objective_id: id, progress }], drafted_timestamp: drafted, update_version: 0, claimed };
}

function Apply(previous: BountyStateRecord | undefined, body: unknown) {
    return MergeBountyState(USER, previous, body, NOW).record;
}

test("bounty writes are dedicated-server only; reads are server or same account", () => {
    assert.equal(IsAuthorizedBountyWriter({ IsGameserver: true }), true);
    assert.equal(IsAuthorizedBountyWriter({ userId: USER }), false);
    assert.equal(IsAuthorizedBountyWriter({ IsPlayerHostRuntime: true, userId: USER }), false);
    assert.equal(IsAuthorizedBountyReader({ IsGameserver: true }, "player-2"), true);
    assert.equal(IsAuthorizedBountyReader({ userId: USER }, USER), true);
    assert.equal(IsAuthorizedBountyReader({ userId: USER }, "player-2"), false);
    assert.equal(IsAuthorizedBountyReader({ IsPlayerHostRuntime: true, userId: USER }, USER), false);
});

test("a player-host runtime reads the bounty state of its hunt roster only and never writes (B8, 2026-10-11)", () => {
    const Host = { IsPlayerHostRuntime: true, IsGameserver: false, userId: USER, RuntimeRosterAccountIds: [USER, "player-2"] };
    assert.equal(IsAuthorizedBountyReader(Host, "player-2"), true);
    assert.equal(IsAuthorizedBountyReader(Host, "player-3"), false);
    assert.equal(IsAuthorizedBountyReader({ ...Host, RuntimeRosterAccountIds: "player-2" }, "player-2"), false);
    assert.equal(IsAuthorizedBountyWriter(Host), false);
});

test("an account with no stored state is served the old stub's empty shape", () => {
    assert.deepEqual(BountyStatePayload(undefined), {
        season_start_date: "2020-08-23T00:00:00.000Z",
        season_end_date: "2099-01-01T00:00:00.000Z",
        bounties: [],
        draft_data: DefaultDraftData(),
        draft_data_daily: DefaultDraftData(),
        draft_data_weekly: DefaultDraftData()
    });
});

test("bounties are grouped by id when no draft data names the component", () => {
    assert.equal(InferBountyGroup("Challenge_Daily_Bronze_KillBlazeWeapon"), "daily");
    assert.equal(InferBountyGroup("43_3_1_Challenge_Season_Spend_Notes-season43-2"), "weekly");
    assert.equal(InferBountyGroup("Bounty_Bronze_KillWithFriends"), "base");
});

test("the weekly seed is stored and served back with its draft data", () => {
    const Seed = [Season("43_1_1_Challenge_Season_BountiesAny_15-season43-0"), Season("43_1_2_Challenge_Season_LanternDamage-season43-0")];
    const Weekly = { current_draft_choices: [], previous_draft_selections: [], bronze_count: 0, silver_count: 0, gold_count: 0 };
    const Record = Apply(undefined, { bounties: Seed, draft_data_weekly: Weekly });
    assert.equal(Record.updateVersion, 1);
    assert.deepEqual(BountyGroupCounts(Record), { base: 0, daily: 0, weekly: 2, unassigned: 0, claimed: 0, credited: 0 });
    const Payload = BountyStatePayload(Record) as any;
    assert.deepEqual(Payload.bounties, Seed);
    assert.deepEqual(Payload.draft_data_weekly, Weekly);
    assert.deepEqual(Payload.draft_data_daily, DefaultDraftData());
});

test("a re-seed at progress 0 cannot erase progress or unclaim a claimed challenge", () => {
    const Id = "43_3_7_Challenge_Season_Break_Heads-season43-2";
    let Record = Apply(undefined, { bounties: [Season(Id)], draft_data_weekly: DefaultDraftData() });
    Record = Apply(Record, { bounties: [Season(Id, 7)] });
    Record = Apply(Record, { bounties: [Season(Id, 10, true)] });
    Record = Apply(Record, { bounties: [Season(Id, 0, false)], draft_data_weekly: DefaultDraftData() });
    const Stored = Record.bounties[0].bounty;
    assert.equal(Stored.objectives[0].progress, 10);
    assert.equal(Stored.claimed, true);
    assert.equal(Record.updateVersion, 4);
});

test("an empty list with draft data updates the draft data but deletes nothing", () => {
    const Ids = ["43_1_1_Challenge_Season_BountiesAny_15-season43-0", "43_1_2_Challenge_Season_LanternDamage-season43-0"];
    let Record = Apply(undefined, { bounties: Ids.map((Id) => Season(Id, 3)), draft_data_weekly: DefaultDraftData() });
    const Next = { ...DefaultDraftData(), gold_count: 4 };
    Record = Apply(Record, { bounties: [], draft_data_weekly: Next });
    assert.equal(Record.bounties.length, 2);
    assert.deepEqual(Record.draftData.weekly, Next);
});

test("a daily draft replaces the previous daily bounty and leaves the season challenges alone", () => {
    const SeasonId = "43_2_1_Challenge_Season_GatherablesAny-season43-1";
    let Record = Apply(undefined, { bounties: [Season(SeasonId, 5)], draft_data_weekly: DefaultDraftData() });
    Record = Apply(Record, {
        bounties: [Daily("Challenge_Daily_Bronze_WoundDamageReduce", "2026-10-09T05:27:52.688Z", 1, true)],
        draft_data_daily: { ...DefaultDraftData(), previous_draft_selections: ["Challenge_Daily_Bronze_WoundDamageReduce"] }
    });
    Record = Apply(Record, {
        bounties: [Daily("Challenge_Daily_Bronze_KillBlazeWeapon", "2026-10-10T05:28:08.000Z")],
        draft_data_daily: { ...DefaultDraftData(), previous_draft_selections: ["Challenge_Daily_Bronze_WoundDamageReduce", "Challenge_Daily_Bronze_KillBlazeWeapon"] }
    });
    const Ids = Record.bounties.map((Entry) => Entry.bounty.bounty_id).sort();
    assert.deepEqual(Ids, ["43_2_1_Challenge_Season_GatherablesAny-season43-1", "Challenge_Daily_Bronze_KillBlazeWeapon"]);
    assert.equal(Record.bounties.find((Entry) => Entry.group === "weekly")!.bounty.objectives[0].progress, 5);
    assert.deepEqual((Record.draftData.daily as any).previous_draft_selections.length, 2);
});

test("a single-bounty save updates progress; a new drafted_timestamp is a new instance", () => {
    const Id = "Challenge_Daily_Bronze_KillBlazeWeapon";
    let Record = Apply(undefined, { bounties: [Daily(Id, "2026-10-09T05:00:00.000Z", 1, true)], draft_data_daily: DefaultDraftData() });
    Record = Apply(Record, { bounties: [Daily(Id, "2026-10-09T05:00:00.000Z", 0, false)] });
    assert.equal(Record.bounties[0].bounty.claimed, true, "same instance stays claimed");
    Record = Apply(Record, { bounties: [Daily(Id, "2026-10-10T05:00:00.000Z", 0, false)] });
    assert.equal(Record.bounties.length, 1);
    assert.equal(Record.bounties[0].bounty.claimed, false, "a later draft of the same bounty starts unclaimed");
    assert.equal(Record.bounties[0].bounty.drafted_timestamp, "2026-10-10T05:00:00.000Z");
    assert.equal(Record.bounties[0].group, "daily");
});

test("an objective the incoming save omits is kept", () => {
    const Two = { bounty_id: "Bounty_Bronze_Two", drafted_timestamp: WEEK, claimed: false,
        objectives: [{ objective_id: "A", progress: 2 }, { objective_id: "B", progress: 4 }] };
    let Record = Apply(undefined, { bounties: [Two] });
    Record = Apply(Record, { bounties: [{ ...Two, objectives: [{ objective_id: "A", progress: 3 }] }] });
    const Objectives = Record.bounties[0].bounty.objectives;
    assert.deepEqual(Objectives, [{ objective_id: "A", progress: 3 }, { objective_id: "B", progress: 4 }]);
});

test("malformed saves are rejected before anything is stored", () => {
    assert.throws(() => Apply(undefined, null), BountySaveValidationError);
    assert.throws(() => Apply(undefined, { bounties: {} }), BountySaveValidationError);
    assert.throws(() => Apply(undefined, { bounties: [{ objectives: [] }] }), BountySaveValidationError);
    assert.throws(() => Apply(undefined, { bounties: [{ bounty_id: "X", objectives: {} }] }), BountySaveValidationError);
    assert.throws(() => Apply(undefined, { bounties: [], draft_data_daily: [] }), BountySaveValidationError);
    assert.throws(() => Apply(undefined, { bounties: new Array(513).fill({ bounty_id: "X" }) }), BountySaveValidationError);
});

test("the stored list is capped, oldest claimed bounties first", () => {
    const Many = [];
    for (let i = 0; i < MAX_STORED_BOUNTIES; i++) Many.push(Daily(`Bounty_Old_${i}`, `2025-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, 1, i < 5));
    let Record: BountyStateRecord | undefined;
    for (let i = 0; i < Many.length; i += 500) Record = Apply(Record, { bounties: Many.slice(i, i + 500) });
    Record = Apply(Record, { bounties: [Daily("Bounty_New", NOW)] });
    assert.equal(Record.bounties.length, MAX_STORED_BOUNTIES);
    assert.ok(Record.bounties.some((Entry) => Entry.bounty.bounty_id === "Bounty_New"));
    assert.equal(BountyGroupCounts(Record).claimed, 4, "one claimed bounty was dropped to make room");
});

// ---- season-challenge rewards ----------------------------------------------------------------------------------------

const AXE = "43_5_5_Challenge_Season_BigHit_Axe-season43-4";
const PARTS = "43_11_2_Challenge_Season_Part_Damage_1Fight-season43-10";

function ApplyAt(previous: BountyStateRecord | undefined, body: unknown, at: string) {
    return MergeBountyState(USER, previous, body, at).record;
}

function Seeded() {
    return ApplyAt(undefined, { bounties: [Season(AXE), Season(PARTS)], draft_data_weekly: DefaultDraftData() }, "2026-10-10T08:00:00.000Z");
}

test("a claim is stamped when first seen claimed and keeps that time on later saves", () => {
    let Record = ApplyAt(Seeded(), { bounties: [Season(AXE, 1, true)] }, "2026-10-10T08:56:04.304Z");
    Record = ApplyAt(Record, { bounties: [Season(AXE, 1, true)] }, "2026-10-10T09:10:00.000Z");
    const Axe = Record.bounties.find((Entry) => Entry.bounty.bounty_id === AXE)!;
    assert.equal(Axe.claimedAt, "2026-10-10T08:56:04.304Z");
    assert.equal(Record.bounties.find((Entry) => Entry.bounty.bounty_id === PARTS)!.claimedAt, undefined);
});

test("each claimed season challenge funds exactly one reward, newest claim first", () => {
    let Record = ApplyAt(Seeded(), { bounties: [Season(AXE, 1, true)] }, "2026-10-10T08:56:04.304Z");
    Record = ApplyAt(Record, { bounties: [Season(PARTS, 1, true)] }, "2026-10-10T08:56:04.378Z");
    assert.equal(FindFundableSeasonClaim(Record)!.bounty.bounty_id, PARTS);
    Record = WithRewardCredit(Record, PARTS, { catalogId: "CURRENCY_SEASONAL_COIN", amount: 400, transactionId: "T1", at: NOW });
    assert.equal(FindFundableSeasonClaim(Record)!.bounty.bounty_id, AXE);
    Record = WithRewardCredit(Record, AXE, { catalogId: "CURRENCY_SEASONAL_COIN", amount: 400, transactionId: "T2", at: NOW });
    assert.equal(FindFundableSeasonClaim(Record), undefined, "no claim left to fund a third grant");
    assert.throws(() => WithRewardCredit(Record, AXE, { catalogId: "CURRENCY_SEASONAL_COIN", amount: 400, transactionId: "T3", at: NOW }));
    assert.equal(BountyGroupCounts(Record).credited, 2);
});

test("a re-seed of the same challenge keeps it claimed and credited, so it can never pay twice", () => {
    let Record = ApplyAt(Seeded(), { bounties: [Season(AXE, 1, true)] }, "2026-10-10T08:56:04.304Z");
    Record = WithRewardCredit(Record, AXE, { catalogId: "CURRENCY_SEASONAL_COIN", amount: 400, transactionId: "T1", at: NOW });
    // The next arrival re-sends the whole season list - as the game did before persistence, at progress 0, unclaimed.
    Record = ApplyAt(Record, { bounties: [Season(AXE, 0, false), Season(PARTS)], draft_data_weekly: DefaultDraftData() }, "2026-10-10T09:30:00.000Z");
    const Axe = Record.bounties.find((Entry) => Entry.bounty.bounty_id === AXE)!;
    assert.equal(Axe.bounty.claimed, true);
    assert.equal(Axe.rewardCredit?.transactionId, "T1");
    assert.equal(FindFundableSeasonClaim(Record), undefined);
    assert.equal((BountyStatePayload(Record) as any).bounties.find((Bounty: any) => Bounty.bounty_id === AXE).claimed, true,
        "the game is served the challenge as claimed");
});

test("a new drafted instance of a challenge starts unclaimed and uncredited", () => {
    let Record = ApplyAt(Seeded(), { bounties: [Season(AXE, 1, true)] }, "2026-10-10T08:56:04.304Z");
    Record = WithRewardCredit(Record, AXE, { catalogId: "CURRENCY_SEASONAL_COIN", amount: 400, transactionId: "T1", at: NOW });
    Record = ApplyAt(Record, { bounties: [Season(AXE, 0, false, "2026-10-17T17:00:00.000Z")] }, "2026-10-17T18:00:00.000Z");
    const Axe = Record.bounties.find((Entry) => Entry.bounty.bounty_id === AXE)!;
    assert.equal(Axe.rewardCredit, undefined);
    assert.equal(Axe.claimedAt, undefined);
});

// [2026-10-17] The once-a-day key is the game's day, from 17:00 UTC (the game's bounty_daily cooldown): under the UTC-date key the
// first daily reward of a new game day was refused whenever one was paid earlier that UTC date.
test("a claimed daily challenge funds one reward per game day (from 17:00 UTC); the day survives later saves", () => {
    const DayOne = Date.parse(NOW);
    let Record = ApplyAt(undefined, {
        bounties: [Daily("Challenge_Daily_Bronze_KillBlazeFrost", NOW, 1, true)],
        draft_data_daily: DefaultDraftData()
    }, NOW);
    assert.equal(FindFundableSeasonClaim(Record, DayOne)!.bounty.bounty_id, "Challenge_Daily_Bronze_KillBlazeFrost");
    Record = WithRewardCredit(Record, "Challenge_Daily_Bronze_KillBlazeFrost",
        { catalogId: "CURRENCY_SEASONAL_COIN", amount: 100, transactionId: "T1", at: NOW });
    assert.equal(Record.dailyRewardCreditedOn, "2026-10-09T17:00:00.000Z", "a morning instant belongs to the game day that began the day before");

    // A re-drafted daily claimed the same game day (the game's own top-up gives +4 draft tokens) is not paid again.
    Record = ApplyAt(Record, { bounties: [Daily("Challenge_Daily_Bronze_KillBlazeWeapon", NOW, 1, true)] }, "2026-10-10T07:00:00.000Z");
    assert.equal(Record.dailyRewardCreditedOn, "2026-10-09T17:00:00.000Z", "a bounty save keeps the day");
    const LastSecond = Date.parse("2026-10-10T16:59:59.000Z");
    assert.equal(FindFundableSeasonClaim(Record, LastSecond), undefined, "the same game day pays no second daily");
    assert.equal(DailyChallengeRewardLimited(Record, LastSecond), true, "its coins are skipped, not refused (controllers/wallet.ts)");

    // At 17:00 UTC the next game day pays the next claimed daily.
    const NextDay = Date.parse("2026-10-10T17:00:01.000Z");
    assert.equal(FindFundableSeasonClaim(Record, NextDay)!.bounty.bounty_id, "Challenge_Daily_Bronze_KillBlazeWeapon");
    assert.equal(DailyChallengeRewardLimited(Record, NextDay), false);
});

test("the game day runs 17:00 to 17:00 UTC, and a day stored in the old UTC-date form never matches it", () => {
    assert.equal(GameDailyWindowKey("2026-10-16T16:59:59.999Z"), "2026-10-15T17:00:00.000Z");
    assert.equal(GameDailyWindowKey("2026-10-16T17:00:00.000Z"), "2026-10-16T17:00:00.000Z");
    assert.equal(GameDailyWindowKey(Date.parse("2026-10-16T18:30:00.000Z")), "2026-10-16T17:00:00.000Z");
    const Old = { userId: USER, bounties: [], draftData: {}, dailyRewardCreditedOn: "2026-10-16", updateVersion: 1, createdAt: NOW, updatedAt: NOW } as BountyStateRecord;
    assert.equal(DailyChallengeRewardPaid(Old, Date.parse("2026-10-16T12:00:00.000Z")), false, "an old value pays at most one extra daily, once");
});

test("a record that still carries the host's premium-token day (an older record) keeps it through bounty saves; it answers the board as none", () => {
    // [2026-10-16] Nothing writes the day any more (hostDraftPremium.ts keeps only the balance cap); records written before still have it.
    const Old: BountyStateRecord = { userId: USER, bounties: [], draftData: {}, dailyPremiumDraftGrantedOn: "2026-10-10", updateVersion: 1,
        createdAt: NOW, updatedAt: NOW };
    assert.deepEqual(BountyStatePayload(Old), BountyStatePayload(undefined));
    const Record = ApplyAt(Old, { bounties: [Daily("Challenge_Daily_Bronze_KillBlazeWeapon", NOW, 1, true)] }, "2026-10-10T07:00:00.000Z");
    assert.equal(Record.dailyPremiumDraftGrantedOn, "2026-10-10", "a bounty save keeps the day");
    assert.equal(Record.bounties.length, 1, "the bounties are kept");
    assert.equal(Record.dailyRewardCreditedOn, undefined, "the daily reward day is a different key");
});

test("a weekly season challenge still pays with a daily already paid that day", () => {
    let Record = ApplyAt(undefined, {
        bounties: [Daily("Challenge_Daily_Bronze_KillBlazeFrost", NOW, 1, true)],
        draft_data_daily: DefaultDraftData()
    }, NOW);
    Record = WithRewardCredit(Record, "Challenge_Daily_Bronze_KillBlazeFrost",
        { catalogId: "CURRENCY_SEASONAL_COIN", amount: 100, transactionId: "T1", at: NOW });
    assert.equal(FindFundableSeasonClaim(Record, Date.parse(NOW)), undefined);
    assert.equal(UtcDay(Date.parse(NOW)), "2026-10-10");
});

test("only Cache Coin grants of a bounded size count as challenge rewards", () => {
    assert.equal(IsChallengeRewardGrant("CURRENCY_SEASONAL_COIN", 400), true);
    assert.equal(IsChallengeRewardGrant("CURRENCY_SEASONAL_COIN", 1001), false);
    assert.equal(IsChallengeRewardGrant("CURRENCY_SEASONAL_COIN", 0), false);
    assert.equal(IsChallengeRewardGrant("CURRENCY_NOTES", 400), false);
});

// ---- host writes (2026-10-13 realms S3) ----------------------------------------------------------------------------

function Merge(previous: BountyStateRecord | undefined, body: unknown, at: string) {
    return MergeBountyState(USER, previous, body, at);
}

test("a player-host runtime is a host bounty writer, and still not an authorised dedicated writer", () => {
    const Host = { IsPlayerHostRuntime: true, IsGameserver: false, userId: USER, RuntimeRosterAccountIds: [USER] };
    assert.equal(IsHostBountyWriter(Host), true);
    assert.equal(IsHostBountyWriter({ IsPlayerHostRuntime: true }), true);
    assert.equal(IsHostBountyWriter({ IsGameserver: true }), false);
    assert.equal(IsHostBountyWriter({ IsGameserver: true, IsPlayerHostRuntime: true }), false);
    assert.equal(IsHostBountyWriter({ userId: USER }), false);
    assert.equal(IsHostBountyWriter(undefined), false);
    assert.equal(IsAuthorizedBountyWriter(Host), false);
});

test("the claim stamp tells which ids a save turned into claimed, and only those", () => {
    const T0 = "2026-10-13T08:00:00.000Z";
    const T1 = "2026-10-13T08:05:00.000Z";
    const T2 = "2026-10-13T08:10:00.000Z";
    const First = Merge(undefined, { bounties: [Season(AXE), Season(PARTS)], draft_data_weekly: DefaultDraftData() }, T0);
    assert.deepEqual(NewlyClaimedBountyIds(First.record), []);

    // Progress only: nothing claimed.
    const Progress = Merge(First.record, { bounties: [Season(AXE, 3)] }, T1);
    assert.deepEqual(NewlyClaimedBountyIds(Progress.record), []);

    // The claim save names AXE.
    const Claim = Merge(Progress.record, { bounties: [Season(AXE, 3, true)] }, T2);
    assert.deepEqual(NewlyClaimedBountyIds(Claim.record), [AXE]);

    // The same claimed instance saved again later is not new, and a second one shows only itself.
    const Again = Merge(Claim.record, { bounties: [Season(AXE, 3, true), Season(PARTS, 1, true)] }, "2026-10-13T08:15:00.000Z");
    assert.deepEqual(NewlyClaimedBountyIds(Again.record), [PARTS]);
    const Quiet = Merge(Again.record, { bounties: [Season(AXE, 3, true)] }, "2026-10-13T08:20:00.000Z");
    assert.deepEqual(NewlyClaimedBountyIds(Quiet.record), []);
});

test("a whole-list save claims several at once; a claim stored before claimedAt existed is never reported", () => {
    const Legacy = { ...Season(AXE, 1, true) };
    const Seeded = Merge(undefined, { bounties: [Legacy] }, "2026-10-09T00:00:00.000Z");
    // Simulate a record from before claimedAt: claimed, no stamp.
    const Old: BountyStateRecord = { ...Seeded.record, bounties: Seeded.record.bounties.map((Entry) => ({ group: Entry.group, bounty: Entry.bounty })) };
    assert.equal(Old.bounties[0].claimedAt, undefined);
    const Next = Merge(Old, { bounties: [Season(AXE, 1, true), Season(PARTS, 2, true)], draft_data_weekly: DefaultDraftData() }, "2026-10-13T09:00:00.000Z");
    assert.deepEqual(NewlyClaimedBountyIds(Next.record), [PARTS]);
});

test("a challenge re-drafted with a new timestamp and claimed again is reported again, so repeats are visible to analysis", () => {
    let Record = Merge(Seeded(), { bounties: [Season(AXE, 1, true)] }, "2026-10-13T08:00:00.000Z").record;
    Record = WithRewardCredit(Record, AXE, { catalogId: "CURRENCY_SEASONAL_COIN", amount: 400, transactionId: "T1", at: NOW });
    const Redraft = Merge(Record, { bounties: [Season(AXE, 1, true, "2026-10-13T08:30:00.000Z")] }, "2026-10-13T08:31:00.000Z");
    assert.deepEqual(NewlyClaimedBountyIds(Redraft.record), [AXE]);
});

test("the host-write summary names the merge mode, group, counts, newly claimed ids and version", () => {
    const Replace = Merge(undefined, { bounties: [Season(AXE, 1, true), Season(PARTS)], draft_data_weekly: DefaultDraftData() }, "2026-10-13T08:00:00.000Z");
    assert.deepEqual(HostBountyWriteSummary(Replace.summary, Replace.record), {
        mode: "replace", group: "weekly", incoming: 2, removed: 0, newlyClaimedCount: 1, newlyClaimed: [AXE], version: 1,
    });
    const Upsert = Merge(Replace.record, { bounties: [Season(PARTS, 4)] }, "2026-10-13T08:01:00.000Z");
    assert.deepEqual(HostBountyWriteSummary(Upsert.summary, Upsert.record), {
        mode: "upsert", incoming: 1, removed: 0, newlyClaimedCount: 0, newlyClaimed: [], version: 2,
    });
});

test("the host-write summary caps the claimed id list but not the count", () => {
    const Ids = Array.from({ length: 40 }, (_, Index) => `43_${Index}_1_Challenge_Season_Test_${Index}-season43-0`);
    const Result = Merge(undefined, { bounties: Ids.map((Id) => Season(Id, 1, true)), draft_data_weekly: DefaultDraftData() }, "2026-10-13T08:00:00.000Z");
    const Summary = HostBountyWriteSummary(Result.summary, Result.record) as any;
    assert.equal(Summary.newlyClaimedCount, 40);
    assert.equal(Summary.newlyClaimed.length, 24);
    assert.deepEqual(Summary.newlyClaimed, Ids.slice(0, 24));
});

// ---- host limits (2026-10-13 realms S3 limits) ---------------------------------------------------------------------------
// The weekly season challenges are a fixed schedule (11 weeks x 10 per hunt-pass window, every instance stamped window start +
// 7 days x (week-1)), so a host's save is held to it: no re-stamp or drop of a claimed instance, no invented ids, progress capped.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// 13 Oct 2026 18:00 UTC is week 11 of the window 2026-07-30T17:00Z .. 2026-10-22T17:00Z (anchor 2024-09-26T17:00Z, 84-day cycles).
const H_NOW = "2026-10-13T18:00:00.000Z";
const H_NOW_MS = Date.parse(H_NOW);
const WINDOW = ActiveSeasonWindowMs(H_NOW_MS);
const PREVIOUS_START = WINDOW.startMs - ACTIVE_SEASON_LENGTH_MS;
const ROLL_MS = WINDOW.endMs;
const CREDIT = { catalogId: "CURRENCY_SEASONAL_COIN", amount: 400, transactionId: "T1", at: NOW };

const Iso = (ms: number) => new Date(ms).toISOString();
const ScheduleStamp = (week: number, windowStartMs = WINDOW.startMs) => Iso(WeeklyScheduleStampMs(windowStartMs, week));
const RollPlus = (minutes: number) => Iso(ROLL_MS + minutes * 60 * 1000);
const WeeklyId = (week: number, slot: number, name = `Test${slot}`) => `43_${week}_${slot}_Challenge_Season_${name}-season43-${week - 1}`;

function Chal(week: number, slot: number, options: { progress?: number; claimed?: boolean; stamp?: string; name?: string } = {}) {
    const { progress = 0, claimed = false, stamp = ScheduleStamp(week), name } = options;
    return {
        bounty_id: WeeklyId(week, slot, name), premium_bounty: false, slot_index: 0,
        objectives: [{ objective_id: `Obj${slot}`, progress }], drafted_timestamp: stamp, update_version: 0, claimed
    };
}

/** All 110 instances of the window that starts at `startMs`, unclaimed, on schedule. */
function Seed(startMs = WINDOW.startMs) {
    const List = [];
    for (let Week = 1; Week <= 11; Week++) {
        for (let Slot = 1; Slot <= 10; Slot++) List.push(Chal(Week, Slot, { stamp: Iso(WeeklyScheduleStampMs(startMs, Week)) }));
    }
    return List;
}

function HostApply(previous: BountyStateRecord | undefined, body: unknown, at = H_NOW) {
    return MergeHostBountyState(USER, previous, body, at);
}

function Find(record: BountyStateRecord, id: string) {
    return record.bounties.find((Entry) => Entry.bounty.bounty_id === id);
}

function SeededHost(at = H_NOW) {
    return HostApply(undefined, { bounties: Seed(), draft_data_weekly: DefaultDraftData() }, at).record;
}

test("the schedule hangs on the served pass window: week 1 is its start, week 11 is 70 days in", () => {
    assert.equal(Iso(WINDOW.startMs), "2026-07-30T17:00:00.000Z");
    assert.equal(Iso(WINDOW.endMs), "2026-10-22T17:00:00.000Z");
    assert.equal(ScheduleStamp(1), "2026-07-30T17:00:00.000Z");
    assert.equal(ScheduleStamp(5), "2026-08-27T17:00:00.000Z");
    assert.equal(ScheduleStamp(11), "2026-10-08T17:00:00.000Z");
});

test("every real weekly id parses; week, slot and the trailing index have to agree", () => {
    const Real = [
        "43_1_1_Challenge_Season_BountiesAny_15-season43-0",
        "43_2_10_Challenge_Season_Gather_Marks_Steel-season43-1",
        "43_5_5_Challenge_Season_BigHit_Axe-season43-4",
        "43_6_10_Challenge_Season_Rock_Alpha_Breaks_Armour-season43-5",
        "43_8_10_Challenge_Season_Crowbear_Alpha_Damage_Stagger_Penalty-season43-7",
        "43_10_5_Challenge_Season_Damage_ChainBlades_SingleFight_Penalty-season43-9",
        "43_11_6_Challenge_Season_KillBehemoth_Blaze_FrostWepx2-season43-10",
        "43_11_10_Challenge_Season_Trials_Break_All-season43-10",
    ];
    for (const Id of Real) assert.ok(ParseWeeklyBountyId(Id), Id);
    assert.deepEqual(ParseWeeklyBountyId("43_11_10_Challenge_Season_Trials_Break_All-season43-10"), { season: 43, week: 11, slot: 10 });
    assert.deepEqual(ParseWeeklyBountyId(WeeklyId(1, 1)), { season: 43, week: 1, slot: 1 });
});

test("ids that cannot be a real weekly instance do not parse", () => {
    const Bad = [
        "Challenge_Season_Fake",                                                // no schedule shape
        "Challenge_Season_X-season43-4",
        "26_11_7_Challenge_Season_BreakParts_Firesacs_Aether_Sally_Terra",      // the tuning template id: no -season suffix
        "43_5_5_Challenge_Season_BigHit_Axe-season43-5",                        // trailing index must be week-1
        "43_5_5_Challenge_Season_BigHit_Axe-season43-3",
        "43_12_1_Challenge_Season_X-season43-11",                               // week 12
        "43_0_1_Challenge_Season_X-season43-0",                                 // week 0
        "43_5_11_Challenge_Season_X-season43-4",                                // slot 11
        "43_5_0_Challenge_Season_X-season43-4",                                 // slot 0
        "043_05_5_Challenge_Season_X-season43-4",                               // leading zeros
        "43_5_5_Challenge_Season_X-season43-04",
        "43_5_5_Challenge_Season_Big-Hit-season43-4",                           // a hyphen inside the name
        "43_5_5_Challenge_Season_-season43-4",                                  // empty name
        "43_5_5_Challenge_Season_X-season43-4 ",                                // trailing space
        "43_5_5_Challenge_Season_X-season43-4\n",
        "x43_5_5_Challenge_Season_X-season43-4",
        "43_5_5_challenge_season_X-season43-4",
        "43_5_5_Challenge_Season_X-season-4",
        "43_5_5_Challenge_Season_Ünï-season43-4",
    ];
    for (const Id of Bad) assert.equal(ParseWeeklyBountyId(Id), undefined, JSON.stringify(Id));
});

test("a host may send the current window's schedule stamp, and the previous window's for two hours after a roll", () => {
    assert.deepEqual(AcceptedWeeklyStampsMs(1, H_NOW_MS), [WINDOW.startMs]);
    assert.deepEqual(AcceptedWeeklyStampsMs(11, H_NOW_MS), [WINDOW.startMs + 70 * DAY_MS]);
    // The last instant of the old window: the old schedule only (the next window does not exist yet).
    assert.deepEqual(AcceptedWeeklyStampsMs(3, ROLL_MS - 1), [WINDOW.startMs + 14 * DAY_MS]);
    // The roll itself: the new schedule first, the old one tolerated.
    assert.deepEqual(AcceptedWeeklyStampsMs(3, ROLL_MS), [ROLL_MS + 14 * DAY_MS, WINDOW.startMs + 14 * DAY_MS]);
    assert.deepEqual(AcceptedWeeklyStampsMs(3, ROLL_MS + WEEKLY_PREVIOUS_WINDOW_GRACE_MS - 1), [ROLL_MS + 14 * DAY_MS, WINDOW.startMs + 14 * DAY_MS]);
    assert.deepEqual(AcceptedWeeklyStampsMs(3, ROLL_MS + WEEKLY_PREVIOUS_WINDOW_GRACE_MS), [ROLL_MS + 14 * DAY_MS]);
    assert.equal(WEEKLY_PREVIOUS_WINDOW_GRACE_MS, 2 * HOUR_MS);
});

test("only a claimed weekly instance on an accepted stamp is protected from being dropped", () => {
    const Entry = (bounty: Record<string, any>, group: StoredBounty["group"] = "weekly"): StoredBounty => ({ group, bounty });
    assert.equal(IsProtectedClaimedWeekly(Entry(Chal(5, 5, { claimed: true })), H_NOW_MS), true);
    assert.equal(IsProtectedClaimedWeekly(Entry(Chal(5, 5, { claimed: false })), H_NOW_MS), false, "an unclaimed one may be dropped");
    assert.equal(IsProtectedClaimedWeekly(Entry(Chal(5, 5, { claimed: true, stamp: ScheduleStamp(5, PREVIOUS_START) })), H_NOW_MS), false, "no accepted stamp can bring an older window's instance back");
    assert.equal(IsProtectedClaimedWeekly(Entry(Chal(5, 5, { claimed: true })), ROLL_MS + HOUR_MS), true, "still tolerated one hour after the roll");
    assert.equal(IsProtectedClaimedWeekly(Entry(Chal(5, 5, { claimed: true })), ROLL_MS + 3 * HOUR_MS), false, "and not three");
    assert.equal(IsProtectedClaimedWeekly(Entry({ ...Chal(5, 5, { claimed: true }), bounty_id: "Challenge_Season_Legacy" }), H_NOW_MS), false);
    assert.equal(IsProtectedClaimedWeekly(Entry(Daily("Challenge_Daily_Bronze_X", H_NOW, 1, true), "daily"), H_NOW_MS), false);
});

test("a host's objective progress is clamped at 100 million; real values and the exact cap pass untouched", () => {
    assert.equal(MAX_HOST_OBJECTIVE_PROGRESS, 100000000);
    const Real = Chal(2, 1, { progress: 500752 });
    assert.equal(ClampHostObjectiveProgress(Real).bounty, Real, "the same object when nothing is clamped");
    assert.equal(ClampHostObjectiveProgress(Chal(2, 1, { progress: 100000000 })).clamped, 0);
    const Over = Chal(2, 1, { progress: 100000001 });
    const Clamped = ClampHostObjectiveProgress(Over);
    assert.equal(Clamped.clamped, 1);
    assert.equal(Clamped.bounty.objectives[0].progress, 100000000);
    assert.equal(Over.objectives[0].progress, 100000001, "the input is not modified");
    // The merge reads progress as Number(progress), so a numeric string or an infinity is clamped the same way.
    const Mixed = ClampHostObjectiveProgress({ bounty_id: "B", objectives: [{ objective_id: "A", progress: "5e9" }, { objective_id: "B", progress: Infinity }, { objective_id: "C", progress: 7 }, { objective_id: "D", progress: -1e12 }, { objective_id: "E" }, "junk"] });
    assert.equal(Mixed.clamped, 2);
    assert.deepEqual(Mixed.bounty.objectives, [
        { objective_id: "A", progress: 100000000 }, { objective_id: "B", progress: 100000000 }, { objective_id: "C", progress: 7 },
        { objective_id: "D", progress: -1e12 }, { objective_id: "E" }, "junk"
    ]);
    assert.equal(ClampHostObjectiveProgress({ bounty_id: "B" }).clamped, 0);
    assert.equal(ClampHostObjectiveProgress({ bounty_id: "B", objectives: {} }).clamped, 0);
});

test("a host's weekly seed on schedule is stored exactly like a dedicated server's, with nothing adjusted", () => {
    const Body = { bounties: Seed(), draft_data_weekly: DefaultDraftData() };
    const Host = HostApply(undefined, Body);
    const Dedicated = MergeBountyState(USER, undefined, Body, H_NOW);
    assert.equal(Host.record.bounties.length, 110);
    assert.deepEqual(Host.record, Dedicated.record);
    assert.equal(Host.summary.incoming, 110);
    assert.deepEqual(Host.summary.host, { keptClaimedWeekly: 0, ignoredWeekly: 0, clampedProgress: 0, keptClaimedWeeklyIds: [], ignoredWeeklyIds: [] });
    assert.equal(Dedicated.summary.host, undefined, "a dedicated save carries no host adjustments");

    // A claim on schedule is accepted, stamped and fundable once.
    const Claim = HostApply(Host.record, { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, "2026-10-13T18:05:00.000Z");
    assert.deepEqual(NewlyClaimedBountyIds(Claim.record), [WeeklyId(5, 5)]);
    assert.equal(FindFundableSeasonClaim(Claim.record)?.bounty.bounty_id, WeeklyId(5, 5));
    assert.equal(Claim.summary.host?.keptClaimedWeekly, 0);
});

test("a host cannot re-stamp a claimed weekly instance: it stays as stored, claimed and credited, and the attempt is counted", () => {
    const Id = WeeklyId(5, 5);
    let Record = HostApply(SeededHost(), { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, "2026-10-13T18:05:00.000Z").record;
    Record = WithRewardCredit(Record, Id, CREDIT);
    const Stamp5 = Date.parse(ScheduleStamp(5));
    const Attempts: unknown[] = [
        ScheduleStamp(4), ScheduleStamp(6),                    // another week's schedule stamp
        ScheduleStamp(5, PREVIOUS_START), ScheduleStamp(5, ROLL_MS),   // an older and a newer window's stamp for the same week
        H_NOW, Iso(Stamp5 + 1), Iso(Stamp5 - 1), Iso(Stamp5 + DAY_MS),
        "2099-01-01T00:00:00.000Z", "not a date", "", undefined, null, 1760000000000,
    ];
    for (const Stamp of Attempts) {
        const Result = HostApply(Record, { bounties: [{ ...Chal(5, 5, { progress: 0, claimed: false }), drafted_timestamp: Stamp }] }, "2026-10-13T18:10:00.000Z");
        const Stored = Find(Result.record, Id)!;
        const Label = String(Stamp);
        assert.equal(Stored.bounty.claimed, true, Label);
        assert.equal(Stored.bounty.drafted_timestamp, ScheduleStamp(5), Label);
        assert.equal(Stored.rewardCredit?.transactionId, "T1", Label);
        assert.equal(Stored.claimedAt, "2026-10-13T18:05:00.000Z", Label);
        assert.equal(Result.summary.host?.keptClaimedWeekly, 1, Label);
        assert.deepEqual(Result.summary.host?.keptClaimedWeeklyIds, [Id], Label);
        assert.equal(Result.summary.host?.ignoredWeekly, 0, Label);
        assert.equal(FindFundableSeasonClaim(Result.record), undefined, Label);
        assert.equal(Result.record.bounties.length, 110, Label);
        assert.equal(Result.record.updateVersion, Record.updateVersion + 1, "the save still applied");
    }
    // The dedicated merge is unchanged: a different stamp is a new instance, unclaimed and uncredited, claimable again.
    const Dedicated = MergeBountyState(USER, Record, { bounties: [Chal(5, 5, { stamp: ScheduleStamp(5, ROLL_MS) })] }, "2026-10-13T18:10:00.000Z").record;
    assert.equal(Find(Dedicated, Id)?.bounty.claimed, false);
    assert.equal(Find(Dedicated, Id)?.rewardCredit, undefined);
});

test("the rest of a save applies when one entry is refused", () => {
    const Id = WeeklyId(5, 5);
    const Record = HostApply(SeededHost(), { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, "2026-10-13T18:05:00.000Z").record;
    const Result = HostApply(Record, { bounties: [Chal(5, 5, { stamp: H_NOW }), Chal(5, 6, { progress: 9 }), Daily("Challenge_Daily_Bronze_X", H_NOW, 2)] }, "2026-10-13T18:10:00.000Z");
    assert.equal(Result.summary.host?.keptClaimedWeekly, 1);
    assert.equal(Find(Result.record, Id)?.bounty.claimed, true);
    assert.equal(Find(Result.record, WeeklyId(5, 6))?.bounty.objectives[0].progress, 9);
    assert.equal(Find(Result.record, "Challenge_Daily_Bronze_X")?.group, "daily");
});

test("an unclaimed weekly instance cannot be re-stamped either, but is counted as ignored, not as a kept claim", () => {
    const Id = WeeklyId(5, 5);
    const Record = HostApply(SeededHost(), { bounties: [Chal(5, 5, { progress: 2 })] }, "2026-10-13T18:05:00.000Z").record;
    const Result = HostApply(Record, { bounties: [Chal(5, 5, { stamp: ScheduleStamp(5, ROLL_MS), claimed: true, progress: 50 })] }, "2026-10-13T18:10:00.000Z");
    assert.equal(Result.summary.host?.ignoredWeekly, 1);
    assert.equal(Result.summary.host?.keptClaimedWeekly, 0);
    assert.deepEqual(Result.summary.host?.ignoredWeeklyIds, [Id]);
    assert.equal(Find(Result.record, Id)?.bounty.claimed, false);
    assert.equal(Find(Result.record, Id)?.bounty.objectives[0].progress, 2);
    assert.equal(Find(Result.record, Id)?.bounty.drafted_timestamp, ScheduleStamp(5));
});

test("a claimed weekly instance cannot be dropped by omission and re-added unclaimed; the dedicated merge still can", () => {
    const Id = WeeklyId(5, 5);
    const Weekly = DefaultDraftData();
    let Record = HostApply(SeededHost(), { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, "2026-10-13T18:05:00.000Z").record;
    Record = WithRewardCredit(Record, Id, CREDIT);

    // The host's whole-list save leaves the claimed instance out (and the other 108 unclaimed ones, which a replace may drop as before).
    const Omit = HostApply(Record, { bounties: [Chal(5, 6, { progress: 2 })], draft_data_weekly: Weekly }, "2026-10-13T18:10:00.000Z");
    assert.equal(Omit.summary.mode, "replace");
    assert.equal(Omit.summary.removed, 108);
    assert.equal(Omit.record.bounties.length, 2);
    assert.equal(Find(Omit.record, Id)?.bounty.claimed, true);
    assert.equal(Find(Omit.record, Id)?.rewardCredit?.transactionId, "T1");
    assert.equal(Omit.summary.host?.keptClaimedWeekly, 1);
    assert.deepEqual(Omit.summary.host?.keptClaimedWeeklyIds, [Id]);

    // A later save adds it back unclaimed: it is still the claimed, credited instance, so nothing is fundable.
    const Back = HostApply(Omit.record, { bounties: [Chal(5, 5, { progress: 0, claimed: false })] }, "2026-10-13T18:15:00.000Z");
    assert.equal(Find(Back.record, Id)?.bounty.claimed, true);
    assert.equal(Find(Back.record, Id)?.rewardCredit?.transactionId, "T1");
    assert.equal(FindFundableSeasonClaim(Back.record), undefined);
    assert.equal(Back.summary.host?.keptClaimedWeekly, 0);

    // The dedicated merge is unchanged: the instance is dropped, comes back unclaimed and its next claim funds a grant again.
    let Dedicated = MergeBountyState(USER, Record, { bounties: [Chal(5, 6, { progress: 2 })], draft_data_weekly: Weekly }, "2026-10-13T18:10:00.000Z").record;
    assert.equal(Find(Dedicated, Id), undefined);
    Dedicated = MergeBountyState(USER, Dedicated, { bounties: [Chal(5, 5)] }, "2026-10-13T18:11:00.000Z").record;
    Dedicated = MergeBountyState(USER, Dedicated, { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, "2026-10-13T18:12:00.000Z").record;
    assert.equal(FindFundableSeasonClaim(Dedicated)?.bounty.bounty_id, Id);
});

test("an ignored entry that a replace-mode host save names stays as stored, and `incoming` counts what was sent", () => {
    const Stored = SeededHost();
    const Result = HostApply(Stored, { bounties: [Chal(5, 5, { stamp: H_NOW, claimed: true }), Chal(5, 6, { progress: 4 })], draft_data_weekly: DefaultDraftData() });
    assert.equal(Result.summary.incoming, 2);
    assert.equal(Result.summary.removed, 108);
    assert.equal(Result.summary.host?.ignoredWeekly, 1);
    assert.equal(Find(Result.record, WeeklyId(5, 5))?.bounty.drafted_timestamp, ScheduleStamp(5), "the named but ignored instance stays as stored");
    assert.equal(Find(Result.record, WeeklyId(5, 5))?.bounty.claimed, false);
    assert.equal(Find(Result.record, WeeklyId(5, 6))?.bounty.objectives[0].progress, 4);
    assert.equal(Result.record.bounties.length, 2);
});

test("entries are judged in order inside one save, against what the earlier entries left", () => {
    const First = Chal(5, 5, { progress: 1, claimed: true });
    const Plan = PlanHostBountySave(undefined, [First, Chal(5, 5, { stamp: H_NOW }), Chal(5, 5, { stamp: ScheduleStamp(5, ROLL_MS) }), Chal(5, 5, { progress: 2, claimed: false })], H_NOW_MS);
    assert.equal(Plan.bounties.length, 2, "the first entry and the repeat on the same stamp");
    assert.equal(Plan.adjustments.keptClaimedWeekly, 2, "two re-stamps of an instance this very save claimed");
    assert.equal(Plan.adjustments.ignoredWeekly, 0);
    assert.equal(Plan.bounties[0], First);
});

test("the same instant written another way is the same instance, not a re-stamp", () => {
    const Id = WeeklyId(11, 1);
    const Record = HostApply(undefined, { bounties: [Chal(11, 1, { progress: 3, claimed: true })] }, "2026-10-13T18:05:00.000Z").record;
    assert.equal(Find(Record, Id)?.bounty.drafted_timestamp, "2026-10-08T17:00:00.000Z");
    for (const Notation of ["2026-10-08T17:00:00+00:00", "2026-10-08T18:00:00+01:00", "2026-10-08T17:00:00Z", "2026-10-08T17:00:00.000000Z"]) {
        const Result = HostApply(Record, { bounties: [{ ...Chal(11, 1, { progress: 0 }), drafted_timestamp: Notation }] }, "2026-10-13T18:10:00.000Z");
        const Entry = Find(Result.record, Id)!;
        assert.equal(Entry.bounty.drafted_timestamp, "2026-10-08T17:00:00.000Z", Notation);
        assert.equal(Entry.bounty.claimed, true, Notation);
        assert.equal(Entry.claimedAt, "2026-10-13T18:05:00.000Z", Notation);
        assert.equal(Result.summary.host?.keptClaimedWeekly, 0, Notation);
        assert.equal(Result.summary.host?.ignoredWeekly, 0, Notation);
    }
});

test("the window rolls: a claimed instance gets its new schedule stamp once, and a stale server's old stamp cannot bring the claim back", () => {
    const Id = WeeklyId(5, 5);
    const NewStamp = ScheduleStamp(5, ROLL_MS);
    // The old window (it ends at ROLL_MS): week 5 claimed and credited (a dedicated server saved it).
    let Record = MergeBountyState(USER, undefined, { bounties: [Chal(5, 5, { progress: 1, claimed: true })], draft_data_weekly: DefaultDraftData() }, "2026-08-28T00:00:00.000Z").record;
    Record = WithRewardCredit(Record, Id, CREDIT);

    // 30 minutes after the roll a server that still carries the old window sends the old instance: the same instance, accepted.
    const Stale = HostApply(Record, { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, RollPlus(30));
    assert.equal(Stale.summary.host?.keptClaimedWeekly, 0);
    assert.equal(Stale.summary.host?.ignoredWeekly, 0);
    assert.equal(Find(Stale.record, Id)?.rewardCredit?.transactionId, "T1");

    // A server started after the roll sends the new window's instance, unclaimed: a legitimate replacement, a new instance.
    const Fresh = HostApply(Record, { bounties: [Chal(5, 5, { stamp: NewStamp })] }, RollPlus(31));
    const FreshEntry = Find(Fresh.record, Id)!;
    assert.equal(FreshEntry.bounty.drafted_timestamp, NewStamp);
    assert.equal(FreshEntry.bounty.claimed, false);
    assert.equal(FreshEntry.rewardCredit, undefined);
    assert.equal(FreshEntry.claimedAt, undefined);
    assert.equal(Fresh.summary.host?.keptClaimedWeekly, 0);
    assert.equal(Fresh.summary.host?.ignoredWeekly, 0);

    // The stale server speaks again and claims the old instance: older than what is stored, so it is refused, not stored.
    const Replay = HostApply(Fresh.record, { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, RollPlus(32));
    assert.equal(Find(Replay.record, Id)?.bounty.drafted_timestamp, NewStamp);
    assert.equal(Find(Replay.record, Id)?.bounty.claimed, false);
    assert.equal(Replay.summary.host?.ignoredWeekly, 1);
    assert.equal(FindFundableSeasonClaim(Replay.record), undefined, "the previous window's claim cannot be funded a second time");

    // The new instance is claimed once; the old stamp then cannot replace it either.
    const Claim = HostApply(Fresh.record, { bounties: [Chal(5, 5, { progress: 1, claimed: true, stamp: NewStamp })] }, RollPlus(40));
    assert.deepEqual(NewlyClaimedBountyIds(Claim.record), [Id]);
    assert.equal(FindFundableSeasonClaim(Claim.record)?.bounty.bounty_id, Id);
    const Again = HostApply(Claim.record, { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, RollPlus(41));
    assert.equal(Again.summary.host?.keptClaimedWeekly, 1);
    assert.equal(Find(Again.record, Id)?.bounty.drafted_timestamp, NewStamp);
    assert.equal(Find(Again.record, Id)?.bounty.claimed, true);
});

test("the previous window's schedule is tolerated for two hours after the roll and not a minute longer", () => {
    const Id = WeeklyId(5, 5);
    const Record = MergeBountyState(USER, undefined, { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, "2026-08-28T00:00:00.000Z").record;
    const Old = { bounties: [Chal(5, 5, { progress: 2, claimed: true })] };
    const Inside = HostApply(Record, Old, RollPlus(119));
    assert.equal(Inside.summary.host?.keptClaimedWeekly, 0);
    assert.equal(Find(Inside.record, Id)?.bounty.objectives[0].progress, 2, "progress on the old instance is saved inside the grace");
    const Outside = HostApply(Record, Old, RollPlus(120));
    assert.equal(Outside.summary.host?.keptClaimedWeekly, 1);
    assert.equal(Find(Outside.record, Id)?.bounty.objectives[0].progress, 1, "and ignored after it");
    // The new window's stamp is accepted from the roll on and never before it.
    const NewStamp = ScheduleStamp(5, ROLL_MS);
    const Early = HostApply(Record, { bounties: [Chal(5, 5, { stamp: NewStamp })] }, Iso(ROLL_MS - 1));
    assert.equal(Early.summary.host?.keptClaimedWeekly, 1);
    assert.equal(Find(Early.record, Id)?.bounty.drafted_timestamp, ScheduleStamp(5));
    const OnTime = HostApply(Record, { bounties: [Chal(5, 5, { stamp: NewStamp })] }, RollPlus(0));
    assert.equal(OnTime.summary.host?.keptClaimedWeekly, 0);
    assert.equal(Find(OnTime.record, Id)?.bounty.drafted_timestamp, NewStamp);
});

test("invented weekly ids are not stored: bad shape, wrong week or index, off-schedule stamp", () => {
    const Valid = Chal(5, 5);
    const Bad = [
        { ...Valid, bounty_id: "Challenge_Season_Fake" },
        { ...Valid, bounty_id: "43_5_5_Challenge_Season_BigHit_Axe" },
        { ...Valid, bounty_id: "43_5_5_Challenge_Season_BigHit_Axe-season43-5" },
        { ...Valid, bounty_id: "43_12_1_Challenge_Season_X-season43-11", drafted_timestamp: ScheduleStamp(12) },
        { ...Valid, bounty_id: "43_5_11_Challenge_Season_X-season43-4" },
        { ...Valid, bounty_id: "43_5_5_Challenge_Season_Big-Hit-season43-4" },
        { ...Valid, bounty_id: "xx43_5_6_Challenge_Season_X-season43-4" },
        { ...Chal(5, 6), drafted_timestamp: H_NOW },                               // a real-looking id stamped "now"
        { ...Chal(5, 7), drafted_timestamp: ScheduleStamp(4) },                    // another week's stamp
        { ...Chal(5, 8), drafted_timestamp: undefined },
        { ...Chal(5, 9), drafted_timestamp: "2099-01-01T00:00:00.000Z" },
    ];
    for (const Entry of Bad) {
        const Result = HostApply(undefined, { bounties: [{ ...Entry, claimed: true }] });
        assert.equal(Result.record.bounties.length, 0, String(Entry.bounty_id));
        assert.equal(Result.summary.host?.ignoredWeekly, 1, String(Entry.bounty_id));
        assert.equal(FindFundableSeasonClaim(Result.record), undefined, String(Entry.bounty_id));
    }
    // All at once, with one good entry among them.
    const Many = HostApply(undefined, { bounties: [...Bad.map((Entry) => ({ ...Entry, claimed: true })), Valid] });
    assert.deepEqual(Many.record.bounties.map((Entry) => Entry.bounty.bounty_id), [WeeklyId(5, 5)]);
    assert.equal(Many.summary.host?.ignoredWeekly, Bad.length);
    assert.equal(Many.summary.host?.ignoredWeeklyIds.length, 10, "the sample of ignored ids is capped");
    // The dedicated merge is unchanged: it stores whatever the server sends.
    const Dedicated = MergeBountyState(USER, undefined, { bounties: [{ ...Bad[0], claimed: true }] }, H_NOW).record;
    assert.equal(FindFundableSeasonClaim(Dedicated)?.bounty.bounty_id, "Challenge_Season_Fake");
});

test("a bounty is filed by its id for a host, so no other id becomes a fundable weekly claim by riding under the weekly key", () => {
    const Daily1 = Daily("Challenge_Daily_Bronze_Fake", H_NOW, 1, true);
    const Base1 = { bounty_id: "Bounty_Bronze_Fake", premium_bounty: false, slot_index: 0, objectives: [], drafted_timestamp: H_NOW, update_version: 0, claimed: true };
    const Body = { bounties: [Daily1, Base1], draft_data_weekly: DefaultDraftData() };
    const Host = HostApply(undefined, Body).record;
    assert.deepEqual(Host.bounties.map((Entry) => Entry.group), ["daily", "base"]);
    // [2026-10-14] A claimed daily funds one reward per UTC day - as a DAILY (its own once-a-day rule), never as a weekly,
    // and the base bounty never funds anything.
    const Found = FindFundableSeasonClaim(Host, Date.parse(H_NOW));
    assert.equal(Found?.group, "daily");
    assert.equal(Found?.bounty.bounty_id, "Challenge_Daily_Bronze_Fake");
    assert.equal(FindFundableSeasonClaim({ ...Host, dailyRewardCreditedOn: GameDailyWindowKey(Date.parse(H_NOW)) }, Date.parse(H_NOW)), undefined,
        "with today's daily paid, nothing here is fundable");
    // The dedicated merge files them under the weekly key, as before.
    const Dedicated = MergeBountyState(USER, undefined, Body, H_NOW).record;
    assert.deepEqual(Dedicated.bounties.map((Entry) => Entry.group), ["weekly", "weekly"]);
});

test("a window holds 110 weekly instances: a host cannot make an account hold more", () => {
    const Full = SeededHost();
    assert.equal(Full.bounties.length, WEEKLY_INSTANCES_PER_WINDOW);
    const Invented = Chal(1, 1, { name: "Invented" });
    const Refused = HostApply(Full, { bounties: [{ ...Invented, claimed: true }] });
    assert.equal(Refused.record.bounties.length, 110);
    assert.equal(Refused.summary.host?.ignoredWeekly, 1);
    assert.equal(Find(Refused.record, Invented.bounty_id), undefined);
    // An instance that is stored is not new: it can still be updated while the window is full.
    const Update = HostApply(Full, { bounties: [Chal(1, 1, { progress: 5 })] });
    assert.equal(Update.summary.host?.ignoredWeekly, 0);
    assert.equal(Find(Update.record, WeeklyId(1, 1))?.bounty.objectives[0].progress, 5);
    // With one slot left a new id is accepted, and the next one is not.
    const Nearly = HostApply(undefined, { bounties: Seed().slice(0, 109) }).record;
    const Added = HostApply(Nearly, { bounties: [Invented] });
    assert.equal(Added.record.bounties.length, 110);
    assert.equal(Added.summary.host?.ignoredWeekly, 0);
    const Extra = HostApply(Added.record, { bounties: [Chal(2, 1, { name: "Invented2" })] });
    assert.equal(Extra.record.bounties.length, 110);
    assert.equal(Extra.summary.host?.ignoredWeekly, 1);
});

test("the cap is per window: a roll makes room for the new window's 110, and the grace stamps do not add an 111th to the old one", () => {
    const Old = SeededHost();                                   // the window that ends at ROLL_MS, full
    // 30 minutes after the roll the old schedule is still accepted - but the old window is full.
    const Invented = HostApply(Old, { bounties: [Chal(1, 1, { name: "Invented" })] }, RollPlus(30));
    assert.equal(Invented.summary.host?.ignoredWeekly, 1);
    assert.equal(Invented.record.bounties.length, 110);
    // The whole new schedule replaces the old instances one by one (110 stored, none kept).
    const Rolled = HostApply(Old, { bounties: Seed(ROLL_MS), draft_data_weekly: DefaultDraftData() }, RollPlus(31));
    assert.equal(Rolled.record.bounties.length, 110);
    assert.equal(Rolled.summary.host?.ignoredWeekly, 0);
    assert.equal(Rolled.summary.host?.keptClaimedWeekly, 0);
    assert.ok(Rolled.record.bounties.every((Entry) => Date.parse(Entry.bounty.drafted_timestamp) >= ROLL_MS));
    // The new window is now full too.
    const Extra = HostApply(Rolled.record, { bounties: [Chal(1, 1, { name: "Invented", stamp: ScheduleStamp(1, ROLL_MS) })] }, RollPlus(32));
    assert.equal(Extra.summary.host?.ignoredWeekly, 1);
    assert.equal(Extra.record.bounties.length, 110);
});

test("a host flooding new bounties cannot evict claimed weekly instances from the capped list; the dedicated merge still evicts the oldest claimed", () => {
    const Protected = Chal(5, 5, { progress: 1, claimed: true });      // stamped 2026-08-27, older than everything below
    const Entries: StoredBounty[] = [{ group: "weekly", bounty: Protected }];
    for (let Index = 0; Index < MAX_STORED_BOUNTIES - 1; Index++) {
        Entries.push({ group: "daily", bounty: Daily(`Challenge_Daily_Old_${Index}`, "2026-10-01T00:00:00.000Z", 1, true) });
    }
    const Stored: BountyStateRecord = { userId: USER, bounties: Entries, draftData: {}, updateVersion: 9, createdAt: H_NOW, updatedAt: H_NOW };
    const Flood = Array.from({ length: 5 }, (_, Index) => Daily(`Challenge_Daily_New_${Index}`, H_NOW));

    const Host = HostApply(Stored, { bounties: Flood }).record;
    assert.equal(Host.bounties.length, MAX_STORED_BOUNTIES);
    assert.ok(Find(Host, WeeklyId(5, 5)), "the claimed weekly instance stays");
    assert.ok(Flood.every((Added) => Find(Host, Added.bounty_id)));

    const Dedicated = MergeBountyState(USER, Stored, { bounties: Flood }, H_NOW).record;
    assert.equal(Dedicated.bounties.length, MAX_STORED_BOUNTIES);
    assert.equal(Find(Dedicated, WeeklyId(5, 5)), undefined, "the dedicated cap order is unchanged: the oldest claimed goes first");
});

test("a host's objective progress above 100 million is clamped and counted, in every group; the dedicated merge stores it as sent", () => {
    const Str = { bounty_id: "Bounty_Bronze_Str", drafted_timestamp: H_NOW, claimed: false, objectives: [{ objective_id: "A", progress: "5e9" }, { objective_id: "B", progress: 7 }] };
    const Inf = { bounty_id: "Bounty_Bronze_Inf", drafted_timestamp: H_NOW, claimed: false, objectives: [{ objective_id: "A", progress: Infinity }] };
    const Body = {
        bounties: [
            Chal(2, 1, { progress: 500752 }), Chal(2, 2, { progress: 100000000 }), Chal(2, 3, { progress: 100000001 }), Chal(2, 4, { progress: 1e12 }),
            Daily("Challenge_Daily_Bronze_Big", H_NOW, 9e15), Str, Inf
        ]
    };
    const Host = HostApply(undefined, Body);
    const Progress = (id: string) => Find(Host.record, id)!.bounty.objectives.map((Objective: any) => Objective.progress);
    assert.deepEqual(Progress(WeeklyId(2, 1)), [500752]);
    assert.deepEqual(Progress(WeeklyId(2, 2)), [100000000]);
    assert.deepEqual(Progress(WeeklyId(2, 3)), [100000000]);
    assert.deepEqual(Progress(WeeklyId(2, 4)), [100000000]);
    assert.deepEqual(Progress("Challenge_Daily_Bronze_Big"), [100000000]);
    assert.deepEqual(Progress("Bounty_Bronze_Str"), [100000000, 7]);
    assert.deepEqual(Progress("Bounty_Bronze_Inf"), [100000000]);
    assert.equal(Host.summary.host?.clampedProgress, 5);
    assert.equal(Host.record.bounties.length, 7, "clamped entries are kept, not refused");
    // The clamp is stable under the monotonic merge: sending it again changes nothing and counts again.
    const Again = HostApply(Host.record, Body);
    assert.deepEqual(Find(Again.record, WeeklyId(2, 4))!.bounty.objectives[0].progress, 100000000);
    assert.equal(Again.summary.host?.clampedProgress, 5);
    // The dedicated merge keeps what it was given.
    const Dedicated = MergeBountyState(USER, undefined, Body, H_NOW).record;
    assert.equal(Find(Dedicated, WeeklyId(2, 4))!.bounty.objectives[0].progress, 1e12);
});

test("daily and base bounties merge for a host exactly as for a dedicated server", () => {
    const Draft = { ...DefaultDraftData(), previous_draft_selections: ["Challenge_Daily_Bronze_KillBlazeWeapon"] };
    const First = { bounties: [Daily("Challenge_Daily_Bronze_KillBlazeWeapon", "2026-10-13T05:28:08.000Z", 1, true)], draft_data_daily: Draft };
    const Second = { bounties: [Daily("Challenge_Daily_Bronze_WoundDamageReduce", "2026-10-14T05:28:08.000Z")], draft_data_daily: Draft };
    const Third = { bounties: [Daily("Challenge_Daily_Bronze_WoundDamageReduce", "2099-01-01T00:00:00.000Z", 3)] };
    let Host: BountyStateRecord | undefined;
    let Dedicated: BountyStateRecord | undefined;
    for (const Body of [First, Second, Third]) {
        Host = HostApply(Host, Body).record;
        Dedicated = MergeBountyState(USER, Dedicated, Body, H_NOW).record;
        assert.deepEqual(Host, Dedicated);
    }
});

test("the host-write tag carries the counts of what the limits changed, and capped samples of the ids", () => {
    const Id = WeeklyId(5, 5);
    const Record = HostApply(SeededHost(), { bounties: [Chal(5, 5, { progress: 1, claimed: true })] }, "2026-10-13T18:05:00.000Z").record;
    const Result = HostApply(Record, {
        bounties: [Chal(5, 5, { stamp: H_NOW }), { ...Chal(5, 6), bounty_id: "Challenge_Season_Fake" }, Chal(5, 7, { progress: 1e9 })]
    }, "2026-10-13T18:10:00.000Z");
    assert.deepEqual(HostBountyWriteSummary(Result.summary, Result.record), {
        mode: "upsert", incoming: 3, removed: 0, newlyClaimedCount: 0, newlyClaimed: [],
        keptClaimedWeekly: 1, ignoredWeekly: 1, clampedProgress: 1,
        keptClaimedWeeklyIds: [Id], ignoredWeeklyIds: ["Challenge_Season_Fake"],
        version: Record.updateVersion + 1,
    });
    // Nothing adjusted: the counts are there (zero), the id lists are not.
    const Quiet = HostApply(Record, { bounties: [Chal(5, 6, { progress: 2 })] }, "2026-10-13T18:11:00.000Z");
    assert.deepEqual(HostBountyWriteSummary(Quiet.summary, Quiet.record), {
        mode: "upsert", incoming: 1, removed: 0, newlyClaimedCount: 0, newlyClaimed: [],
        keptClaimedWeekly: 0, ignoredWeekly: 0, clampedProgress: 0, version: Record.updateVersion + 1,
    });
});

test("a malformed host save is rejected like a dedicated one, before anything is planned", () => {
    assert.throws(() => HostApply(undefined, null), BountySaveValidationError);
    assert.throws(() => HostApply(undefined, { bounties: {} }), BountySaveValidationError);
    assert.throws(() => HostApply(undefined, { bounties: [{ objectives: [] }] }), BountySaveValidationError);
    assert.throws(() => HostApply(undefined, { bounties: [], draft_data_daily: [] }), BountySaveValidationError);
    assert.throws(() => HostApply(undefined, { bounties: new Array(513).fill({ bounty_id: "X" }) }), BountySaveValidationError);
});
