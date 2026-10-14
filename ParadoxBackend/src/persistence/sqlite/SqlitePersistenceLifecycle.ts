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

import { PersistenceLifecycle } from "../contracts/UnitOfWork";
import { SqliteDatabase } from "./database";

const PURGE_EVERY_MS = 10 * 60_000;
const BACKUP_CHECK_EVERY_MS = 60 * 60_000;

/** Where the lifecycle gets the database: opened on demand, or only looked at (health checks never reopen a closed file). */
export interface SqliteDatabaseSource {
    open(): SqliteDatabase;
    peek(): SqliteDatabase | undefined;
    close(): Promise<void>;
}

// Lifecycle of the SQLite provider. The file is opened (schema applied, WAL on) when the database object is created,
// so start() has little left to do: remove rows whose TTL mirror is past (MongoDB's TTL monitor does that in the
// background there), take a backup if one is due, and arm the two housekeeping timers. Both timers are unref'd.
export class SqlitePersistenceLifecycle implements PersistenceLifecycle {
    private Timers: NodeJS.Timeout[] = [];

    constructor(
        private readonly source: SqliteDatabaseSource,
        private readonly warn: (message: string) => void = (message) => console.warn(message)
    ) {}

    async start(): Promise<void> {
        const Db = this.source.open();
        await Db.purgeExpired();
        await this.backupIfDue(Db);

        this.stopTimers();
        const Purge = setInterval(() => {
            Db.purgeExpired().catch((error) => this.warn(`[sqlite] purge of expired rows failed: ${String(error)}`));
        }, PURGE_EVERY_MS);
        const Backup = setInterval(() => { void this.backupIfDue(Db); }, BACKUP_CHECK_EVERY_MS);
        Purge.unref();
        Backup.unref();
        this.Timers = [Purge, Backup];
    }

    async isHealthy(): Promise<boolean> {
        try {
            return (await this.source.peek()?.isHealthy()) ?? false;
        } catch {
            return false;
        }
    }

    async stop(): Promise<void> {
        this.stopTimers();
        await this.source.close();
    }

    private async backupIfDue(Db: SqliteDatabase): Promise<void> {
        const { backupIntervalMinutes, backupKeep } = Db.config;
        try {
            await Db.backupIfDue(backupIntervalMinutes, backupKeep);
        } catch (error) {
            // A failed backup (disk full, locked folder) must not stop the realm from starting or running.
            this.warn(`[sqlite] backup failed: ${String(error)}`);
        }
    }

    private stopTimers(): void {
        for (const Timer of this.Timers) clearInterval(Timer);
        this.Timers = [];
    }
}
