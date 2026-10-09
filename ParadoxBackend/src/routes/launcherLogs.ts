/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import express, { Router, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { HasLauncherAuth } from "../middleware/HasLauncherAuth";
import { GetRepositories, LauncherAccountRecord } from "../persistence";
import { LauncherApiError, SendLauncherError } from "../security/launcherErrors";
import { IsRateLimited } from "../security/rateLimit";
import { TESTER_ROLE } from "../security/testerFeatures";

// Stored on this backend's own host — it's already the authenticated, publicly-reachable
// service the launcher talks to (paradox.mysticfox.dev), so a session-log upload endpoint
// here needs no new service, deployment, certs, or firewall rules. Sibling-directory
// convention matches LAUNCHER_UPDATE_ROOT (see routes/launcherUpdates.ts / .env) — kept
// outside dist/ so `npm run build`'s clean step and any redeploy never touch it.
export const LOG_STORAGE_ROOT = path.resolve(process.env.LAUNCHER_LOG_STORAGE_DIR ?? path.join(process.cwd(), "..", "MysticLauncherLogs"));

const SESSION_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;
// Exactly the files the launcher's launch::logs module writes into a session folder — see
// ParadoxLauncher/src-tauri/src/launch/logs.rs. Anything else is rejected before it reaches disk.
const ALLOWED_EXACT_FILENAMES = new Set(["metadata.json", "launcher.log"]);
const ALLOWED_FILENAME_PATTERN = /^runtime-mysticparadox_dll_port\d+\.log$/i;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// Per-account caps so a tester (the only role that can reach this endpoint) can't fill the
// disk by minting unlimited session ids or re-uploading indefinitely. Generous for real
// usage (a handful of sessions/day, a few small text files each) but bounded.
const MAX_ACCOUNT_STORAGE_BYTES = 200 * 1024 * 1024;
const MAX_SESSIONS_PER_ACCOUNT = 200;

function isAllowedFilename(name: string): boolean {
    return ALLOWED_EXACT_FILENAMES.has(name) || ALLOWED_FILENAME_PATTERN.test(name);
}

function accountStorageUsage(userId: string): { totalBytes: number; sessionCount: number } {
    const userDir = path.join(LOG_STORAGE_ROOT, userId);
    if (!fs.existsSync(userDir)) return { totalBytes: 0, sessionCount: 0 };

    let totalBytes = 0;
    let sessionCount = 0;
    for (const sessionId of fs.readdirSync(userDir)) {
        const sessionDir = path.join(userDir, sessionId);
        if (!fs.statSync(sessionDir).isDirectory()) continue;
        sessionCount += 1;
        for (const fileName of fs.readdirSync(sessionDir)) {
            totalBytes += fs.statSync(path.join(sessionDir, fileName)).size;
        }
    }
    return { totalBytes, sessionCount };
}

export const launcherLogsRouter = Router();

launcherLogsRouter.put(
    "/launcher/v1/logs/sessions/:launchSessionId/:fileName",
    HasLauncherAuth,
    express.raw({ type: "application/octet-stream", limit: `${MAX_UPLOAD_BYTES}b` }),
    async (req: Request, res: Response) => {
        const AuthData = (req as any).LauncherAuthData;
        const Account = await GetRepositories().launcherAccounts.findByUserId(AuthData.userId) as LauncherAccountRecord | undefined;
        if (!Account || !Account.roles.includes(TESTER_ROLE)) {
            SendLauncherError(res, new LauncherApiError("AUTH_TESTER_REQUIRED", "Tester access is required to upload logs."));
            return;
        }

        if (IsRateLimited(`log-upload:${Account.userId}`, 120, 60 * 60 * 1000)) {
            res.status(429).json({ error: { code: "LOG_UPLOAD_RATE_LIMITED", message: "Too many uploads. Try again later." } });
            return;
        }
        if (IsRateLimited(`log-upload-ip:${req.ip ?? "unknown"}`, 300, 60 * 60 * 1000)) {
            res.status(429).json({ error: { code: "LOG_UPLOAD_RATE_LIMITED", message: "Too many uploads. Try again later." } });
            return;
        }

        const LaunchSessionId = String(req.params.launchSessionId ?? "");
        const FileName = String(req.params.fileName ?? "");
        if (!SESSION_ID_PATTERN.test(LaunchSessionId) || !isAllowedFilename(FileName)) {
            SendLauncherError(res, new LauncherApiError("AUTH_VALIDATION_FAILED", "Invalid session id or file name."));
            return;
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            SendLauncherError(res, new LauncherApiError("AUTH_VALIDATION_FAILED", "The uploaded file was empty."));
            return;
        }
        if (req.body.length > MAX_UPLOAD_BYTES) {
            SendLauncherError(res, new LauncherApiError("AUTH_VALIDATION_FAILED", "The uploaded file is too large."));
            return;
        }

        const SessionDir = path.join(LOG_STORAGE_ROOT, Account.userId, LaunchSessionId);
        const IsNewSession = !fs.existsSync(SessionDir);
        const Usage = accountStorageUsage(Account.userId);
        if (IsNewSession && Usage.sessionCount >= MAX_SESSIONS_PER_ACCOUNT) {
            res.status(413).json({ error: { code: "LOG_UPLOAD_QUOTA", message: "Session limit reached for this account." } });
            return;
        }
        if (Usage.totalBytes + (req.body as Buffer).length > MAX_ACCOUNT_STORAGE_BYTES) {
            res.status(413).json({ error: { code: "LOG_UPLOAD_QUOTA", message: "Storage quota reached for this account." } });
            return;
        }

        fs.mkdirSync(SessionDir, { recursive: true });
        const UploadedAt = new Date().toISOString();
        fs.writeFileSync(path.join(SessionDir, FileName), req.body as Buffer);
        fs.writeFileSync(
            path.join(SessionDir, ".uploaded-at.json"),
            `${JSON.stringify({ lastUploadedAt: UploadedAt })}\n`
        );

        res.status(201).json({ uploadedAt: UploadedAt });
    }
);
