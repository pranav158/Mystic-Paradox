/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
    CheckEscalationLevelXp,
    CheckEscalationTalents,
    DefaultEscalationProgress,
    EscalationTalentPoints,
    FilterEscalationUnlocks,
    IsAuthorizedEscalationReader,
    IsAuthorizedEscalationWriter,
    IsHostEscalationSeasonAllowed,
    IsHostEscalationWriter,
    LoadEscalationTuning,
    MAX_HOST_ESCALATION_ENTRIES,
    MergeEntriesNeverLower,
    MergeEscalationProgress,
    MergeHostEscalationProgress,
    ParseEscalationTuning,
    RecordToEscalationPayload
} from "./escalationProgress";
import type { EscalationSeasonProgressUpdate, EscalationSeasonTuning, EscalationTuning } from "./escalationProgress";
import { gameDataPath } from "./gameData/loader";
import type { EscalationProgressRecord } from "./persistence";

const USER = "player-1";
const SEASON = "ESC_SEASON_6";
const NOW = "2026-07-29T00:00:00.000Z";

test("escalation writes are gameserver-authoritative and same-account for ordinary players", () => {
    assert.equal(IsAuthorizedEscalationWriter({ IsGameserver: true }, "player-2"), true);
    assert.equal(IsAuthorizedEscalationWriter({ userId: "player-1" }, "player-1"), true);
    assert.equal(IsAuthorizedEscalationWriter({ userId: "player-1" }, "player-2"), false);
    assert.equal(IsAuthorizedEscalationWriter({ IsPlayerHostRuntime: true, userId: "player-1" }, "player-1"), false);
    assert.equal(IsAuthorizedEscalationWriter({}, "player-1"), false);
});

test("escalation reads are gameserver-authoritative or same-account", () => {
    assert.equal(IsAuthorizedEscalationReader({ IsGameserver: true }, "player-2"), true);
    assert.equal(IsAuthorizedEscalationReader({ userId: "player-1" }, "player-1"), true);
    assert.equal(IsAuthorizedEscalationReader({ userId: "player-1" }, "player-2"), false);
    assert.equal(IsAuthorizedEscalationReader({ IsPlayerHostRuntime: true, userId: "player-1" }, "player-2"), false);
    // [2026-10-11 B8] Within its own hunt roster a player-host runtime may read; writes stay refused.
    const Host = { IsPlayerHostRuntime: true, userId: "player-1", RuntimeRosterAccountIds: ["player-1", "player-2"] };
    assert.equal(IsAuthorizedEscalationReader(Host, "player-2"), true);
    assert.equal(IsAuthorizedEscalationReader(Host, "player-3"), false);
    assert.equal(IsAuthorizedEscalationWriter(Host, "player-2"), false);
});

test("new escalation state starts at the wire-compatible zero baseline", () => {
    assert.deepEqual(DefaultEscalationProgress(), {
        escalation_level: 0,
        next_level_xp: 0,
        talents_progress: [],
        unlock_progress: [],
        update_version: 0
    });
});

test("level, XP, talents, and unlocks round-trip into a durable record", () => {
    const Saved = MergeEscalationProgress(USER, SEASON, undefined, {
        escalation_level: 7,
        next_level_xp: 545,
        talents_progress: [{ talent_id: "Talent_MoveSpeed", talent_rank: 1 }],
        unlock_progress: [{ unlock_id: "EscalationReward05", is_unlocked: true, is_collected: false }],
        update_version: 99
    }, NOW);

    assert.deepEqual(RecordToEscalationPayload(Saved), {
        escalation_level: 7,
        next_level_xp: 545,
        talents_progress: [{ talent_id: "Talent_MoveSpeed", talent_rank: 1 }],
        unlock_progress: [{ unlock_id: "EscalationReward05", is_unlocked: true, is_collected: false }],
        update_version: 1
    });
    assert.equal(Saved.createdAt, NOW);
    assert.equal(Saved.updatedAt, NOW);
});

test("partial writes retain fields the game server omitted", () => {
    const First = MergeEscalationProgress(USER, SEASON, undefined, {
        escalation_level: 2,
        next_level_xp: 400,
        talents_progress: [{ talent_id: "Talent_A", talent_rank: 1 }],
        unlock_progress: [{ unlock_id: "Reward_A", is_unlocked: true }]
    }, NOW);
    const Second = MergeEscalationProgress(USER, SEASON, First, {
        next_level_xp: 545
    }, "2026-07-29T00:01:00.000Z");

    assert.equal(Second.escalationLevel, 2);
    assert.equal(Second.nextLevelXp, 545);
    assert.deepEqual(Second.talentsProgress, First.talentsProgress);
    assert.deepEqual(Second.unlockProgress, First.unlockProgress);
    assert.equal(Second.updateVersion, 2);
    assert.equal(Second.createdAt, NOW);
});

test("a stale hunt cannot lower a level already persisted by another server", () => {
    const LevelEight = MergeEscalationProgress(USER, SEASON, undefined, {
        escalation_level: 8,
        next_level_xp: 120
    }, NOW);
    const Stale = MergeEscalationProgress(USER, SEASON, LevelEight, {
        escalation_level: 1,
        next_level_xp: 20
    }, "2026-07-29T00:01:00.000Z");

    assert.equal(Stale.escalationLevel, 8);
});

test("an explicit empty talent array supports the in-game talent reset", () => {
    const WithTalent = MergeEscalationProgress(USER, SEASON, undefined, {
        escalation_level: 5,
        talents_progress: [{ talent_id: "Talent_A", talent_rank: 3 }]
    }, NOW);
    const Reset = MergeEscalationProgress(USER, SEASON, WithTalent, {
        talents_progress: []
    }, "2026-07-29T00:01:00.000Z");

    assert.deepEqual(Reset.talentsProgress, []);
    assert.equal(Reset.escalationLevel, 5);
});

// [2026-10-13 realms S3] Host writes: stored progress is never lowered.
const LATER = "2026-10-13T00:01:00.000Z";

// The 1.12 wire shapes: talents { rank, talent_id }, unlocks { collected, reward_id }.
const Talent = (id: string, rank: number) => ({ talent_id: id, rank });
const Unlock = (id: string, collected: boolean) => ({ reward_id: id, collected });

function Stored(level: number, xp: number, talents: unknown[] = [], unlocks: unknown[] = []) {
    return MergeEscalationProgress(USER, SEASON, undefined, { escalation_level: level, next_level_xp: xp, talents_progress: talents, unlock_progress: unlocks }, NOW);
}

test("a player-host runtime is a host writer, and still not an authorised escalation writer", () => {
    const Host = { IsPlayerHostRuntime: true, IsGameserver: false, userId: "player-1" };
    assert.equal(IsHostEscalationWriter(Host), true);
    assert.equal(IsHostEscalationWriter({ IsGameserver: true }), false);
    assert.equal(IsHostEscalationWriter({ IsGameserver: true, IsPlayerHostRuntime: true }), false);
    assert.equal(IsHostEscalationWriter({ userId: "player-1" }), false);
    assert.equal(IsHostEscalationWriter(undefined), false);
    assert.equal(IsAuthorizedEscalationWriter(Host, "player-1"), false);
});

test("a host raising the level takes the new level and its own XP remainder", () => {
    const Previous = Stored(8, 400);
    const { record, summary } = MergeHostEscalationProgress(USER, SEASON, Previous, { escalation_level: 9, next_level_xp: 35 }, LATER);
    assert.equal(record.escalationLevel, 9);
    assert.equal(record.nextLevelXp, 35, "XP is the remainder of the new level, so it may be below the old remainder");
    assert.equal(record.updateVersion, 2);
    assert.equal(record.createdAt, NOW);
    assert.equal(record.updatedAt, LATER);
    assert.deepEqual(summary, {
        levelBefore: 8, levelAfter: 9, xpBefore: 400, xpAfter: 35, levelXpRegressionIgnored: false,
        talents: { before: 0, after: 0, ignored: 0 }, unlocks: { before: 0, after: 0, ignored: 0 }, version: 2,
    });
});

test("a host cannot lower the level or the XP: a lower level keeps both, the same level keeps the larger XP", () => {
    const Previous = Stored(8, 400);
    // The dedicated merge lets a stale write lower the XP next to a level it kept; the host merge does not.
    assert.equal(MergeEscalationProgress(USER, SEASON, Previous, { escalation_level: 1, next_level_xp: 20 }, LATER).nextLevelXp, 20);

    const Stale = MergeHostEscalationProgress(USER, SEASON, Previous, { escalation_level: 1, next_level_xp: 20 }, LATER);
    assert.equal(Stale.record.escalationLevel, 8);
    assert.equal(Stale.record.nextLevelXp, 400);
    assert.equal(Stale.summary.levelXpRegressionIgnored, true);

    const SameLevelLowerXp = MergeHostEscalationProgress(USER, SEASON, Previous, { escalation_level: 8, next_level_xp: 120 }, LATER);
    assert.equal(SameLevelLowerXp.record.escalationLevel, 8);
    assert.equal(SameLevelLowerXp.record.nextLevelXp, 400);
    assert.equal(SameLevelLowerXp.summary.levelXpRegressionIgnored, true);

    const SameLevelHigherXp = MergeHostEscalationProgress(USER, SEASON, Previous, { escalation_level: 8, next_level_xp: 450 }, LATER);
    assert.equal(SameLevelHigherXp.record.nextLevelXp, 450);
    assert.equal(SameLevelHigherXp.summary.levelXpRegressionIgnored, false);

    // XP alone, no level in the request: it is judged at the stored level.
    assert.equal(MergeHostEscalationProgress(USER, SEASON, Previous, { next_level_xp: 3 }, LATER).record.nextLevelXp, 400);
    assert.equal(MergeHostEscalationProgress(USER, SEASON, Previous, { next_level_xp: 401 }, LATER).record.nextLevelXp, 401);
});

test("invalid numbers are not accepted from a host either, and omitted fields keep their stored value", () => {
    const Previous = Stored(5, 100, [Talent("Talent_A", 2)], [Unlock("Reward_A", true)]);
    for (const Bad of [-1, 1.5, 2_147_483_648, "9", null, Number.NaN]) {
        const { record } = MergeHostEscalationProgress(USER, SEASON, Previous, { escalation_level: Bad as any, next_level_xp: Bad as any }, LATER);
        assert.equal(record.escalationLevel, 5, String(Bad));
        assert.equal(record.nextLevelXp, 100, String(Bad));
    }
    const Empty = MergeHostEscalationProgress(USER, SEASON, Previous, {}, LATER);
    assert.deepEqual(RecordToEscalationPayload(Empty.record), { ...RecordToEscalationPayload(Previous), update_version: 2 });
    assert.deepEqual(Empty.summary.talents, { before: 1, after: 1, ignored: 0 });
});

test("a host first write for an account with no stored state is accepted as sent", () => {
    const { record, summary } = MergeHostEscalationProgress(USER, SEASON, undefined, {
        escalation_level: 3, next_level_xp: 12, talents_progress: [Talent("Talent_A", 1)], unlock_progress: [Unlock("Reward_A", true)], update_version: 99,
    }, NOW);
    assert.deepEqual(RecordToEscalationPayload(record), {
        escalation_level: 3, next_level_xp: 12, talents_progress: [Talent("Talent_A", 1)], unlock_progress: [Unlock("Reward_A", true)], update_version: 1,
    });
    assert.equal(summary.levelXpRegressionIgnored, false);
    assert.equal(record.createdAt, NOW);
});

test("a host cannot lower a talent rank, drop a talent, or reset the tree with an empty array", () => {
    const Previous = Stored(10, 0, [Talent("Talent_A", 3), Talent("Talent_B", 1)]);
    const Lowered = MergeHostEscalationProgress(USER, SEASON, Previous, { talents_progress: [Talent("Talent_A", 1), Talent("Talent_B", 1)] }, LATER);
    assert.deepEqual(Lowered.record.talentsProgress, [Talent("Talent_A", 3), Talent("Talent_B", 1)]);
    assert.equal(Lowered.summary.talents.ignored, 1);

    const Reset = MergeHostEscalationProgress(USER, SEASON, Previous, { talents_progress: [] }, LATER);
    assert.deepEqual(Reset.record.talentsProgress, [Talent("Talent_A", 3), Talent("Talent_B", 1)]);
    assert.equal(Reset.summary.talents.ignored, 2);
    // The dedicated merge still honours the in-game RESET.
    assert.deepEqual(MergeEscalationProgress(USER, SEASON, Previous, { talents_progress: [] }, LATER).talentsProgress, []);

    const Raised = MergeHostEscalationProgress(USER, SEASON, Previous, { talents_progress: [Talent("Talent_A", 4), Talent("Talent_B", 1), Talent("Talent_C", 1)] }, LATER);
    assert.deepEqual(Raised.record.talentsProgress, [Talent("Talent_A", 4), Talent("Talent_B", 1), Talent("Talent_C", 1)]);
    assert.deepEqual(Raised.summary.talents, { before: 2, after: 3, ignored: 0 });
});

test("a collected unlock stays collected, and unlocks the host omits stay", () => {
    const Previous = Stored(20, 0, [], [Unlock("Reward_A", true), Unlock("Reward_B", true), Unlock("Reward_C", false)]);
    const { record, summary } = MergeHostEscalationProgress(USER, SEASON, Previous, {
        unlock_progress: [Unlock("Reward_A", false), Unlock("Reward_C", true), Unlock("Reward_D", true)],
    }, LATER);
    assert.deepEqual(record.unlockProgress, [Unlock("Reward_A", true), Unlock("Reward_B", true), Unlock("Reward_C", true), Unlock("Reward_D", true)]);
    // Reward_A tried to un-collect, Reward_B was omitted.
    assert.deepEqual(summary.unlocks, { before: 3, after: 4, ignored: 2 });
});

test("unlock entries keyed by unlock_id are merged the same way", () => {
    const Previous = Stored(20, 0, [], [{ unlock_id: "EscalationReward05", is_unlocked: true, is_collected: false }]);
    const { record } = MergeHostEscalationProgress(USER, SEASON, Previous, {
        unlock_progress: [{ unlock_id: "EscalationReward05", is_unlocked: false, is_collected: true }],
    }, LATER);
    assert.deepEqual(record.unlockProgress, [{ unlock_id: "EscalationReward05", is_unlocked: true, is_collected: true }]);
});

test("array entries are merged field by field: numbers keep the larger value, fields the host omits stay", () => {
    const Merged = MergeEntriesNeverLower(
        [{ talent_id: "T", rank: 2, spent: 4, note: "old" }],
        [{ talent_id: "T", rank: 1, spent: 6, note: "new", extra: 1 }]
    );
    assert.deepEqual(Merged.merged, [{ talent_id: "T", rank: 2, spent: 6, note: "new", extra: 1 }]);
    assert.equal(Merged.ignored, 1);
    assert.deepEqual(MergeEntriesNeverLower([{ talent_id: "T", rank: 2, spent: 4 }], [{ talent_id: "T" }]).merged, [{ talent_id: "T", rank: 2, spent: 4 }]);
    // A field of another type cannot replace a stored number or a true flag.
    assert.deepEqual(MergeEntriesNeverLower([{ talent_id: "T", rank: 2, on: true }], [{ talent_id: "T", rank: "9", on: "yes" }]).merged,
        [{ talent_id: "T", rank: 2, on: true }]);
});

test("an entry with no recognised key is not accepted from a host, and stored keyless entries stay", () => {
    const Previous = Stored(5, 0, [Talent("Talent_A", 1), { legacy: "kept" }]);
    const { record, summary } = MergeHostEscalationProgress(USER, SEASON, Previous, {
        talents_progress: [Talent("Talent_A", 2), { rank: 9 }, "text", null, [1], { talent_id: "" }],
    }, LATER);
    assert.deepEqual(record.talentsProgress, [Talent("Talent_A", 2), { legacy: "kept" }]);
    assert.equal(summary.talents.ignored, 5);
});

test("a duplicated key in one host save is folded, and a stored duplicate is folded too", () => {
    assert.deepEqual(MergeEntriesNeverLower([], [Talent("A", 1), Talent("A", 3), Talent("A", 2)]).merged, [Talent("A", 3)]);
    assert.deepEqual(MergeEntriesNeverLower([Talent("A", 1), Talent("A", 4)], [Talent("A", 2)]).merged, [Talent("A", 4)]);
});

test("a request body field named __proto__ cannot reach a prototype", () => {
    const Hostile = JSON.parse("{\"talent_id\":\"T\",\"rank\":1,\"__proto__\":{\"polluted\":true}}");
    const Merged = MergeEntriesNeverLower([JSON.parse("{\"talent_id\":\"T\",\"rank\":0}")], [Hostile]).merged[0] as any;
    assert.equal(Merged.rank, 1);
    assert.equal(Object.getPrototypeOf(Merged), Object.prototype);
    assert.equal(({} as any).polluted, undefined);
});

test("new keys stop at the per-array cap, existing ones can still rise", () => {
    const Many = Array.from({ length: MAX_HOST_ESCALATION_ENTRIES + 10 }, (_, Index) => Talent(`T${Index}`, 1));
    const First = MergeEntriesNeverLower([], Many);
    assert.equal(First.merged.length, MAX_HOST_ESCALATION_ENTRIES);
    assert.equal(First.ignored, 10);
    const Raised = MergeEntriesNeverLower(First.merged, [Talent("T0", 5), Talent("Overflow", 1)]);
    assert.equal(Raised.merged.length, MAX_HOST_ESCALATION_ENTRIES);
    assert.deepEqual(Raised.merged[0], Talent("T0", 5));
});

test("the host merge does not alias or mutate the request body or the stored record", () => {
    const Previous = Stored(5, 10, [Talent("Talent_A", 2)]);
    const Before = structuredClone(Previous);
    const Body = { escalation_level: 6, talents_progress: [Talent("Talent_A", 3)] };
    const BodyBefore = structuredClone(Body);
    const { record } = MergeHostEscalationProgress(USER, SEASON, Previous, Body, LATER);
    assert.deepEqual(Previous, Before);
    assert.deepEqual(Body, BodyBefore);
    (record.talentsProgress[0] as any).rank = 99;
    assert.deepEqual(Body, BodyBefore);
});

// ---------------------------------------------------------------------------------------------------------------------
// [2026-10-13 realms S3 limits] Host writes judged against the season's real limits (a tuning table).
//
// A synthetic two-season table with the real tables' structure (25 levels; six tiers gated at 0/4/8/12/16/20 points; per tier
// three talents of 3, 2 and 1 ranks; six unlocks), so these tests need no game data. Season 2 mirrors the quirk of the real
// ESC_SEASON_5 / ESC_SEASON_6 tables: it also holds an id that carries another season's prefix. The real tables are checked in
// escalationTuning.gamedata.test.ts.

type RawTalent = { pointsToUnlock: number; pointCosts: number[] };

function SyntheticSeason(Prefix: string, Extra: Record<string, RawTalent> = {}) {
    const Talents: Record<string, RawTalent> = { ...Extra };
    for (let Tier = 1; Tier <= 6; Tier++) {
        const Gate = (Tier - 1) * 4;
        Talents[`${Prefix}_T${Tier}_A`] = { pointsToUnlock: Gate, pointCosts: [1, 1, 1] };
        Talents[`${Prefix}_T${Tier}_B`] = { pointsToUnlock: Gate, pointCosts: [1, 1] };
        Talents[`${Prefix}_T${Tier}_C`] = { pointsToUnlock: Gate, pointCosts: [1] };
    }
    return {
        maxLevel: 25,
        xpToReachLevel: Array.from({ length: 25 }, (_, Index) => 100 * (Index + 1)),
        unlocks: { R3: { level: 5 }, R2: { level: 8 }, R5: { level: 10 }, R4: { level: 15 }, R6: { level: 20 }, R7: { level: 25 } },
        talents: Talents,
    };
}

const S1 = "ESC_SEASON_1";
const S2 = "ESC_SEASON_2";
const RawTuning = () => ({
    seasons: {
        [S1]: SyntheticSeason("S1"),
        [S2]: SyntheticSeason("S2", { S1_T6_X: { pointsToUnlock: 20, pointCosts: [1] }, S2_FREE: { pointsToUnlock: 20, pointCosts: [0] } }),
    },
});
const TUNING: EscalationTuning = (() => {
    const Parsed = ParseEscalationTuning(RawTuning());
    assert.equal(Parsed.problem, undefined);
    return Parsed.tuning as EscalationTuning;
})();
const SEASON_1 = TUNING.seasons.get(S1)!;
const SEASON_2 = TUNING.seasons.get(S2)!;

const Tal = (Id: string, Rank: unknown) => ({ talent_id: Id, rank: Rank });
const Rew = (Id: unknown, Collected: unknown) => ({ reward_id: Id, collected: Collected });
// Whole tiers (3 + 2 + 1 ranks each = 6 points a tier) of a synthetic season: every earlier tier is always paid in full, so the gates hold.
const Full = (Prefix: string, Tiers: number[]) => Tiers.flatMap((Tier) => [Tal(`${Prefix}_T${Tier}_A`, 3), Tal(`${Prefix}_T${Tier}_B`, 2), Tal(`${Prefix}_T${Tier}_C`, 1)]);

function StoredIn(Season: string, Level: number, Xp: number, Talents: unknown[] = [], Unlocks: unknown[] = []): EscalationProgressRecord {
    return MergeEscalationProgress(USER, Season, undefined, { escalation_level: Level, next_level_xp: Xp, talents_progress: Talents, unlock_progress: Unlocks }, NOW);
}

function Limited(Previous: EscalationProgressRecord | undefined, Update: EscalationSeasonProgressUpdate, Season = S1) {
    return MergeHostEscalationProgress(USER, Season, Previous, Update, LATER, TUNING);
}

// Two different 9-point builds of season 1, both valid from level 9 (BUILD_B buys tier 3 only because tiers 1 and 2 bank 8 points).
const BUILD_A = [Tal("S1_T1_A", 3), Tal("S1_T1_B", 2), Tal("S1_T1_C", 1), Tal("S1_T2_A", 3)];
const BUILD_B = [Tal("S1_T1_A", 3), Tal("S1_T1_B", 2), Tal("S1_T2_B", 2), Tal("S1_T2_C", 1), Tal("S1_T3_C", 1)];

test("a tuning table is parsed from the game-data shape, and one bad value rejects the whole file", () => {
    const Parsed = ParseEscalationTuning(RawTuning());
    assert.equal(Parsed.problem, undefined);
    assert.equal(SEASON_1.maxLevel, 25);
    assert.equal(SEASON_1.unlockLevels.get("R7"), 25);
    assert.equal(SEASON_1.xpToReachLevel[0], 100);
    assert.deepEqual(SEASON_1.talents.get("S1_T4_A"), { pointsToUnlock: 12, pointCosts: [1, 1, 1] });
    assert.equal(SEASON_1.talents.get("S1_T6_X"), undefined);
    assert.deepEqual(SEASON_2.talents.get("S1_T6_X"), { pointsToUnlock: 20, pointCosts: [1] });

    for (const Junk of [undefined, null, 5, "x", [], {}, { seasons: [] }, { seasons: {} }, { seasons: { "": SyntheticSeason("S1") } }]) {
        assert.equal(ParseEscalationTuning(Junk).tuning, undefined, JSON.stringify(Junk));
        assert.equal(typeof ParseEscalationTuning(Junk).problem, "string", JSON.stringify(Junk));
    }

    const Bad = (Change: (Season: any) => void, Problem: RegExp) => {
        const Raw: any = RawTuning();
        Change(Raw.seasons[S2]);
        const Result = ParseEscalationTuning(Raw);
        assert.equal(Result.tuning, undefined, String(Problem));
        assert.match(Result.problem ?? "", Problem);
    };
    Bad((Season) => { Season.maxLevel = 0; }, /seasons\.ESC_SEASON_2\.maxLevel/);
    Bad((Season) => { Season.maxLevel = 25.5; }, /maxLevel/);
    Bad((Season) => { Season.maxLevel = 1001; }, /maxLevel/);
    Bad((Season) => { Season.maxLevel = "25"; }, /maxLevel/);
    Bad((Season) => { Season.xpToReachLevel.pop(); }, /xpToReachLevel must hold one value per level \(25\)/);
    Bad((Season) => { Season.xpToReachLevel[3] = 0; }, /xpToReachLevel\[3\]/);
    Bad((Season) => { Season.xpToReachLevel[3] = "400"; }, /xpToReachLevel\[3\]/);
    Bad((Season) => { Season.unlocks = {}; }, /unlocks must be a non-empty object/);
    Bad((Season) => { Season.unlocks.R3.level = 0; }, /unlocks\.R3\.level/);
    Bad((Season) => { Season.unlocks.R3.level = 26; }, /unlocks\.R3\.level/);
    Bad((Season) => { Season.talents = {}; }, /talents must be a non-empty object/);
    Bad((Season) => { Season.talents.S2_T1_A.pointsToUnlock = -1; }, /S2_T1_A\.pointsToUnlock/);
    Bad((Season) => { Season.talents.S2_T1_A.pointCosts = []; }, /S2_T1_A\.pointCosts/);
    Bad((Season) => { Season.talents.S2_T1_A.pointCosts = "1"; }, /S2_T1_A\.pointCosts/);
    Bad((Season) => { Season.talents.S2_T1_A.pointCosts = [1, -1]; }, /S2_T1_A\.pointCosts\[1\]/);
    Bad((Season) => { Season.talents.S2_T1_A.pointCosts = [1.5]; }, /S2_T1_A\.pointCosts\[0\]/);
    Bad((Season) => { Season.talents.S2_T1_A = 7; }, /S2_T1_A must be an object/);
});

test("the committed example file is a valid tuning table", () => {
    const Parsed = ParseEscalationTuning(JSON.parse(fs.readFileSync(gameDataPath("escalation_tuning.example.json"), "utf8")));
    assert.equal(Parsed.problem, undefined);
    assert.ok(Parsed.tuning?.seasons.has("ESC_SEASON_1"));
});

test("loading never throws: a missing file, an unreadable one and a rejected one leave hosts on the never-lower merge", () => {
    assert.deepEqual(LoadEscalationTuning(() => undefined), { tuning: undefined, status: "missing" });
    const Unreadable = LoadEscalationTuning(() => { throw new SyntaxError("Unexpected token"); });
    assert.equal(Unreadable.status, "invalid");
    assert.match(Unreadable.problem ?? "", /unreadable: Unexpected token/);
    const Rejected = LoadEscalationTuning(() => ({ seasons: {} }));
    assert.equal(Rejected.status, "invalid");
    assert.equal(Rejected.tuning, undefined);
    const Loaded = LoadEscalationTuning(() => RawTuning());
    assert.equal(Loaded.status, "loaded");
    assert.equal(Loaded.problem, undefined);
    assert.equal(Loaded.tuning?.seasons.size, 2);
});

test("a host may write only the table's seasons, and any season when there is no table", () => {
    assert.equal(IsHostEscalationSeasonAllowed(TUNING, S1), true);
    assert.equal(IsHostEscalationSeasonAllowed(TUNING, S2), true);
    for (const Season of ["ESC_SEASON_0", "ESC_SEASON_7", "esc_season_1", "ESC_SEASON_1 ", "", "__proto__", "constructor", "toString"]) {
        assert.equal(IsHostEscalationSeasonAllowed(TUNING, Season), false, Season);
    }
    assert.equal(IsHostEscalationSeasonAllowed(undefined, "ESC_SEASON_7"), true);
    // The merge itself refuses to guess: the route checks the season first.
    assert.throws(() => Limited(undefined, { escalation_level: 1 }, "ESC_SEASON_7"), /not in the tuning table/);
});

test("without a tuning table the host summary has none of the limit fields and the never-lower rules apply as before", () => {
    const Previous = Stored(9, 0, [Talent("Talent_A", 3)]);
    const Reset = MergeHostEscalationProgress(USER, SEASON, Previous, { escalation_level: 40, talents_progress: [] }, LATER);
    assert.equal(Reset.record.escalationLevel, 40, "no ceiling without the table");
    assert.deepEqual(Reset.record.talentsProgress, [Talent("Talent_A", 3)], "and the respec does not persist");
    assert.deepEqual(Object.keys(Reset.summary).sort(), ["levelAfter", "levelBefore", "levelXpRegressionIgnored", "talents", "unlocks", "version", "xpAfter", "xpBefore"]);
});

test("level and XP: the season maximum is a ceiling, XP stays under the next level's need, and the stored pair is kept for an impossible one", () => {
    assert.equal(CheckEscalationLevelXp(SEASON_1, 0, 99), undefined);
    assert.match(CheckEscalationLevelXp(SEASON_1, 0, 100) ?? "", /100 XP level 1 takes/);
    assert.equal(CheckEscalationLevelXp(SEASON_1, 24, 2499), undefined);
    assert.match(CheckEscalationLevelXp(SEASON_1, 24, 2500) ?? "", /2500 XP level 25 takes/);
    assert.equal(CheckEscalationLevelXp(SEASON_1, 25, 0), undefined);
    assert.equal(CheckEscalationLevelXp(SEASON_1, 25, 2_000_000_000), undefined, "nothing bounds the XP at the maximum level");
    assert.match(CheckEscalationLevelXp(SEASON_1, 26, 0) ?? "", /level 26 is above the season maximum 25/);

    const Previous = StoredIn(S1, 24, 40);
    const Level26 = Limited(Previous, { escalation_level: 26, next_level_xp: 0 });
    assert.equal(Level26.record.escalationLevel, 24);
    assert.equal(Level26.record.nextLevelXp, 40);
    assert.match(Level26.summary.levelXpRejected ?? "", /level 26 is above the season maximum 25/);
    assert.equal(Level26.summary.levelXpRegressionIgnored, false, "a refused pair is not a regression");

    const Level25 = Limited(Previous, { escalation_level: 25, next_level_xp: 7 });
    assert.equal(Level25.record.escalationLevel, 25);
    assert.equal(Level25.record.nextLevelXp, 7);
    assert.equal(Level25.summary.levelXpRejected, undefined);

    // Level 3 needs 400 XP to reach 4: 399 is possible, 400 is not (it would have been level 4 with 0).
    const Three = StoredIn(S1, 3, 10);
    assert.equal(Limited(Three, { escalation_level: 3, next_level_xp: 399 }).record.nextLevelXp, 399);
    const Over = Limited(Three, { escalation_level: 3, next_level_xp: 400 });
    assert.equal(Over.record.nextLevelXp, 10);
    assert.match(Over.summary.levelXpRejected ?? "", /next_level_xp 400 is not below the 400 XP level 4 takes/);
    // The remainder carried into a new level is judged at the new level; XP sent alone is judged at the stored level.
    assert.equal(Limited(Three, { escalation_level: 4, next_level_xp: 450 }).record.nextLevelXp, 450);
    assert.equal(Limited(Three, { escalation_level: 4, next_level_xp: 500 }).record.escalationLevel, 3);
    assert.equal(Limited(Three, { next_level_xp: 500 }).record.nextLevelXp, 10);
    assert.equal(Limited(Three, { next_level_xp: 300 }).record.nextLevelXp, 300);
    assert.equal(Limited(undefined, { escalation_level: 0, next_level_xp: 100 }).record.nextLevelXp, 0, "the first level needs 100 XP too");

    // Never lower still holds inside the limits.
    const Lower = Limited(Previous, { escalation_level: 10, next_level_xp: 5 });
    assert.equal(Lower.record.escalationLevel, 24);
    assert.equal(Lower.summary.levelXpRegressionIgnored, true);
    assert.equal(Lower.summary.levelXpRejected, undefined);

    // A write that sends neither is not judged on the stored pair.
    const Legacy = StoredIn(S1, 30, 99999);
    const Untouched = Limited(Legacy, { talents_progress: [] });
    assert.equal(Untouched.summary.levelXpRejected, undefined);
    assert.equal(Untouched.record.escalationLevel, 30);
});

test("talents: a respec to [] persists, then a different valid build replaces it instead of merging with it", () => {
    const Level9 = StoredIn(S1, 9, 0, BUILD_A);
    const Respec = Limited(Level9, { talents_progress: [] });
    assert.deepEqual(Respec.record.talentsProgress, []);
    assert.equal(Respec.summary.talentsReset, true);
    assert.equal(Respec.summary.talentsRejected, undefined);
    assert.deepEqual(Respec.summary.talentPoints, { before: 9, after: 0 });
    assert.deepEqual(Respec.summary.talents, { before: 4, after: 0, ignored: 0 });
    assert.equal(Respec.record.escalationLevel, 9, "a respec leaves the level alone");

    const Respent = Limited(Respec.record, { talents_progress: BUILD_B });
    assert.deepEqual(Respent.record.talentsProgress, BUILD_B);
    assert.deepEqual(Respent.summary.talentPoints, { before: 0, after: 9 });
    assert.equal(Respent.summary.talentsReset, undefined);

    // The same build replaced in one write (respec and re-spend inside one 30 s window): replaced, not unioned.
    const Swapped = Limited(Level9, { talents_progress: BUILD_B });
    assert.deepEqual(Swapped.record.talentsProgress, BUILD_B);
    assert.equal(Swapped.summary.talentsReset, undefined, "equal points is not a smaller build");
    assert.deepEqual(Swapped.summary.talentPoints, { before: 9, after: 9 });

    // A lower rank, or a dropped entry, is a legitimate smaller build.
    const Smaller = Limited(Level9, { talents_progress: [Tal("S1_T1_A", 1), Tal("S1_T1_B", 2)] });
    assert.deepEqual(Smaller.record.talentsProgress, [Tal("S1_T1_A", 1), Tal("S1_T1_B", 2)]);
    assert.equal(Smaller.summary.talentsReset, true);
    assert.deepEqual(Smaller.summary.talentPoints, { before: 9, after: 3 });

    // Re-sending the stored build is a no-op, and a request without talents leaves them alone.
    const Same = Limited(Level9, { talents_progress: BUILD_A });
    assert.deepEqual(Same.record.talentsProgress, BUILD_A);
    assert.equal(Same.summary.talentsReset, undefined);
    const Omitted = Limited(Level9, { next_level_xp: 3 });
    assert.deepEqual(Omitted.record.talentsProgress, BUILD_A);
    assert.deepEqual(Omitted.summary.talents, { before: 4, after: 4, ignored: 0 });
    assert.equal(Omitted.summary.talentsReset, undefined);
});

test("talents: more points than the level earned is refused and the stored build stays (the old union inflation)", () => {
    const Level9 = StoredIn(S1, 9, 0, BUILD_A);
    // BUILD_A merged with BUILD_B entry by entry: 13 points at level 9.
    const Union = [Tal("S1_T1_A", 3), Tal("S1_T1_B", 2), Tal("S1_T1_C", 1), Tal("S1_T2_A", 3), Tal("S1_T2_B", 2), Tal("S1_T2_C", 1), Tal("S1_T3_C", 1)];
    const Inflated = Limited(Level9, { talents_progress: Union });
    assert.deepEqual(Inflated.record.talentsProgress, BUILD_A);
    assert.match(Inflated.summary.talentsRejected ?? "", /13 points spent with 9 earned \(level 9\)/);
    assert.deepEqual(Inflated.summary.talents, { before: 4, after: 4, ignored: 7 });
    assert.deepEqual(Inflated.summary.talentPoints, { before: 9, after: 9 });
    assert.equal(Inflated.summary.talentsReset, undefined);
    assert.equal(Inflated.record.updateVersion, 2, "the rest of the write is still accepted");

    // The same build is fine once the level pays for it, in the same request.
    const Raised = Limited(Level9, { escalation_level: 13, next_level_xp: 0, talents_progress: Union });
    assert.deepEqual(Raised.record.talentsProgress, Union);
    assert.equal(Raised.summary.talentsRejected, undefined);

    // ...but not when the level is the part that was refused: the points are judged at the level that was accepted.
    const Cheat = Limited(Level9, { escalation_level: 26, next_level_xp: 0, talents_progress: Union });
    assert.equal(Cheat.record.escalationLevel, 9);
    assert.deepEqual(Cheat.record.talentsProgress, BUILD_A);
    assert.ok(Cheat.summary.levelXpRejected);
    assert.ok(Cheat.summary.talentsRejected);

    // Level 25 buys at most 25 points, whatever the build.
    assert.deepEqual(CheckEscalationTalents(SEASON_1, [...Full("S1", [1, 2, 3, 4]), Tal("S1_T5_C", 1)], 25), { ok: true, points: 25 });
    const Check = CheckEscalationTalents(SEASON_1, Full("S1", [1, 2, 3, 4, 5, 6]), 25);
    assert.equal(Check.ok, false);
    assert.match(Check.ok ? "" : Check.reason, /36 points spent with 25 earned/);
});

test("talents: ids must be this season's exact rows, including a table that holds another season's prefix", () => {
    // S1_T6_X sits in season 2's table only, as ESC_TALENT_S4_* ids sit in ESC_SEASON_5's and ESC_TALENT_S5_* in ESC_SEASON_6's.
    assert.equal(CheckEscalationTalents(SEASON_2, [Tal("S1_T6_X", 1)], 25).ok, false, "known to season 2, but gated at 20 points");
    const Gated = (Prefix: string) => [...Full(Prefix, [1, 2, 3]), Tal(`${Prefix}_T4_A`, 3)]; // 21 points spent
    assert.deepEqual(CheckEscalationTalents(SEASON_2, [...Gated("S2"), Tal("S1_T6_X", 1)], 25), { ok: true, points: 22 });
    assert.match((CheckEscalationTalents(SEASON_1, [...Gated("S1"), Tal("S1_T6_X", 1)], 25) as any).reason, /"S1_T6_X" is not in this season's table/);

    const Reasons = (Entries: unknown[], Season = SEASON_1) => {
        const Result = CheckEscalationTalents(Season, Entries, 25);
        assert.equal(Result.ok, false, JSON.stringify(Entries));
        return Result.ok ? "" : Result.reason;
    };
    assert.match(Reasons([Tal("S2_T1_A", 1)]), /"S2_T1_A" is not in this season's table/, "another season's talent");
    assert.match(Reasons([Tal("S1_T1_a", 1)]), /not in this season's table/, "ids are case-sensitive");
    assert.match(Reasons([Tal(" S1_T1_A", 1)]), /not in this season's table/);
    assert.match(Reasons([Tal("S1_T7_A", 1)]), /not in this season's table/, "a tier the table does not have");
    for (const Id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) assert.match(Reasons([Tal(Id, 1)]), /not in this season's table/, Id);
    assert.match(Reasons([JSON.parse("{\"talent_id\":\"__proto__\",\"rank\":1}")]), /not in this season's table/);
    assert.match(Reasons([Tal("S1_T1_A".repeat(40), 1)]), /\.\.\."/, "a long id is clipped in the reason");

    assert.match(Reasons([Tal("S1_T1_A", 1), Tal("S1_T1_A", 2)]), /appears twice/);
    assert.match(Reasons([Tal("S1_T1_A", 0)]), /rank of 1\.\.3/, "rank 0 is not an entry the game keeps");
    assert.match(Reasons([Tal("S1_T1_A", 4)]), /rank of 1\.\.3/);
    assert.match(Reasons([Tal("S1_T1_C", 2)]), /rank of 1\.\.1/);
    for (const Rank of [-1, 1.5, "2", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, [2], { n: 2 }]) {
        assert.match(Reasons([Tal("S1_T1_A", Rank)]), /rank of 1\.\.3/, String(Rank));
    }
    assert.match(Reasons([{ rank: 1 }]), /no talent_id/);
    assert.match(Reasons([{ talent_id: 5, rank: 1 }]), /no talent_id/);
    assert.match(Reasons(["S1_T1_A"]), /not an object/);
    assert.match(Reasons([null]), /not an object/);
    assert.match(Reasons([[Tal("S1_T1_A", 1)]]), /not an object/);
    assert.match(Reasons(Array.from({ length: 19 }, (_, Index) => Tal(`S1_T${(Index % 6) + 1}_A`, 1))), /19 entries for a season with 18 talents/);
    assert.deepEqual(CheckEscalationTalents(SEASON_1, "not an array", 25), { ok: false, reason: "talents_progress is not an array" });

    // A refused array leaves the stored build and counts every offered entry as ignored.
    const Previous = StoredIn(S1, 9, 0, BUILD_A);
    const Wrong = Limited(Previous, { talents_progress: [Tal("S2_T1_A", 1), Tal("S1_T1_A", 1)] });
    assert.deepEqual(Wrong.record.talentsProgress, BUILD_A);
    assert.deepEqual(Wrong.summary.talents, { before: 4, after: 4, ignored: 2 });
    assert.match(Wrong.summary.talentsRejected ?? "", /S2_T1_A/);
});

test("talents: tier gates are checked against the points spent before each purchase, in the best order", () => {
    const Ok = (Entries: unknown[], Level = 25) => CheckEscalationTalents(SEASON_1, Entries, Level);
    // Alone, a tier-2 or tier-6 talent cannot have been bought: nothing was spent before it.
    assert.match((Ok([Tal("S1_T2_C", 1)]) as any).reason, /gated at 4 points is bought with 0 spent/);
    assert.match((Ok([Tal("S1_T6_C", 1)]) as any).reason, /gated at 20 points is bought with 0 spent/);
    // Three tier-1 points are one short of the tier-2 gate; four are enough.
    assert.equal(Ok([Tal("S1_T1_A", 3), Tal("S1_T2_C", 1)]).ok, false);
    assert.deepEqual(Ok([Tal("S1_T1_A", 3), Tal("S1_T1_C", 1), Tal("S1_T2_C", 1)]), { ok: true, points: 5 });
    // The gate counts points already spent, so the entry order of the array does not matter...
    assert.deepEqual(Ok([Tal("S1_T3_C", 1), Tal("S1_T2_B", 2), Tal("S1_T1_A", 3), Tal("S1_T1_B", 2), Tal("S1_T1_C", 1)]), { ok: true, points: 9 });
    // ...but a rank of a talent cannot be bought before the points it needs: 7 spent is not 8.
    assert.equal(Ok([Tal("S1_T3_C", 1), Tal("S1_T2_B", 2), Tal("S1_T1_A", 3), Tal("S1_T1_B", 2)]).ok, false);
    // Tier 3 (gate 8) needs 8 points before its first purchase: 4 + 3 = 7 is one short, 5 + 3 = 8 is enough.
    assert.equal(Ok([Tal("S1_T1_A", 3), Tal("S1_T1_B", 1), Tal("S1_T2_A", 3), Tal("S1_T3_C", 1)]).ok, false);
    assert.equal(Ok([Tal("S1_T1_A", 3), Tal("S1_T1_B", 2), Tal("S1_T2_A", 3), Tal("S1_T3_C", 1)]).ok, true);
    // Up to tier 6: tiers 1-3 in full (18 points) are two short of the 20-point gate, two more points of tier 4 reach it.
    assert.deepEqual(Ok([...Full("S1", [1, 2, 3]), Tal("S1_T6_C", 1)]), { ok: false, reason: "a talent gated at 20 points is bought with 18 spent" });
    assert.deepEqual(Ok([...Full("S1", [1, 2, 3]), Tal("S1_T4_A", 2), Tal("S1_T6_C", 1)]), { ok: true, points: 21 });
    // The level bounds the build before the gates are looked at.
    assert.match((Ok([...Full("S1", [1, 2, 3]), Tal("S1_T4_A", 2), Tal("S1_T6_C", 1)], 20) as any).reason, /21 points spent with 20 earned/);
});

test("talents: a free rank still has its tier gate", () => {
    const Tiers123 = Full("S2", [1, 2, 3]); // 18 points
    assert.equal(CheckEscalationTalents(SEASON_2, [Tal("S2_FREE", 1)], 25).ok, false, "free, but 0 points spent is below 20");
    assert.equal(CheckEscalationTalents(SEASON_2, [...Tiers123, Tal("S2_FREE", 1)], 25).ok, false, "18 spent is below 20");
    assert.deepEqual(CheckEscalationTalents(SEASON_2, [...Tiers123, Tal("S2_T4_A", 2), Tal("S2_FREE", 1)], 25), { ok: true, points: 20 });
    assert.deepEqual(CheckEscalationTalents(SEASON_2, [...Tiers123, Tal("S2_T4_A", 2), Tal("S2_FREE", 1)], 20), { ok: true, points: 20 }, "the free rank costs nothing against the level");
});

test("talent points of a stored build count only entries the season knows, once each", () => {
    assert.equal(EscalationTalentPoints(SEASON_1, BUILD_A), 9);
    assert.equal(EscalationTalentPoints(SEASON_1, []), 0);
    assert.equal(EscalationTalentPoints(SEASON_1, [Tal("S1_T1_A", 9), Tal("S1_T1_A", 1), Tal("Legacy", 5), { rank: 3 }, null, "x", Tal("S1_T1_B", 0), Tal("S1_T1_C", "1")]), 3, "a rank beyond the maximum counts as the maximum");
    assert.equal(EscalationTalentPoints(SEASON_2, [Tal("S2_FREE", 1)]), 0);
});

test("unlocks: only the season's rewards, and collected only once the accepted level has reached the reward's level", () => {
    const Filter = (Entries: unknown[], Level: number) => FilterEscalationUnlocks(SEASON_1, Entries, Level);
    assert.deepEqual(Filter([Rew("R3", true)], 5), { accepted: [Rew("R3", true)], rejected: 0 });
    assert.deepEqual(Filter([Rew("R3", true)], 4), { accepted: [], rejected: 1 });
    assert.deepEqual(Filter([Rew("R3", false)], 0), { accepted: [Rew("R3", false)], rejected: 0 }, "an uncollected entry is fine at any level");
    assert.deepEqual(Filter([{ reward_id: "R3" }], 0), { accepted: [{ reward_id: "R3" }], rejected: 0 });
    assert.deepEqual(Filter([Rew("R7", true)], 24), { accepted: [], rejected: 1 });
    assert.deepEqual(Filter([Rew("R7", true)], 25), { accepted: [Rew("R7", true)], rejected: 0 });
    assert.deepEqual(Filter([Rew("ESC_Reward_99", false), Rew("r3", false), Rew("", false), Rew("__proto__", false), { unlock_id: "R3", is_collected: true }, { collected: true }, Rew(5, true), null, "R3", [Rew("R3", true)]], 25).accepted, []);
    assert.equal(Filter([Rew("R3", "yes"), Rew("R3", 1), Rew("R3", null)], 25).rejected, 3, "collected must be a boolean");

    const Previous = StoredIn(S1, 8, 0, [], [Rew("R3", true)]);
    const Early = Limited(Previous, { unlock_progress: [Rew("R3", true), Rew("R2", true), Rew("R5", true), Rew("Bogus", true)] });
    // R2 unlocks at 8 (reached), R5 at 10 (not), Bogus is not a reward of the season.
    assert.deepEqual(Early.record.unlockProgress, [Rew("R3", true), Rew("R2", true)]);
    assert.deepEqual(Early.summary.unlocks, { before: 1, after: 2, ignored: 2 });

    // The accepted level is the one that counts, also when it rises in the same write...
    assert.deepEqual(Limited(Previous, { escalation_level: 10, next_level_xp: 0, unlock_progress: [Rew("R5", true)] }).record.unlockProgress, [Rew("R3", true), Rew("R5", true)]);
    // ...and not when that rise was refused.
    const Refused = Limited(StoredIn(S1, 24, 0), { escalation_level: 26, next_level_xp: 0, unlock_progress: [Rew("R7", true)] });
    assert.deepEqual(Refused.record.unlockProgress, []);
    assert.equal(Refused.summary.unlocks.ignored, 1);
    assert.deepEqual(Limited(StoredIn(S1, 24, 0), { escalation_level: 25, next_level_xp: 0, unlock_progress: [Rew("R7", true)] }).record.unlockProgress, [Rew("R7", true)]);
});

test("unlocks: collected never goes true to false, omitted entries stay, entries are keyed by reward_id, and older stored shapes are kept", () => {
    const Legacy = { unlock_id: "EscalationReward05", is_unlocked: true, is_collected: false };
    const Previous = StoredIn(S1, 20, 0, [], [Rew("R3", true), Rew("R2", true), Rew("R5", false), Legacy]);
    const Result = Limited(Previous, { unlock_progress: [Rew("R3", false), Rew("R5", true)] });
    assert.deepEqual(Result.record.unlockProgress, [Rew("R3", true), Rew("R2", true), Rew("R5", true), Legacy]);
    // R3 tried to un-collect and R2 was omitted (both kept); the stored entry of the older shape is not keyed by reward_id and is not touched.
    assert.deepEqual(Result.summary.unlocks, { before: 4, after: 4, ignored: 2 });

    // An entry that also carries a talent_id still merges into its reward's entry, not a new key.
    const Mixed = Limited(Previous, { unlock_progress: [{ reward_id: "R5", talent_id: "S1_T1_A", collected: true }] });
    assert.equal(Mixed.record.unlockProgress.filter((Entry: any) => Entry.reward_id === "R5").length, 1);
    assert.equal((Mixed.record.unlockProgress[2] as any).collected, true);
});

test("the limited merge does not alias or mutate the request body or the stored record", () => {
    const Previous = StoredIn(S1, 9, 0, BUILD_A, [Rew("R3", true)]);
    const Before = structuredClone(Previous);
    const Body = { escalation_level: 12, next_level_xp: 5, talents_progress: structuredClone(BUILD_B), unlock_progress: [Rew("R2", true)] };
    const BodyBefore = structuredClone(Body);
    const { record } = Limited(Previous, Body);
    assert.deepEqual(Previous, Before);
    assert.deepEqual(Body, BodyBefore);
    (record.talentsProgress[0] as any).rank = 99;
    (record.unlockProgress[0] as any).collected = "x";
    assert.deepEqual(Body, BodyBefore);
    assert.deepEqual(Previous, Before);

    // A refused array keeps the stored build as a copy too.
    const Refused = Limited(Previous, { talents_progress: [Tal("Nope", 1)] });
    (Refused.record.talentsProgress[0] as any).rank = 99;
    assert.deepEqual(Previous, Before);
});

test("a host first write with a table is judged like any other: a valid build at a valid level is stored as sent", () => {
    const { record, summary } = Limited(undefined, {
        escalation_level: 9, next_level_xp: 50, talents_progress: BUILD_A, unlock_progress: [Rew("R3", true), Rew("R2", true)], update_version: 99,
    });
    assert.deepEqual(RecordToEscalationPayload(record), {
        escalation_level: 9, next_level_xp: 50, talents_progress: BUILD_A, unlock_progress: [Rew("R3", true), Rew("R2", true)], update_version: 1,
    });
    assert.deepEqual(summary, {
        levelBefore: 0, levelAfter: 9, xpBefore: 0, xpAfter: 50, levelXpRegressionIgnored: false,
        talents: { before: 0, after: 4, ignored: 0 }, unlocks: { before: 0, after: 2, ignored: 0 }, version: 1,
        talentPoints: { before: 0, after: 9 },
    });
});

// Brute force: can the build be reached by buying one rank at a time, each purchase needing its tier gate covered by the points
// already spent and no more points spent than the level earned? CheckEscalationTalents judges the same thing in one pass (it sorts
// the purchases by gate), so the two must agree on every build.
function ReachableByPurchases(Season: EscalationSeasonTuning, Target: [string, number][], Level: number): boolean {
    const Talents = Target.map(([Id]) => Season.talents.get(Id)!);
    const Goal = Target.map(([, Rank]) => Rank);
    const Known = new Map<string, boolean>();
    const Visit = (Ranks: number[], Spent: number): boolean => {
        if (Ranks.every((Rank, Index) => Rank === Goal[Index])) return true;
        const Key = Ranks.join(",");
        const Cached = Known.get(Key);
        if (Cached !== undefined) return Cached;
        let Found = false;
        for (let Index = 0; Index < Ranks.length && !Found; Index++) {
            if (Ranks[Index] >= Goal[Index]) continue;
            const Cost = Talents[Index].pointCosts[Ranks[Index]];
            if (Spent < Talents[Index].pointsToUnlock || Spent + Cost > Level) continue;
            Ranks[Index]++;
            Found = Visit(Ranks, Spent + Cost);
            Ranks[Index]--;
        }
        Known.set(Key, Found);
        return Found;
    };
    return Visit(Target.map(() => 0), 0);
}

test("the talent check agrees with a brute-force search over purchase orders, free ranks and level included", () => {
    let Seed = 20261013;
    const Random = (Max: number) => { Seed = (Math.imul(Seed, 1103515245) + 12345) & 0x7fffffff; return (Seed >>> 8) % Max; };
    for (const Season of [SEASON_1, SEASON_2]) {
        const Ids = [...Season.talents.keys()];
        let Accepted = 0;
        let Refused = 0;
        for (let Round = 0; Round < 700; Round++) {
            // A random build of at most 10 ranks, drawn from the first few tiers more often than the last so that both outcomes occur.
            const Tiers = 1 + Random(6);
            const Pool = Ids.filter((Id) => (Season.talents.get(Id)!.pointsToUnlock / 4) < Tiers);
            const Picked = new Map<string, number>();
            let Ranks = 0;
            for (let Attempt = 0; Attempt < 12 && Ranks < 10; Attempt++) {
                const Id = Pool[Random(Pool.length)];
                if (Picked.has(Id)) continue;
                const Rank = Math.min(1 + Random(Season.talents.get(Id)!.pointCosts.length), 10 - Ranks);
                Picked.set(Id, Rank);
                Ranks += Rank;
            }
            const Build = [...Picked.entries()];
            const Level = Random(14);
            const Expected = ReachableByPurchases(Season, Build, Level);
            const Actual = CheckEscalationTalents(Season, Build.map(([Id, Rank]) => Tal(Id, Rank)), Level);
            assert.equal(Actual.ok, Expected, `${JSON.stringify(Build)} at level ${Level}`);
            if (Expected) Accepted++; else Refused++;
        }
        assert.ok(Accepted >= 100 && Refused >= 100, `both outcomes occur (${Accepted} accepted, ${Refused} refused)`);
    }
});
