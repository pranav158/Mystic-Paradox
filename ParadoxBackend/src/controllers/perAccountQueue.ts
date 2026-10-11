/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Runs `work` after every earlier queued work for the same key has settled. The game server posts several saves of one
// account's document within milliseconds; applying them one at a time in this process avoids version-conflict retries
// (the versioned writes still protect against a second backend instance).
export class PerAccountQueue {
    private readonly Queues = new Map<string, Promise<unknown>>();

    run<T>(key: string, work: () => Promise<T>): Promise<T> {
        const Previous = this.Queues.get(key) ?? Promise.resolve();
        const Next = Previous.catch(() => undefined).then(work);
        this.Queues.set(key, Next);
        Next.finally(() => {
            if (this.Queues.get(key) === Next) this.Queues.delete(key);
        }).catch(() => undefined);
        return Next;
    }
}
