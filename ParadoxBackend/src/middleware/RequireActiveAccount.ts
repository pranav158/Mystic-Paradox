/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "../logger";
import { GetRepositories } from "../persistence";
import { AssertAccountNotDeactivated, AssertConsentCurrentWhenEnforced } from "../security/accountConsent";
import { LauncherApiError, SendLauncherError } from "../security/launcherErrors";

// [2026-10-14] Runs after HasLauncherAuth on the routes that host or join (realm and P2P hosting, realm joins, P2P host and join
// bootstraps): a deactivated account is refused with ACCOUNT_DEACTIVATED, and with `consent` set, MYSTICPARADOX_CONSENT_ENFORCE
// refuses an account without a current consent. Only the answer changes: the handler is not called.

export interface ActiveAccountGuardOptions {
    /** Also apply the consent check (MYSTICPARADOX_CONSENT_ENFORCE). Realm hosting sets it; joins and P2P bootstraps do not. */
    consent: boolean;
}

export function RequireActiveAccount(options: ActiveAccountGuardOptions): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const userId = (req as any).LauncherAuthData?.userId;
            const Account = typeof userId === "string" && userId.length > 0
                ? await GetRepositories().launcherAccounts.findByUserId(userId)
                : undefined;
            if (Account === undefined) {
                throw new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required.");
            }
            AssertAccountNotDeactivated(Account);
            if (options.consent) AssertConsentCurrentWhenEnforced(Account);
            next();
        } catch (error) {
            if (error instanceof LauncherApiError) {
                SendLauncherError(res, error);
                return;
            }
            logger.error(`Unhandled error in the active-account guard for ${req.method} ${req.path}: ${error}`);
            SendLauncherError(res, new LauncherApiError("INTERNAL", "Something went wrong. Please try again."));
        }
    };
}
