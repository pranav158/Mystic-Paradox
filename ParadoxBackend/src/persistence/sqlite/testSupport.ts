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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ClientSession } from "mongodb";
import { RepositoryProvider } from "../contracts/UnitOfWork";
import { BACKEND_ROOT, ReadSqliteRuntimeConfig, SqliteRuntimeConfig } from "./config";
import { SqliteDatabase } from "./database";
import { CreateSqliteRepositoryProvider } from "./index";
import { SqliteUnitOfWork } from "./SqliteUnitOfWork";

// Helpers for the SQLite provider's tests. The databases live under ParadoxBackend/.test-sqlite (binaries in this
// repository run at Low integrity and cannot write %TEMP%); every test file removes its own folder when it is done.

export const TEST_ROOT = path.join(BACKEND_ROOT, ".test-sqlite");

export interface TestRealm {
    dir: string;
    databasePath: string;
    db: SqliteDatabase;
    repos: RepositoryProvider;
    uow: SqliteUnitOfWork;
    /** Closes the database and deletes the folder (and `.test-sqlite` itself when it is then empty). */
    cleanup(): Promise<void>;
}

export function NewTestDirectory(label: string): string {
    const Dir = path.join(TEST_ROOT, `${label}-${crypto.randomBytes(5).toString("hex")}`);
    fs.mkdirSync(Dir, { recursive: true });
    return Dir;
}

export function RemoveTestDirectory(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
        if (fs.existsSync(TEST_ROOT) && fs.readdirSync(TEST_ROOT).length === 0) fs.rmdirSync(TEST_ROOT);
    } catch { /* another test file may be using the folder right now */ }
}

export function TestConfig(databasePath: string, overrides: Partial<SqliteRuntimeConfig> = {}): SqliteRuntimeConfig {
    return { ...ReadSqliteRuntimeConfig({ MYSTICPARADOX_SQLITE_PATH: databasePath }), ...overrides };
}

export function OpenTestRealm(label: string, overrides: Partial<SqliteRuntimeConfig> = {}): TestRealm {
    const Dir = NewTestDirectory(label);
    const DatabasePath = path.join(Dir, "realm.sqlite");
    const Db = SqliteDatabase.open(TestConfig(DatabasePath, overrides));
    const Repos = CreateSqliteRepositoryProvider(Db);
    return {
        dir: Dir,
        databasePath: DatabasePath,
        db: Db,
        repos: Repos,
        uow: new SqliteUnitOfWork(Db, Repos),
        cleanup: async () => {
            await Db.close();
            RemoveTestDirectory(Dir);
        }
    };
}

/** What a unit of work hands its callback; repositories only pass it back. */
export type Session = ClientSession;

export const NOW = "2026-10-13T12:00:00.000Z";
export const PAST = "2026-10-13T10:00:00.000Z";
export const FUTURE = "2099-01-01T00:00:00.000Z";

export function IsoIn(ms: number): string {
    return new Date(Date.now() + ms).toISOString();
}

/** Resolves on a later macrotask: lets every already-runnable continuation run first. */
export function Tick(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function Gate(): { wait: Promise<void>; open: () => void } {
    let Open!: () => void;
    const Wait = new Promise<void>((resolve) => { Open = resolve; });
    return { wait: Wait, open: Open };
}
