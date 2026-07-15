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

import { ProgressionTrackRecord, ProgressionObjectiveEventRecord, ProgressionObjectiveRecord } from "../mapping/domainTypes";










export interface ProgressionTrackRepository {
    getAllForUser(userId: string): Promise<ProgressionTrackRecord[]>;

    get(userId: string, progressionId: string): Promise<ProgressionTrackRecord | undefined>;

    
    increment(userId: string, progressionId: string, amount: number): Promise<ProgressionTrackRecord>;

    
    setProgressIfGreater(userId: string, progressionId: string, value: number): Promise<ProgressionTrackRecord>;

    
    setConfirmedFremiumRank(userId: string, progressionId: string, rank: number): Promise<ProgressionTrackRecord>;

    
    appendObjectiveEvent(event: ProgressionObjectiveEventRecord): Promise<void>;

    getAllObjectivesForUser(userId: string): Promise<ProgressionObjectiveRecord[]>;

    
    setObjectiveIfGreater(userId: string, objectiveId: string, value: number, completedCount: number): Promise<ProgressionObjectiveRecord>;
}
