/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LOG_STORAGE_ROOT } from "./launcherLogs";

// A separate, narrowly-scoped credential from the interactive admin dashboard's
// TOTP+cookie+CSRF session — this is for an unattended script (see
// scripts/sync-launcher-logs.mjs) pulling uploaded logs to the dev machine, which can't do an
// interactive MFA flow. Same shared-secret pattern already used for the runtime-update
// publisher endpoints (see UPDATE_PUBLISHER_API_KEY in launcherUpdates.ts). Scoped to
// read-only listing/download of already-uploaded logs — nothing else.
function hasValidSyncToken(req: Request): boolean {
    const expected = process.env.LAUNCHER_LOG_SYNC_TOKEN?.trim();
    const provided = req.header("x-sync-token")?.trim();
    if (!expected || !provided || expected.length !== provided.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    } catch {
        return false;
    }
}

function requireSyncToken(req: Request, res: Response, next: NextFunction): void {
    if (!hasValidSyncToken(req)) {
        res.status(401).json({ error: "Invalid sync credentials." });
        return;
    }
    next();
}

export const adminLauncherLogsRouter = Router();

interface SessionEntry {
    userId: string;
    launchSessionId: string;
    uploadedAt: string;
    files: string[];
}

function isSafeSegment(value: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function listSessions(sinceIso: string | undefined): SessionEntry[] {
    const entries: SessionEntry[] = [];
    if (!fs.existsSync(LOG_STORAGE_ROOT)) return entries;
    const since = sinceIso ? Date.parse(sinceIso) : undefined;

    for (const userId of fs.readdirSync(LOG_STORAGE_ROOT)) {
        if (!isSafeSegment(userId)) continue;
        const userDir = path.join(LOG_STORAGE_ROOT, userId);
        if (!fs.statSync(userDir).isDirectory()) continue;

        for (const launchSessionId of fs.readdirSync(userDir)) {
            if (!isSafeSegment(launchSessionId)) continue;
            const sessionDir = path.join(userDir, launchSessionId);
            if (!fs.statSync(sessionDir).isDirectory()) continue;

            let uploadedAt = new Date(fs.statSync(sessionDir).mtimeMs).toISOString();
            try {
                const marker = JSON.parse(fs.readFileSync(path.join(sessionDir, ".uploaded-at.json"), "utf8")) as { lastUploadedAt?: string };
                if (marker.lastUploadedAt) uploadedAt = marker.lastUploadedAt;
            } catch {
                // No marker yet (shouldn't happen once a file's been uploaded) — fall back to dir mtime.
            }
            if (since != undefined && Date.parse(uploadedAt) <= since) continue;

            const files = fs.readdirSync(sessionDir).filter((name) => name !== ".uploaded-at.json");
            entries.push({ userId, launchSessionId, uploadedAt, files });
        }
    }
    return entries.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
}

adminLauncherLogsRouter.get("/admin/v1/launcher-logs", requireSyncToken, (req: Request, res: Response) => {
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    res.json({ sessions: listSessions(since) });
});

adminLauncherLogsRouter.get(
    "/admin/v1/launcher-logs/:userId/:launchSessionId/:fileName",
    requireSyncToken,
    (req: Request, res: Response) => {
        const userId = String(req.params.userId ?? "");
        const launchSessionId = String(req.params.launchSessionId ?? "");
        const fileName = String(req.params.fileName ?? "");
        if (![userId, launchSessionId, fileName].every(isSafeSegment)) {
            res.status(400).json({ error: "Invalid path." });
            return;
        }
        const filePath = path.join(LOG_STORAGE_ROOT, userId, launchSessionId, fileName);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            res.sendStatus(404);
            return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", fs.statSync(filePath).size);
        fs.createReadStream(filePath).pipe(res);
    }
);
