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

import { PlayerJourneyRecord } from "../mapping/domainTypes";

// Repository contract for the `playerjourney` table (Slayer's Path / PJM).
//
// The client-facing updateVersion is retained for wire compatibility; revision is a server-owned
// CAS token and must advance on every successful replacement, including stale-version merges.
export interface PlayerJourneyRepository {
    findByUserId(userId: string): Promise<PlayerJourneyRecord | undefined>;

    /** Inserts only when the account has no journey row; returns false on a concurrent insert. */
    createIfAbsent(record: PlayerJourneyRecord): Promise<boolean>;

    /** Replaces the blob and advances server revision only when expectedRevision still matches. */
    updateIfRevision(userId: string, nodesJson: string, updateVersion: number, expectedRevision: number): Promise<boolean>;
}
