/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { NextFunction, Request, Response } from "express";
import { GetRepositories } from "../persistence";
import { HashOpaqueToken } from "../security/launcherTokens";
import { IsAccountEligible } from "../security/accountEligibility";
import { logger } from "../logger";
import {
    HasManagerOperatorHeaders,
    ManagerActorAccount,
    ManagerOperatorEnabled,
    ManagerOperatorSecret,
    RawBodyOf,
    SharedManagerOperatorNonces,
    VerifyManagerOperatorRequest
} from "../security/managerOperator";

export const ADMIN_COOKIE_NAME = "mysticparadox_admin";

function ReadCookie(req: Request, name: string): string | undefined {
    const Header = req.headers.cookie;
    if (!Header) return undefined;
    for (const Part of Header.split(";")) {
        const [Key, ...Value] = Part.trim().split("=");
        if (Key === name) return decodeURIComponent(Value.join("="));
    }
    return undefined;
}

export async function HasAdminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    // [2026-10-14, P5.1] The manager's signed operator credential (security/managerOperator.ts, contract in its header). With the
    // switch off, operator headers are ignored and the request is judged by the cookie session below, as before.
    if (HasManagerOperatorHeaders(req.headers) && ManagerOperatorEnabled(process.env)) {
        const Verdict = VerifyManagerOperatorRequest(
            {
                method: req.method,
                target: req.originalUrl,
                peerAddress: req.socket?.remoteAddress,
                headers: req.headers,
                rawBody: RawBodyOf(req)
            },
            { secret: ManagerOperatorSecret(process.env), nonces: SharedManagerOperatorNonces(), nowMs: Date.now() }
        );
        if (!Verdict.ok) {
            logger.warn(`[ADMIN] manager operator request refused: ${Verdict.code} ${req.method} ${req.path}`);
            res.status(Verdict.status).json({ error: { code: Verdict.code, message: Verdict.message } });
            return;
        }
        // A manager request acts as the synthetic administrator `manager:<operatorId>`: no backend session, cookie or CSRF token.
        (req as any).AdminAuth = {
            session: undefined,
            account: ManagerActorAccount(Verdict, new Date().toISOString()),
            manager: true
        };
        next();
        return;
    }

    const RawToken = ReadCookie(req, ADMIN_COOKIE_NAME);
    if (!RawToken) {
        res.status(401).json({ error: { code: "ADMIN_UNAUTHORIZED", message: "Administrator sign-in required." } });
        return;
    }

    const Repos = GetRepositories();
    const Session = await Repos.admin.findActiveSessionByTokenHash(HashOpaqueToken(RawToken));
    if (!Session) {
        res.status(401).json({ error: { code: "ADMIN_UNAUTHORIZED", message: "Administrator session expired." } });
        return;
    }

    const Account = await Repos.launcherAccounts.findByUserId(Session.userId);
    if (!Account || !Account.roles.includes("admin") || !IsAccountEligible(Account)) {
        await Repos.admin.revokeSession(Session.id);
        res.status(403).json({ error: { code: "ADMIN_FORBIDDEN", message: "Administrator access denied." } });
        return;
    }

    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        const Csrf = req.headers["x-csrf-token"];
        if (typeof Csrf !== "string" || Csrf !== Session.csrfToken) {
            res.status(403).json({ error: { code: "ADMIN_CSRF", message: "Invalid request token." } });
            return;
        }
    }

    (req as any).AdminAuth = { session: Session, account: Account };
    next();
}
