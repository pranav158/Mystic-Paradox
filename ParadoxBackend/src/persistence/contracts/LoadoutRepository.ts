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
import { LoadoutRecord } from "../mapping/domainTypes";

// Repository contract for the `loadouts` table.
//
// Covers the current call sites in controllers/loadout.ts: GetAllLoadoutsForUserIdAndCharacterId,
// GetPersistentLoadoutForUserIdAndCharacterId, character-slot unlocks, and
// SetLoadoutDataForUserIdAndCharacterId (numeric slot and "persistent" paths).
//
// [hardening 2026-07-14] The unconditional whole-blob writers (updateLoadouts / updatePersistent /
// replaceSlotZero) were REMOVED: their only callers were the passive GET-time normalize/backfill
// paths, which have been deleted (bootstrap recovery is now transactional and never rewrites a
// live loadout on read). Every remaining writer is optimistic-concurrency-guarded, so no code
// path can silently clobber a concurrent writer's loadout changes.
export interface LoadoutRepository {
    findByCharacterIdAndUserId(characterId: string, userId: string, session?: ClientSession): Promise<LoadoutRecord | undefined>;

    create(loadout: LoadoutRecord, session?: ClientSession): Promise<void>;

    /**
     * [hardening] Optimistic-concurrency-guarded numeric-slot replace for the real player-facing
     * write path. Only applies if the requested slot already exists and the row's CURRENT
     * revision equals `expectedRevision`; the new revision is `expectedRevision + 1`. Returns
     * `true` if applied, `false` if the filter didn't match (row missing, or a concurrent writer
     * already changed the row since the caller last read it — caller should re-read and retry,
     * not blindly overwrite).
     */
    replaceSlotIfRevisionMatches(characterId: string, userId: string, slotIndex: number, dataJson: string, expectedRevision: number): Promise<boolean>;

    /** Replaces the complete stored loadout array and its visible total-slot entitlement under
     * the same revision guard. Excess legacy slot contents may remain stored but dormant. */
    replaceAllAndEntitlementIfRevisionMatches(characterId: string, userId: string, loadoutsJson: string, unlockedTotalSlots: number, expectedRevision: number): Promise<boolean>;

    /** [hardening] Optimistic-concurrency-guarded persistent replace, same semantics as
     *  replaceSlotIfRevisionMatches above, for the "persistent" index write path. */
    updatePersistentIfRevisionMatches(characterId: string, userId: string, persistentJson: string, expectedRevision: number): Promise<boolean>;

    /** Persists the zero-based active gameplay slot under the same revision guard. The
     * implementation rejects locked/nonexistent slots and treats an unchanged value as success. */
    updateActiveIndexIfRevisionMatches(characterId: string, userId: string, activeIndex: number, expectedRevision: number): Promise<boolean>;
}
