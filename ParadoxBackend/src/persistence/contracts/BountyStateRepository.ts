/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession } from "mongodb";
import { BountyStateRecord } from "../mapping/domainTypes";

export interface BountyStateRepository {
    /** `session` lets a reward grant read and mark the funding claim inside its own inventory transaction. */
    get(userId: string, session?: ClientSession): Promise<BountyStateRecord | undefined>;

    /**
     * Creates or replaces the account's bounty state with optimistic concurrency, like
     * EscalationProgressRepository.saveIfVersion: `expectedVersion === undefined` means "insert only"; otherwise the
     * write succeeds only when the stored updateVersion equals it. A conflict returns undefined so the caller can
     * re-read, merge and retry (the game server sends several bounty saves within milliseconds).
     */
    saveIfVersion(record: BountyStateRecord, expectedVersion: number | undefined, session?: ClientSession): Promise<BountyStateRecord | undefined>;
}
