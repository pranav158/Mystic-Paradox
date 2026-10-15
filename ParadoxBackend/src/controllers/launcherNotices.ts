/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { Request, Response } from "express";
import { GetRepositories, GetUnitOfWork, LauncherAccountRecord, LauncherNoticesRecord } from "../persistence";
import { logger } from "../logger";
import { LauncherApiError, SendLauncherError } from "../security/launcherErrors";
import {
    AdminLauncherNoticesView,
    EmptyLauncherNotices,
    PublicLauncherNoticesView,
    ValidateLauncherNoticesExpectedVersion,
    ValidateLauncherNoticesInput,
    ValidateLauncherNoticesReason
} from "../services/launcherNotices";

// [2026-10-15] The launcher notices (SteamDocs/LAUNCHER_NOTICES_2026_10_15.md): the public read the launcher polls, and the manager's read and
// versioned save. The store and the rules are in persistence/contracts/LauncherNoticesRepository.ts and services/launcherNotices.ts.

// The launcher polls this every five minutes, and the answer is cacheable for half a minute (the contract).
const PUBLIC_CACHE_CONTROL = "public, max-age=30";

// One log line per streak of failed reads (reset by the next good read), so a broken store does not flood the log every poll.
let PublicReadFailureLogged = false;

/** GET /launcher/v1/notices: the items active now. A store read error answers the empty set, never an error the launcher must show. */
export async function GetPublicLauncherNotices(_req: Request, res: Response): Promise<void> {
    res.set("Cache-Control", PUBLIC_CACHE_CONTROL);
    let record: LauncherNoticesRecord | undefined;
    try {
        record = await GetRepositories().launcherNotices.get();
        PublicReadFailureLogged = false;
    } catch (error) {
        if (!PublicReadFailureLogged) {
            PublicReadFailureLogged = true;
            logger.error(`[LauncherNotices] could not read the notices, answering none: ${error}`);
        }
        record = undefined;
    }
    res.status(200).json(PublicLauncherNoticesView(record, Date.now(), new Date().toISOString()));
}

/** GET /admin/v1/launcher-notices: the whole document, inactive items included. */
export async function GetAdminLauncherNotices(_req: Request, res: Response): Promise<void> {
    try {
        const record = await GetRepositories().launcherNotices.get();
        res.status(200).json(AdminLauncherNoticesView(record, new Date().toISOString()));
    } catch (error) {
        logger.error(`[LauncherNotices] admin read failed: ${error}`);
        SendLauncherError(res, new LauncherApiError("INTERNAL", "The launcher notices could not be read. Please try again."));
    }
}

/** Thrown inside the save's transaction when the stored version is not the one the caller read: the transaction rolls back. */
class NoticesVersionConflict extends Error {
    constructor(readonly current: LauncherNoticesRecord) {
        super("NOTICES_VERSION_CONFLICT");
        this.name = "NoticesVersionConflict";
    }
}

function NoticesAuditState(record: LauncherNoticesRecord): Record<string, unknown> {
    return { version: record.version, announcements: record.announcements, tags: record.tags };
}

/**
 * PUT /admin/v1/launcher-notices: { announcements, tags, expectedVersion, reason }. The whole set is replaced; 400 NOTICES_INVALID for any
 * refused field (named in the message), 409 NOTICES_VERSION_CONFLICT (with the current document) when expectedVersion is stale. The
 * version check, the write and the admin audit record are one transaction.
 */
export async function UpdateLauncherNotices(req: Request, res: Response): Promise<void> {
    const actor = (req as any).AdminAuth.account as LauncherAccountRecord;
    const Body = req.body !== null && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : undefined;

    const Content = ValidateLauncherNoticesInput(req.body, { newId: () => crypto.randomUUID() });
    if (!Content.ok) {
        SendLauncherError(res, new LauncherApiError("NOTICES_INVALID", Content.message));
        return;
    }
    const Reason = ValidateLauncherNoticesReason(Body?.reason);
    if (!Reason.ok) {
        SendLauncherError(res, new LauncherApiError("NOTICES_INVALID", Reason.message));
        return;
    }
    const Version = ValidateLauncherNoticesExpectedVersion(Body?.expectedVersion);
    if (!Version.ok) {
        SendLauncherError(res, new LauncherApiError("NOTICES_INVALID", Version.message));
        return;
    }

    const requestId = crypto.randomUUID();
    const savedAt = new Date().toISOString();
    try {
        const After = await GetUnitOfWork().withTransaction(async (repos, session) => {
            const Before = (await repos.launcherNotices.get(session)) ?? EmptyLauncherNotices();
            if (Before.version !== Version.value) throw new NoticesVersionConflict(Before);
            const Next: LauncherNoticesRecord = {
                version: Version.value + 1,
                updatedAt: savedAt,
                updatedBy: actor.userId,
                announcements: Content.value.announcements,
                tags: Content.value.tags
            };
            const Written = await repos.launcherNotices.replaceIfVersion(Next, Version.value, session);
            if (!Written) throw new NoticesVersionConflict(Before);
            await repos.admin.appendAudit({
                id: crypto.randomUUID(),
                actorUserId: actor.userId,
                action: "launcher_notices.update",
                oldState: NoticesAuditState(Before),
                newState: NoticesAuditState(Next),
                reason: Reason.value,
                ip: req.ip ?? "unknown",
                requestId,
                createdAt: savedAt
            }, session);
            return Next;
        });
        logger.info(`[LauncherNotices] saved version ${After.version} by ${actor.userId}: ${After.announcements.length} announcement(s), ${After.tags.length} tag(s)`);
        res.status(200).json(AdminLauncherNoticesView(After, new Date().toISOString()));
    } catch (error) {
        if (error instanceof NoticesVersionConflict) {
            SendLauncherError(res, new LauncherApiError("NOTICES_VERSION_CONFLICT",
                "The launcher notices were saved by someone else. Reload them and apply your change again.",
                { details: { current: AdminLauncherNoticesView(error.current, new Date().toISOString()) } }));
            return;
        }
        logger.error(`[LauncherNotices] save failed: ${error}`);
        SendLauncherError(res, new LauncherApiError("INTERNAL", "The launcher notices could not be saved. Please try again."));
    }
}
