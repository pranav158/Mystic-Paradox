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

// [2026-07-30] `skuProgression` is the second grant kind a store SKU can carry
// (FOnlineStorePhoenixOffer::GrantedProgress = {TrackId, Amount, Ranks}). It appears in two forms in
// the real captures:
//
//   {"progressionId": "d24_season1",       "xp": 2000, "ranks": null}   Elite Track bundles
//   {"progressionId": "selected_huntpass", "xp": null, "ranks": 20}     hp_level_skip_*_ranks
//
// The `xp` form is a plain increment. The `ranks` form is NOT: "skip 20 ranks" has to become an XP
// delta, because `progressionTracks.progress` stores XP and the rank curve is non-linear (requirement
// rows are INCREMENTAL per-rank costs - see controllers/progression.ts's BuildTrackCurves and
// tools/CatalogExporter/ExportFlags.md). The conversion here is deterministic given the curve and the
// player's current progress: advance to the cumulative XP threshold of (current rank + N), clamped
// to the track's max rank.
//
// This is a RECONSTRUCTED rule, not a captured one - no live rank-skip purchase has ever been
// observed against this server. It is deliberately conservative: it never grants more XP than the
// curve says those ranks cost, and it can only move progress forward. See
// Progress/33_PLATINUM_STORE.md.
//
// Pure module (no Mongo, no config import) so the arithmetic is unit-testable in isolation; the
// caller supplies the curve.

export type RankCurve = {
    maxRank: number;
    /** rank -> cumulative XP required to have reached that rank. */
    cumulativeXpForRank: Map<number, number>;
};

export type SkuProgression = {
    progressionId?: string | null;
    xp?: number | null;
    ranks?: number | null;
};

export type ProgressionGrantPlan =
    | { kind: "none"; reason: "no_progression" | "no_amount" | "already_max_rank" }
    | { kind: "xp"; progressionId: string; xp: number }
    | { kind: "ranks"; progressionId: string; xp: number; fromRank: number; toRank: number };

/** Highest rank whose cumulative XP threshold is already met by `progress`. 0 = below rank 1. */
export function RankForProgress(curve: RankCurve, progress: number): number {
    let Rank = 0;
    for (const [Candidate, Threshold] of curve.cumulativeXpForRank) {
        if (progress >= Threshold && Candidate > Rank) {
            Rank = Candidate;
        }
    }
    return Rank;
}

/**
 * Resolves a SKU's `skuProgression` payload into a single progression increment.
 *
 * `resolveTrackId` maps the SKU's symbolic track id to a real one - `selected_huntpass` is not a
 * track, it means "whichever Hunt Pass is currently selected" (the active season; our
 * GET /huntpass/:userId answers `season43` on 1.14.7, `season19` on 1.12). Returning undefined from it means "unknown track",
 * which yields a no-op plan rather than a guessed grant.
 */
export function ResolveProgressionGrant(
    progression: SkuProgression | null | undefined,
    currentProgress: number,
    resolveTrackId: (progressionId: string) => string | undefined,
    getCurve: (progressionId: string) => RankCurve | undefined
): ProgressionGrantPlan {
    const RawTrackId = progression?.progressionId;
    if (typeof RawTrackId !== "string" || RawTrackId.length === 0) {
        return { kind: "none", reason: "no_progression" };
    }

    const TrackId = resolveTrackId(RawTrackId);
    if (TrackId == undefined || TrackId.length === 0) {
        return { kind: "none", reason: "no_progression" };
    }

    const Xp = Math.trunc(Number(progression?.xp ?? 0)) || 0;
    const Ranks = Math.trunc(Number(progression?.ranks ?? 0)) || 0;

    // A SKU carrying both is not something any capture shows; XP wins because it is the exact,
    // non-derived quantity.
    if (Xp > 0) {
        return { kind: "xp", progressionId: TrackId, xp: Xp };
    }

    if (Ranks <= 0) {
        return { kind: "none", reason: "no_amount" };
    }

    const Curve = getCurve(TrackId);
    if (Curve == undefined) {
        // No curve for this track means no defensible rank->XP conversion. Refuse rather than
        // invent one (a linear guess would silently over- or under-grant).
        return { kind: "none", reason: "no_progression" };
    }

    const FromRank = RankForProgress(Curve, currentProgress);
    if (FromRank >= Curve.maxRank) {
        return { kind: "none", reason: "already_max_rank" };
    }

    const ToRank = Math.min(FromRank + Ranks, Curve.maxRank);
    const Threshold = Curve.cumulativeXpForRank.get(ToRank);
    if (Threshold == undefined) {
        return { kind: "none", reason: "no_progression" };
    }

    const Delta = Threshold - currentProgress;
    if (Delta <= 0) {
        return { kind: "none", reason: "no_amount" };
    }

    return { kind: "ranks", progressionId: TrackId, xp: Delta, fromRank: FromRank, toRank: ToRank };
}
