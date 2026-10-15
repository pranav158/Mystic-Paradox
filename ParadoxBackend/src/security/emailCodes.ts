/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The one-time codes of email verification (purpose "verify"), password reset ("reset") and the Discord unlink ("unlink"). A code is 6 digits, valid
// EMAIL_CODE_TTL_MINUTES from when it is issued, accepted once, and refused after EMAIL_CODE_MAX_TRIES wrong tries. The codes are
// stored only as HMAC-SHA256 (HashEmailCode, under the API_KEY_HASH_SECRET). The TTL is the one constant every part reads: the
// repository's expiry, the mail's wording (RenderCodeEmail) and the sign-in message.
import crypto from "node:crypto";
import { HashEmailCode } from "./apiKeyHash";
import type { EmailCodePurpose } from "../persistence/contracts/EmailCodeRepository";

export const EMAIL_CODE_TTL_MINUTES = 5;
export const EMAIL_CODE_TTL_MS = EMAIL_CODE_TTL_MINUTES * 60 * 1000;
export const EMAIL_CODE_MAX_TRIES = 5;

/** A fresh 6-digit code. crypto.randomInt draws it without modulo bias; leading zeros are kept. */
export function GenerateEmailCode(): string {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Exactly six ASCII digits. Anything else is refused before a try is counted. */
export function IsEmailCodeFormat(value: unknown): value is string {
    return typeof value === "string" && /^\d{6}$/.test(value);
}

/** The stored form of a code: an HMAC that binds the code to its account and purpose. */
export function EmailCodeHash(userId: string, purpose: EmailCodePurpose, code: string): string {
    return HashEmailCode(userId, purpose, code);
}

/**
 * Constant-time comparison of two hex hashes (the stored one and the hash of the submitted code). Unequal lengths or malformed hex
 * never match.
 */
export function EmailCodeMatches(storedHash: string, candidateHash: string): boolean {
    const Stored = Buffer.from(storedHash, "hex");
    const Candidate = Buffer.from(candidateHash, "hex");
    return Stored.length > 0 && Stored.length === Candidate.length && crypto.timingSafeEqual(Stored, Candidate);
}

/**
 * An address for messages and logs: the first letter, three stars, the last letter of a longer name, then the domain as it is
 * (`m***x@gmail.com`). A name of two letters or fewer keeps only its first letter.
 */
export function MaskEmail(email: string): string {
    const At = email.lastIndexOf("@");
    if (At <= 0) return "***";
    const Local = email.slice(0, At);
    const Domain = email.slice(At + 1);
    const Tail = Local.length > 2 ? Local[Local.length - 1] : "";
    return `${Local[0]}***${Tail}@${Domain}`;
}
