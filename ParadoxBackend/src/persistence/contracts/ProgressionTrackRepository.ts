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

import { ClientSession } from "mongodb";
import { ProgressionTrackRecord, ProgressionObjectiveEventRecord, ProgressionObjectiveRecord } from "../mapping/domainTypes";

// Repository contract for WP-1 (Plans/PROGRESSION_XP_COMBAT_DATA_IMPLEMENTATION_PLAN.md
// section 5.2). Covers the `progressionTracks` collection (raw per-track XP totals), the
// `progressionObjectives` collection (resolved mastery/objective state), and the
// `progressionObjectiveEvents` append-only raw-capture log (section 6.3 stage 1).
//
// Delta-vs-absolute semantics for mastery/objectives were PROVEN from real sequential traffic
// (not guessed) — see ProgressionObjectiveRecord's doc comment in domainTypes.ts. Rank
// calculation and reward resolution still depend on validated 1.12 rank-table definitions this
// phase does not yet have (plan Phase 5+) and remain out of scope here.
export interface ProgressionTrackRepository {
    getAllForUser(userId: string): Promise<ProgressionTrackRecord[]>;

    get(userId: string, progressionId: string, session?: ClientSession): Promise<ProgressionTrackRecord | undefined>;

    /**
     * Atomically applies `amount` to the track's `progress`, creating the row (starting from 0)
     * if it doesn't exist yet. Returns the row AFTER the increment is applied, so callers can log
     * old/new totals (plan section 12's `[ProgressionGrant]` log line) from one round trip.
     *
     * Accepts an optional session so a store purchase can grant `skuProgression` inside the same
     * Mongo transaction as its currency debit (see controllers/store.ts) - a rank skip that commits
     * while the platinum charge rolls back, or vice versa, would be worse than either failing.
     */
    increment(userId: string, progressionId: string, amount: number, session?: ClientSession): Promise<ProgressionTrackRecord>;

    /**
     * Sets the track's `progress` to `value` ONLY if `value` is greater than what's stored
     * (monotonic max-guard) — used for MasteryTrack_* progress_tracks entries, which report
     * absolute rank/tier numbers, not deltas (proven from real traffic, see
     * ProgressionObjectiveRecord's doc comment). A stale/out-of-order request can never regress
     * progress with this rule. Returns the row after the (possible) update.
     */
    setProgressIfGreater(userId: string, progressionId: string, value: number): Promise<ProgressionTrackRecord>;

    /**
     * Persists confirmedFremiumRank using a monotonic max-guard ($max) — never touches `progress`
     * or confirmedPremiumRank. Fixes a real bug (confirmed via live repro) where the rank-confirm
     * route was returning the rank NUMBER in the `progress` field, which the client trusts and
     * uses to overwrite its cached XP total, visibly clobbering e.g. 250 XP down to "3" (the
     * rank). The $max guard is a second layer against replay/reordering — callers (see
     * ConfirmPublicProgressionRank) MUST validate the rank is in-range and the account's
     * persisted XP qualifies for it BEFORE calling this; this method does not re-validate either.
     * If the track row doesn't exist yet (confirm called before any grant — shouldn't normally
     * happen but must be handled without fabricating a progress value), creates it with
     * progress:0 rather than inventing a number.
     */
    setConfirmedFremiumRank(userId: string, progressionId: string, rank: number): Promise<ProgressionTrackRecord>;

    /** Appends one raw mastery/objective event. Append-only — never updates or dedupes here. */
    appendObjectiveEvent(event: ProgressionObjectiveEventRecord): Promise<void>;

    getAllObjectivesForUser(userId: string): Promise<ProgressionObjectiveRecord[]>;

    /**
     * Resolved-state counterpart to setProgressIfGreater, for individual mastery/achievement
     * objectives (MasteryObjective_*, AchievementObjective_*). Same monotonic max-guard rule,
     * applied to both `value` and `completedCount` independently. Returns the row after the
     * (possible) update.
     */
    setObjectiveIfGreater(userId: string, objectiveId: string, value: number, completedCount: number): Promise<ProgressionObjectiveRecord>;

    /**
     * [hardening 2026-07-26] Atomically applies `-amount` to `progress` via Mongo's native $inc,
     * filter-guarded so it only applies if the current progress is >= `amount` (same shape as
     * WalletRepository.incrementBalance's overspend guard) — never a read-modify-write, and never
     * lets progress go negative. Returns `undefined` if the filter doesn't match (insufficient
     * banked progress, or the track doesn't exist), so the caller can reject rather than clamp.
     * Accepts a session so this can participate in the same atomic transaction as a currency
     * grant it is meant to fund (see wallet.ts's SpendBankedPrestigeForReward) — a reward must
     * never be creditable without its backing progress being consumed in the same commit.
     */
    spend(userId: string, progressionId: string, amount: number, session?: ClientSession): Promise<ProgressionTrackRecord | undefined>;
}
