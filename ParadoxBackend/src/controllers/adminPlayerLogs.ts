/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { Request, Response } from "express";
import { GetRepositories, LauncherAccountRecord } from "../persistence";
import { logger } from "../logger";
import { LOG_STORAGE_ROOT } from "../routes/launcherLogs";
import { isSafeSegment } from "../services/launcherLogNames";
import {
    DeletePlayerLogSession,
    ListPlayerLogSessions,
    PLAYER_LOG_LIST_DEFAULT_LIMIT,
    PLAYER_LOG_LIST_MAX_LIMIT,
    PLAYER_LOG_REASON_MAX,
    PLAYER_LOG_REASON_MIN,
    PlayerLogRefusal,
    ReadPlayerLogFile
} from "../services/playerLogs";

// [2026-10-15] The operator's view of the tester uploads. The manager reaches these through its signed admin proxy, and the owner's PC
// through the manager's deploy routes. Mounted behind HasAdminAuth in routes/admin.ts: GET the list, GET one file, DELETE one session
// (audited). The rules are in services/playerLogs.ts.

let RootOverride: string | undefined;

/** Tests only: points these routes at another folder (the upload folder otherwise). */
export function UsePlayerLogsRootForTest(root: string | undefined): void {
    RootOverride = root;
}

function PlayerLogsRoot(): string {
    return RootOverride ?? LOG_STORAGE_ROOT;
}

/** The text of one query parameter: undefined when absent, null when it is repeated (refused). */
function QueryText(value: unknown): string | undefined | null {
    if (value === undefined) return undefined;
    return typeof value === "string" ? value : null;
}

function SendRefusal(res: Response, refusal: PlayerLogRefusal): void {
    res.status(refusal.status).json({ error: { code: refusal.code, message: refusal.message } });
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** GET /admin/v1/player-logs?userId=&limit=&before=: the sessions, newest first, with nextBefore for the next page. */
export async function ListPlayerLogs(req: Request, res: Response): Promise<void> {
    const UserIdText = QueryText(req.query.userId);
    if (UserIdText === null || (UserIdText !== undefined && UserIdText !== "" && !isSafeSegment(UserIdText))) {
        res.status(400).json({ error: { code: "PLAYER_LOGS_QUERY", message: "userId must be one account id." } });
        return;
    }
    const LimitText = QueryText(req.query.limit);
    let Limit = PLAYER_LOG_LIST_DEFAULT_LIMIT;
    if (LimitText !== undefined) {
        const Value = LimitText === null ? NaN : Number(LimitText);
        if (!/^\d{1,3}$/.test(String(LimitText)) || !Number.isInteger(Value) || Value < 1 || Value > PLAYER_LOG_LIST_MAX_LIMIT) {
            res.status(400).json({ error: { code: "PLAYER_LOGS_QUERY", message: `limit must be a whole number from 1 to ${PLAYER_LOG_LIST_MAX_LIMIT}.` } });
            return;
        }
        Limit = Value;
    }
    const BeforeText = QueryText(req.query.before);
    let Before: number | undefined;
    if (BeforeText !== undefined) {
        const Ms = BeforeText === null ? NaN : (ISO_UTC.test(BeforeText) ? Date.parse(BeforeText) : NaN);
        if (!Number.isFinite(Ms)) {
            res.status(400).json({ error: { code: "PLAYER_LOGS_QUERY", message: "before must be a UTC time such as 2026-10-15T12:00:00.000Z." } });
            return;
        }
        Before = Ms;
    }
    const Page = ListPlayerLogSessions(PlayerLogsRoot(), {
        userId: UserIdText === undefined || UserIdText === "" ? undefined : UserIdText,
        limit: Limit,
        before: Before
    });
    res.status(200).json(Page);
}

/**
 * GET /admin/v1/player-logs/:userId/:launchSessionId/:fileName: the file's bytes as text (metadata.json as JSON). ?download=1 adds
 * Content-Disposition: attachment; any other download value is refused.
 */
export async function ReadPlayerLogFileRoute(req: Request, res: Response): Promise<void> {
    const DownloadText = QueryText(req.query.download);
    if (DownloadText !== undefined && DownloadText !== "0" && DownloadText !== "1") {
        res.status(400).json({ error: { code: "PLAYER_LOGS_QUERY", message: "download must be 1 or 0." } });
        return;
    }
    const Result = ReadPlayerLogFile(PlayerLogsRoot(), String(req.params.userId ?? ""), String(req.params.launchSessionId ?? ""), String(req.params.fileName ?? ""));
    if (!Result.ok) {
        SendRefusal(res, Result);
        return;
    }
    res.status(200);
    res.setHeader("Content-Type", Result.contentType);
    res.setHeader("Content-Length", String(Result.bytes.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (DownloadText === "1") res.setHeader("Content-Disposition", `attachment; filename="${Result.name}"`);
    res.end(Result.bytes);
}

/**
 * DELETE /admin/v1/player-logs/:userId/:launchSessionId with { reason } (8 to 200 characters): removes the session folder and writes the
 * audit record player_logs.delete. If the audit record cannot be written after the removal, the answer says so (500) and the log names it.
 */
export async function DeletePlayerLogSessionRoute(req: Request, res: Response): Promise<void> {
    const Actor = (req as any).AdminAuth.account as LauncherAccountRecord;
    const UserId = String(req.params.userId ?? "");
    const LaunchSessionId = String(req.params.launchSessionId ?? "");
    const Reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (Reason.length < PLAYER_LOG_REASON_MIN || Reason.length > PLAYER_LOG_REASON_MAX) {
        res.status(400).json({
            error: { code: "PLAYER_LOG_REASON", message: `Give a reason of ${PLAYER_LOG_REASON_MIN} to ${PLAYER_LOG_REASON_MAX} characters for the audit log.` }
        });
        return;
    }

    const Removed = DeletePlayerLogSession(PlayerLogsRoot(), UserId, LaunchSessionId);
    if (!Removed.ok) {
        SendRefusal(res, Removed);
        return;
    }

    const RequestId = crypto.randomUUID();
    try {
        await GetRepositories().admin.appendAudit({
            id: crypto.randomUUID(),
            actorUserId: Actor.userId,
            targetUserId: UserId,
            action: "player_logs.delete",
            oldState: {
                launchSessionId: Removed.session.launchSessionId,
                uploadedAt: Removed.session.uploadedAt,
                files: Removed.session.files,
                totalBytes: Removed.session.totalBytes
            },
            newState: { deleted: true },
            reason: Reason,
            ip: req.ip ?? "unknown",
            requestId: RequestId,
            createdAt: new Date().toISOString()
        });
    } catch (error) {
        logger.error(`[PlayerLogs] a session was removed but its audit record could not be written (request ${RequestId}): ${error}`);
        res.status(500).json({
            error: { code: "PLAYER_LOG_AUDIT_FAILED", message: "The session was removed, but its audit record could not be written. Check the audit log." },
            requestId: RequestId
        });
        return;
    }
    res.status(200).json({
        deleted: true,
        requestId: RequestId,
        userId: UserId,
        launchSessionId: LaunchSessionId,
        files: Removed.session.files.length,
        totalBytes: Removed.session.totalBytes
    });
}
