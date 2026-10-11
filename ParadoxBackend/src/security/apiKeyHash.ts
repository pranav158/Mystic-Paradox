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

// [2026-10-09, ported from the public repo's August security follow-ups] API keys (gameserver and user) are stored
// as HMAC-SHA256 under a server-side secret, domain-separated by scope, instead of a plain SHA-256. A copy of the
// key collections alone no longer lets anyone test guesses offline, which matters while a key is human-chosen.
//
// [2026-10-11] Records written before this change (plain SHA-256) no longer match: the migration fallback and its
// API_KEY_LEGACY_SHA256 switch are gone. Register such a key again (GAMESERVER_API_KEYS, or the keys-to-register
// collection drained at boot) to store its HMAC form.
import crypto from "node:crypto";

const MIN_SECRET_LENGTH = 32;

function ApiKeyHashSecret(): Buffer {
    const secret = process.env.API_KEY_HASH_SECRET?.trim();
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
        throw new Error("API_KEY_HASH_SECRET must contain at least 32 characters.");
    }
    return Buffer.from(secret, "utf8");
}

/** Fails fast at startup instead of on the first gameserver request. */
export function AssertApiKeyHashSecret(): void {
    ApiKeyHashSecret();
}

export function HashApiKey(value: string, scope: "gameserver" | "user"): string {
    return crypto
        .createHmac("sha256", ApiKeyHashSecret())
        .update(scope, "utf8")
        .update("\0")
        .update(value, "utf8")
        .digest("hex");
}

/** Constant-time comparison of one hex hash against stored records; returns the first match. */
export function FindApiKeyRecord<T extends { keyHash?: string | null }>(records: T[], hashHex: string): T | undefined {
    const Incoming = Buffer.from(hashHex, "hex");
    let Found: T | undefined;
    for (const Record of records) {
        if (!Record.keyHash) continue;
        const Stored = Buffer.from(Record.keyHash, "hex");
        if (Stored.length !== Incoming.length) continue;
        if (crypto.timingSafeEqual(Incoming, Stored) && Found === undefined) Found = Record;
    }
    return Found;
}
