/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { EscalationProgressRecord } from "../mapping/domainTypes";

export interface EscalationProgressRepository {
    get(userId: string, seasonId: string): Promise<EscalationProgressRecord | undefined>;

    /**
     * Creates or replaces one season record with optimistic concurrency.
     *
     * `expectedVersion === undefined` means "insert only". For an existing row, the write
     * succeeds only when its current updateVersion equals expectedVersion. A conflict returns
     * undefined so the caller can re-read, merge, and retry without losing a concurrent update.
     */
    saveIfVersion(
        record: EscalationProgressRecord,
        expectedVersion: number | undefined
    ): Promise<EscalationProgressRecord | undefined>;
}
