/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The email routes of the launcher's sign-in: verify (password AND code), resend, forgot password, reset password by code, and
// the sweep that removes a registration not verified within 48 h. The codes are in controllers/emailCodes.ts. Answers never say whether an
// address has an account, except the registration's existing AUTH_EMAIL_TAKEN: resend and forgot always answer { sent: true }, and the code
// for an existing account is mailed after the answer has gone out, so the two cases take the same time.
import { GetRepositories } from "../persistence";
import type { EmailCodePurpose } from "../persistence/contracts/EmailCodeRepository";
import { LauncherApiError } from "../security/launcherErrors";
import { HashPassword, VerifyPassword } from "../security/passwords";
import { DescribeMailError } from "../mail/mailSender";
import { logger } from "../logger";
import { AssertAccountNotBlocked, IsValidEmailAddress, LauncherAccountView, LauncherSessionResult, SignInAfterEmailProof } from "./launcherAuth";
import { AcceptEmailCode, CODE_REFUSED_MESSAGE, IssueEmailCode, RequireEmailSending, TakeAttempt } from "./emailCodes";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** A registration not verified this long after it was made is removed, which frees its address. */
export const UNVERIFIED_REGISTRATION_TTL_MS = 48 * 60 * 60 * 1000;
export const UNVERIFIED_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function NormalizeAddress(email: string): string {
    return email.trim().toLowerCase();
}

/** What may be logged about a failed background step: the error's code or class name, never its message. */
function DescribeFailure(error: unknown): string {
    const Code = (error as { code?: unknown } | null)?.code;
    if (typeof Code === "string" && Code.length > 0) return Code;
    return error instanceof Error ? error.name : "error";
}

/**
 * POST /launcher/v1/auth/email/verify: the password AND the emailed code must both be right. A right pair verifies the email and gives the
 * sign-in answer, or the approval-pending answer while the approval is pending (no session, as a registration).
 */
export async function VerifyEmailWithPassword(email: unknown, password: unknown, code: unknown, deviceId: string, deviceName: string,
    ip: string): Promise<LauncherSessionResult | { approvalRequired: true; account: LauncherAccountView }> {
    RequireEmailSending();
    TakeAttempt(`email-verify-ip:${ip}`, 30, FIFTEEN_MINUTES_MS);
    if (typeof email !== "string" || typeof password !== "string") {
        throw new LauncherApiError("AUTH_INVALID_CREDENTIALS", "The email or password is incorrect.");
    }
    const Normalized = NormalizeAddress(email);
    // Verify takes the password, so it is guarded like the password sign-in: per address as well as per IP.
    TakeAttempt(`email-verify:${Normalized}`, 10, FIFTEEN_MINUTES_MS);

    const Repos = GetRepositories();
    const Account = await Repos.launcherAccounts.findByEmail(Normalized);
    const PasswordOk = await VerifyPassword(Account?.passwordHash, password);
    if (Account == undefined || !PasswordOk) {
        throw new LauncherApiError("AUTH_INVALID_CREDENTIALS", "The email or password is incorrect.");
    }
    AssertAccountNotBlocked(Account);

    if (!(await AcceptEmailCode(Account.userId, "verify", code))) {
        throw new LauncherApiError("AUTH_CODE_INVALID", CODE_REFUSED_MESSAGE);
    }

    const VerifiedAt = new Date().toISOString();
    await Repos.launcherAccounts.setEmailVerified(Account.userId, VerifiedAt);
    return SignInAfterEmailProof({ ...Account, emailVerifiedAt: VerifiedAt, emailVerificationPendingSince: undefined }, deviceId, deviceName);
}

/**
 * Mails a code to the account of the address when it may receive one: an account that exists and is not banned or disabled, and, for
 * a verify code, whose email is not verified yet. Runs after the answer has gone out. Nothing here reaches the caller; a failure is
 * logged by its error code only.
 */
async function DeliverCodeToAccount(normalizedEmail: string, purpose: EmailCodePurpose, ip: string): Promise<void> {
    try {
        const Account = await GetRepositories().launcherAccounts.findByEmail(normalizedEmail);
        if (Account == undefined || Account.status !== "active") return;
        if (purpose === "verify" && Account.emailVerifiedAt != undefined) return;
        await IssueEmailCode(Account.userId, Account.email ?? normalizedEmail, purpose, ip);
    } catch (error) {
        logger.warn(`[Email] a ${purpose} code request could not be completed (${DescribeFailure(error)})`);
    }
}

/** POST /launcher/v1/auth/email/resend: a new verification code, if the address has an unverified account. Always { sent: true }. */
export async function ResendEmailCode(email: unknown, ip: string): Promise<{ sent: true }> {
    RequireEmailSending();
    TakeAttempt(`email-resend-ip:${ip}`, 20, HOUR_MS);
    if (!IsValidEmailAddress(email)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Enter a valid email address.");
    }
    const Normalized = NormalizeAddress(email);
    TakeAttempt(`email-resend:${Normalized}`, 5, HOUR_MS);

    void DeliverCodeToAccount(Normalized, "verify", ip);
    return { sent: true };
}

/** POST /launcher/v1/auth/password/forgot: a password reset code, if the address has an account. Always { sent: true }. */
export async function RequestPasswordResetCode(email: unknown, ip: string): Promise<{ sent: true }> {
    RequireEmailSending();
    TakeAttempt(`password-forgot-ip:${ip}`, 20, HOUR_MS);
    if (!IsValidEmailAddress(email)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Enter a valid email address.");
    }
    const Normalized = NormalizeAddress(email);
    TakeAttempt(`password-forgot:${Normalized}`, 5, HOUR_MS);

    void DeliverCodeToAccount(Normalized, "reset", ip);
    return { sent: true };
}

/**
 * POST /launcher/v1/auth/password/reset: the emailed reset code and a new password. A right code sets the password, verifies the email
 * (this is how the owner of an address recovers one someone else registered), ends every session of the account, and gives the sign-in
 * answer (or the approval-pending answer).
 */
export async function ResetPasswordWithCode(email: unknown, code: unknown, newPassword: unknown, deviceId: string, deviceName: string,
    ip: string): Promise<LauncherSessionResult | { approvalRequired: true; account: LauncherAccountView }> {
    RequireEmailSending();
    TakeAttempt(`password-reset-ip:${ip}`, 30, FIFTEEN_MINUTES_MS);
    if (!IsValidEmailAddress(email)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Enter a valid email address.");
    }
    const Normalized = NormalizeAddress(email);
    TakeAttempt(`password-reset:${Normalized}`, 10, FIFTEEN_MINUTES_MS);
    // The password rules of registration, checked before a try is counted.
    if (typeof newPassword !== "string" || newPassword.length < 8) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Password must be at least 8 characters.");
    }

    const Repos = GetRepositories();
    const Account = await Repos.launcherAccounts.findByEmail(Normalized);
    if (Account == undefined || !(await AcceptEmailCode(Account.userId, "reset", code))) {
        throw new LauncherApiError("AUTH_CODE_INVALID", CODE_REFUSED_MESSAGE);
    }
    // Checked after the code: only the owner of the address, who has the code, learns that the account is banned or disabled.
    AssertAccountNotBlocked(Account);

    const VerifiedAt = new Date().toISOString();
    await Repos.launcherAccounts.setPasswordHash(Account.userId, await HashPassword(newPassword));
    await Repos.launcherAccounts.setEmailVerified(Account.userId, VerifiedAt);
    // Every session of the account ends: whoever held the old password loses them.
    await Repos.refreshSessions.revokeAllForUser(Account.userId);
    return SignInAfterEmailProof({ ...Account, emailVerifiedAt: VerifiedAt, emailVerificationPendingSince: undefined }, deviceId, deviceName);
}

/**
 * Removes the launcher accounts registered under MYSTICPARADOX_EMAIL_VERIFICATION=required that were not verified within 48 h, with their
 * codes and sessions. It removes nothing else: existing accounts carry no pending mark, and an account verified meanwhile is kept by the
 * conditional delete. Returns how many accounts were removed.
 */
export async function SweepUnverifiedRegistrations(nowMs: number = Date.now(), limit: number = 500): Promise<number> {
    const CutoffIso = new Date(nowMs - UNVERIFIED_REGISTRATION_TTL_MS).toISOString();
    const Repos = GetRepositories();
    const Due = await Repos.launcherAccounts.listUnverifiedRegistrations(CutoffIso, limit);

    let Removed = 0;
    for (const Account of Due) {
        if (!(await Repos.launcherAccounts.deleteUnverifiedRegistration(Account.userId, CutoffIso))) continue;
        // The account is gone, so nothing can sign in as it. Its codes and sessions go too (a registration that was never verified never got a session).
        await Repos.emailCodes.deleteForUser(Account.userId);
        await Repos.refreshSessions.deleteAllForUser(Account.userId);
        Removed += 1;
    }
    if (Removed > 0) logger.info(`[EmailSweep] removed ${Removed} unverified registration(s) older than 48 h`);
    return Removed;
}

let SweepTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Starts the hourly sweep (once; the timer is unref-ed, so it never keeps the process alive). server.ts starts it only while the mode is
 * required: under off no registration is ever pending.
 */
export function StartUnverifiedRegistrationSweeper(): void {
    if (SweepTimer !== undefined) return;
    let Running = false;
    SweepTimer = setInterval(() => {
        if (Running) return; // a slow sweep is not overlapped
        Running = true;
        SweepUnverifiedRegistrations()
            .catch((error) => logger.warn(`[EmailSweep] sweep failed (${DescribeFailure(error)})`))
            .finally(() => { Running = false; });
    }, UNVERIFIED_SWEEP_INTERVAL_MS);
    SweepTimer.unref();
}

export function StopUnverifiedRegistrationSweeper(): void {
    if (SweepTimer !== undefined) clearInterval(SweepTimer);
    SweepTimer = undefined;
}

export function IsUnverifiedRegistrationSweeperRunning(): boolean {
    return SweepTimer !== undefined;
}
