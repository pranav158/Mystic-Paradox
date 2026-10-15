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
import { LAUNCHER_LOG_SESSION_ID_PATTERN } from "./launcherLogNames";

// [2026-10-14] Uploaded launcher log sessions (tester uploads, routes/launcherLogs.ts) are stored as
// <root>/<accountId>/<launchSessionId>/<file>, with .uploaded-at.json beside the files. Privacy Policy section 1 says they contain the
// username and the game folder path, so they are kept 90 days after their last upload (scripts/purge_uploaded_logs.ts) and removed
// with the account (scripts/process_account_deletions.ts). Removal only ever touches folders named like an account or a session.
// [2026-10-15] The server runs the same expiry rule by itself (StartUploadedLogRetention below). Symbolic links are never followed here:
// a folder that is a link is not listed, so it is never removed through the link.

const ACCOUNT_FOLDER = /^[A-Za-z0-9-]{1,64}$/;
const SESSION_FOLDER = LAUNCHER_LOG_SESSION_ID_PATTERN;

export interface UploadedLogSession {
    userId: string;
    sessionId: string;
    dir: string;
    /** The last upload of the session (.uploaded-at.json), or the folder's own time when that file is unreadable. */
    uploadedAtMs: number;
}

/** The last upload time of a session folder in milliseconds (the marker, else the folder's own time). */
export function UploadedAtOf(sessionDir: string): number {
    try {
        const Recorded = JSON.parse(fs.readFileSync(path.join(sessionDir, ".uploaded-at.json"), "utf8")) as { lastUploadedAt?: unknown };
        const Ms = typeof Recorded.lastUploadedAt === "string" ? Date.parse(Recorded.lastUploadedAt) : NaN;
        if (Number.isFinite(Ms)) return Ms;
    } catch {
        // No or unreadable record: the folder's own time decides.
    }
    return fs.statSync(sessionDir).mtimeMs;
}

/** True for a real folder: a symbolic link (or junction) is not one. */
function IsRealDirectory(dir: string): boolean {
    try {
        return fs.lstatSync(dir).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Every uploaded session under `root`, in account and session folders with plain names. With `userId`, only that account's folder is
 * read (the admin list of one player). Symbolic links are skipped.
 */
export function ListUploadedLogSessions(root: string, userId?: string): UploadedLogSession[] {
    if (!fs.existsSync(root)) return [];
    const Sessions: UploadedLogSession[] = [];
    const Accounts = userId === undefined ? fs.readdirSync(root) : [userId];
    for (const UserId of Accounts) {
        const UserDir = path.join(root, UserId);
        if (!ACCOUNT_FOLDER.test(UserId) || !IsRealDirectory(UserDir)) continue;
        for (const SessionId of fs.readdirSync(UserDir)) {
            const SessionDir = path.join(UserDir, SessionId);
            if (!SESSION_FOLDER.test(SessionId) || !IsRealDirectory(SessionDir)) continue;
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

/** What one pass did. Counts and error codes only: the caller may log it, and it names no account and no session. */
export interface UploadedLogRetentionPass {
    checked: number;
    expired: number;
    removed: number;
    failed: number;
    /** The distinct error codes (EACCES, EBUSY ...) of the removals that failed, sorted. */
    failureCodes: string[];
}

/** The error code of a failure (EACCES, EBUSY ...), or UNKNOWN. The message is never used: it names paths. */
function ErrorCodeOf(error: unknown): string {
    const Code = (error as NodeJS.ErrnoException | undefined)?.code;
    return typeof Code === "string" && /^[A-Z0-9_]{1,32}$/.test(Code) ? Code : "UNKNOWN";
}

/**
 * One pass of the retention: removes every uploaded session whose last upload is past the period. A removal that fails is counted by its
 * error code and the pass goes on. `remove` is injectable for the tests.
 */
export function PurgeExpiredUploadedLogs(root: string, nowMs: number, retentionDays: number = UPLOADED_LAUNCHER_LOG_RETENTION_DAYS,
    remove: (dir: string) => void = (dir) => fs.rmSync(dir, { recursive: true, force: true })): UploadedLogRetentionPass {
    const All = ListUploadedLogSessions(root);
    const Expired = ExpiredUploadedLogSessions(All, nowMs, retentionDays);
    let Removed = 0;
    let Failed = 0;
    const Codes = new Set<string>();
    for (const Session of Expired) {
        try {
            remove(Session.dir);
            Removed += 1;
        } catch (error) {
            Failed += 1;
            Codes.add(ErrorCodeOf(error));
        }
    }
    return { checked: All.length, expired: Expired.length, removed: Removed, failed: Failed, failureCodes: [...Codes].sort() };
}

/** The switch that turns the automatic pass off. Blank and on keep it on, which is the policy default. */
export const UPLOADED_LOG_RETENTION_SWITCH_KEY = "MYSTICPARADOX_LOG_RETENTION";
/** The first pass runs this long after start (shortly, so a bad start shows at once). */
export const UPLOADED_LOG_RETENTION_FIRST_PASS_MS = 60_000;
/** Then one pass every six hours. */
export const UPLOADED_LOG_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** `off` (any case, spaces trimmed) disables the pass. Blank and `on` keep it on; any other value keeps it on and is reported. */
export function ReadUploadedLogRetentionSwitch(environment: NodeJS.ProcessEnv = process.env): { enabled: boolean; unrecognised: boolean } {
    const Raw = (environment[UPLOADED_LOG_RETENTION_SWITCH_KEY] ?? "").trim().toLowerCase();
    if (Raw === "off") return { enabled: false, unrecognised: false };
    return { enabled: true, unrecognised: Raw !== "" && Raw !== "on" };
}

export interface UploadedLogRetentionTimers {
    setTimeout(callback: () => void, ms: number): { unref(): unknown };
    clearTimeout(handle: unknown): void;
    setInterval(callback: () => void, ms: number): { unref(): unknown };
    clearInterval(handle: unknown): void;
}

const NodeTimers: UploadedLogRetentionTimers = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface UploadedLogRetentionOptions {
    /** The folder of the uploads (routes/launcherLogs.ts LOG_STORAGE_ROOT). */
    root: string;
    /** One line per event. The server passes its logger; the lines carry counts and error codes only. */
    log: (line: string) => void;
    retentionDays?: number;
    firstPassMs?: number;
    intervalMs?: number;
    now?: () => number;
    timers?: UploadedLogRetentionTimers;
}

export interface UploadedLogRetentionJob {
    /** Stops both timers. A pass is synchronous, so one that is running has already finished. */
    stop(): void;
}

/**
 * Starts the automatic pass when the switch allows it (server.ts calls this once at start). It logs one line at start (or why it is off),
 * one line per pass, and both timers are unref-ed, so they never keep the process alive. Returns undefined when the switch is off.
 */
export function StartUploadedLogRetention(options: UploadedLogRetentionOptions,
    environment: NodeJS.ProcessEnv = process.env): UploadedLogRetentionJob | undefined {
    const Switch = ReadUploadedLogRetentionSwitch(environment);
    if (!Switch.enabled) {
        options.log(`[LogRetention] automatic purge of uploaded launcher logs is off (${UPLOADED_LOG_RETENTION_SWITCH_KEY}=off); they stay until removed by hand`);
        return undefined;
    }
    if (Switch.unrecognised) {
        options.log(`[LogRetention] ${UPLOADED_LOG_RETENTION_SWITCH_KEY} is neither off nor on; the automatic purge stays on`);
    }
    const Days = options.retentionDays ?? UPLOADED_LAUNCHER_LOG_RETENTION_DAYS;
    const FirstMs = options.firstPassMs ?? UPLOADED_LOG_RETENTION_FIRST_PASS_MS;
    const IntervalMs = options.intervalMs ?? UPLOADED_LOG_RETENTION_INTERVAL_MS;
    const Now = options.now ?? (() => Date.now());
    const Timers = options.timers ?? NodeTimers;

    const RunPass = (): void => {
        try {
            const Pass = PurgeExpiredUploadedLogs(options.root, Now(), Days);
            const Codes = Pass.failureCodes.length > 0 ? ` (${Pass.failureCodes.join(", ")})` : "";
            options.log(`[LogRetention] uploaded launcher logs: checked ${Pass.checked}, older than ${Days} days ${Pass.expired}, removed ${Pass.removed}, failed ${Pass.failed}${Codes}`);
        } catch (error) {
            options.log(`[LogRetention] uploaded launcher logs: the pass could not run (${ErrorCodeOf(error)})`);
        }
    };

    options.log(`[LogRetention] uploaded launcher logs are removed ${Days} days after their last upload; first pass in ${Math.round(FirstMs / 1000)} s, then every ${Math.round(IntervalMs / 3_600_000)} h`);
    const First = Timers.setTimeout(RunPass, FirstMs);
    First.unref();
    const Repeat = Timers.setInterval(RunPass, IntervalMs);
    Repeat.unref();
    return {
        stop(): void {
            Timers.clearTimeout(First);
            Timers.clearInterval(Repeat);
        },
    };
}
