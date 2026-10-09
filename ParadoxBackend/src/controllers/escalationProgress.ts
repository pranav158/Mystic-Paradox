/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import {
    EscalationSeasonProgressUpdate,
    MergeEscalationProgress,
    RecordToEscalationPayload
} from "../escalationProgress";
import { GetRepositories } from "../persistence";

const MAX_SAVE_ATTEMPTS = 8;

export async function GetEscalationProgress(userId: string, seasonId: string) {
    const Record = await GetRepositories().escalationProgress.get(userId, seasonId);
    return RecordToEscalationPayload(Record);
}

export async function SaveEscalationProgress(
    userId: string,
    seasonId: string,
    Update: EscalationSeasonProgressUpdate
) {
    const Repository = GetRepositories().escalationProgress;

    for (let Attempt = 0; Attempt < MAX_SAVE_ATTEMPTS; Attempt++) {
        const Previous = await Repository.get(userId, seasonId);
        const Next = MergeEscalationProgress(userId, seasonId, Previous, Update);
        const Saved = await Repository.saveIfVersion(Next, Previous?.updateVersion);

        if (Saved !== undefined) {
            return RecordToEscalationPayload(Saved);
        }
    }

    throw new Error(`Escalation progress save remained contended for ${userId}/${seasonId}`);
}
