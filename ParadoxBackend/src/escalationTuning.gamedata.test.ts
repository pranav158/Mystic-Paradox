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
    CheckEscalationLevelXp,
    CheckEscalationTalents,
    EscalationTalentPoints,
    FilterEscalationUnlocks,
    IsHostEscalationSeasonAllowed,
    LoadEscalationTuning,
    MergeEscalationProgress,
    MergeHostEscalationProgress
} from "./escalationProgress";
import type { EscalationSeasonTuning, EscalationTuning } from "./escalationProgress";

/*
 * [2026-10-13 realms S3 limits] The real 1.14.7 escalation tables in game-data/escalation_tuning.json: what the file says about
 * the six seasons, and the host rules run on real ids. The rules themselves (and a brute-force check of the gate logic) are in
 * escalationProgress.test.ts on a synthetic table. Skipped when the file is missing, as in a fresh public checkout; a file that
 * is present but rejected fails here.
 */

const Loaded = LoadEscalationTuning();
const Skip = Loaded.status === "missing" ? "game-data/escalation_tuning.json is not present" : false;
const Tuning = Loaded.tuning as EscalationTuning;
const Season = (Id: string): EscalationSeasonTuning => Tuning.seasons.get(Id) as EscalationSeasonTuning;

const USER = "player-1";
const NOW = "2026-10-13T00:00:00.000Z";
const LATER = "2026-10-13T00:01:00.000Z";
const SEASONS = ["ESC_SEASON_1", "ESC_SEASON_2", "ESC_SEASON_3", "ESC_SEASON_4", "ESC_SEASON_5", "ESC_SEASON_6"];

const XP_TO_REACH_LEVEL = [
    500, 600, 700, 800, 900, 1000, 1200, 1500, 1800, 2500, 3000, 3500, 4000,
    4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500, 9000, 9500, 10000,
];
const UNLOCK_LEVELS: Record<string, number> = { ESC_Reward_3: 5, ESC_Reward_2: 8, ESC_Reward_5: 10, ESC_Reward_4: 15, ESC_Reward_6: 20, ESC_Reward_7: 25 };

const Tal = (Id: string, Rank: number) => ({ talent_id: Id, rank: Rank });
const Rew = (Id: string, Collected: boolean) => ({ reward_id: Id, collected: Collected });

function Stored(Season: string, Level: number, Xp: number, Talents: unknown[] = [], Unlocks: unknown[] = []) {
    return MergeEscalationProgress(USER, Season, undefined, { escalation_level: Level, next_level_xp: Xp, talents_progress: Talents, unlock_progress: Unlocks }, NOW);
}

function Host(Season: string, Previous: ReturnType<typeof Stored> | undefined, Update: Parameters<typeof MergeHostEscalationProgress>[3]) {
    return MergeHostEscalationProgress(USER, Season, Previous, Update, LATER, Tuning);
}

/** Every talent of the season up to tier `Tiers` (tier n is gated at 4 * (n - 1) points) at its maximum rank. */
function WholeTiers(Id: string, Tiers: number): { talent_id: string; rank: number }[] {
    return [...Season(Id).talents].filter(([, Talent]) => Talent.pointsToUnlock <= (Tiers - 1) * 4).map(([TalentId, Talent]) => Tal(TalentId, Talent.pointCosts.length));
}

test("the file is valid and holds the six escalation seasons", { skip: Skip }, () => {
    assert.equal(Loaded.status, "loaded", Loaded.problem ?? "escalation_tuning.json was rejected");
    assert.deepEqual([...Tuning.seasons.keys()], SEASONS);
    for (const Id of SEASONS) assert.equal(IsHostEscalationSeasonAllowed(Tuning, Id), true, Id);
    for (const Id of ["ESC_SEASON_0", "ESC_SEASON_7", "ESC_SEASON_10", "esc_season_1"]) assert.equal(IsHostEscalationSeasonAllowed(Tuning, Id), false, Id);
});

test("every season has the 25-level XP curve and the six unlocks of the paks", { skip: Skip }, () => {
    for (const Id of SEASONS) {
        const Data = Season(Id);
        assert.equal(Data.maxLevel, 25, Id);
        assert.deepEqual([...Data.xpToReachLevel], XP_TO_REACH_LEVEL, Id);
        assert.deepEqual(Object.fromEntries(Data.unlockLevels), UNLOCK_LEVELS, Id);
    }
    // 109000 XP in all, as the paks' cumulative column says.
    assert.equal(XP_TO_REACH_LEVEL.reduce((Sum, Xp) => Sum + Xp, 0), 109000);
});

test("the talent tables are the paks' exact rows: sizes, tier gates, rank costs and the prefix quirk", { skip: Skip }, () => {
    const Sizes = Object.fromEntries(SEASONS.map((Id) => [Id, Season(Id).talents.size]));
    assert.deepEqual(Sizes, { ESC_SEASON_1: 18, ESC_SEASON_2: 18, ESC_SEASON_3: 18, ESC_SEASON_4: 18, ESC_SEASON_5: 21, ESC_SEASON_6: 18 });

    const Owner = new Map<string, string>();
    for (const Id of SEASONS) {
        for (const [TalentId, Talent] of Season(Id).talents) {
            assert.equal(Owner.get(TalentId), undefined, `${TalentId} is in two seasons' tables`);
            Owner.set(TalentId, Id);
            const Tier = Number(/TIER(\d)/.exec(TalentId)?.[1]);
            assert.equal(Talent.pointsToUnlock, (Tier - 1) * 4, `${TalentId} tier gate`);
            assert.ok(Talent.pointCosts.length >= 1 && Talent.pointCosts.length <= 4, `${TalentId} max rank`);
            const Expected = TalentId === "ESC_TALENT_S2_TIER6_SPECIAL_UNLOCKTWO" ? [0] : Talent.pointCosts.map(() => 1);
            assert.deepEqual([...Talent.pointCosts], Expected, `${TalentId} rank costs`);
        }
    }

    // ESC_SEASON_5's table holds S4-prefixed ids and ESC_SEASON_6's S5-prefixed ones: the rows decide, not the prefix.
    for (const Id of ["ESC_TALENT_S4_TIER6_ASPECT_DEFENDER", "ESC_TALENT_S4_TIER6_ASPECT_SCOUT", "ESC_TALENTS_S4_TIER4_HARVESTER"]) assert.equal(Owner.get(Id), "ESC_SEASON_5", Id);
    for (const Id of ["ESC_TALENT_S5_TIER6_BLAZE", "ESC_TALENT_S5_TIER6_UMBRAL", "ESC_TALENT_S5_TIER6_TERRA"]) assert.equal(Owner.get(Id), "ESC_SEASON_6", Id);
    assert.equal(Owner.get("ESC_TALENT_S5_TIER1_WARMTH"), "ESC_SEASON_5");
    assert.equal(Owner.get("ESC_TALENT_S6_TIER1_REVOLVER"), "ESC_SEASON_6");
    assert.equal(Owner.get("ESC_TALENT_S6_TIER6_BLAZE"), undefined, "an id that follows the prefix but is not a row");
    assert.deepEqual([...Season("ESC_SEASON_2").talents.get("ESC_TALENT_S2_TIER6_SPECIAL_UNLOCKTWO")!.pointCosts], [0], "the one free rank");
});

test("a talent build the game's own rules can reach is always accepted", { skip: Skip }, () => {
    // Random legitimate play: a level, then purchases drawn at random from what is buyable (tier gate covered, rank below the
    // maximum) until the earned points are spent or nothing is left to buy.
    let Seed = 1013;
    const Random = (Max: number) => { Seed = (Math.imul(Seed, 1103515245) + 12345) & 0x7fffffff; return (Seed >>> 8) % Max; };
    for (const Id of SEASONS) {
        const Data = Season(Id);
        for (let Round = 0; Round < 300; Round++) {
            const Level = 1 + Random(25);
            const Ranks = new Map<string, number>();
            let Spent = 0;
            for (;;) {
                const Buyable = [...Data.talents].filter(([TalentId, Talent]) => {
                    const Rank = Ranks.get(TalentId) ?? 0;
                    return Rank < Talent.pointCosts.length && Spent >= Talent.pointsToUnlock && Spent + Talent.pointCosts[Rank] <= Level;
                });
                if (Buyable.length === 0) break;
                const [TalentId, Talent] = Buyable[Random(Buyable.length)];
                const Rank = Ranks.get(TalentId) ?? 0;
                Spent += Talent.pointCosts[Rank];
                Ranks.set(TalentId, Rank + 1);
            }
            const Build = [...Ranks].map(([TalentId, Rank]) => Tal(TalentId, Rank));
            assert.deepEqual(CheckEscalationTalents(Data, Build, Level), { ok: true, points: Spent }, `${Id} level ${Level} ${JSON.stringify(Build)}`);
            assert.equal(EscalationTalentPoints(Data, Build), Spent);
        }
    }
});

test("no season's whole table fits in 25 levels, and a level-25 build is refused one point over", { skip: Skip }, () => {
    for (const Id of SEASONS) {
        const Data = Season(Id);
        const Everything = [...Data.talents].map(([TalentId, Talent]) => Tal(TalentId, Talent.pointCosts.length));
        const Check = CheckEscalationTalents(Data, Everything, 25);
        assert.equal(Check.ok, false, Id);
        assert.match(Check.ok ? "" : Check.reason, /points spent with 25 earned/, Id);
    }
    // Tiers 1-3 of ESC_SEASON_6 are 22 points; three more of tier 4 make 25, a fourth does not fit.
    const Season6 = Season("ESC_SEASON_6");
    const Tiers123 = WholeTiers("ESC_SEASON_6", 3);
    assert.equal(EscalationTalentPoints(Season6, Tiers123), 22);
    assert.deepEqual(CheckEscalationTalents(Season6, [...Tiers123, Tal("ESC_TALENT_S6_TIER4_STAGGER_PASSIVE", 3)], 25), { ok: true, points: 25 });
    assert.equal(CheckEscalationTalents(Season6, [...Tiers123, Tal("ESC_TALENT_S6_TIER4_STAGGER_PASSIVE", 3), Tal("ESC_TALENT_S6_TIER5_TIRELESS", 1)], 25).ok, false);
});

test("level and XP limits on the real curve", { skip: Skip }, () => {
    const Data = Season("ESC_SEASON_1");
    assert.equal(CheckEscalationLevelXp(Data, 0, 499), undefined);
    assert.match(CheckEscalationLevelXp(Data, 0, 500) ?? "", /500 XP level 1 takes/);
    assert.equal(CheckEscalationLevelXp(Data, 9, 2499), undefined, "level 10 takes 2500");
    assert.match(CheckEscalationLevelXp(Data, 9, 2500) ?? "", /2500 XP level 10 takes/);
    assert.equal(CheckEscalationLevelXp(Data, 24, 9999), undefined);
    assert.match(CheckEscalationLevelXp(Data, 24, 10000) ?? "", /10000 XP level 25 takes/);
    assert.equal(CheckEscalationLevelXp(Data, 25, 0), undefined);
    assert.match(CheckEscalationLevelXp(Data, 26, 0) ?? "", /above the season maximum 25/);

    const Previous = Stored("ESC_SEASON_3", 24, 4000);
    assert.equal(Host("ESC_SEASON_3", Previous, { escalation_level: 25, next_level_xp: 0 }).record.escalationLevel, 25);
    const Over = Host("ESC_SEASON_3", Previous, { escalation_level: 26, next_level_xp: 0 });
    assert.equal(Over.record.escalationLevel, 24);
    assert.equal(Over.record.nextLevelXp, 4000);
    assert.ok(Over.summary.levelXpRejected);
});

test("the old union's 18 points at level 9 are refused, a respec persists and a real re-spend replaces it (ESC_SEASON_6)", { skip: Skip }, () => {
    const S6 = "ESC_SEASON_6";
    // Level 9: tier 1 (gate 0) and tier 2 (gate 4) talents, 9 points.
    const BuildA = [Tal("ESC_TALENT_S6_TIER1_REVOLVER", 3), Tal("ESC_TALENT_S6_TIER1_FLEET", 3), Tal("ESC_TALENT_S6_TIER2_DAMAGE_REDUCTION", 3)];
    const BuildB = [Tal("ESC_TALENT_S6_TIER1_EXECUTIONER", 3), Tal("ESC_TALENT_S6_TIER1_REVOLVER", 3), Tal("ESC_TALENT_S6_TIER2_FLASK_FLINGER", 1), Tal("ESC_TALENT_S6_TIER2_BLIND_FIGHTING", 2)];
    const Level9 = Stored(S6, 9, 120, BuildA);
    assert.equal(CheckEscalationTalents(Season(S6), BuildA, 9).ok, true);
    assert.equal(CheckEscalationTalents(Season(S6), BuildB, 9).ok, true);

    // A union of two respec builds, the shape the old merge produced: far more than 9 points.
    const Rebuilt = [Tal("ESC_TALENT_S6_TIER1_EXECUTIONER", 3), Tal("ESC_TALENT_S6_TIER3_FARSLAYER", 3), Tal("ESC_TALENT_S6_TIER3_THRILL", 3)];
    const Union = [...BuildA, ...Rebuilt];
    const Inflated = Host(S6, Level9, { talents_progress: Union });
    assert.deepEqual(Inflated.record.talentsProgress, BuildA);
    assert.match(Inflated.summary.talentsRejected ?? "", /18 points spent with 9 earned \(level 9\)/);
    // ...and the rebuilt half alone was never a real build either: tier-3 talents with only 3 points spent.
    const Alone = CheckEscalationTalents(Season(S6), Rebuilt, 25);
    assert.equal(Alone.ok, false);
    assert.match(Alone.ok ? "" : Alone.reason, /gated at 8 points is bought with 3 spent/);

    const Respec = Host(S6, Level9, { escalation_level: 9, next_level_xp: 120, talents_progress: [] });
    assert.deepEqual(Respec.record.talentsProgress, []);
    assert.equal(Respec.summary.talentsReset, true);
    assert.deepEqual(Respec.summary.talentPoints, { before: 9, after: 0 });
    assert.equal(Respec.record.escalationLevel, 9);
    assert.equal(Respec.record.nextLevelXp, 120);

    const Respent = Host(S6, Respec.record, { talents_progress: BuildB });
    assert.deepEqual(Respent.record.talentsProgress, BuildB);
    assert.equal(Respent.summary.talentsReset, undefined);
});

test("talent ids follow the season's rows, not its prefix (ESC_SEASON_5 and ESC_SEASON_6)", { skip: Skip }, () => {
    const Tier1To3 = (Id: string) => WholeTiers(Id, 3);
    // ESC_SEASON_5: tiers 1-3 are 20 points; its S4-prefixed rows are real here and S5-prefixed ESC_SEASON_6 rows are not.
    const Season5 = Season("ESC_SEASON_5");
    assert.equal(EscalationTalentPoints(Season5, Tier1To3("ESC_SEASON_5")), 20);
    assert.deepEqual(CheckEscalationTalents(Season5, [...Tier1To3("ESC_SEASON_5"), Tal("ESC_TALENT_S4_TIER6_ASPECT_SCOUT", 1), Tal("ESC_TALENTS_S4_TIER4_HARVESTER", 3)], 25), { ok: true, points: 24 });
    const WrongSeason = CheckEscalationTalents(Season5, [...Tier1To3("ESC_SEASON_5"), Tal("ESC_TALENT_S5_TIER6_BLAZE", 1)], 25);
    assert.match(WrongSeason.ok ? "" : WrongSeason.reason, /"ESC_TALENT_S5_TIER6_BLAZE" is not in this season's table/);
    assert.equal(CheckEscalationTalents(Season5, [Tal("ESC_TALENT_S6_TIER1_REVOLVER", 1)], 25).ok, false);

    // ESC_SEASON_6: the S5-prefixed tier-6 rows are its own (gate 20: tiers 1-3 are 22 points).
    const Season6 = Season("ESC_SEASON_6");
    assert.deepEqual(CheckEscalationTalents(Season6, [...Tier1To3("ESC_SEASON_6"), Tal("ESC_TALENT_S5_TIER6_BLAZE", 1)], 25), { ok: true, points: 23 });
    assert.equal(CheckEscalationTalents(Season6, [...Tier1To3("ESC_SEASON_6"), Tal("ESC_TALENT_S6_TIER6_BLAZE", 1)], 25).ok, false, "follows the prefix, is not a row");
    assert.equal(CheckEscalationTalents(Season6, [...Tier1To3("ESC_SEASON_6"), Tal("ESC_TALENT_S4_TIER6_ASPECT_SCOUT", 1)], 25).ok, false, "a season 5 row");

    // Through the host merge, at the route's seam: another season's table cannot be used for this season's write.
    const Previous = Stored("ESC_SEASON_4", 25, 0);
    const Foreign = Host("ESC_SEASON_4", Previous, { talents_progress: [Tal("ESC_TALENT_S6_TIER1_REVOLVER", 1)] });
    assert.deepEqual(Foreign.record.talentsProgress, []);
    assert.ok(Foreign.summary.talentsRejected);
});

test("a free rank of ESC_SEASON_2 still needs its tier-6 gate, and the 21 points before it fit level 21", { skip: Skip }, () => {
    const Season2 = Season("ESC_SEASON_2");
    const Tiers123 = WholeTiers("ESC_SEASON_2", 3);
    assert.equal(EscalationTalentPoints(Season2, Tiers123), 21);
    const Free = Tal("ESC_TALENT_S2_TIER6_SPECIAL_UNLOCKTWO", 1);
    assert.equal(CheckEscalationTalents(Season2, [Free], 25).ok, false);
    assert.deepEqual(CheckEscalationTalents(Season2, [...Tiers123, Free], 25), { ok: true, points: 21 });
    assert.deepEqual(CheckEscalationTalents(Season2, [...Tiers123, Free], 21), { ok: true, points: 21 });
    assert.equal(CheckEscalationTalents(Season2, [...Tiers123, Free], 20).ok, false);
});

test("unlocks on the real ids: collected only from the reward's level, and nothing outside the season's six", { skip: Skip }, () => {
    const Data = Season("ESC_SEASON_4");
    for (const [Reward, Level] of Object.entries(UNLOCK_LEVELS)) {
        assert.equal(FilterEscalationUnlocks(Data, [Rew(Reward, true)], Level).rejected, 0, `${Reward} at ${Level}`);
        assert.equal(FilterEscalationUnlocks(Data, [Rew(Reward, true)], Level - 1).rejected, 1, `${Reward} at ${Level - 1}`);
        assert.equal(FilterEscalationUnlocks(Data, [Rew(Reward, false)], 0).rejected, 0, `${Reward} uncollected`);
    }
    assert.equal(FilterEscalationUnlocks(Data, [Rew("ESC_Reward_1", false), Rew("ESC_Reward_8", false), Rew("ESC_REWARD_3", false)], 25).rejected, 3);

    // The level-25 armour set (ESC_Reward_7) cannot be collected from level 24, but can in the write that reaches 25.
    const Previous = Stored("ESC_SEASON_4", 24, 100, [], [Rew("ESC_Reward_6", true)]);
    const Early = Host("ESC_SEASON_4", Previous, { unlock_progress: [Rew("ESC_Reward_6", true), Rew("ESC_Reward_7", true)] });
    assert.deepEqual(Early.record.unlockProgress, [Rew("ESC_Reward_6", true)]);
    assert.equal(Early.summary.unlocks.ignored, 1);
    const Reached = Host("ESC_SEASON_4", Previous, { escalation_level: 25, next_level_xp: 0, unlock_progress: [Rew("ESC_Reward_6", true), Rew("ESC_Reward_7", true)] });
    assert.deepEqual(Reached.record.unlockProgress, [Rew("ESC_Reward_6", true), Rew("ESC_Reward_7", true)]);
});
