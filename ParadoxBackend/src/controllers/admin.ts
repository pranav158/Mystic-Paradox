/*
 * Copyright (C) 2026 Mystic Paradox (pranav158/MysticParadox)
 * Licensed under the GNU Affero General Public License v3.0.
 */

import crypto from "crypto";
import { Request, Response } from "express";
import { GetRepositories, AccountApprovalStatus, AccountOperationalStatus, LauncherAccountRecord } from "../persistence";
import { VerifyPassword } from "../security/passwords";
import { GenerateOpaqueToken, HashOpaqueToken } from "../security/launcherTokens";
import { EffectiveApprovalStatus, IsAccountEligible } from "../security/accountEligibility";
import { VerifyTotp } from "../security/totp";
import { IsRateLimited } from "../security/rateLimit";
import { ADMIN_COOKIE_NAME } from "../middleware/HasAdminAuth";
import { sessionRegistry } from "../realtime/SessionRegistry";

const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function PublicAccount(account: LauncherAccountRecord): Record<string, unknown> {
    return {
        userId: account.userId,
        displayName: account.displayName,
        email: account.email ?? "",
        approvalStatus: EffectiveApprovalStatus(account),
        status: account.status,
        roles: account.roles,
        usernameSet: account.usernameSet !== false,
        createdAt: account.createdAt,
        lastLoginAt: account.lastLoginAt,
        approvalUpdatedAt: account.approvalUpdatedAt,
        approvalUpdatedBy: account.approvalUpdatedBy,
        approvalReason: account.approvalReason
    };
}

function AdminCookieOptions(maxAgeSeconds = ADMIN_SESSION_TTL_MS / 1000): string {
    const Secure = process.env.NODE_ENV === "production" || /^(1|true)$/i.test(process.env.ADMIN_COOKIE_SECURE ?? "");
    return `Path=/admin/v1; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${Secure ? "; Secure" : ""}`;
}

export async function AdminLogin(req: Request, res: Response): Promise<void> {
    const Ip = req.ip ?? "unknown";
    if (IsRateLimited(`admin-login:${Ip}`, 6, 15 * 60 * 1000)) {
        res.status(429).json({ error: { code: "ADMIN_RATE_LIMITED", message: "Too many sign-in attempts." } });
        return;
    }

    const Email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const Password = typeof req.body?.password === "string" ? req.body.password : "";
    const Account = await GetRepositories().launcherAccounts.findByEmail(Email);
    if (!Account || !(await VerifyPassword(Account.passwordHash, Password)) || !Account.roles.includes("admin") || !IsAccountEligible(Account)) {
        res.status(401).json({ error: { code: "ADMIN_INVALID_CREDENTIALS", message: "Administrator credentials are invalid." } });
        return;
    }

    const TotpSecret = process.env.ADMIN_TOTP_SECRET;
    if (!TotpSecret && process.env.NODE_ENV === "production") {
        res.status(503).json({ error: { code: "ADMIN_MFA_NOT_CONFIGURED", message: "Administrator MFA is not configured." } });
        return;
    }
    if (TotpSecret && !VerifyTotp(TotpSecret, req.body?.totp)) {
        res.status(401).json({ error: { code: "ADMIN_MFA_INVALID", message: "The authenticator code is invalid." } });
        return;
    }

    const RawToken = GenerateOpaqueToken();
    const Now = new Date();
    const SessionId = crypto.randomUUID();
    const CsrfToken = GenerateOpaqueToken();
    await GetRepositories().admin.createSession({
        id: SessionId,
        tokenHash: HashOpaqueToken(RawToken),
        userId: Account.userId,
        csrfToken: CsrfToken,
        createdAt: Now.toISOString(),
        expiresAt: new Date(Now.getTime() + ADMIN_SESSION_TTL_MS).toISOString(),
        ip: Ip,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300)
    });

    res.setHeader("Set-Cookie", `${ADMIN_COOKIE_NAME}=${encodeURIComponent(RawToken)}; ${AdminCookieOptions()}`);
    res.json({ csrfToken: CsrfToken, account: PublicAccount(Account) });
}

export async function AdminLogout(req: Request, res: Response): Promise<void> {
    await GetRepositories().admin.revokeSession((req as any).AdminAuth.session.id);
    res.setHeader("Set-Cookie", `${ADMIN_COOKIE_NAME}=; ${AdminCookieOptions(0)}`);
    res.json({});
}

export async function AdminMe(req: Request, res: Response): Promise<void> {
    const Auth = (req as any).AdminAuth;
    res.json({ csrfToken: Auth.session.csrfToken, account: PublicAccount(Auth.account) });
}

export async function ListPlayers(req: Request, res: Response): Promise<void> {
    const Page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const Limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "25"), 10) || 25));
    const Approval = ["pending", "approved", "rejected"].includes(String(req.query.approvalStatus))
        ? String(req.query.approvalStatus) as AccountApprovalStatus : undefined;
    const Status = ["active", "disabled", "banned"].includes(String(req.query.status))
        ? String(req.query.status) as AccountOperationalStatus : undefined;
    const Result = await GetRepositories().launcherAccounts.listForAdmin({
        approvalStatus: Approval,
        status: Status,
        search: typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : undefined,
        skip: (Page - 1) * Limit,
        limit: Limit
    });
    res.json({ accounts: Result.accounts.map(PublicAccount), total: Result.total, page: Page, limit: Limit });
}

export async function ListOnlinePlayers(_req: Request, res: Response): Promise<void> {
    
    
    const AccountIds = sessionRegistry.onlineAccountIds();
    const Accounts = await Promise.all(
        AccountIds.map((UserId) => GetRepositories().launcherAccounts.findByUserId(UserId))
    );
    const Players = Accounts
        .filter((Account): Account is LauncherAccountRecord => Account !== undefined)
        .map((Account) => ({ userId: Account.userId, displayName: Account.displayName }))
        .sort((A, B) => A.displayName.localeCompare(B.displayName, undefined, { sensitivity: "base" }));

    res.json({
        count: Players.length,
        players: Players,
        observedAt: new Date().toISOString(),
        source: "xmpp"
    });
}

export async function UpdatePlayerAccess(req: Request, res: Response): Promise<void> {
    const Actor = (req as any).AdminAuth.account as LauncherAccountRecord;
    const TargetUserId = String(req.params.userId ?? "");
    const Approval = req.body?.approvalStatus;
    const Status = req.body?.status;
    const Reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";

    if (Approval != undefined && !["pending", "approved", "rejected"].includes(Approval)) {
        res.status(400).json({ error: { code: "ADMIN_VALIDATION", message: "Invalid approval status." } });
        return;
    }
    if (Status != undefined && !["active", "disabled", "banned"].includes(Status)) {
        res.status(400).json({ error: { code: "ADMIN_VALIDATION", message: "Invalid account status." } });
        return;
    }
    if (Approval == undefined && Status == undefined) {
        res.status(400).json({ error: { code: "ADMIN_VALIDATION", message: "No access-state change was supplied." } });
        return;
    }
    const WouldRemoveOwnAccess =
        (Approval != undefined && Approval !== "approved")
        || (Status != undefined && Status !== "active");
    if (TargetUserId === Actor.userId && WouldRemoveOwnAccess) {
        res.status(409).json({
            error: {
                code: "ADMIN_SELF_LOCKOUT",
                message: "You cannot reject, disable, or ban your own administrator account."
            }
        });
        return;
    }

    const Repos = GetRepositories();
    const Before = await Repos.launcherAccounts.findByUserId(TargetUserId);
    if (!Before) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Player not found." } });
        return;
    }
    const After = await Repos.launcherAccounts.setAccessState(TargetUserId, {
        approvalStatus: Approval,
        status: Status,
        approvalUpdatedAt: new Date().toISOString(),
        approvalUpdatedBy: Actor.userId,
        approvalReason: Reason
    });
    if (!After) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Player not found." } });
        return;
    }

    if (!IsAccountEligible(After)) {
        await Promise.all([
            Repos.refreshSessions.revokeAllForUser(TargetUserId),
            Repos.gameExchangeCodes.revokeUnusedForUser(TargetUserId)
        ]);
    }

    const RequestId = crypto.randomUUID();
    await Repos.admin.appendAudit({
        id: crypto.randomUUID(),
        actorUserId: Actor.userId,
        targetUserId: TargetUserId,
        action: "player.access.update",
        oldState: { approvalStatus: EffectiveApprovalStatus(Before), status: Before.status },
        newState: { approvalStatus: EffectiveApprovalStatus(After), status: After.status },
        reason: Reason || undefined,
        ip: req.ip ?? "unknown",
        requestId: RequestId,
        createdAt: new Date().toISOString()
    });
    res.json({ account: PublicAccount(After), requestId: RequestId });
}

export async function DeletePlayer(req: Request, res: Response): Promise<void> {
    const Actor = (req as any).AdminAuth.account as LauncherAccountRecord;
    const TargetUserId = String(req.params.userId ?? "");
    if (TargetUserId === Actor.userId) {
        res.status(409).json({ error: { code: "ADMIN_SELF_DELETE", message: "You cannot delete your own administrator account." } });
        return;
    }

    const Repos = GetRepositories();
    const Target = await Repos.launcherAccounts.findByUserId(TargetUserId);
    if (!Target) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Player not found." } });
        return;
    }

    const ExpectedConfirmation = `DELETE ${Target.displayName}`;
    const Confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation : "";
    const Reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (Confirmation !== ExpectedConfirmation) {
        res.status(400).json({
            error: {
                code: "ADMIN_DELETE_CONFIRMATION",
                message: `Type "${ExpectedConfirmation}" to confirm permanent deletion.`
            }
        });
        return;
    }
    if (Reason.length < 3) {
        res.status(400).json({ error: { code: "ADMIN_DELETE_REASON", message: "Provide a deletion reason for the audit log." } });
        return;
    }

    const RequestId = crypto.randomUUID();
    const Result = await Repos.admin.deletePlayerData(TargetUserId, {
        id: crypto.randomUUID(),
        actorUserId: Actor.userId,
        targetUserId: TargetUserId,
        action: "player.account.delete",
        oldState: {
            approvalStatus: EffectiveApprovalStatus(Target),
            status: Target.status,
            roles: Target.roles
        },
        newState: { deleted: true },
        reason: Reason,
        ip: req.ip ?? "unknown",
        requestId: RequestId,
        createdAt: new Date().toISOString()
    });

    res.json({ requestId: RequestId, ...Result });
}

export async function ListAudit(req: Request, res: Response): Promise<void> {
    const Page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const Limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const Target = typeof req.query.targetUserId === "string" ? req.query.targetUserId : undefined;
    const Result = await GetRepositories().admin.listAudit(Target, (Page - 1) * Limit, Limit);
    res.json({ records: Result.records, total: Result.total, page: Page, limit: Limit });
}
