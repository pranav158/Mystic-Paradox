/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import fs from "node:fs";
import path from "node:path";
import { DAY_MS, SERVER_LOG_DEFAULT_RETENTION_DAYS } from "../legal/retentionPolicy";

// [2026-10-14] Retention of the server log (debug/metagame/metagame.log), Privacy Policy section 5. At the start of a server run
// (logger.ts calls this only in the server entry, before the file transport opens the log) the previous run's file is archived
// whenever it has content, and archives older than MYSTICPARADOX_LOG_RETENTION_DAYS are deleted. Archiving at every start (not only
// on a new UTC day) keeps a same-day restart from emptying the log: the server opens it with append: false.
// Only files matching the archive name are ever deleted. Nothing here runs under the test runner.

const ARCHIVE_NAME = /^metagame-\d{8}-\d{6}(?:-\d+)?\.log$/;


/** The previous run's log is archived whenever it has content; an empty file is simply reopened. */
export function ShouldRotateServerLog(file: { size: number }): boolean {
    return file.size > 0;
}

/** metagame-YYYYMMDD-HHMMSS.log (UTC), with -2, -3, ... when a file of that second already exists. Colons are not allowed on Windows. */
export function ServerLogArchiveName(nowMs: number, taken: (name: string) => boolean): string {
    const Stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    let Name = `metagame-${Stamp}.log`;
    for (let Suffix = 2; taken(Name); Suffix++) {
        Name = `metagame-${Stamp}-${Suffix}.log`;
    }
    return Name;
}

/** The archive names whose last write is older than the retention period. */
export function ExpiredServerLogArchives(entries: Array<{ name: string; mtimeMs: number }>, nowMs: number, retentionDays: number): string[] {
    const Cutoff = nowMs - retentionDays * DAY_MS;
    return entries
        .filter((entry) => ARCHIVE_NAME.test(entry.name) && entry.mtimeMs < Cutoff)
        .map((entry) => entry.name);
}

/** MYSTICPARADOX_LOG_RETENTION_DAYS: a whole number of days, 90 when unset or not a whole number of at least 1. */
export function ServerLogRetentionDays(environment: NodeJS.ProcessEnv = process.env): number {
    const Raw = environment.MYSTICPARADOX_LOG_RETENTION_DAYS?.trim();
    if (Raw === undefined || Raw === "") return SERVER_LOG_DEFAULT_RETENTION_DAYS;
    const Value = Number(Raw);
    return Number.isInteger(Value) && Value >= 1 ? Value : SERVER_LOG_DEFAULT_RETENTION_DAYS;
}

export interface ServerLogRotationResult {
    rotatedTo?: string;
    deleted: string[];
}

/**
 * Archives the live log when it is due and deletes expired archives. Call it before anything opens `logPath`. A missing log is not
 * an error (a first start has nothing to archive).
 */
export function RotateServerLogAtStart(logPath: string, nowMs: number, retentionDays: number,
    fileSystem: typeof fs = fs): ServerLogRotationResult {
    const Dir = path.dirname(logPath);
    const Result: ServerLogRotationResult = { deleted: [] };

    let Live: fs.Stats | undefined;
    try {
        Live = fileSystem.statSync(logPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Live !== undefined && ShouldRotateServerLog({ size: Live.size })) {
        const Name = ServerLogArchiveName(nowMs, (candidate) => fileSystem.existsSync(path.join(Dir, candidate)));
        fileSystem.renameSync(logPath, path.join(Dir, Name));
        Result.rotatedTo = Name;
    }

    if (fileSystem.existsSync(Dir)) {
        const Entries = fileSystem.readdirSync(Dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && ARCHIVE_NAME.test(entry.name))
            .map((entry) => ({ name: entry.name, mtimeMs: fileSystem.statSync(path.join(Dir, entry.name)).mtimeMs }));
        for (const Name of ExpiredServerLogArchives(Entries, nowMs, retentionDays)) {
            fileSystem.unlinkSync(path.join(Dir, Name));
            Result.deleted.push(Name);
        }
    }
    return Result;
}
