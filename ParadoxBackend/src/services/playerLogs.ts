/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import fs from "node:fs";
import path from "node:path";
import { isAllowedLauncherLogFileName, isSafeSegment, LAUNCHER_LOG_SESSION_ID_PATTERN } from "./launcherLogNames";
import { ListUploadedLogSessions, UploadedAtOf, UploadedLogSession } from "./launcherLogRetention";

// [2026-10-15] The operator's view of the tester uploads (routes: controllers/adminPlayerLogs.ts). Every function takes the upload root
// as an argument, so the tests use a temporary folder. Paths are checked before any file is touched: a segment must be a plain name, a
// file must carry one of the launcher's names, a folder or file that is a symbolic link is never followed, and the session must resolve
// inside the root. Contents are returned as bytes; nothing here logs them.

/** The largest file the admin view serves. An upload is capped at the same size, so a larger file is not one the launcher wrote. */
export const PLAYER_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const PLAYER_LOG_LIST_DEFAULT_LIMIT = 50;
export const PLAYER_LOG_LIST_MAX_LIMIT = 200;
/** The reason an operator gives for a deletion (trimmed length), written to the audit record. */
export const PLAYER_LOG_REASON_MIN = 8;
export const PLAYER_LOG_REASON_MAX = 200;

const TEXT_TYPE = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

export interface PlayerLogFile {
    name: string;
    size: number;
}

export interface PlayerLogSession {
    userId: string;
    launchSessionId: string;
    /** The last upload of the session (UTC, milliseconds). */
    uploadedAt: string;
    /** The launcher's files that are present (other names are never listed). */
    files: PlayerLogFile[];
    totalBytes: number;
}

export interface PlayerLogPage {
    sessions: PlayerLogSession[];
    /** Pass as `before` to get the sessions uploaded earlier than this page; null when this page is the last. */
    nextBefore: string | null;
}

export interface PlayerLogRefusal {
    ok: false;
    status: 400 | 404 | 413;
    code: string;
    message: string;
}

export interface PlayerLogFileBytes {
    ok: true;
    name: string;
    contentType: string;
    bytes: Buffer;
}

function Refuse(status: 400 | 404 | 413, code: string, message: string): PlayerLogRefusal {
    return { ok: false, status, code, message };
}

function LStatOrUndefined(target: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(target);
    } catch {
        return undefined;
    }
}

function CompareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** The launcher's files in one session folder, by name. Other names and links are left out. */
function FilesOf(sessionDir: string): PlayerLogFile[] {
    const Files: PlayerLogFile[] = [];
    for (const Name of fs.readdirSync(sessionDir)) {
        if (!isAllowedLauncherLogFileName(Name)) continue;
        const Stat = LStatOrUndefined(path.join(sessionDir, Name));
        if (Stat === undefined || !Stat.isFile()) continue;
        Files.push({ name: Name, size: Stat.size });
    }
    return Files.sort((a, b) => CompareText(a.name, b.name));
}

function SummaryOf(session: UploadedLogSession, uploadedMs: number): PlayerLogSession {
    const Files = FilesOf(session.dir);
    return {
        userId: session.userId,
        launchSessionId: session.sessionId,
        uploadedAt: new Date(uploadedMs).toISOString(),
        files: Files,
        totalBytes: Files.reduce((sum, file) => sum + file.size, 0),
    };
}

/**
 * The uploaded sessions, newest first. `userId` limits the list to one account; `before` (milliseconds) keeps only the sessions uploaded
 * strictly earlier. A page never splits a group of sessions with the same upload time, so `nextBefore` loses none of them.
 */
export function ListPlayerLogSessions(root: string, options: { userId?: string; limit: number; before?: number }): PlayerLogPage {
    if (options.userId !== undefined && !isSafeSegment(options.userId)) return { sessions: [], nextBefore: null };
    // Whole milliseconds: the cursor is an ISO string, and a fraction would move a session across the boundary.
    const Sorted = ListUploadedLogSessions(root, options.userId)
        .map((session) => ({ session, uploadedMs: Math.floor(session.uploadedAtMs) }))
        .filter((entry) => options.before === undefined || entry.uploadedMs < options.before)
        .sort((a, b) => (b.uploadedMs - a.uploadedMs)
            || CompareText(a.session.userId, b.session.userId)
            || CompareText(a.session.sessionId, b.session.sessionId));
    let Take = Math.min(options.limit, Sorted.length);
    if (Sorted.length > options.limit) {
        const Edge = Sorted[options.limit - 1].uploadedMs;
        while (Take < Sorted.length && Sorted[Take].uploadedMs === Edge) Take += 1;
    }
    const Page = Sorted.slice(0, Take).map((entry) => SummaryOf(entry.session, entry.uploadedMs));
    const NextBefore = Take < Sorted.length ? new Date(Sorted[Take - 1].uploadedMs).toISOString() : null;
    return { sessions: Page, nextBefore: NextBefore };
}

/** Resolves a session folder under the root, or refuses. Nothing below the root is a link, and the folder resolves inside the root. */
function LocateSession(root: string, userId: string, launchSessionId: string): { ok: true; sessionDir: string } | PlayerLogRefusal {
    if (!isSafeSegment(userId) || !isSafeSegment(launchSessionId) || !LAUNCHER_LOG_SESSION_ID_PATTERN.test(launchSessionId)) {
        return Refuse(400, "PLAYER_LOG_PATH", "The account or session id is not a valid folder name.");
    }
    const Missing = Refuse(404, "PLAYER_LOG_NOT_FOUND", "No such uploaded session.");
    if (!fs.existsSync(root)) return Missing;
    const UserDir = path.join(root, userId);
    const SessionDir = path.join(UserDir, launchSessionId);
    const UserStat = LStatOrUndefined(UserDir);
    const SessionStat = LStatOrUndefined(SessionDir);
    if (UserStat === undefined || !UserStat.isDirectory() || SessionStat === undefined || !SessionStat.isDirectory()) return Missing;
    const RootReal = fs.realpathSync(root);
    const SessionReal = fs.realpathSync(SessionDir);
    const Relative = path.relative(RootReal, SessionReal);
    if (Relative === "" || path.isAbsolute(Relative) || Relative.split(path.sep)[0] === "..") return Missing;
    return { ok: true, sessionDir: SessionDir };
}

/** The bytes of one launcher file of one uploaded session. Only the launcher's names; at most PLAYER_LOG_FILE_MAX_BYTES. */
export function ReadPlayerLogFile(root: string, userId: string, launchSessionId: string, fileName: string): PlayerLogFileBytes | PlayerLogRefusal {
    if (!isSafeSegment(fileName)) return Refuse(400, "PLAYER_LOG_PATH", "The file name is not a valid file name.");
    if (!isAllowedLauncherLogFileName(fileName)) {
        return Refuse(400, "PLAYER_LOG_NAME_REFUSED", "Only the launcher's log files can be read (metadata.json, launcher.log, runtime logs).");
    }
    const Located = LocateSession(root, userId, launchSessionId);
    if (!Located.ok) return Located;
    const FilePath = path.join(Located.sessionDir, fileName);
    const Stat = LStatOrUndefined(FilePath);
    if (Stat === undefined || !Stat.isFile()) return Refuse(404, "PLAYER_LOG_NOT_FOUND", "No such file in that session.");
    if (Stat.size > PLAYER_LOG_FILE_MAX_BYTES) return Refuse(413, "PLAYER_LOG_TOO_LARGE", "That file is larger than the admin view serves.");
    let Bytes: Buffer;
    try {
        Bytes = fs.readFileSync(FilePath);
    } catch {
        return Refuse(404, "PLAYER_LOG_NOT_FOUND", "No such file in that session.");
    }
    if (Bytes.length > PLAYER_LOG_FILE_MAX_BYTES) return Refuse(413, "PLAYER_LOG_TOO_LARGE", "That file is larger than the admin view serves.");
    return { ok: true, name: fileName, contentType: fileName === "metadata.json" ? JSON_TYPE : TEXT_TYPE, bytes: Bytes };
}

/** Removes one uploaded session folder and returns what it held (for the audit record). The folder is never followed through a link. */
export function DeletePlayerLogSession(root: string, userId: string, launchSessionId: string): { ok: true; session: PlayerLogSession } | PlayerLogRefusal {
    const Located = LocateSession(root, userId, launchSessionId);
    if (!Located.ok) return Located;
    const Uploaded = Math.floor(UploadedAtOf(Located.sessionDir));
    const Summary = SummaryOf({ userId, sessionId: launchSessionId, dir: Located.sessionDir, uploadedAtMs: Uploaded }, Uploaded);
    fs.rmSync(Located.sessionDir, { recursive: true, force: true });
    return { ok: true, session: Summary };
}
