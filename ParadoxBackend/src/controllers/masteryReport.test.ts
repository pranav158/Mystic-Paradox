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
    ApplyMasteryReport,
    ApplyMasteryReportWithPlan,
    BuildMasteryObjectiveCheck,
    DescribeMasteryLimits,
    HOST_MASTERY_MAX_COMPLETED_COUNT,
    HOST_MASTERY_MAX_NEWLY_COMPLETED,
    HOST_MASTERY_MAX_VALUE,
    HostMasteryLimits,
    HostObjectiveIdRefusal,
    IsMasteryObjectiveIdShape,
    MasteryCardTrackFor,
    MasteryHostLimits,
    PlanMasteryReport,
    StoredObjectiveState,
    SummarizeMasteryPlan
} from "./masteryReport";

const Stored = (Rows: [string, number, number][]) =>
    new Map<string, StoredObjectiveState>(Rows.map(([Id, Value, Count]) => [Id, { value: Value, completedCount: Count }]));

test("objective ids map to their mastery card track", () => {
    assert.equal(MasteryCardTrackFor("MasteryObjective_Behemoth_Embermane_Kill"), "MasteryTrack_Behemoth");
    assert.equal(MasteryCardTrackFor("MasteryObjective_Weapon_Axe_Embermane_Craft"), "MasteryTrack_Weapon_Axe");
    assert.equal(MasteryCardTrackFor("MasteryObjective_Weapon_Pike_Generic_Kills1"), "MasteryTrack_Weapon_Spear");
    assert.equal(MasteryCardTrackFor("MasteryObjective_Weapon_DP_Generic_Kills1"), "MasteryTrack_Weapon_Repeaters");
    assert.equal(MasteryCardTrackFor("MasteryObjective_Weapon_CB_Generic_Kills1"), "MasteryTrack_Weapon_ChainBlades");   // CB = chain blades
    assert.equal(MasteryCardTrackFor("MasteryObjective_Weapon_Hammer_Charrogg_PrestigeXP"), "MasteryTrack_Weapon_Hammer");
    assert.equal(MasteryCardTrackFor("MasteryObjective_Weapon_Zzz_Generic_Kills1"), null);
    assert.equal(MasteryCardTrackFor("AchievementObjective_Crafter_Craft"), undefined);
});

test("a newly completed kill objective credits the player and its card track once", () => {
    // Live kill report, 10 Oct 18:29Z: PlayerLevel +1, Behemoth +1 with Embermane_Kill 1/1.
    const Body = {
        progress_tracks: [{ progression_id: "MasteryTrack_PlayerLevel", progress: 1 }, { progression_id: "MasteryTrack_Behemoth", progress: 1 }],
        objectives: [{ objective_id: "MasteryObjective_Behemoth_Embermane_Kill", value: 1, completed_count: 1 },
            { objective_id: "AchievementObjective_Slayer_Kills", value: 40, completed_count: 0 }],
    };
    const First = PlanMasteryReport(Body, Stored([]));
    assert.deepEqual(First.newlyCompleted, ["MasteryObjective_Behemoth_Embermane_Kill"]);
    assert.deepEqual(First.credits, { MasteryTrack_PlayerLevel: 1, MasteryTrack_Behemoth: 1 });

    // The same report again (a retry, or the next arrival) finds the objective stored as completed: nothing is credited.
    const Again = PlanMasteryReport(Body, Stored([["MasteryObjective_Behemoth_Embermane_Kill", 1, 1]]));
    assert.deepEqual(Again.newlyCompleted, []);
    assert.deepEqual(Again.credits, {});
});

test("the arrival re-send of already stored craft objectives credits nothing", () => {
    const Ids = ["MasteryObjective_Behemoth_Gnasher_Craft_Armor", "MasteryObjective_Weapon_Axe_Embermane_Craft"];
    const Body = {
        progress_tracks: [{ progression_id: "MasteryTrack_PlayerLevel", progress: 9 }, { progression_id: "MasteryTrack_Weapon_Axe", progress: 6 }],
        objectives: Ids.map((Id) => ({ objective_id: Id, value: 1, completed_count: 1 })),
    };
    const Plan = PlanMasteryReport(Body, Stored(Ids.map((Id) => [Id, 1, 1] as [string, number, number])));
    assert.deepEqual(Plan.credits, {});
    assert.equal(Plan.objectives.length, 2);
});

test("credit is capped at the report's own claim, and an unknown weapon code credits the player track only", () => {
    const Body = {
        progress_tracks: [{ progression_id: "MasteryTrack_PlayerLevel", progress: 1 }],
        objectives: [{ objective_id: "MasteryObjective_Weapon_Axe_A_Kill", value: 1, completed_count: 1 },
            { objective_id: "MasteryObjective_Weapon_Zzz_B_Kill", value: 1, completed_count: 1 }],
    };
    const Plan = PlanMasteryReport(Body, Stored([]));
    assert.deepEqual(Plan.credits, { MasteryTrack_PlayerLevel: 1 });                 // 2 earned, 1 claimed; Axe never claimed
    assert.deepEqual(Plan.unmapped, ["MasteryObjective_Weapon_Zzz_B_Kill"]);
    assert.ok(Plan.capped.some((Line) => Line.startsWith("MasteryTrack_PlayerLevel 2->1")));
    assert.ok(Plan.capped.some((Line) => Line.startsWith("MasteryTrack_Weapon_Axe 1->0")));
});

test("duplicate objective ids merge to their maximum, and the response never goes below what was stored or reported", () => {
    const Body = {
        progress_tracks: [],
        objectives: [{ objective_id: "MasteryObjective_Behemoth_Embermane_Boop", value: 3, completed_count: 0 },
            { objective_id: "MasteryObjective_Behemoth_Embermane_Boop", value: 5, completed_count: 0 }],
    };
    const Plan = PlanMasteryReport(Body, Stored([["MasteryObjective_Behemoth_Embermane_Boop", 7, 0]]));
    assert.deepEqual(Plan.objectives, [{ objectiveId: "MasteryObjective_Behemoth_Embermane_Boop", value: 5, completedCount: 0 }]);
    assert.deepEqual(Plan.merged.get("MasteryObjective_Behemoth_Embermane_Boop"), { value: 7, completedCount: 0 });
    assert.deepEqual(Plan.credits, {});
});

// [2026-10-13 realms S3] A player-hosted server's mastery report is applied by the same code and its plan is the tag.

function FakeUnitOfWork(StoredObjectives: { objectiveId: string; value: number; completedCount: number }[] = [], StartingTotals: Record<string, number> = {}) {
    const Merged: any[] = [];
    const Increments: [string, number][] = [];
    const Reads: string[] = [];
    const Totals = new Map<string, number>(Object.entries(StartingTotals));
    const Repos: any = {
        progressionTracks: {
            getObjectives: async () => StoredObjectives,
            mergeObjectives: async (_UserId: string, Rows: any[]) => { Merged.push(...Rows); },
            increment: async (_UserId: string, Track: string, Amount: number) => {
                Increments.push([Track, Amount]);
                Totals.set(Track, (Totals.get(Track) ?? 0) + Amount);
                return { progress: Totals.get(Track), updatedAt: "2026-10-13T00:00:00.000Z" };
            },
            get: async (_UserId: string, Track: string) => { Reads.push(Track); return Totals.has(Track) ? { progress: Totals.get(Track) } : undefined; },
        },
    };
    return { UnitOfWork: { withTransaction: async (Action: any) => Action(Repos, {}) } as any, Merged, Increments, Reads, Totals };
}

const KillReport = {
    progress_tracks: [{ progression_id: "MasteryTrack_PlayerLevel", progress: 1 }, { progression_id: "MasteryTrack_Behemoth", progress: 1 }],
    objectives: [{ objective_id: "MasteryObjective_Behemoth_Embermane_Kill", value: 1, completed_count: 1 },
        { objective_id: "AchievementObjective_Slayer_Kills", value: 40, completed_count: 0 }],
};

test("the plan version of the apply returns the same payload as before, plus what it did", async () => {
    const Plain = FakeUnitOfWork();
    const Payload = await ApplyMasteryReport("user-1", KillReport, Plain.UnitOfWork);
    const WithPlan = FakeUnitOfWork();
    const Applied = await ApplyMasteryReportWithPlan("user-1", KillReport, WithPlan.UnitOfWork);

    assert.deepEqual(Object.keys(Payload).sort(), ["objectives", "progress_tracks"]);
    assert.deepEqual(Object.keys(Applied.payload).sort(), ["objectives", "progress_tracks"]);
    const Strip = (Rows: any[]) => Rows.map(({ created_date, last_modified_date, ...Rest }) => Rest);   // the two dates are "now"
    assert.deepEqual(Strip(Applied.payload.objectives), Strip(Payload.objectives));
    assert.deepEqual(Applied.payload.progress_tracks, Payload.progress_tracks);
    assert.deepEqual(Applied.plan.newlyCompleted, ["MasteryObjective_Behemoth_Embermane_Kill"]);
    assert.deepEqual(WithPlan.Increments, Plain.Increments);
    assert.deepEqual(WithPlan.Increments.sort(), [["MasteryTrack_Behemoth", 1], ["MasteryTrack_PlayerLevel", 1]]);
});

test("the tag of a mastery report lists what it completed and credited", async () => {
    const Applied = await ApplyMasteryReportWithPlan("user-1", KillReport, FakeUnitOfWork().UnitOfWork);
    assert.deepEqual(SummarizeMasteryPlan(Applied.plan), {
        objectives: 2,
        newlyCompleted: ["MasteryObjective_Behemoth_Embermane_Kill"],
        newlyCompletedCount: 1,
        credits: { MasteryTrack_PlayerLevel: 1, MasteryTrack_Behemoth: 1 },
        claimed: { MasteryTrack_PlayerLevel: 1, MasteryTrack_Behemoth: 1 },
    });
});

test("a re-sent report credits nothing and its tag says so; mastery never goes below what was stored", async () => {
    const Done = [{ objectiveId: "MasteryObjective_Behemoth_Embermane_Kill", value: 6, completedCount: 2 }];
    const Fake = FakeUnitOfWork(Done);
    const Applied = await ApplyMasteryReportWithPlan("user-1", KillReport, Fake.UnitOfWork);
    assert.deepEqual(Fake.Increments, []);
    const Summary: any = SummarizeMasteryPlan(Applied.plan);
    assert.deepEqual([Summary.newlyCompleted, Summary.newlyCompletedCount, Summary.credits], [[], 0, {}]);
    const Kill = Applied.payload.objectives.find((Row: any) => Row.objective_id === "MasteryObjective_Behemoth_Embermane_Kill");
    assert.deepEqual([Kill.progress, Kill.completed_count], [6, 2]);          // the stored (higher) values, not the report's 1/1
});

test("a tag keeps the capped and unmapped notes and at most 20 completed ids", () => {
    const Many = Array.from({ length: 30 }, (_, Index) => `MasteryObjective_Weapon_Zzz_Kill${Index}`);
    const Plan = PlanMasteryReport({
        progress_tracks: [{ progression_id: "MasteryTrack_PlayerLevel", progress: 3 }],
        objectives: Many.map((Id) => ({ objective_id: Id, value: 1, completed_count: 1 })),
    }, new Map());
    const Summary: any = SummarizeMasteryPlan(Plan);
    assert.equal(Summary.newlyCompleted.length, 20);
    assert.equal(Summary.newlyCompletedCount, 30);
    assert.equal(Summary.objectives, 30);
    assert.deepEqual(Summary.credits, { MasteryTrack_PlayerLevel: 3 });         // 30 earned, 3 claimed
    assert.equal(Summary.unmapped.length, 20);
    assert.ok(Summary.capped[0].startsWith("MasteryTrack_PlayerLevel 30->3"));
    assert.ok(JSON.stringify(Summary).length < 4000);
});

// ---- [2026-10-13 realms S3 limits] a player-hosted server's report -------------------------------------------------------------

const Everything = (_Id: string) => true;
const Weapon = (Code: string, Index: number) => `MasteryObjective_Weapon_${Code}_Generic_Kills${Index}`;
const Done = (Id: string, Value = 1, Count = 1) => ({ objective_id: Id, value: Value, completed_count: Count });
const Claim = (Track: string, Progress: number) => ({ progression_id: Track, progress: Progress });

// Limits with every id accepted and no track caps unless a test adds them; none of these tests reads game data.
const Limits = (Overrides: Partial<MasteryHostLimits> = {}) => HostMasteryLimits({ isKnownObjective: Everything, trackCap: () => undefined, ...Overrides });

test("the host limits are the researched ones", () => {
    assert.equal(HOST_MASTERY_MAX_NEWLY_COMPLETED, 64);
    assert.equal(HOST_MASTERY_MAX_COMPLETED_COUNT, 10);
    assert.equal(HOST_MASTERY_MAX_VALUE, 100_000_000);
    const Defaults = Limits();
    assert.deepEqual([Defaults.maxNewlyCompleted, Defaults.maxCompletedCount, Defaults.maxValue], [64, 10, 100_000_000]);
});

test("without limits a report is planned exactly as before: unknown ids, huge values and 100 completions all pass", () => {
    const Many = Array.from({ length: 100 }, (_, Index) => Weapon("Axe", Index));
    const Body = {
        progress_tracks: [Claim("MasteryTrack_PlayerLevel", 101), Claim("MasteryTrack_Weapon_Axe", 101)],
        objectives: [...Many.map((Id) => Done(Id)), Done("Anything_Goes", 5e8, 99), Done("MasteryObjective_Weapon_Axe_Big_Damage", 5e8, 99)],
    };
    const Plan = PlanMasteryReport(Body, new Map());
    assert.equal(Plan.newlyCompleted.length, 101);                                      // the 100 plus the big one; Anything_Goes is no mastery id
    assert.deepEqual(Plan.credits, { MasteryTrack_PlayerLevel: 101, MasteryTrack_Weapon_Axe: 101 });
    assert.deepEqual(Plan.merged.get("Anything_Goes"), { value: 5e8, completedCount: 99 });
    assert.deepEqual([Plan.ignored, Plan.overLimit, Plan.clamped, Plan.atCap], [[], [], [], []]);
    const Summary: any = SummarizeMasteryPlan(Plan);
    for (const Key of ["ignored", "ignoredCount", "overLimit", "overLimitCount", "clamped", "atCap"]) assert.equal(Key in Summary, false, Key);
    assert.equal(DescribeMasteryLimits(Plan), undefined);
});

test("a host's report credits and stores real objectives like a dedicated server's", () => {
    const Body = {
        progress_tracks: [Claim("MasteryTrack_PlayerLevel", 1), Claim("MasteryTrack_Behemoth", 1)],
        objectives: [Done("MasteryObjective_Behemoth_Embermane_Kill"), Done("AchievementObjective_Slayer_Kills", 40, 0)],
    };
    const Host = PlanMasteryReport(Body, new Map(), Limits());
    const Dedicated = PlanMasteryReport(Body, new Map());
    assert.deepEqual(Host.credits, { MasteryTrack_PlayerLevel: 1, MasteryTrack_Behemoth: 1 });
    assert.deepEqual(Host.credits, Dedicated.credits);
    assert.deepEqual(Host.objectives, Dedicated.objectives);
    assert.deepEqual([...Host.merged], [...Dedicated.merged]);
    assert.equal(DescribeMasteryLimits(Host), undefined);
});

test("a host's objective with an id the check does not know is neither stored nor credited, and is counted", () => {
    const Real = "MasteryObjective_Behemoth_Embermane_Kill";
    const Body = {
        progress_tracks: [Claim("MasteryTrack_PlayerLevel", 5), Claim("MasteryTrack_Behemoth", 5)],
        objectives: [Done(Real), Done("MasteryObjective_Behemoth_Invented_Kill"), Done("MasteryObjective_Behemoth_Invented_Kill"),
            Done("AchievementObjective_Invented_Thing", 3, 1), Done("Objective_1"), Done("QuestObjective_X"), Done("AchievementObjective_Real", 2, 0)],
    };
    const Plan = PlanMasteryReport(Body, new Map(), Limits({ isKnownObjective: (Id) => Id === Real || Id === "AchievementObjective_Real" }));
    assert.deepEqual(Plan.newlyCompleted, [Real]);
    assert.deepEqual(Plan.credits, { MasteryTrack_PlayerLevel: 1, MasteryTrack_Behemoth: 1 });
    assert.deepEqual(Plan.objectives.map((Row) => Row.objectiveId), [Real, "AchievementObjective_Real"]);
    assert.deepEqual([...Plan.merged.keys()], [Real, "AchievementObjective_Real"]);
    assert.deepEqual(Plan.ignored, [
        { objectiveId: "MasteryObjective_Behemoth_Invented_Kill", reason: "unknown_mastery_id" },     // twice in the report, listed once
        { objectiveId: "AchievementObjective_Invented_Thing", reason: "unknown_achievement_id" },
        { objectiveId: "Objective_1", reason: "unrecognised_id_family" },
        { objectiveId: "QuestObjective_X", reason: "unrecognised_id_family" },
    ]);
    const Summary: any = SummarizeMasteryPlan(Plan);
    assert.equal(Summary.ignoredCount, 4);
    assert.ok(Summary.ignored.includes("MasteryObjective_Behemoth_Invented_Kill:unknown_mastery_id"));
    assert.match(DescribeMasteryLimits(Plan) ?? "", /^ignored=4\[/);
});

test("at most 64 new completions are applied per host report; the rest are not stored, so a later report can still credit them", () => {
    const Ids = Array.from({ length: 70 }, (_, Index) => Weapon("Axe", Index));
    const Body = { progress_tracks: [Claim("MasteryTrack_PlayerLevel", 70), Claim("MasteryTrack_Weapon_Axe", 70)], objectives: Ids.map((Id) => Done(Id)) };

    const First = PlanMasteryReport(Body, new Map(), Limits());
    assert.deepEqual(First.newlyCompleted, Ids.slice(0, 64));
    assert.deepEqual(First.overLimit, Ids.slice(64));
    assert.deepEqual(First.credits, { MasteryTrack_PlayerLevel: 64, MasteryTrack_Weapon_Axe: 64 });
    assert.equal(First.objectives.length, 64);
    assert.equal(First.merged.size, 64);
    assert.equal((SummarizeMasteryPlan(First) as any).overLimit.length, 6);
    assert.equal((SummarizeMasteryPlan(First) as any).overLimitCount, 6);

    // The same report once the first 64 are stored: the remaining six are now the new completions and are credited.
    const Stored = new Map<string, StoredObjectiveState>(Ids.slice(0, 64).map((Id) => [Id, { value: 1, completedCount: 1 }]));
    const Second = PlanMasteryReport(Body, Stored, Limits());
    assert.deepEqual(Second.newlyCompleted, Ids.slice(64));
    assert.deepEqual(Second.overLimit, []);
    assert.deepEqual(Second.credits, { MasteryTrack_PlayerLevel: 6, MasteryTrack_Weapon_Axe: 6 });

    // A report that only repeats already completed objectives, or only moves progress, counts nothing toward the limit.
    const Repeats = PlanMasteryReport({ progress_tracks: [], objectives: [...Ids.slice(0, 64).map((Id) => Done(Id)), Done(Weapon("Axe", 99), 5, 0)] }, Stored, Limits());
    assert.deepEqual([Repeats.newlyCompleted, Repeats.overLimit], [[], []]);
    assert.equal(Repeats.objectives.length, 65);

    // Exactly 64 completions are all applied.
    const Exact = PlanMasteryReport({ progress_tracks: [], objectives: Ids.slice(0, 64).map((Id) => Done(Id)) }, new Map(), Limits());
    assert.equal(Exact.newlyCompleted.length, 64);
    assert.deepEqual(Exact.overLimit, []);
});

test("an ignored over-limit objective leaves the stored state in the response", () => {
    const Ids = Array.from({ length: 3 }, (_, Index) => Weapon("Sword", Index));
    const Stored = new Map<string, StoredObjectiveState>([[Ids[2], { value: 4, completedCount: 0 }]]);
    const Plan = PlanMasteryReport({ progress_tracks: [], objectives: Ids.map((Id) => Done(Id, 9, 1)) }, Stored, Limits({ maxNewlyCompleted: 2 }));
    assert.deepEqual(Plan.newlyCompleted, Ids.slice(0, 2));
    assert.deepEqual(Plan.overLimit, [Ids[2]]);
    assert.deepEqual(Plan.merged.get(Ids[2]), { value: 4, completedCount: 0 });             // not the reported 9/1
    assert.equal(Plan.objectives.some((Row) => Row.objectiveId === Ids[2]), false);        // and not written
});

test("a host's completed_count and value are clamped, not dropped: the completion still counts and nothing above the limit is stored", () => {
    const Id = "MasteryObjective_Weapon_Hammer_Generic_Damage8";
    const Body = {
        progress_tracks: [Claim("MasteryTrack_PlayerLevel", 1), Claim("MasteryTrack_Weapon_Hammer", 1)],
        objectives: [Done(Id, 5e8, 99), Done("AchievementObjective_Real", 1_186_502, 2)],
    };
    const Plan = PlanMasteryReport(Body, new Map(), Limits());
    assert.deepEqual(Plan.merged.get(Id), { value: 100_000_000, completedCount: 10 });
    assert.deepEqual(Plan.objectives.find((Row) => Row.objectiveId === Id), { objectiveId: Id, value: 100_000_000, completedCount: 10 });
    assert.deepEqual(Plan.credits, { MasteryTrack_PlayerLevel: 1, MasteryTrack_Weapon_Hammer: 1 });
    assert.deepEqual(Plan.clamped, [`${Id} value 500000000->100000000`, `${Id} count 99->10`]);
    assert.deepEqual(Plan.merged.get("AchievementObjective_Real"), { value: 1_186_502, completedCount: 2 });   // the largest real row is untouched
    assert.deepEqual((SummarizeMasteryPlan(Plan) as any).clamped, Plan.clamped);

    const AtLimit = PlanMasteryReport({ progress_tracks: [], objectives: [Done(Id, 100_000_000, 10)] }, new Map(), Limits());
    assert.deepEqual(AtLimit.clamped, []);
    // Duplicates of one id merge to their maximum after the clamp, so a clamped copy cannot exceed the limit either.
    const Twice = PlanMasteryReport({ progress_tracks: [], objectives: [Done(Id, 5e8, 1), Done(Id, 7e8, 50)] }, new Map(), Limits());
    assert.deepEqual(Twice.merged.get(Id), { value: 100_000_000, completedCount: 10 });
});

test("a host's credit stops at the track's total; without a stored total or a cap nothing is cut", () => {
    const Ids = [Weapon("Axe", 1), Weapon("Axe", 2), Weapon("Axe", 3)];
    const Body = { progress_tracks: [Claim("MasteryTrack_PlayerLevel", 3), Claim("MasteryTrack_Weapon_Axe", 3)], objectives: Ids.map((Id) => Done(Id)) };
    const Caps: Record<string, number> = { MasteryTrack_PlayerLevel: 1111, MasteryTrack_Weapon_Axe: 115 };
    const TrackCap = (Track: string) => Caps[Track];

    const Near = PlanMasteryReport(Body, new Map(), Limits({ trackCap: TrackCap, trackTotals: new Map([["MasteryTrack_PlayerLevel", 20], ["MasteryTrack_Weapon_Axe", 114]]) }));
    assert.deepEqual(Near.credits, { MasteryTrack_PlayerLevel: 3, MasteryTrack_Weapon_Axe: 1 });
    assert.deepEqual(Near.atCap, ["MasteryTrack_Weapon_Axe 3->1 (total 114, cap 115)"]);
    assert.deepEqual((SummarizeMasteryPlan(Near) as any).atCap, Near.atCap);

    const Full = PlanMasteryReport(Body, new Map(), Limits({ trackCap: TrackCap, trackTotals: new Map([["MasteryTrack_PlayerLevel", 1111], ["MasteryTrack_Weapon_Axe", 400]]) }));
    assert.deepEqual(Full.credits, {});                                                      // a total above the cap leaves no room, never a negative credit
    assert.equal(Full.atCap.length, 2);

    const NoTotals = PlanMasteryReport(Body, new Map(), Limits({ trackCap: TrackCap }));
    assert.deepEqual(NoTotals.credits, { MasteryTrack_PlayerLevel: 3, MasteryTrack_Weapon_Axe: 3 });
    const NoCap = PlanMasteryReport(Body, new Map(), Limits({ trackTotals: new Map([["MasteryTrack_Weapon_Axe", 114]]) }));
    assert.deepEqual(NoCap.credits, { MasteryTrack_PlayerLevel: 3, MasteryTrack_Weapon_Axe: 3 });
    assert.deepEqual(NoCap.atCap, []);
});

test("the claim still bounds a host's credit, and the cap is applied after it", () => {
    const Body = { progress_tracks: [Claim("MasteryTrack_Weapon_Axe", 1)], objectives: [Done(Weapon("Axe", 1)), Done(Weapon("Axe", 2))] };
    const Plan = PlanMasteryReport(Body, new Map(), Limits({ trackCap: () => 115, trackTotals: new Map([["MasteryTrack_Weapon_Axe", 115]]) }));
    assert.deepEqual(Plan.credits, {});
    assert.ok(Plan.capped.some((Line) => Line.startsWith("MasteryTrack_PlayerLevel 2->0")));   // never claimed
    assert.ok(Plan.capped.some((Line) => Line.startsWith("MasteryTrack_Weapon_Axe 2->1")));    // claimed 1
    assert.deepEqual(Plan.atCap, ["MasteryTrack_Weapon_Axe 1->0 (total 115, cap 115)"]);
});

test("a chain blades objective credits the chain blades track (CB code), host or dedicated", () => {
    const Body = { progress_tracks: [Claim("MasteryTrack_PlayerLevel", 1), Claim("MasteryTrack_Weapon_ChainBlades", 1)], objectives: [Done("MasteryObjective_Weapon_CB_Amber_Craft")] };
    for (const Limit of [undefined, Limits()]) {
        const Plan = PlanMasteryReport(Body, new Map(), Limit);
        assert.deepEqual(Plan.credits, { MasteryTrack_PlayerLevel: 1, MasteryTrack_Weapon_ChainBlades: 1 });
        assert.deepEqual(Plan.unmapped, []);
    }
});

test("the id grammar accepts every id the code and the live database use and refuses the rest", () => {
    for (const Id of [
        "MasteryObjective_Behemoth_Embermane_Kill", "MasteryObjective_Behemoth_Embermane_Boop_X_Times", "MasteryObjective_Behemoth_Gnasher_Craft_Armor",
        "MasteryObjective_Behemoth_Charrogg_XP", "MasteryObjective_Behemoth_Charrogg_PrestigeXP", "MasteryObjective_Weapon_Axe_A_Kill",
        "MasteryObjective_Weapon_Hammer_Generic_Shock_Damage8", "MasteryObjective_Weapon_Hammer_SkiesOfOstia_XP", "MasteryObjective_Weapon_Pike_Generic_Kills1",
        "MasteryObjective_Weapon_CB_Amber_Craft", "MasteryObjective_Weapon_Zzz_Kill0", "AchievementObjective_Crafter_Craft", "AchievementObjective_Craft_AllElements_Blaze_New",
    ]) assert.equal(IsMasteryObjectiveIdShape(Id), true, Id);
    for (const Id of ["", "MasteryObjective_", "MasteryObjective_Weapon_Axe", "MasteryObjective_Cheater_Axe_Kill", "MasteryObjective_Behemoth__Kill",
        "MasteryObjective_Behemoth_Embermane_Kill\n", "MasteryObjective_Behemoth_Embermane-Kill", "masteryobjective_behemoth_embermane_kill",
        "Objective_1", "AchievementObjective_", `MasteryObjective_Behemoth_${"A".repeat(120)}_Kill`]) assert.equal(IsMasteryObjectiveIdShape(Id), false, JSON.stringify(Id));
    const Started = Date.now();
    assert.equal(IsMasteryObjectiveIdShape(`MasteryObjective_Behemoth_${"A".repeat(5000)}_${"B".repeat(5000)}!`), false);
    assert.ok(Date.now() - Started < 200, "a long near-miss id is refused without a long scan");
});

test("host objective ids are refused by family, then by the check", () => {
    const Known = (Id: string) => Id === "MasteryObjective_Behemoth_A_Kill" || Id === "AchievementObjective_A";
    assert.equal(HostObjectiveIdRefusal("MasteryObjective_Behemoth_A_Kill", Known), undefined);
    assert.equal(HostObjectiveIdRefusal("AchievementObjective_A", Known), undefined);
    assert.equal(HostObjectiveIdRefusal("MasteryObjective_Behemoth_B_Kill", Known), "unknown_mastery_id");
    assert.equal(HostObjectiveIdRefusal("AchievementObjective_B", Known), "unknown_achievement_id");
    assert.equal(HostObjectiveIdRefusal("Other_A", () => true), "unrecognised_id_family");          // a known family is required even if the check says yes
    assert.equal(HostObjectiveIdRefusal("", () => true), "bad_id");
    assert.equal(HostObjectiveIdRefusal("MasteryObjective_" + "A".repeat(200), () => true), "bad_id");
});

test("the exact-id check comes from the game data file's objectiveIds and ignores a file without any", () => {
    const Check = BuildMasteryObjectiveCheck({ schema: 1, objectiveIds: ["MasteryObjective_Behemoth_A_Kill", 7, null, "AchievementObjective_A"], cards: [], achievements: [] });
    assert.equal(Check?.("MasteryObjective_Behemoth_A_Kill"), true);
    assert.equal(Check?.("AchievementObjective_A"), true);
    assert.equal(Check?.("MasteryObjective_Behemoth_B_Kill"), false);
    for (const Bad of [undefined, null, {}, [], "x", { objectiveIds: "x" }, { objectiveIds: [] }, { objectiveIds: [1, 2] }]) assert.equal(BuildMasteryObjectiveCheck(Bad), undefined);
});

test("applying a host's report stores only what the limits keep, reads only the capped tracks' totals, and tags the cuts", async () => {
    const Ids = Array.from({ length: 70 }, (_, Index) => Weapon("Axe", Index));
    const Body = {
        progress_tracks: [Claim("MasteryTrack_PlayerLevel", 70), Claim("MasteryTrack_Weapon_Axe", 70), Claim("MasteryTrack_Bogus", 5), Claim("ExperienceTrack_PlayerLevel", 9e5)],
        objectives: [...Ids.map((Id) => Done(Id, 5e8, 99)), Done("MasteryObjective_Weapon_Axe_Invented_Kill"), Done("Objective_1")],
    };
    const Caps: Record<string, number> = { MasteryTrack_PlayerLevel: 1111, MasteryTrack_Weapon_Axe: 115 };
    const Fake = FakeUnitOfWork([], { MasteryTrack_PlayerLevel: 1100, MasteryTrack_Weapon_Axe: 20 });
    const Limit = HostMasteryLimits({ isKnownObjective: (Id) => Id.startsWith("MasteryObjective_Weapon_Axe_Generic_"), trackCap: (Track) => Caps[Track] });
    const Applied = await ApplyMasteryReportWithPlan("user-1", Body, Fake.UnitOfWork, Limit);

    assert.equal(Fake.Merged.length, 64);                                                    // 64 applied; 6 over the limit and 2 unknown never reach the store
    assert.ok(Fake.Merged.every((Row: any) => Row.value === 100_000_000 && Row.completedCount === 10));
    assert.deepEqual(Fake.Increments.sort(), [["MasteryTrack_PlayerLevel", 11], ["MasteryTrack_Weapon_Axe", 64]]);   // player level: room 11 of the 64
    assert.deepEqual([...new Set(Fake.Reads.slice(0, 2))].sort(), ["MasteryTrack_PlayerLevel", "MasteryTrack_Weapon_Axe"]);   // totals read before planning
    assert.deepEqual(Fake.Reads, ["MasteryTrack_PlayerLevel", "MasteryTrack_Weapon_Axe", "MasteryTrack_Bogus"]);   // two total reads ahead of the plan (the capped tracks); the uncapped claim is only read back for the response, as before
    assert.equal(Fake.Reads.includes("ExperienceTrack_PlayerLevel"), false);
    assert.equal(Applied.payload.objectives.length, 64);
    assert.equal(Applied.payload.objectives.some((Row: any) => Row.objective_id === "Objective_1"), false);

    const Summary: any = SummarizeMasteryPlan(Applied.plan);
    assert.equal(Summary.ignoredCount, 2);
    assert.equal(Summary.overLimitCount, 6);
    assert.equal(Summary.clamped.length, 20);
    assert.deepEqual(Summary.atCap, ["MasteryTrack_PlayerLevel 64->11 (total 1100, cap 1111)"]);
    assert.ok(JSON.stringify(Summary).length < 6000);
});

test("applying without limits reads and writes exactly what it did before (no total reads, no row filtering)", async () => {
    const Ids = Array.from({ length: 70 }, (_, Index) => Weapon("Axe", Index));
    const Body = { progress_tracks: [Claim("MasteryTrack_PlayerLevel", 70), Claim("MasteryTrack_Weapon_Axe", 70)], objectives: [...Ids.map((Id) => Done(Id, 5e8, 99)), Done("Objective_1")] };
    const Fake = FakeUnitOfWork([], { MasteryTrack_PlayerLevel: 1100 });
    const Applied = await ApplyMasteryReportWithPlan("user-1", Body, Fake.UnitOfWork);
    assert.equal(Fake.Merged.length, 71);
    assert.ok(Fake.Merged.every((Row: any) => Row.objectiveId === "Objective_1" || (Row.value === 5e8 && Row.completedCount === 99)));
    assert.deepEqual(Fake.Increments.sort(), [["MasteryTrack_PlayerLevel", 70], ["MasteryTrack_Weapon_Axe", 70]]);
    assert.deepEqual(Fake.Reads, []);                                                        // every claimed track was credited, so none was read back
    assert.equal(Applied.plan.newlyCompleted.length, 70);
});
