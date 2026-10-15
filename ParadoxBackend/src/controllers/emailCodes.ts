/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The one-time code flow shared by the sign-in (controllers/launcherAuth.ts) and the email routes (controllers/launcherEmail.ts):
// the send limits, issuing a code and mailing it, the "mail is set up here" check, and accepting a submitted code. The code itself is
// never stored or logged: only its HMAC (security/emailCodes.ts), and the mail carries it to the owner of the address.
import { GetRepositories } from "../persistence";
import type { EmailCodePurpose } from "../persistence/contracts/EmailCodeRepository";
import { IsRateLimited } from "../security/rateLimit";
import { LauncherApiError } from "../security/launcherErrors";
import {
    EMAIL_CODE_MAX_TRIES,
    EMAIL_CODE_TTL_MS,
    EmailCodeHash,
    EmailCodeMatches,
    GenerateEmailCode,
    IsEmailCodeFormat,
    MaskEmail
} from "../security/emailCodes";
import { DescribeMailError, SendDiscordUnlinkCode, SendPasswordResetCode, SendVerificationCode } from "../mail/mailSender";
import { ReadSmtpSettings } from "../mail/mailConfig";
import { logger } from "../logger";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The answer for a wrong, expired, used or out-of-tries code, and for an address with no account (one message for all of them). */
export const CODE_REFUSED_MESSAGE = "That code is wrong or has expired. Check the latest email or resend the code.";

/** One attempt against a window; over the budget it refuses with AUTH_RATE_LIMITED. Keys combine the address or the IP with the route. */
export function TakeAttempt(key: string, maxAttempts: number, windowMs: number): void {
    if (IsRateLimited(key, maxAttempts, windowMs)) {
        throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many attempts. Try again later.");
    }
}

/** True when the code mail's SMTP settings are complete (the environment is read at each call; tests set it per case). */
export function IsEmailSendingConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
    return ReadSmtpSettings(environment).configured;
}

/** Refuses with AUTH_EMAIL_UNAVAILABLE (503) while the code mail is not set up on this server. Checked before anything else in the routes. */
export function RequireEmailSending(environment: NodeJS.ProcessEnv = process.env): void {
    if (!IsEmailSendingConfigured(environment)) {
        throw new LauncherApiError("AUTH_EMAIL_UNAVAILABLE", "Email codes aren't available on this server right now. Try again later.");
    }
}

/**
 * Takes a send slot for the account and purpose (one code a minute, five an hour) and one for the address (twenty an hour). False when a
 * limit is reached: nothing is then stored or mailed. The account windows are taken first, so a send refused by them uses no address slot.
 */
export function TakeCodeSendSlot(userId: string, purpose: EmailCodePurpose, ip: string): boolean {
    if (IsRateLimited(`mail-minute:${purpose}:${userId}`, 1, MINUTE_MS)) return false;
    if (IsRateLimited(`mail-hour:${purpose}:${userId}`, 5, HOUR_MS)) return false;
    return !IsRateLimited(`mail-ip:${ip}`, 20, HOUR_MS);
}

/**
 * Stores a new live code for the account and purpose (it replaces the code issued before) and mails it. Returns "limited", storing and
 * mailing nothing, when a send limit is reached, and "failed" when the mail could not be sent (logged with its error code only; the
 * stored code is kept, so the owner can ask for another one). [2026-10-15] The signed-out routes answer the same whatever this says;
 * a signed-in caller (the Discord unlink) may tell the player a failed send.
 */
export type EmailCodeIssue = "sent" | "limited" | "failed";

export async function IssueEmailCode(userId: string, email: string, purpose: EmailCodePurpose, ip: string): Promise<EmailCodeIssue> {
    if (!TakeCodeSendSlot(userId, purpose, ip)) return "limited";

    const Code = GenerateEmailCode();
    const IssuedAt = Date.now();
    await GetRepositories().emailCodes.replace({
        userId,
        purpose,
        codeHash: EmailCodeHash(userId, purpose, Code),
        attempts: 0,
        createdAt: new Date(IssuedAt).toISOString(),
        expiresAt: new Date(IssuedAt + EMAIL_CODE_TTL_MS).toISOString()
    });

    try {
        if (purpose === "verify") await SendVerificationCode(email, Code);
        else if (purpose === "reset") await SendPasswordResetCode(email, Code);
        else await SendDiscordUnlinkCode(email, Code); // [2026-10-15] "unlink"
    } catch (error) {
        logger.warn(`[Email] the ${purpose} code for user ${userId} was not mailed (${DescribeMailError(error)})`);
        return "failed";
    }

    logger.info(`[Email] ${purpose} code mailed to ${MaskEmail(email)} (user ${userId})`);
    return "sent";
}

/**
 * Accepts or refuses a submitted code for the account and purpose. A malformed code is refused without a try. A right code (compared in
 * constant time against the live code) is used by one conditional delete, which verifies and consumes it in the same write: a second use,
 * or a parallel one, finds nothing. A wrong code, or no live code, counts one try in one atomic write, so parallel guesses cannot exceed the
 * limit; the code that runs out of tries is removed at once. Returns whether the code was accepted.
 */
export async function AcceptEmailCode(userId: string, purpose: EmailCodePurpose, code: unknown,
    nowIso: string = new Date().toISOString()): Promise<boolean> {
    if (!IsEmailCodeFormat(code)) return false;

    const Repos = GetRepositories();
    const Live = await Repos.emailCodes.peekLive(userId, purpose, nowIso, EMAIL_CODE_MAX_TRIES);
    if (Live !== undefined && EmailCodeMatches(Live.codeHash, EmailCodeHash(userId, purpose, code))) {
        return Repos.emailCodes.consume(userId, purpose, Live.codeHash, nowIso, EMAIL_CODE_MAX_TRIES);
    }

    // A wrong code (or none live): the try is counted atomically, and the row that ran out of tries goes now.
    const Counted = await Repos.emailCodes.reserveTry(userId, purpose, nowIso, EMAIL_CODE_MAX_TRIES);
    if (Counted !== undefined && Counted.attempts >= EMAIL_CODE_MAX_TRIES) {
        await Repos.emailCodes.remove(userId, purpose, Counted.codeHash);
    }
    return false;
}
