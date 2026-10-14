/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { Request, Response } from "express";
import { GetRepositories, LauncherGuardSessionRecord, LauncherGuardStatus } from "../persistence";

// [2026-10-14] Read-only Guard endpoints for the admin dashboard (mounted behind HasAdminAuth in routes/admin.ts). The sessions keep
// their challenge (the heartbeat chain's secret) and public key in the store; the responses leave both out.

const GUARD_STATUSES: readonly LauncherGuardStatus[] = ["CHALLENGED", "HEALTHY", "DEGRADED", "REVOKED", "EXPIRED"];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function PageOf(raw: unknown): number {
    return Math.max(1, Number.parseInt(String(raw ?? "1"), 10) || 1);
}

function LimitOf(raw: unknown): number {
    return Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(String(raw ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
}

function BadQuery(res: Response, message: string): void {
    res.status(400).json({ error: { code: "GUARD_QUERY_INVALID", message } });
}

/** A Guard session as the dashboard may see it (no challenge, no public key). The reasons are those of the latest heartbeat. */
export function PublicGuardSession(record: LauncherGuardSessionRecord): Record<string, unknown> {
    return {
        guardSessionId: record.guardSessionId,
        accountId: record.accountId,
        role: record.role,
        status: record.status,
        riskScore: record.riskScore,
        reasons: record.reasons ?? [],
        channel: record.channel,
        launcherVersion: record.launcherVersion,
        manifestId: record.manifestId,
        manifestSequence: record.manifestSequence,
        lastSequence: record.lastSequence,
        createdAt: record.createdAt,
        lastHeartbeatAt: record.lastHeartbeatAt ?? null,
        expiresAt: record.expiresAt,
        lastSignals: record.lastSignals ?? null
    };
}

/** GET /admin/v1/guard/sessions?status=&minRisk=&page=&limit= : newest first. */
export async function ListGuardSessions(req: Request, res: Response): Promise<void> {
    const StatusText = typeof req.query.status === "string" ? req.query.status.trim() : "";
    if (StatusText !== "" && !GUARD_STATUSES.includes(StatusText as LauncherGuardStatus)) {
        BadQuery(res, `status must be one of ${GUARD_STATUSES.join(", ")}`);
        return;
    }
    const MinRiskText = typeof req.query.minRisk === "string" ? req.query.minRisk.trim() : "";
    const MinRisk = MinRiskText === "" ? undefined : Number(MinRiskText);
    if (MinRisk !== undefined && (!Number.isInteger(MinRisk) || MinRisk < 0 || MinRisk > 100)) {
        BadQuery(res, "minRisk must be a whole number from 0 to 100");
        return;
    }
    const Page = PageOf(req.query.page);
    const Limit = LimitOf(req.query.limit);
    const Result = await GetRepositories().launcherGuard.listSessions(
        { status: StatusText === "" ? undefined : StatusText as LauncherGuardStatus, minRisk: MinRisk },
        (Page - 1) * Limit,
        Limit
    );
    res.json({ sessions: Result.records.map(PublicGuardSession), total: Result.total, page: Page, limit: Limit });
}

/** GET /admin/v1/guard/sessions/:guardSessionId : the session and its last 20 heartbeats, newest first. */
export async function GetGuardSession(req: Request, res: Response): Promise<void> {
    const Id = String(req.params.guardSessionId ?? "");
    const Record = Id === "" ? undefined : await GetRepositories().launcherGuard.find(Id);
    if (Record === undefined) {
        res.status(404).json({ error: { code: "GUARD_SESSION_NOT_FOUND", message: "No Guard session has that id." } });
        return;
    }
    res.json({ session: PublicGuardSession(Record), history: Record.history ?? [] });
}

/** GET /admin/v1/guard/findings?signer=&page=&limit= : module findings, most seen first. */
export async function ListGuardFindings(req: Request, res: Response): Promise<void> {
    const Signer = typeof req.query.signer === "string" ? req.query.signer.trim().slice(0, 100) : "";
    const Page = PageOf(req.query.page);
    const Limit = LimitOf(req.query.limit);
    const Result = await GetRepositories().launcherGuard.listFindings({ signer: Signer === "" ? undefined : Signer }, (Page - 1) * Limit, Limit);
    res.json({ findings: Result.records, total: Result.total, page: Page, limit: Limit });
}
