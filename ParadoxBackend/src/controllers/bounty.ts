/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { BountyMergeSummary, BountyStatePayload, MergeBountyState } from "../bountyState";
import { BountyStateRecord, GetRepositories } from "../persistence";
import { PerAccountQueue } from "./perAccountQueue";

const MAX_SAVE_ATTEMPTS = 8;

// The game server posts several bounty saves within milliseconds (one per bounty component, plus single-bounty
// progress updates); they are applied one at a time per account.
const SaveQueue = new PerAccountQueue();

export async function GetBountyState(userId: string): Promise<{ payload: Record<string, unknown>; record: BountyStateRecord | undefined }> {
    const Record = await GetRepositories().bountyStates.get(userId);
    return { payload: BountyStatePayload(Record), record: Record };
}

export function SaveBountyState(userId: string, body: unknown): Promise<{ payload: Record<string, unknown>; record: BountyStateRecord; summary: BountyMergeSummary }> {
    return SaveQueue.run(userId, async () => {
        const Repository = GetRepositories().bountyStates;
        for (let Attempt = 0; Attempt < MAX_SAVE_ATTEMPTS; Attempt++) {
            const Previous = await Repository.get(userId);
            const { record, summary } = MergeBountyState(userId, Previous, body);
            const Saved = await Repository.saveIfVersion(record, Previous?.updateVersion);
            if (Saved !== undefined) {
                return { payload: BountyStatePayload(Saved), record: Saved, summary };
            }
        }
        throw new Error(`Bounty state save remained contended for ${userId}`);
    });
}
