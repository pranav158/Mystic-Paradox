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
import { InventoryRecord } from "../mapping/domainTypes";

// Repository contract for the `inventories` table.
//
// Covers the current call sites in controllers/inventory.ts: UpdateInstancedItem,
// RunInventoryTransaction, GetInventoryForUserIdAndCharacterId, and the transactional bootstrap
// recovery in starterManifest.ts.
//
// [hardening 2026-07-14] The unconditional whole-blob writers (updateInstancedItems /
// updateStackedItems / updateBoth) were REMOVED: every inventory mutation now goes through the
// revision-guarded updateBothIfRevisionMatches, so no writer can silently clobber a concurrent
// gatherable/reward/transaction write.
export interface InventoryRepository {
    findByCharacterId(characterId: string, session?: ClientSession): Promise<InventoryRecord | undefined>;

    create(inventory: InventoryRecord, session?: ClientSession): Promise<void>;

    /**
     * [hardening] Optimistic-concurrency-guarded full-inventory write — the ONLY mutation path.
     * Only applies if the row's CURRENT revision equals `expectedRevision` (the revision the
     * caller read before computing its changes); the new revision is `expectedRevision + 1`.
     * Returns the updated record on success, or `undefined` if the filter didn't match — either
     * the row doesn't exist, or (far more likely) someone else's write landed first and bumped the
     * revision, meaning the caller's in-memory read-modify-write is now stale and must be retried
     * against fresh data rather than applied blindly.
     */
    updateBothIfRevisionMatches(
        characterId: string,
        instancedItemsJson: string,
        stackedItemsJson: string,
        expectedRevision: number,
        session?: ClientSession
    ): Promise<InventoryRecord | undefined>;
}
