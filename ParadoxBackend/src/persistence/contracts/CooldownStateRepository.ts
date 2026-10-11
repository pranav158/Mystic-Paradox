/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { CooldownStateRecord } from "../mapping/domainTypes";

export interface CooldownStateRepository {
    get(userId: string): Promise<CooldownStateRecord | undefined>;

    /** Optimistic-concurrency write, like BountyStateRepository.saveIfVersion (undefined on a version conflict). */
    saveIfVersion(record: CooldownStateRecord, expectedVersion: number | undefined): Promise<CooldownStateRecord | undefined>;
}
