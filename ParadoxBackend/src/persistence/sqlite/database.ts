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

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync, SQLInputValue } from "node:sqlite";
import { IN_MEMORY_DATABASE, SqliteRuntimeConfig } from "./config";
import { MapSqliteError } from "./errors";
import { ApplySchema, CURRENT_SQLITE_SCHEMA_VERSION, ReadSchemaVersion, TTL_DOC_TABLES, TTL_TABLES } from "./schema";

// The SQLite engine room: one write connection, one read connection, an in-process write queue and the transaction
// context. Node's `node:sqlite` is synchronous, so a repository operation is a plain function of a `Conn`; this class
// decides WHICH connection it runs on and WHEN.
//
// Rules (they reproduce what the repositories get from MongoDB):
//  * A unit of work (`transaction`) is one `BEGIN IMMEDIATE ... COMMIT` on the write connection. It holds the write
//    queue for its whole duration, so transactions never interleave and no other write can slip into it.
//  * A repository call made inside the unit of work joins it. It does so through the `session` argument the contracts
//    already pass AND through AsyncLocalStorage, because MongoDB lets a call that forgot its session run outside the
//    transaction, whereas here the same call would wait for the queue held by its own caller and deadlock.
//  * A write outside any unit of work takes the queue for one short `BEGIN IMMEDIATE ... COMMIT`, so multi-step
//    repository operations (read, decide, write) are atomic, also against another process using the same file.
//  * A read outside any unit of work uses the read connection (WAL snapshot): it sees committed data only, never a
//    transaction in flight, and never waits. Inside a unit of work reads use the write connection (read your writes).
//  * Inside a unit of work every repository call runs in a SAVEPOINT, so a failing multi-statement call (a duplicate
//    key halfway through an operation) leaves no partial effect behind even if the caller catches the error.

type Row = Record<string, unknown>;

/**
 * SQLite binds text up to its first NUL byte, so a parameter or key containing U+0000 would silently be cut short and
 * could address a different row (or two keys would collapse into one). Reject it loudly instead. Document text is
 * unaffected: JSON.stringify escapes NUL inside the document.
 */
function AssertNoNul(params: readonly unknown[]): void {
    for (const Param of params) {
        if (typeof Param === "string" && Param.includes("\u0000")) {
            throw new Error("SQLITE_NUL_IN_TEXT: a value containing a NUL character cannot be stored or looked up");
        }
    }
}

/** A compiled-statement cache around one `DatabaseSync` handle. Errors are mapped (unique violation -> E11000). */
export class Conn {
    private readonly Statements = new Map<string, StatementSync>();

    constructor(readonly handle: DatabaseSync) {}

    private prepare(sql: string): StatementSync {
        let Statement = this.Statements.get(sql);
        if (Statement === undefined) {
            // Dynamic IN lists make the key space unbounded; the cache is only a speed-up.
            if (this.Statements.size >= 400) this.Statements.clear();
            Statement = this.handle.prepare(sql);
            this.Statements.set(sql, Statement);
        }
        return Statement;
    }

    all(sql: string, ...params: SQLInputValue[]): Row[] {
        AssertNoNul(params);
        try { return this.prepare(sql).all(...params) as Row[]; } catch (error) { throw MapSqliteError(error); }
    }

    get(sql: string, ...params: SQLInputValue[]): Row | undefined {
        AssertNoNul(params);
        try { return this.prepare(sql).get(...params) as Row | undefined; } catch (error) { throw MapSqliteError(error); }
    }

    /** Runs a statement and returns the number of rows it changed. */
    run(sql: string, ...params: SQLInputValue[]): number {
        AssertNoNul(params);
        try { return Number(this.prepare(sql).run(...params).changes); } catch (error) { throw MapSqliteError(error); }
    }

    exec(sql: string): void {
        try { this.handle.exec(sql); } catch (error) { throw MapSqliteError(error); }
    }

    get inTransaction(): boolean {
        return this.handle.isTransaction;
    }

    close(): void {
        this.Statements.clear();
        this.handle.close();
    }
}

/**
 * The token a unit of work hands to its callback in place of MongoDB's ClientSession. The contracts type that
 * parameter as `ClientSession`; the provider casts. It only has to identify the transaction.
 */
export class SqliteSession {
    active = true;

    constructor(readonly owner: SqliteDatabase, readonly conn: Conn) {}

    inTransaction(): boolean {
        return this.active;
    }
}

export class SqliteDatabase {
    private readonly Transactions = new AsyncLocalStorage<SqliteSession>();
    private Tail: Promise<void> = Promise.resolve();
    private SavepointCounter = 0;
    private Closed = false;

    private constructor(
        readonly config: SqliteRuntimeConfig,
        private readonly writeConn: Conn,
        /** undefined for ":memory:" and when WAL is unavailable: reads then take the write queue. */
        private readonly readConn: Conn | undefined,
        readonly upgraded: boolean
    ) {}

    // ---------------------------------------------------------------------------------------------------------------
    // Opening
    // ---------------------------------------------------------------------------------------------------------------

    static open(config: SqliteRuntimeConfig): SqliteDatabase {
        const InMemory = config.path === IN_MEMORY_DATABASE;
        if (!InMemory) fs.mkdirSync(path.dirname(config.path), { recursive: true });

        const Write = new Conn(new DatabaseSync(config.path));
        let Read: Conn | undefined;
        try {
            Write.exec(`PRAGMA busy_timeout = ${Math.trunc(config.busyTimeoutMs)}`);
            let Wal = false;
            if (!InMemory) {
                // The mode is persistent in the file; a read-only connection can only follow WAL snapshots.
                Wal = String(Write.get("PRAGMA journal_mode = WAL")?.journal_mode).toLowerCase() === "wal";
            }
            Write.exec(`PRAGMA synchronous = ${config.synchronous}`);

            // A database that already holds data is backed up before this build changes its schema.
            const Version = ReadSchemaVersion(Write);
            if (Version > 0 && Version < CURRENT_SQLITE_SCHEMA_VERSION && !InMemory) {
                SqliteDatabase.backupBeforeUpgrade(Write, config.path, Version);
            }
            const Upgraded = ApplySchema(Write);

            if (Wal) {
                Read = new Conn(new DatabaseSync(config.path, { readOnly: true }));
                Read.exec(`PRAGMA busy_timeout = ${Math.trunc(config.busyTimeoutMs)}`);
            }
            return new SqliteDatabase(config, Write, Read, Upgraded);
        } catch (error) {
            try { Read?.close(); } catch { /* ignore */ }
            try { Write.close(); } catch { /* ignore */ }
            throw error;
        }
    }

    private static backupBeforeUpgrade(c: Conn, databasePath: string, fromVersion: number): void {
        const Folder = path.join(path.dirname(databasePath), "backups");
        fs.mkdirSync(Folder, { recursive: true });
        const Target = path.join(Folder, `${path.basename(databasePath, path.extname(databasePath))}-pre-upgrade-v${fromVersion}-${FileStamp()}.sqlite`);
        c.run("VACUUM INTO ?", Target);
    }

    get path(): string {
        return this.config.path;
    }

    get isOpen(): boolean {
        return !this.Closed;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The write queue
    // ---------------------------------------------------------------------------------------------------------------

    /**
     * Takes a place in the write queue. A queue that never advances (a unit of work whose callback never settles, or
     * code that lost its transaction context) must not hang the realm silently: after queueTimeoutMs the wait fails
     * with SQLITE_QUEUE_TIMEOUT, and the place is handed on as soon as it comes up so nobody behind is blocked.
     */
    private async acquire(): Promise<() => void> {
        let Release!: () => void;
        const Next = new Promise<void>((resolve) => { Release = resolve; });
        const Previous = this.Tail;
        this.Tail = Previous.then(() => Next);

        let Timer: NodeJS.Timeout | undefined;
        const TimedOut = new Promise<never>((_resolve, reject) => {
            Timer = setTimeout(() => reject(new Error(
                `SQLITE_QUEUE_TIMEOUT: waited ${this.config.queueTimeoutMs} ms for the database write queue; a unit of work is not finishing`
            )), this.config.queueTimeoutMs);
        });
        try {
            await Promise.race([Previous, TimedOut]);
        } catch (error) {
            void Previous.then(() => Release());
            throw error;
        } finally {
            clearTimeout(Timer);
        }
        return Release;
    }

    private async exclusive<T>(fn: () => T): Promise<T> {
        const Release = await this.acquire();
        try { return fn(); } finally { Release(); }
    }

    private resolveSession(session: unknown): SqliteSession | undefined {
        if (session instanceof SqliteSession) {
            if (session.owner !== this) throw new Error("SQLITE_SESSION_FOREIGN: the session belongs to another database");
            if (!session.active) {
                throw new Error("SQLITE_SESSION_ENDED: the transaction this session belongs to has already finished");
            }
            return session;
        }
        // A call that did not pass its session but runs inside the unit of work still joins it (see the header).
        const Ambient = this.Transactions.getStore();
        return Ambient !== undefined && Ambient.owner === this && Ambient.active ? Ambient : undefined;
    }

    private inSavepoint<T>(c: Conn, fn: () => T): T {
        const Name = `sp${++this.SavepointCounter}`;
        c.exec(`SAVEPOINT ${Name}`);
        try {
            const Result = fn();
            c.exec(`RELEASE ${Name}`);
            return Result;
        } catch (error) {
            try { c.exec(`ROLLBACK TO ${Name}`); c.exec(`RELEASE ${Name}`); } catch { /* the original error wins */ }
            throw error;
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Repository entry points
    // ---------------------------------------------------------------------------------------------------------------

    /** A read. `session` is the contract's optional session argument. */
    async read<T>(session: unknown, fn: (c: Conn) => T): Promise<T> {
        this.assertOpen();
        const Tx = this.resolveSession(session);
        if (Tx !== undefined) return fn(Tx.conn);
        if (this.readConn !== undefined) return fn(this.readConn);
        return this.exclusive(() => fn(this.writeConn));
    }

    /** A write: atomic as a whole (a savepoint inside a unit of work, its own transaction outside one). */
    async write<T>(session: unknown, fn: (c: Conn) => T): Promise<T> {
        this.assertOpen();
        const Tx = this.resolveSession(session);
        if (Tx !== undefined) return this.inSavepoint(Tx.conn, () => fn(Tx.conn));

        const Release = await this.acquire();
        try {
            this.assertOpen();
            this.writeConn.exec("BEGIN IMMEDIATE");
            try {
                const Result = fn(this.writeConn);
                this.writeConn.exec("COMMIT");
                return Result;
            } catch (error) {
                this.rollbackQuietly();
                throw error;
            }
        } finally {
            Release();
        }
    }

    /**
     * The unit of work. `fn` runs once (there is no transient-error retry: in-process transactions cannot conflict, and
     * a lock held by another process is waited for by busy_timeout and then reported). A nested call joins the outer
     * transaction through a savepoint instead of waiting for it.
     */
    async transaction<T>(fn: (session: SqliteSession) => Promise<T>): Promise<T> {
        this.assertOpen();
        const Outer = this.Transactions.getStore();
        if (Outer !== undefined && Outer.owner === this && Outer.active) {
            const Name = `sp${++this.SavepointCounter}`;
            Outer.conn.exec(`SAVEPOINT ${Name}`);
            try {
                const Result = await fn(Outer);
                Outer.conn.exec(`RELEASE ${Name}`);
                return Result;
            } catch (error) {
                try { Outer.conn.exec(`ROLLBACK TO ${Name}`); Outer.conn.exec(`RELEASE ${Name}`); } catch { /* ignore */ }
                throw error;
            }
        }

        const Release = await this.acquire();
        const Session = new SqliteSession(this, this.writeConn);
        try {
            this.assertOpen();
            this.writeConn.exec("BEGIN IMMEDIATE");
            try {
                const Result = await this.Transactions.run(Session, () => fn(Session));
                Session.active = false;
                this.writeConn.exec("COMMIT");
                return Result;
            } catch (error) {
                Session.active = false;
                this.rollbackQuietly();
                throw error;
            }
        } finally {
            Session.active = false;
            Release();
        }
    }

    private rollbackQuietly(): void {
        try {
            if (this.writeConn.inTransaction) this.writeConn.exec("ROLLBACK");
        } catch { /* the original error is the one worth reporting */ }
    }

    private assertOpen(): void {
        if (this.Closed) throw new Error("SQLITE_CLOSED: the database has been closed");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Maintenance
    // ---------------------------------------------------------------------------------------------------------------

    async isHealthy(): Promise<boolean> {
        try {
            if (this.Closed) return false;
            await this.read(undefined, (c) => c.get("SELECT 1 AS ok"));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * A consistent copy of the database with VACUUM INTO (it also compacts). It runs on the read connection, a WAL
     * snapshot, so writers are not blocked and an open unit of work is not part of the copy. Refuses to overwrite.
     */
    async backup(destination: string): Promise<void> {
        this.assertOpen();
        const Target = path.resolve(destination);
        if (fs.existsSync(Target)) throw new Error(`SQLITE_BACKUP_EXISTS: ${Target} already exists`);
        fs.mkdirSync(path.dirname(Target), { recursive: true });
        if (this.readConn !== undefined) {
            this.readConn.run("VACUUM INTO ?", Target);
        } else {
            await this.exclusive(() => this.writeConn.run("VACUUM INTO ?", Target));
        }
    }

    /**
     * Writes `<database folder>/backups/<name>-<stamp>.sqlite` when the newest backup is older than `intervalMinutes`
     * (0 = never) and removes the oldest beyond `keep`. Returns the new file, or undefined when none was due.
     */
    async backupIfDue(intervalMinutes: number, keep: number, nowMs: number = Date.now()): Promise<string | undefined> {
        if (intervalMinutes <= 0 || this.config.path === IN_MEMORY_DATABASE) return undefined;
        const Folder = path.join(path.dirname(this.config.path), "backups");
        const Base = path.basename(this.config.path, path.extname(this.config.path));
        const Mine = (name: string) => name.startsWith(`${Base}-`) && name.endsWith(".sqlite") && !name.includes("-pre-upgrade-");

        let Newest = 0;
        let Existing: string[] = [];
        if (fs.existsSync(Folder)) {
            Existing = fs.readdirSync(Folder).filter(Mine).sort();
            for (const Name of Existing) {
                Newest = Math.max(Newest, fs.statSync(path.join(Folder, Name)).mtimeMs);
            }
        }
        if (Newest > 0 && nowMs - Newest < intervalMinutes * 60_000) return undefined;

        const Target = path.join(Folder, `${Base}-${FileStamp(new Date(nowMs))}.sqlite`);
        await this.backup(Target);
        Existing.push(path.basename(Target));
        for (const Name of Existing.sort().slice(0, Math.max(0, Existing.length - keep))) {
            try { fs.rmSync(path.join(Folder, Name)); } catch { /* a locked old backup is not worth failing for */ }
        }
        return Target;
    }

    /** Deletes the rows whose storage-only `ttlAt` is past (MongoDB's TTL monitor). Returns how many per table. */
    async purgeExpired(nowIso: string = new Date().toISOString()): Promise<Record<string, number>> {
        return this.write(undefined, (c) => {
            const Removed: Record<string, number> = {};
            for (const Table of TTL_TABLES) {
                Removed[Table] = c.run(`DELETE FROM "${Table}" WHERE ttlAt < ?`, nowIso);
            }
            // [2026-10-14] Document-only ttlAt (no column): the same comparison on the stored JSON.
            for (const Table of TTL_DOC_TABLES) {
                Removed[Table] = c.run(`DELETE FROM "${Table}" WHERE json_extract(doc, '$.ttlAt') < ?`, nowIso);
            }
            return Removed;
        });
    }

    /**
     * Waits for the write queue, then closes both connections. If the queue never advances (a stuck unit of work) the
     * connections are closed anyway after queueTimeoutMs: this is shutdown, and SQLite rolls the open transaction back.
     */
    async close(): Promise<void> {
        if (this.Closed) return;
        let Release: (() => void) | undefined;
        try {
            Release = await this.acquire();
        } catch {
            // A unit of work is stuck: proceed with the shutdown regardless.
        }
        try {
            if (this.Closed) return;
            this.Closed = true;
            try { this.readConn?.close(); } catch { /* ignore */ }
            try { this.writeConn.close(); } catch { /* ignore */ }
        } finally {
            Release?.();
        }
    }
}

export function FileStamp(date: Date = new Date()): string {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
