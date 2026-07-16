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




export type LauncherErrorCode =
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
    | "GAME_EXCHANGE_CODE_EXPIRED"
    | "GAME_BUILD_UNSUPPORTED"
    | "NOT_FOUND"
    | "INTERNAL";

const StatusByCode: Record<LauncherErrorCode, number> = {
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
    GAME_EXCHANGE_CODE_EXPIRED: 410,
    GAME_BUILD_UNSUPPORTED: 400,
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

    res.status(StatusByCode[error.code]).json({
        error: { code: error.code, message: error.message, requestId: RequestId }
    });
}
