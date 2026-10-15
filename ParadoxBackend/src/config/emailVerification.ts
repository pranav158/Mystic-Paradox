/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] MYSTICPARADOX_EMAIL_VERIFICATION=off|required decides whether a sign-in needs a verified email. off (the default, and
// blank) keeps today's sign-in. required: a new registration is mailed a code and waits for it; an unverified account gets a code at
// sign-in and must enter it (launcher 0.1.67 or later). An unrecognised value fails closed to required, with a warning. required
// needs working SMTP settings: without them the backend refuses to start (AssertEmailVerificationConfig), as it does without
// API_KEY_HASH_SECRET.
import { logger } from "../logger";
import { ReadSmtpSettings, SMTP_HOST_ENV, SMTP_PASSWORD_ENV, SMTP_USER_ENV } from "../mail/mailConfig";

export const EMAIL_VERIFICATION_ENV = "MYSTICPARADOX_EMAIL_VERIFICATION";

export type EmailVerificationMode = "off" | "required";

export interface EmailVerificationPolicy {
    /** The mode in force: required asks for a code, off does not check the email. */
    mode: EmailVerificationMode;
    /** True when the variable is unset or blank and the default (off) applies. */
    isDefault: boolean;
    /** Set when the variable held an unrecognised value (the mode is then required). The value itself is not repeated. */
    refusal?: string;
}

/**
 * Pure: the mode from the environment alone. Only required and off are recognised, case-insensitively and trimmed; blank means off
 * (the default); anything else is required.
 */
export function ResolveEmailVerification(environment: NodeJS.ProcessEnv = process.env): EmailVerificationPolicy {
    const Raw = (environment[EMAIL_VERIFICATION_ENV] ?? "").trim().toLowerCase();
    if (Raw === "") return { mode: "off", isDefault: true };
    if (Raw === "off") return { mode: "off", isDefault: false };
    if (Raw === "required") return { mode: "required", isDefault: false };
    return {
        mode: "required",
        isDefault: false,
        refusal: `${EMAIL_VERIFICATION_ENV} must be required or off; the unrecognised value is treated as required`
    };
}

/** True when sign-in needs a verified email (MYSTICPARADOX_EMAIL_VERIFICATION=required). */
export function EmailVerificationRequired(environment: NodeJS.ProcessEnv = process.env): boolean {
    return ResolveEmailVerification(environment).mode === "required";
}

/**
 * One startup line with the active mode (plus a warning for an unrecognised value). Called once from server.ts, so the warning is
 * logged once.
 */
export function LogEmailVerificationPolicy(policy: EmailVerificationPolicy,
    sink: { info(message: string): void; warn(message: string): void } = logger): void {
    if (policy.refusal !== undefined) sink.warn(`[Startup] WARNING: ${policy.refusal}`);
    if (policy.mode === "required") {
        sink.info(`[Startup] ${EMAIL_VERIFICATION_ENV}=required: sign-in needs a verified email (launcher 0.1.67 or later)`);
    } else if (policy.isDefault) {
        sink.info(`[Startup] ${EMAIL_VERIFICATION_ENV} not set (default off): sign-in does not check the email`);
    } else {
        sink.info(`[Startup] ${EMAIL_VERIFICATION_ENV}=off: sign-in does not check the email`);
    }
}

/**
 * Throws at startup when the mode is required and the SMTP settings are incomplete or invalid. The message names the keys, never
 * their values. Nothing is checked when the mode is off.
 */
export function AssertEmailVerificationConfig(environment: NodeJS.ProcessEnv = process.env): void {
    if (!EmailVerificationRequired(environment)) return;
    const Reading = ReadSmtpSettings(environment);
    if (!Reading.configured) {
        throw new Error(
            `${EMAIL_VERIFICATION_ENV}=required needs working SMTP settings (${Reading.problems.join(", ")} not set or invalid; ` +
            `the required keys are ${SMTP_HOST_ENV}, ${SMTP_USER_ENV} and ${SMTP_PASSWORD_ENV}; see ParadoxBackend/.env.example)`
        );
    }
}
