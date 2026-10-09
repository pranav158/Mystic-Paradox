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
    | "AUTH_TESTER_REQUIRED"
    | "AUTH_CHANNEL_MISMATCH"
    | "GAME_EXCHANGE_CODE_EXPIRED"
    | "GAME_BUILD_UNSUPPORTED"
    | "RUNTIME_BUILD_UNSUPPORTED"
    | "GUARD_MANIFEST_UNAVAILABLE"
    | "GUARD_MANIFEST_MISMATCH"
    | "GUARD_REPORT_INVALID"
    | "GUARD_SESSION_INVALID"
    | "GUARD_SIGNATURE_INVALID"
    | "GUARD_SEQUENCE_CONFLICT"
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
    AUTH_TESTER_REQUIRED: 403,
    AUTH_CHANNEL_MISMATCH: 409,
    GAME_EXCHANGE_CODE_EXPIRED: 410,
    GAME_BUILD_UNSUPPORTED: 400,
    RUNTIME_BUILD_UNSUPPORTED: 409,
    GUARD_MANIFEST_UNAVAILABLE: 503,
    GUARD_MANIFEST_MISMATCH: 409,
    GUARD_REPORT_INVALID: 400,
    GUARD_SESSION_INVALID: 401,
    GUARD_SIGNATURE_INVALID: 401,
    GUARD_SEQUENCE_CONFLICT: 409,
    NOT_FOUND: 404,
    INTERNAL: 500
};

export class LauncherApiError extends Error {
    code: LauncherErrorCode;

    constructor(code: LauncherErrorCode, message: string) {
        super(message);
        this.name = "LauncherApiError";
        this.code = code;
    }
}

export function SendLauncherError(res: Response, error: LauncherApiError): void {
    const RequestId = crypto.randomUUID();

    const Status = (StatusByCode as Record<string, number>)[error.code] ?? ExtensionStatusByCode.get(error.code) ?? 500;
    res.status(Status).json({
        error: { code: error.code, message: error.message, requestId: RequestId }
    });
}
