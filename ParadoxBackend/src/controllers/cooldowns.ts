/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { CooldownEntry, CooldownList, CooldownStatePayload, MergeCooldownState } from "../cooldownState";
import { CooldownStateRecord, GetRepositories } from "../persistence";
import { PerAccountQueue } from "./perAccountQueue";

const MAX_SAVE_ATTEMPTS = 8;
const SaveQueue = new PerAccountQueue();

export interface CooldownResult {
    payload: Record<string, string>;   // the wire payload (id -> ISO date map)
    list: CooldownEntry[];             // the same cooldowns as a list, for logs
}

export async function GetCooldownState(userId: string): Promise<CooldownResult & { record: CooldownStateRecord | undefined }> {
    const Record = await GetRepositories().cooldownStates.get(userId);
    return { payload: CooldownStatePayload(Record), list: CooldownList(Record), record: Record };
}

export function SaveCooldowns(userId: string, body: unknown): Promise<CooldownResult & { record: CooldownStateRecord }> {
    return SaveQueue.run(userId, async () => {
        const Repository = GetRepositories().cooldownStates;
        for (let Attempt = 0; Attempt < MAX_SAVE_ATTEMPTS; Attempt++) {
            const Previous = await Repository.get(userId);
            const Next = MergeCooldownState(userId, Previous, body);
            const Saved = await Repository.saveIfVersion(Next, Previous?.updateVersion);
            if (Saved !== undefined) return { payload: CooldownStatePayload(Saved), list: CooldownList(Saved), record: Saved };
        }
        throw new Error(`Cooldown save remained contended for ${userId}`);
    });
}
