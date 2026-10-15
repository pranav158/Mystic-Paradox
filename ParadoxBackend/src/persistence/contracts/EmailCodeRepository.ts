/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The live one-time code of an account for one purpose: "verify" (email verification), "reset" (password reset) or "unlink"
// (confirming the unlink of Discord). There is at most one row per account and purpose (the Mongo _id and the SQLite _id are
// "<userId>:<purpose>"). Only the HMAC of the
// code is stored (security/emailCodes.ts). A row is removed when its code is accepted, when it runs out of tries, when it expires,
// or when the account is erased; the expiry (ttlAt) also lets the database purge a row nothing removed.

// [2026-10-15] "unlink": the code that confirms unlinking Discord from a signed-in account.
export type EmailCodePurpose = "verify" | "reset" | "unlink";

export interface EmailCodeRecord {
    userId: string;
    purpose: EmailCodePurpose;
    /** HMAC-SHA256 of the code (EmailCodeHash); the code itself is never stored. */
    codeHash: string;
    /** Tries counted against this code so far (a try is counted before the code is compared). */
    attempts: number;
    createdAt: string;
    /** ISO time after which the code is refused and removed. */
    expiresAt: string;
}

export interface EmailCodeRepository {
    /** Stores the live code of the account and purpose, replacing any code issued before it. */
    replace(record: EmailCodeRecord): Promise<void>;

    /**
     * Reads the live code (a read only, nothing is written): the code while it has not expired and has tries left, else undefined. The
     * caller compares the hash, then uses the code with consume.
     */
    peekLive(userId: string, purpose: EmailCodePurpose, nowIso: string, maxTries: number): Promise<EmailCodeRecord | undefined>;

    /**
     * Uses the code in one conditional write: the row is removed only while it still holds this hash, has not expired and has tries left.
     * This is the write that verifies and consumes a right code at once, so a second use, or a parallel one, finds nothing. Returns whether
     * this call used it.
     */
    consume(userId: string, purpose: EmailCodePurpose, codeHash: string, nowIso: string, maxTries: number): Promise<boolean>;

    /**
     * Counts one try against the live code in one atomic write: only while it has not expired and has tries left, so parallel wrong guesses
     * cannot exceed the limit. Returns the code as it stands after the try. When it cannot be tried (no code, expired, or out of tries) it
     * returns undefined, and a row that has expired or run out of tries is removed in the same write.
     */
    reserveTry(userId: string, purpose: EmailCodePurpose, nowIso: string, maxTries: number): Promise<EmailCodeRecord | undefined>;

    /**
     * Removes the code only while it is still the one with this hash (a code that ran out of tries is discarded this way). Returns whether
     * this call removed it.
     */
    remove(userId: string, purpose: EmailCodePurpose, codeHash: string): Promise<boolean>;

    /** Removes every code of the account (the registration sweep, the account erasure). Returns how many were removed. */
    deleteForUser(userId: string): Promise<number>;
}
