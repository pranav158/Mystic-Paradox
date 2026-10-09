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
import { ProgressionGrantRecord } from "../mapping/domainTypes";

/** Exactly-once ledger for authoritative progression grants. */
export interface ProgressionGrantRepository {
    findByGrantId(grantId: string, session?: ClientSession): Promise<ProgressionGrantRecord | undefined>;
    insertApplied(record: ProgressionGrantRecord, session: ClientSession): Promise<void>;
}
