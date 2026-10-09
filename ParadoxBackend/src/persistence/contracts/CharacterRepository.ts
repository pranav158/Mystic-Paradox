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
import { CharacterRecord } from "../mapping/domainTypes";

// Repository contract for the `characters` table.
//
// Covers every current call site in controllers/character.ts: GetCharactersForUid,
// CreateCharacterForUid, UpdateCharacterForUid (optimistic-concurrency guarded
// update), GetCharacterWithUid, and the IsFreshOnboarding helper.
//
// NOTE: The optimistic-concurrency semantics (reject if stale unless gameserver,
// force-advance for gameserver writes, monotonic progression-guard) live in
// controllers/character.ts and are NOT part of this contract. The repository
// exposes a plain conditional update; the business rule for "what expected
// version to use" stays in the controller/service layer per plan section 7.4
// ("Controllers should orchestrate... Services enforce business rules.
// Repositories own persistence details.").
export interface CharacterRepository {
    findManyByUserId(userId: string, session?: ClientSession): Promise<CharacterRecord[]>;

    findByCharacterIdAndUserId(characterId: string, userId: string, session?: ClientSession): Promise<CharacterRecord | undefined>;

    create(character: CharacterRecord, session?: ClientSession): Promise<CharacterRecord>;

    /**
     * Conditional update: only writes if the row's current updateVersion is
     * strictly less than `effectiveVersion` (this predicate originally mirrored the
     * pre-migration Drizzle `lt(characters.updateVersion, EffectiveVersion)` clause;
     * the MongoDB implementation now enforces it directly via a query filter).
     * Returns void — current code does not check affected-row count; a stricter
     * matched-row/optimistic-concurrency check is still open follow-up work.
     */
    updateDataConditional(
        characterId: string,
        userId: string,
        data: string,
        effectiveVersion: number
    ): Promise<void>;
}
