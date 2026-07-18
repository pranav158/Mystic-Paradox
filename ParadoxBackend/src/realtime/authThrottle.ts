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



interface Entry {
    failures: number;
    blockedUntil: number;
    lastFailure: number;
}

const byIp = new Map<string, Entry>();

const MAX_FAILURES = 5; 
const DECAY_MS = 5 * 60_000; 
const BASE_BLOCK_MS = 5_000; 
const MAX_BLOCK_MS = 10 * 60_000;

export function isAuthThrottled(ip: string): boolean {
    const e = byIp.get(ip);
    return e !== undefined && Date.now() < e.blockedUntil;
}

export function recordAuthFailure(ip: string): void {
    const now = Date.now();
    let e = byIp.get(ip);
    if (e === undefined || now - e.lastFailure > DECAY_MS) {
        e = { failures: 0, blockedUntil: 0, lastFailure: now };
    }
    e.failures += 1;
    e.lastFailure = now;
    if (e.failures >= MAX_FAILURES) {
        const over = e.failures - MAX_FAILURES;
        e.blockedUntil = now + Math.min(BASE_BLOCK_MS * 2 ** over, MAX_BLOCK_MS);
    }
    byIp.set(ip, e);
}

export function recordAuthSuccess(ip: string): void {
    byIp.delete(ip);
}
