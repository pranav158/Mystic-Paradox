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

import { EncounteredContentRecord } from "../mapping/domainTypes";

// Repository contract for the `encounteredcontent` table.
//
// Covers every current call site in controllers/progression.ts:
// QueryEncounteredContent (find + in-memory filter/group), AddEncounteredContent
// (find-or-create, then read-append-rewrite).
export interface EncounteredContentRepository {
    findByCharacterIdAndUserId(characterId: string, userId: string): Promise<EncounteredContentRecord | undefined>;

    create(record: EncounteredContentRecord): Promise<void>;

    updateContent(characterId: string, userId: string, encounteredContentJson: string): Promise<void>;
}
