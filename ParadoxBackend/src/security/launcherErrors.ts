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

import { Response } from "express";
import crypto from "crypto";

// Matches Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md's error shape exactly —
// the Launcher frontend's src/api/client.ts already parses this. SERVER_UNAVAILABLE
// is client-synthesized (fetch failure) and never sent by this server.
type CoreLauncherErrorCode =
    | "AUTH_VALIDATION_FAILED"
    | "AUTH_INVALID_CREDENTIALS"
    | "AUTH_EMAIL_TAKEN"
    | "AUTH_DISPLAY_NAME_TAKEN"
    | "AUTH_ACCOUNT_DISABLED"
    | "AUTH_ACCOUNT_BANNED"
    | "AUTH_APPROVAL_PENDING"
    | "AUTH_APPROVAL_REJECTED"
    | "AUTH_USERNAME_REQUIRED"
    | "AUTH_REFRESH_INVALID"
    | "AUTH_UNAUTHORIZED"
    | "AUTH_RATE_LIMITED"
    | "AUTH_DISCORD_NOT_CONFIGURED"
    | "AUTH_DISCORD_CANCELLED"
    | "AUTH_DISCORD_ALREADY_LINKED"
    // [2026-10-15] Email verification and password reset by code (controllers/launcherEmail.ts), and the Discord link and unlink.
    | "AUTH_EMAIL_UNVERIFIED"
    | "AUTH_CODE_INVALID"
    | "AUTH_EMAIL_UNAVAILABLE"
    | "AUTH_DISCORD_NOT_LINKED"
    | "AUTH_DISCORD_ACCOUNT_HAS_LINK"
    | "AUTH_DISCORD_ONLY_LOGIN"
    | "AUTH_TESTER_REQUIRED"
    | "AUTH_CHANNEL_MISMATCH"
    // [2026-10-14] Terms of Use / Privacy Policy consent and the account deletion hold (launcherAuth routes, accountConsent.ts).
    | "CONSENT_REQUIRED"
    | "CONSENT_AGE_REQUIRED"
    | "LEGAL_VERSION_OUTDATED"
    | "DELETION_CONFIRMATION_MISMATCH"
    | "DELETION_HOLD_EXPIRED"
    | "ACCOUNT_DEACTIVATED"
    | "GAME_EXCHANGE_CODE_EXPIRED"
    | "GAME_BUILD_UNSUPPORTED"
    | "RUNTIME_BUILD_UNSUPPORTED"
    | "GUARD_MANIFEST_UNAVAILABLE"
    | "GUARD_MANIFEST_MISMATCH"
    | "GUARD_REPORT_INVALID"
    | "GUARD_SESSION_INVALID"
    | "GUARD_SIGNATURE_INVALID"
    | "GUARD_SEQUENCE_CONFLICT"
    // [2026-10-15] A launch with no realm while MYSTICPARADOX_OFFICIAL_PLAY is off (config/officialPlay.ts).
    | "OFFICIAL_PLAY_UNAVAILABLE"
    // [2026-10-16] Play from an unofficial launcher build while MYSTICPARADOX_UNOFFICIAL_LAUNCHER=refuse (security/unofficialLauncherPolicy.ts).
    | "LAUNCHER_UNOFFICIAL"
    // [2026-10-15] Launcher notices (controllers/launcherNotices.ts): a manager save that is refused (400), and one whose expectedVersion
    // is stale (409, the answer carries the current document).
    | "NOTICES_INVALID"
    | "NOTICES_VERSION_CONFLICT"
    | "NOT_FOUND"
    | "INTERNAL";

/**
 * Codes of an optional module (src/extensions). The module adds its codes by augmenting this
 * interface (code -> HTTP status) and registers the statuses with RegisterLauncherErrorStatuses().
 */
export interface ExtensionLauncherErrorCodes {}

export type LauncherErrorCode = CoreLauncherErrorCode | keyof ExtensionLauncherErrorCodes;

const ExtensionStatusByCode = new Map<string, number>();

export function RegisterLauncherErrorStatuses(statuses: { [Code in keyof ExtensionLauncherErrorCodes]?: number }): void {
    for (const [code, status] of Object.entries(statuses)) {
        if (typeof status === "number") ExtensionStatusByCode.set(code, status);
    }
}

const StatusByCode: Record<CoreLauncherErrorCode, number> = {
    AUTH_VALIDATION_FAILED: 400,
    AUTH_INVALID_CREDENTIALS: 401,
    AUTH_EMAIL_TAKEN: 409,
    AUTH_DISPLAY_NAME_TAKEN: 409,
    AUTH_ACCOUNT_DISABLED: 403,
    AUTH_ACCOUNT_BANNED: 403,
    AUTH_APPROVAL_PENDING: 403,
    AUTH_APPROVAL_REJECTED: 403,
    AUTH_USERNAME_REQUIRED: 403,
    AUTH_REFRESH_INVALID: 401,
    AUTH_UNAUTHORIZED: 401,
    AUTH_RATE_LIMITED: 429,
    AUTH_DISCORD_NOT_CONFIGURED: 503,
    AUTH_DISCORD_CANCELLED: 400,
    AUTH_DISCORD_ALREADY_LINKED: 409,
    // [2026-10-15] A sign-in whose email is not verified is refused (403) until a code is entered; a wrong, expired, used-up or
    // already-used code is one generic answer (400); the mail settings missing is a 503, like the other "not set up here" codes.
    AUTH_EMAIL_UNVERIFIED: 403,
    AUTH_CODE_INVALID: 400,
    AUTH_EMAIL_UNAVAILABLE: 503,
    AUTH_DISCORD_NOT_LINKED: 403,
    AUTH_DISCORD_ACCOUNT_HAS_LINK: 409,
    AUTH_DISCORD_ONLY_LOGIN: 409,
    AUTH_TESTER_REQUIRED: 403,
    AUTH_CHANNEL_MISMATCH: 409,
    // [2026-10-14] CONSENT_REQUIRED defaults to 400 (registration); a refusal of a game session or realm hosting sends 403 with
    // { status: 403 } (LauncherApiError options), like the other statuses one code can carry.
    CONSENT_REQUIRED: 400,
    CONSENT_AGE_REQUIRED: 400,
    LEGAL_VERSION_OUTDATED: 409,
    DELETION_CONFIRMATION_MISMATCH: 400,
    DELETION_HOLD_EXPIRED: 409,
    ACCOUNT_DEACTIVATED: 403,
    GAME_EXCHANGE_CODE_EXPIRED: 410,
    GAME_BUILD_UNSUPPORTED: 400,
    RUNTIME_BUILD_UNSUPPORTED: 409,
    GUARD_MANIFEST_UNAVAILABLE: 503,
    GUARD_MANIFEST_MISMATCH: 409,
    GUARD_REPORT_INVALID: 400,
    GUARD_SESSION_INVALID: 401,
    GUARD_SIGNATURE_INVALID: 401,
    GUARD_SEQUENCE_CONFLICT: 409,
    // [2026-10-15] Official play is off on this server (the same 503 as the other "not available here" codes).
    OFFICIAL_PLAY_UNAVAILABLE: 503,
    LAUNCHER_UNOFFICIAL: 403,
    // [2026-10-15] Launcher notices: a refused save (400) and a stale expectedVersion (409).
    NOTICES_INVALID: 400,
    NOTICES_VERSION_CONFLICT: 409,
    NOT_FOUND: 404,
    INTERNAL: 500
};

export interface LauncherApiErrorOptions {
    /** HTTP status for this refusal. One code may be refused with different statuses (CONSENT_REQUIRED: 400 at sign-up, 403 at play). */
    status?: number;
    /** Extra top-level fields of the error object (for example `scheduledFor` on ACCOUNT_DEACTIVATED), as the P2P errors send them. */
    details?: Record<string, unknown>;
}

export class LauncherApiError extends Error {
    code: LauncherErrorCode;
    status?: number;
    details?: Record<string, unknown>;

    constructor(code: LauncherErrorCode, message: string, options: LauncherApiErrorOptions = {}) {
        super(message);
        this.name = "LauncherApiError";
        this.code = code;
        this.status = options.status;
        this.details = options.details;
    }
}

export function SendLauncherError(res: Response, error: LauncherApiError): void {
    const RequestId = crypto.randomUUID();

    const Status = error.status ?? (StatusByCode as Record<string, number>)[error.code] ?? ExtensionStatusByCode.get(error.code) ?? 500;
    res.status(Status).json({
        // The fixed fields come last, so a detail can never replace the code, the message or the request id.
        error: { ...(error.details ?? {}), code: error.code, message: error.message, requestId: RequestId }
    });
}
