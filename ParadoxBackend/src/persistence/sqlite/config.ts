/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import path from "node:path";

// Settings of the SQLite persistence provider (local realms, realms plan S5). Everything is read from the
// environment; nothing here is secret.
//
//   MYSTICPARADOX_SQLITE_PATH                      database file; ":memory:" for tests. A relative path is resolved
//                                                  against the backend folder, never the process working directory.
//                                                  Default: ../realm-data/realm.sqlite (next to the backend folder).
//   MYSTICPARADOX_SQLITE_SYNCHRONOUS               full (default) | normal. FULL fsyncs every commit; NORMAL (WAL)
//                                                  can lose the last commits on a power cut but never corrupts.
//   MYSTICPARADOX_SQLITE_BUSY_TIMEOUT_MS           wait for a lock held by ANOTHER process (default 5000). It blocks
//                                                  the event loop while waiting, so keep it short.
//   MYSTICPARADOX_SQLITE_QUEUE_TIMEOUT_MS          how long a write waits behind other writes and the open unit of work before it
//                                                  fails with SQLITE_QUEUE_TIMEOUT instead of hanging (default 60000).
//   MYSTICPARADOX_SQLITE_BACKUP_INTERVAL_MINUTES   VACUUM INTO backup when the newest one is older than this
//                                                  (default 1440 = daily, 0 = never). Checked at start and hourly.
//   MYSTICPARADOX_SQLITE_BACKUP_KEEP               number of backups kept in <database folder>/backups (default 7).

export interface SqliteRuntimeConfig {
    path: string;
    synchronous: "FULL" | "NORMAL";
    busyTimeoutMs: number;
    queueTimeoutMs: number;
    backupIntervalMinutes: number;
    backupKeep: number;
}

/** The ParadoxBackend folder, from both `src/persistence/sqlite` and the compiled `build/persistence/sqlite`. */
export const BACKEND_ROOT = path.resolve(__dirname, "..", "..", "..");
export const DEFAULT_SQLITE_RELATIVE_PATH = path.join("..", "realm-data", "realm.sqlite");
export const IN_MEMORY_DATABASE = ":memory:";

function ReadBoundedInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
    const raw = environment[name]?.trim();
    if (raw == undefined || raw.length === 0) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}

export function ResolveSqlitePath(raw: string | undefined): string {
    const value = raw?.trim();
    if (value == undefined || value.length === 0) return path.resolve(BACKEND_ROOT, DEFAULT_SQLITE_RELATIVE_PATH);
    if (value === IN_MEMORY_DATABASE) return value;
    if (/[\u0000-\u001F]/u.test(value)) throw new Error("MYSTICPARADOX_SQLITE_PATH contains control characters");
    return path.resolve(BACKEND_ROOT, value);
}

export function ReadSqliteRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): SqliteRuntimeConfig {
    const synchronous = (environment.MYSTICPARADOX_SQLITE_SYNCHRONOUS ?? "full").trim().toLowerCase();
    if (synchronous !== "full" && synchronous !== "normal") {
        throw new Error("MYSTICPARADOX_SQLITE_SYNCHRONOUS must be 'full' or 'normal'");
    }
    return {
        path: ResolveSqlitePath(environment.MYSTICPARADOX_SQLITE_PATH),
        synchronous: synchronous === "normal" ? "NORMAL" : "FULL",
        busyTimeoutMs: ReadBoundedInteger(environment, "MYSTICPARADOX_SQLITE_BUSY_TIMEOUT_MS", 5_000, 0, 60_000),
        queueTimeoutMs: ReadBoundedInteger(environment, "MYSTICPARADOX_SQLITE_QUEUE_TIMEOUT_MS", 60_000, 100, 600_000),
        backupIntervalMinutes: ReadBoundedInteger(environment, "MYSTICPARADOX_SQLITE_BACKUP_INTERVAL_MINUTES", 1_440, 0, 525_600),
        backupKeep: ReadBoundedInteger(environment, "MYSTICPARADOX_SQLITE_BACKUP_KEEP", 7, 1, 365)
    };
}
