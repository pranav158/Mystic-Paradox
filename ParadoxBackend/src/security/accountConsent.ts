/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { LauncherAccountRecord, LauncherConsentRecord } from "../persistence/contracts/LauncherAccountRepository";
import { ReadPersistenceProvider } from "../persistence";
import { CurrentLegalRequirements, IsAcceptedPrivacyVersion, LegalRequirements } from "../legal/legalPolicy";
import { LauncherApiError } from "./launcherErrors";

// [2026-10-14] Consent to the Terms of Use and Privacy Policy, the age confirmation, and the account deletion hold. The pure rules
// (the flags, the consent check, the refusals) live here so the routes, the game-session controller, the realm and P2P routes and
// the tests use one definition. Flags are read from the environment at each call (the operator may change them with a restart).

/**
 * MYSTICPARADOX_CONSENT_REQUIRED: an explicit value wins (off/false/0/no turns it off, anything else on). When blank, the default
 * follows the persistence provider: on with MongoDB (the official backend), off with SQLite (a local server, whose operator sets its
 * own rules).
 */
export function ConsentRequiredAtSignUp(environment: NodeJS.ProcessEnv = process.env): boolean {
    const Raw = environment.MYSTICPARADOX_CONSENT_REQUIRED?.trim().toLowerCase();
    if (Raw === undefined || Raw === "") return ReadPersistenceProvider(environment) === "mongodb";
    return !/^(0|false|off|no)$/.test(Raw);
}

/** MYSTICPARADOX_CONSENT_ENFORCE: off unless set to on (default off). When on, game sessions and realm hosting need a current consent. */
export function ConsentEnforced(environment: NodeJS.ProcessEnv = process.env): boolean {
    const Raw = environment.MYSTICPARADOX_CONSENT_ENFORCE?.trim().toLowerCase() ?? "";
    return /^(1|true|on|yes)$/.test(Raw);
}

/** True when the stored consent names the current documents and the age confirmation. */
export function IsConsentCurrent(consent: LauncherConsentRecord | undefined, required: LegalRequirements = CurrentLegalRequirements()): boolean {
    return consent !== undefined
        && consent !== null
        && consent.ageConfirmed === true
        && consent.termsVersion === required.termsVersion
        && IsAcceptedPrivacyVersion(consent.privacyVersion, required);
}

/** The consent as the launcher reads it (GET /launcher/v1/account/consent), or null when none is stored. */
export function ConsentView(consent: LauncherConsentRecord | undefined): LauncherConsentRecord | null {
    if (consent === undefined || consent === null) return null;
    return { termsVersion: consent.termsVersion, privacyVersion: consent.privacyVersion, ageConfirmed: true, acceptedAt: consent.acceptedAt };
}

/**
 * The consent a registration carries (POST /launcher/v1/auth/register `consent`). Absent: refused when consent is required, otherwise
 * no consent is recorded. A consent that does not confirm age is refused with CONSENT_AGE_REQUIRED. A consent for other versions is
 * refused with CONSENT_REQUIRED when consent is required (the launcher must be updated), and ignored otherwise.
 */
export function ValidateRegistrationConsent(
    raw: unknown,
    nowIso: string,
    environment: NodeJS.ProcessEnv = process.env,
    required: LegalRequirements = CurrentLegalRequirements()
): LauncherConsentRecord | undefined {
    const Required = ConsentRequiredAtSignUp(environment);
    const Body = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : undefined;

    if (Body === undefined) {
        if (Required) throw ConsentRequiredError();
        return undefined;
    }
    if (Body.ageConfirmed !== true) {
        throw new LauncherApiError("CONSENT_AGE_REQUIRED", `You must be at least ${required.minimumAge} years old to create an account.`);
    }
    if (Body.termsVersion !== required.termsVersion || !IsAcceptedPrivacyVersion(Body.privacyVersion, required)) {
        if (Required) throw ConsentRequiredError();
        return undefined;
    }
    return {
        termsVersion: required.termsVersion,
        // [2026-10-15] The version the player was shown (the current one, or one still accepted during its transition).
        privacyVersion: Body.privacyVersion as string,
        ageConfirmed: true,
        acceptedAt: nowIso
    };
}

export function ConsentRequiredError(): LauncherApiError {
    return new LauncherApiError("CONSENT_REQUIRED",
        "Update the launcher to read and accept the current Terms of Use and Privacy Policy, then try again.");
}

/** The deactivation refusal of an account with a deletion request: 403 ACCOUNT_DEACTIVATED with scheduledFor beside the code. */
export function AssertAccountNotDeactivated(account: LauncherAccountRecord): void {
    if (account.deletion === undefined || account.deletion === null) return;
    throw new LauncherApiError("ACCOUNT_DEACTIVATED",
        "This account is scheduled for deletion and is deactivated. Restore it from the Account page to play again.",
        { details: { scheduledFor: account.deletion.scheduledFor } });
}

/** Game sessions and realm hosting, when MYSTICPARADOX_CONSENT_ENFORCE is on: 403 CONSENT_REQUIRED unless the consent is current. */
export function AssertConsentCurrentWhenEnforced(account: LauncherAccountRecord, environment: NodeJS.ProcessEnv = process.env): void {
    if (!ConsentEnforced(environment) || IsConsentCurrent(account.consent)) return;
    throw new LauncherApiError("CONSENT_REQUIRED",
        "Update the launcher to read and accept the current Terms of Use and Privacy Policy, then try again.", { status: 403 });
}
