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
    BountyGroupCounts,
    BountySaveValidationError,
    BountyStatePayload,
    DefaultDraftData,
    FindFundableSeasonClaim,
    InferBountyGroup,
    IsAuthorizedBountyReader,
    IsAuthorizedBountyWriter,
    MAX_STORED_BOUNTIES,
    MergeBountyState,
    WithRewardCredit
} from "./bountyState";
import { IsChallengeRewardGrant } from "./controllers/challengeRewards";
import { BountyStateRecord } from "./persistence/mapping/domainTypes";

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

test("daily bounties never fund a challenge reward", () => {
    const Record = ApplyAt(undefined, {
        bounties: [Daily("Challenge_Daily_Bronze_KillBlazeFrost", NOW, 1, true)],
        draft_data_daily: DefaultDraftData()
    }, NOW);
    assert.equal(FindFundableSeasonClaim(Record), undefined);
});

test("only Cache Coin grants of a bounded size count as challenge rewards", () => {
    assert.equal(IsChallengeRewardGrant("CURRENCY_SEASONAL_COIN", 400), true);
    assert.equal(IsChallengeRewardGrant("CURRENCY_SEASONAL_COIN", 1001), false);
    assert.equal(IsChallengeRewardGrant("CURRENCY_SEASONAL_COIN", 0), false);
    assert.equal(IsChallengeRewardGrant("CURRENCY_NOTES", 400), false);
});
