/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import fs from "node:fs";
import path from "node:path";
import { DAY_MS, UPLOADED_LAUNCHER_LOG_RETENTION_DAYS } from "../legal/retentionPolicy";

// [2026-10-14] Uploaded launcher log sessions (tester uploads, routes/launcherLogs.ts) are stored as
// <root>/<accountId>/<launchSessionId>/<file>, with .uploaded-at.json beside the files. Privacy Policy section 1 says they contain the
// username and the game folder path, so they are kept 90 days after their last upload (scripts/purge_uploaded_logs.ts) and removed
// with the account (scripts/process_account_deletions.ts). Removal only ever touches folders named like an account or a session.

const ACCOUNT_FOLDER = /^[A-Za-z0-9-]{1,64}$/;
const SESSION_FOLDER = /^[a-f0-9-]{8,64}$/i;

export interface UploadedLogSession {
    userId: string;
    sessionId: string;
    dir: string;
    /** The last upload of the session (.uploaded-at.json), or the folder's own time when that file is unreadable. */
    uploadedAtMs: number;
}

function UploadedAtOf(sessionDir: string): number {
    try {
        const Recorded = JSON.parse(fs.readFileSync(path.join(sessionDir, ".uploaded-at.json"), "utf8")) as { lastUploadedAt?: unknown };
        const Ms = typeof Recorded.lastUploadedAt === "string" ? Date.parse(Recorded.lastUploadedAt) : NaN;
        if (Number.isFinite(Ms)) return Ms;
    } catch {
        // No or unreadable record: the folder's own time decides.
    }
    return fs.statSync(sessionDir).mtimeMs;
}

/** Every uploaded session under `root`, in account and session folders with plain names. */
export function ListUploadedLogSessions(root: string): UploadedLogSession[] {
    if (!fs.existsSync(root)) return [];
    const Sessions: UploadedLogSession[] = [];
    for (const UserId of fs.readdirSync(root)) {
        const UserDir = path.join(root, UserId);
        if (!ACCOUNT_FOLDER.test(UserId) || !fs.statSync(UserDir).isDirectory()) continue;
        for (const SessionId of fs.readdirSync(UserDir)) {
            const SessionDir = path.join(UserDir, SessionId);
            if (!SESSION_FOLDER.test(SessionId) || !fs.statSync(SessionDir).isDirectory()) continue;
            Sessions.push({ userId: UserId, sessionId: SessionId, dir: SessionDir, uploadedAtMs: UploadedAtOf(SessionDir) });
        }
    }
    return Sessions;
}

/** The sessions whose last upload is older than the retention period at `nowMs`. */
export function ExpiredUploadedLogSessions(sessions: UploadedLogSession[], nowMs: number,
    retentionDays: number = UPLOADED_LAUNCHER_LOG_RETENTION_DAYS): UploadedLogSession[] {
    const Cutoff = nowMs - retentionDays * DAY_MS;
    return sessions.filter((session) => session.uploadedAtMs < Cutoff);
}

/** Removes the session folders given (they must come from ListUploadedLogSessions) and returns how many were removed. */
export function RemoveUploadedLogSessions(sessions: UploadedLogSession[]): number {
    for (const Session of sessions) {
        fs.rmSync(Session.dir, { recursive: true, force: true });
    }
    return sessions.length;
}

/** Removes every upload of one account (the account deletion). Refuses an id that is not a plain folder name. */
export function RemoveUploadedLogsOfAccount(root: string, userId: string): number {
    if (!ACCOUNT_FOLDER.test(userId)) {
        throw new Error("Refusing to remove uploaded logs for an account id that is not a plain folder name");
    }
    const UserDir = path.join(root, userId);
    if (!fs.existsSync(UserDir)) return 0;
    const Count = ListUploadedLogSessions(root).filter((session) => session.userId === userId).length;
    fs.rmSync(UserDir, { recursive: true, force: true });
    return Count;
}
