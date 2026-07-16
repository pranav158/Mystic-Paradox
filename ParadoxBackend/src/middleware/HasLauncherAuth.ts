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

import { NextFunction, Request, Response } from "express";
import { logger } from "../logger";
import { ValidateLauncherAccessToken } from "../security/launcherTokens";
import { SendLauncherError, LauncherApiError } from "../security/launcherErrors";
import { GetRepositories } from "../persistence";
import { AssertAccountAdmitted } from "../security/accountEligibility";






export async function HasLauncherAuth(req: Request, res: Response, next: NextFunction) {
    const AuthHeader = req.headers.authorization;

    if (
        AuthHeader == undefined ||
        (!AuthHeader.startsWith("bearer ") && !AuthHeader.startsWith("Bearer ") && !AuthHeader.startsWith("BEARER "))
    ) {
        SendLauncherError(res, new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required."));
        return;
    }

    const Token = AuthHeader.slice("bearer ".length);

    try {
        const Payload = ValidateLauncherAccessToken(Token);
        const Repos = GetRepositories();
        const [Account, SessionActive] = await Promise.all([
            Repos.launcherAccounts.findByUserId(Payload.userId),
            Repos.refreshSessions.isFamilyActive(Payload.sid, Payload.userId)
        ]);
        if (Account == undefined || !SessionActive) {
            throw new LauncherApiError("AUTH_UNAUTHORIZED", "Your session has expired. Please sign in again.");
        }
        AssertAccountAdmitted(Account);
        (req as any).LauncherAuthData = Payload;
        next();
    } catch (error) {
        if (error instanceof LauncherApiError) {
            SendLauncherError(res, error);
            return;
        }
        logger.warn("Request with bad launcher auth!");
        SendLauncherError(res, new LauncherApiError("AUTH_UNAUTHORIZED", "Your session has expired. Please sign in again."));
    }
}
