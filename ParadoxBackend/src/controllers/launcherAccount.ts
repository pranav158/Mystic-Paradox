/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { GetRepositories } from "../persistence";
import type { LauncherAccountRecord, LauncherConsentRecord, LauncherDeletionRecord } from "../persistence/contracts/LauncherAccountRepository";
import { CurrentLegalRequirements, IsAcceptedPrivacyVersion, LegalRequirements } from "../legal/legalPolicy";
import { DELETION_HOLD_DAYS, RetentionDateAfter } from "../legal/retentionPolicy";
import { ConsentView, IsConsentCurrent } from "../security/accountConsent";
import { LauncherApiError } from "../security/launcherErrors";

// [2026-10-14] The account routes of the launcher: the Terms of Use and Privacy Policy consent (GET/POST /launcher/v1/account/consent)
// and the account deletion request with its 30-day hold (/launcher/v1/account/deletion). Both need a launcher sign-in and keep
// working while the account is deactivated, so the launcher can offer Restore. Route wiring: routes/launcherAuth.ts.

export interface ConsentState {
    required: LegalRequirements;
    accepted: LauncherConsentRecord | null;
    upToDate: boolean;
}

export interface DeletionState {
    request: LauncherDeletionRecord | null;
    holdDays: number;
}

async function RequireAccount(userId: string): Promise<LauncherAccountRecord> {
    const Account = await GetRepositories().launcherAccounts.findByUserId(userId);
    if (Account == undefined) {
        throw new LauncherApiError("NOT_FOUND", "Account not found.");
    }
    return Account;
}

function ConsentStateOf(consent: LauncherConsentRecord | undefined): ConsentState {
    return {
        required: CurrentLegalRequirements(),
        accepted: ConsentView(consent),
        upToDate: IsConsentCurrent(consent)
    };
}

export async function GetConsentState(userId: string): Promise<ConsentState> {
    return ConsentStateOf((await RequireAccount(userId)).consent);
}

/**
 * Records the player's acceptance of the documents the launcher shows. The age confirmation must be true; the versions must be the
 * current ones (a launcher with older texts gets LEGAL_VERSION_OUTDATED and must be updated before it can accept).
 */
export async function AcceptConsent(userId: string, body: unknown, now: Date = new Date()): Promise<ConsentState> {
    const Fields = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const Required = CurrentLegalRequirements();

    if (Fields.ageConfirmed !== true) {
        throw new LauncherApiError("CONSENT_AGE_REQUIRED", `You must be at least ${Required.minimumAge} years old to play Mystic Paradox.`);
    }
    if (typeof Fields.termsVersion !== "string" || typeof Fields.privacyVersion !== "string") {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "termsVersion and privacyVersion are required.");
    }
    if (Fields.termsVersion !== Required.termsVersion || !IsAcceptedPrivacyVersion(Fields.privacyVersion, Required)) {
        throw new LauncherApiError("LEGAL_VERSION_OUTDATED",
            "These Terms of Use or this Privacy Policy have changed. Update the launcher, read them again and accept.",
            { details: { termsVersion: Required.termsVersion, privacyVersion: Required.privacyVersion } });
    }

    await RequireAccount(userId);
    const Consent: LauncherConsentRecord = {
        termsVersion: Required.termsVersion,
        // [2026-10-15] The version the player was shown (the current one, or one still accepted during its transition).
        privacyVersion: Fields.privacyVersion,
        ageConfirmed: true,
        acceptedAt: now.toISOString()
    };
    await GetRepositories().launcherAccounts.setConsent(userId, Consent);
    return ConsentStateOf(Consent);
}

function DeletionStateOf(request: LauncherDeletionRecord | undefined): DeletionState {
    return { request: request ?? null, holdDays: DELETION_HOLD_DAYS };
}

export async function GetDeletionState(userId: string): Promise<DeletionState> {
    return DeletionStateOf((await RequireAccount(userId)).deletion);
}

/**
 * Asks for the account to be deleted after the hold. The player types the username to confirm (case-insensitive). The account is
 * deactivated at once: it cannot play, host or join, but it can sign in and restore it. Asking again changes nothing.
 */
export async function RequestAccountDeletion(userId: string, body: unknown, now: Date = new Date()): Promise<DeletionState> {
    const Account = await RequireAccount(userId);
    const Typed = typeof (body as { confirmUsername?: unknown } | undefined)?.confirmUsername === "string"
        ? (body as { confirmUsername: string }).confirmUsername.trim()
        : "";

    if (Typed.length === 0 || Typed.toLowerCase() !== Account.displayName.toLowerCase()) {
        throw new LauncherApiError("DELETION_CONFIRMATION_MISMATCH", "Type your username exactly as it is shown to confirm the deletion.");
    }
    if (Account.deletion !== undefined) {
        return DeletionStateOf(Account.deletion);
    }

    const RequestedAt = now.toISOString();
    const Deletion: LauncherDeletionRecord = {
        requestedAt: RequestedAt,
        scheduledFor: RetentionDateAfter(RequestedAt, DELETION_HOLD_DAYS).toISOString()
    };
    await GetRepositories().launcherAccounts.setDeletion(userId, Deletion);
    return DeletionStateOf(Deletion);
}

/** Restores a deactivated account while its hold lasts. Restoring an account with no request changes nothing. */
export async function CancelAccountDeletion(userId: string, now: Date = new Date()): Promise<DeletionState> {
    const Account = await RequireAccount(userId);
    if (Account.deletion === undefined) {
        return DeletionStateOf(undefined);
    }
    if (Date.parse(Account.deletion.scheduledFor) <= now.getTime()) {
        throw new LauncherApiError("DELETION_HOLD_EXPIRED",
            `The ${DELETION_HOLD_DAYS}-day hold has ended, so this account can no longer be restored.`);
    }
    await GetRepositories().launcherAccounts.setDeletion(userId, undefined);
    return DeletionStateOf(undefined);
}
