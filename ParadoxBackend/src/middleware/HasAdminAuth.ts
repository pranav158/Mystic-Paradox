/*
 * Copyright (C) 2026 Mystic Paradox (pranav158/MysticParadox)
 * Licensed under the GNU Affero General Public License v3.0.
 */

import { NextFunction, Request, Response } from "express";
import { GetRepositories } from "../persistence";
import { HashOpaqueToken } from "../security/launcherTokens";
import { IsAccountEligible } from "../security/accountEligibility";

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
