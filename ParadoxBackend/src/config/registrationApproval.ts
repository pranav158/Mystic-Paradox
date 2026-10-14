/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";

// [2026-10-14] MYSTICPARADOX_REGISTRATION_APPROVAL=required|off decides what a newly registered launcher account starts with, on every
// persistence provider (MongoDB and SQLite, launcher sign-up and Discord sign-up alike). off (the default, and blank) approves the account
// at once; required keeps it pending until an operator approves it. An unrecognised value fails closed to required, with a warning.
// The earlier MYSTICPARADOX_REGISTRATION_AUTO_APPROVE switch (sqlite only) is replaced: it is read only to warn that it has no effect.

export const REGISTRATION_APPROVAL_ENV = "MYSTICPARADOX_REGISTRATION_APPROVAL";
export const LEGACY_REGISTRATION_AUTO_APPROVE_ENV = "MYSTICPARADOX_REGISTRATION_AUTO_APPROVE";

export type RegistrationApprovalMode = "required" | "off";

export interface RegistrationApprovalPolicy {
    /** The mode in force: required keeps new accounts pending, off approves them at once. */
    mode: RegistrationApprovalMode;
    /** The approval status a newly registered account starts with. */
    approvalStatus: "approved" | "pending";
    /** True when the variable is unset or blank and the default (off) applies. */
    isDefault: boolean;
    /** Set when the variable held an unrecognised value (the mode is then required). */
    refusal?: string;
    /** Set when the replaced sqlite-only switch is still present in the environment. It has no effect. */
    legacyWarning?: string;
}

/**
 * Pure: what a new launcher account starts with, from the environment alone (the provider does not matter). Only the exact values
 * required and off are recognised, case-insensitively and trimmed; blank means off (the default); anything else is required.
 */
export function ResolveRegistrationApproval(environment: NodeJS.ProcessEnv): RegistrationApprovalPolicy {
    const Raw = (environment[REGISTRATION_APPROVAL_ENV] ?? "").trim().toLowerCase();
    const LegacyRaw = (environment[LEGACY_REGISTRATION_AUTO_APPROVE_ENV] ?? "").trim();
    const LegacyWarning = LegacyRaw === "" ? undefined
        : `${LEGACY_REGISTRATION_AUTO_APPROVE_ENV} is replaced by ${REGISTRATION_APPROVAL_ENV} and has no effect now; ` +
          `set ${REGISTRATION_APPROVAL_ENV}=off to approve new accounts at once, or required to keep them pending`;

    const Withheld = LegacyWarning === undefined ? {} : { legacyWarning: LegacyWarning };
    if (Raw === "") return { mode: "off", approvalStatus: "approved", isDefault: true, ...Withheld };
    if (Raw === "off") return { mode: "off", approvalStatus: "approved", isDefault: false, ...Withheld };
    if (Raw === "required") return { mode: "required", approvalStatus: "pending", isDefault: false, ...Withheld };
    return {
        mode: "required", approvalStatus: "pending", isDefault: false, ...Withheld,
        refusal: `${REGISTRATION_APPROVAL_ENV} must be required or off (got ${JSON.stringify(Raw)}); it is treated as required, ` +
            "so new accounts stay pending"
    };
}

/**
 * One startup line with the active mode (plus a warning when the value was unrecognised or the replaced switch is still set).
 * Called once from server.ts, for every provider.
 */
export function LogRegistrationApprovalPolicy(policy: RegistrationApprovalPolicy,
    sink: { info(message: string): void; warn(message: string): void } = logger): void {
    if (policy.refusal !== undefined) sink.warn(`[Startup] WARNING: ${policy.refusal}`);
    if (policy.legacyWarning !== undefined) sink.warn(`[Startup] WARNING: ${policy.legacyWarning}`);
    if (policy.mode === "required") {
        sink.info(`[Startup] ${REGISTRATION_APPROVAL_ENV}=required: new accounts need approval`);
    } else if (policy.isDefault) {
        sink.info(`[Startup] ${REGISTRATION_APPROVAL_ENV} not set (default off): new accounts are approved at once`);
    } else {
        sink.info(`[Startup] ${REGISTRATION_APPROVAL_ENV}=off: new accounts are approved at once`);
    }
}
