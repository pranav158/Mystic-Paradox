import crypto from "node:crypto";
import { Request, Response } from "express";
import { LauncherAccountRecord } from "../persistence";
import { GetUnitOfWork } from "../persistence";
import { GetMongoDb } from "../persistence/mongo/client";
import { Collections } from "../persistence/mongo/collections";
import { GetOperationsPolicy, OperationsPolicyWeakeningCodes, SetOperationsPolicy } from "../services/operationsPolicy";
import { ApplyDiagnosticsLogProfile } from "../logger";
import { VerifyTotp } from "../security/totp";
import { IsRateLimited } from "../security/rateLimit";
import { GetP2PExtension } from "../extensions/p2p";

export async function GetOperationsOverview(_req: Request, res: Response): Promise<void> {
    const db = await GetMongoDb();
    const [launcherGuard, policy, extension] = await Promise.all([
        db.collection(Collections.LauncherGuardSessions).find({})
            .project({ _id: 1, accountId: 1, launcherVersion: 1, manifestSequence: 1, status: 1,
                riskScore: 1, lastHeartbeatAt: 1, expiresAt: 1, lastSignals: 1 })
            .sort({ createdAt: -1 }).limit(100).toArray(),
        GetOperationsPolicy(),
        GetP2PExtension().operations.overview()
    ]);
    res.json({
        observedAt: new Date().toISOString(),
        policy: { ...policy, ...extension.policy },
        launcherGuard: launcherGuard.map(({ _id, ...entry }) => ({ ...entry, guardSessionId: String(_id) })),
        ...extension.sections
    });
}

/** Operator step-up for a safety reduction: a fresh authenticator code, rate limited per operator. */
export function VerifyOperationsStepUp(actorUserId: string, code: unknown): boolean {
    const secret = process.env.ADMIN_OPERATIONS_TOTP_SECRET?.trim() || process.env.ADMIN_TOTP_SECRET?.trim();
    const rateLimited = IsRateLimited(`admin-operations-step-up:${actorUserId}`, 6, 15 * 60_000);
    return Boolean(secret) && !rateLimited && VerifyTotp(secret!, code);
}

export async function UpdateOperationsPolicy(req: Request, res: Response): Promise<void> {
    const actor = (req as any).AdminAuth.account as LauncherAccountRecord;
    const guardEnforcement = req.body?.guardEnforcement;
    const diagnosticsProfile = req.body?.diagnosticsProfile;
    const expectedVersion = Number(req.body?.expectedVersion);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (!["OBSERVE", "ENFORCE"].includes(guardEnforcement) ||
        !["PRODUCTION", "DEVELOPMENT"].includes(diagnosticsProfile) ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 || reason.length < 8) {
        res.status(400).json({ error: { code: "ADMIN_VALIDATION",
            message: "A complete versioned policy and an audit reason of at least 8 characters are required." } });
        return;
    }
    const requestId = crypto.randomUUID();
    const outcome = await GetUnitOfWork().withTransaction(async (repos, mongoSession) => {
        const before = await GetOperationsPolicy(mongoSession);
        if (before.version !== expectedVersion) return { kind: "CONFLICT" as const, before };
        const requested = { guardEnforcement, diagnosticsProfile } as const;
        const weakeningCodes = OperationsPolicyWeakeningCodes(before, requested);
        if (weakeningCodes.length > 0 && !VerifyOperationsStepUp(actor.userId, req.body?.breakGlassTotp)) {
            await repos.admin.appendAudit({
                id: crypto.randomUUID(), actorUserId: actor.userId,
                action: "operations.policy.weakening_rejected", oldState: before,
                newState: { ...requested, weakeningCodes }, reason,
                ip: req.ip ?? "unknown", requestId, createdAt: new Date().toISOString()
            }, mongoSession);
            return { kind: "STEP_UP_REQUIRED" as const, before, weakeningCodes };
        }
        const after = await SetOperationsPolicy(requested, actor.userId, expectedVersion, mongoSession);
        if (after == undefined) return { kind: "CONFLICT" as const, before };
        await repos.admin.appendAudit({
            id: crypto.randomUUID(), actorUserId: actor.userId, action: "operations.policy.update",
            oldState: before, newState: { ...after, weakeningCodes }, reason,
            ip: req.ip ?? "unknown", requestId,
            createdAt: new Date().toISOString()
        }, mongoSession);
        return { kind: "UPDATED" as const, before, after };
    });
    if (outcome.kind === "CONFLICT") {
        res.status(409).json({ error: { code: "ADMIN_POLICY_CONFLICT",
            message: "The operations policy changed. Refresh it before trying again." }, policy: outcome.before });
        return;
    }
    if (outcome.kind === "STEP_UP_REQUIRED") {
        res.status(403).json({ error: { code: "ADMIN_POLICY_STEP_UP_REQUIRED",
            message: "A fresh operations authenticator code is required for this safety reduction." },
            policy: outcome.before, weakeningCodes: outcome.weakeningCodes });
        return;
    }
    const { after } = outcome;
    // Apply runtime verbosity only after the policy+audit transaction has committed. If that
    // transaction rolls back, process-wide logging must remain on the previously durable profile.
    ApplyDiagnosticsLogProfile(after.diagnosticsProfile);
    res.json({ policy: after, requestId });
}
