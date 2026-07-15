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












export interface LoadoutRepository {
    findByCharacterIdAndUserId(characterId: string, userId: string, session?: ClientSession): Promise<LoadoutRecord | undefined>;

    create(loadout: LoadoutRecord, session?: ClientSession): Promise<void>;

    
    replaceSlotIfRevisionMatches(characterId: string, userId: string, slotIndex: number, dataJson: string, expectedRevision: number): Promise<boolean>;

    
    replaceAllAndEntitlementIfRevisionMatches(characterId: string, userId: string, loadoutsJson: string, unlockedTotalSlots: number, expectedRevision: number): Promise<boolean>;

    
    updatePersistentIfRevisionMatches(characterId: string, userId: string, persistentJson: string, expectedRevision: number): Promise<boolean>;
}
