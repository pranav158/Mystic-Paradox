/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RankCurve, RankForProgress, ResolveProgressionGrant } from "./skuProgression";

// A deliberately NON-linear curve, because that is the whole reason rank skips cannot be a
// multiplication: rank 1 costs 100, rank 2 another 200, rank 3 another 300.
const Curve: RankCurve = {
    maxRank: 4,
    cumulativeXpForRank: new Map([
        [1, 100],
        [2, 300],
        [3, 600],
        [4, 1000],
    ]),
};

const ResolveTrack = (id: string) => (id === "selected_huntpass" ? "season19" : id === "season19" ? "season19" : undefined);
const GetCurve = (id: string) => (id === "season19" ? Curve : undefined);

test("an xp-form SKU grants exactly the captured amount", () => {
    const Plan = ResolveProgressionGrant({ progressionId: "season19", xp: 2000, ranks: null }, 50, ResolveTrack, GetCurve);

    assert.deepEqual(Plan, { kind: "xp", progressionId: "season19", xp: 2000 });
});

test("selected_huntpass resolves to the active season track", () => {
    const Plan = ResolveProgressionGrant({ progressionId: "selected_huntpass", xp: null, ranks: 1 }, 0, ResolveTrack, GetCurve);

    assert.equal(Plan.kind, "ranks");
    assert.equal(Plan.kind === "ranks" && Plan.progressionId, "season19");
});

test("a rank skip grants the curve's real cost, not a linear guess", () => {
    // At 100 xp the player is rank 1; skipping 2 ranks must reach rank 3's threshold of 600.
    const Plan = ResolveProgressionGrant({ progressionId: "selected_huntpass", xp: null, ranks: 2 }, 100, ResolveTrack, GetCurve);

    assert.deepEqual(Plan, { kind: "ranks", progressionId: "season19", xp: 500, fromRank: 1, toRank: 3 });
});

test("a rank skip from mid-rank only pays the remaining distance", () => {
    // 250 xp is still rank 1 (rank 2 needs 300). One rank => reach 300, i.e. +50, not +200.
    const Plan = ResolveProgressionGrant({ progressionId: "season19", xp: null, ranks: 1 }, 250, ResolveTrack, GetCurve);

    assert.deepEqual(Plan, { kind: "ranks", progressionId: "season19", xp: 50, fromRank: 1, toRank: 2 });
});

test("a rank skip past the top of the track clamps to max rank", () => {
    const Plan = ResolveProgressionGrant({ progressionId: "season19", xp: null, ranks: 100 }, 0, ResolveTrack, GetCurve);

    assert.deepEqual(Plan, { kind: "ranks", progressionId: "season19", xp: 1000, fromRank: 0, toRank: 4 });
});

test("a player already at max rank gets no grant rather than overshooting the curve", () => {
    const Plan = ResolveProgressionGrant({ progressionId: "season19", xp: null, ranks: 10 }, 1000, ResolveTrack, GetCurve);

    assert.deepEqual(Plan, { kind: "none", reason: "already_max_rank" });
});

test("an unknown track grants nothing instead of inventing a conversion", () => {
    const Plan = ResolveProgressionGrant({ progressionId: "d24_season1", xp: null, ranks: 5 }, 0, ResolveTrack, GetCurve);

    assert.deepEqual(Plan, { kind: "none", reason: "no_progression" });
});

test("a track with no curve refuses a rank skip but still allows a plain xp grant", () => {
    const NoCurve = (id: string) => undefined;

    assert.deepEqual(
        ResolveProgressionGrant({ progressionId: "season19", xp: null, ranks: 5 }, 0, ResolveTrack, NoCurve),
        { kind: "none", reason: "no_progression" }
    );
    assert.deepEqual(
        ResolveProgressionGrant({ progressionId: "season19", xp: 500, ranks: null }, 0, ResolveTrack, NoCurve),
        { kind: "xp", progressionId: "season19", xp: 500 }
    );
});

test("an absent or empty progression payload is a no-op", () => {
    assert.deepEqual(ResolveProgressionGrant(null, 0, ResolveTrack, GetCurve), { kind: "none", reason: "no_progression" });
    assert.deepEqual(ResolveProgressionGrant({ progressionId: "season19", xp: 0, ranks: 0 }, 0, ResolveTrack, GetCurve), { kind: "none", reason: "no_amount" });
});

test("RankForProgress reports the highest threshold actually met", () => {
    assert.equal(RankForProgress(Curve, 0), 0);
    assert.equal(RankForProgress(Curve, 99), 0);
    assert.equal(RankForProgress(Curve, 100), 1);
    assert.equal(RankForProgress(Curve, 599), 2);
    assert.equal(RankForProgress(Curve, 5000), 4);
});
