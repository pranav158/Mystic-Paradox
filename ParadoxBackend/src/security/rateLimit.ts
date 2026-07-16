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







const Windows = new Map<string, number[]>();

export function IsRateLimited(key: string, maxAttempts: number, windowMs: number): boolean {
    const Now = Date.now();
    const Attempts = (Windows.get(key) ?? []).filter((t) => Now - t < windowMs);

    if (Attempts.length >= maxAttempts) {
        Windows.set(key, Attempts);
        return true;
    }

    Attempts.push(Now);
    Windows.set(key, Attempts);
    return false;
}
