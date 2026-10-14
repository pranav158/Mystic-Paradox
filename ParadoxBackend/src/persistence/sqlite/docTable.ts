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

import { SQLInputValue } from "node:sqlite";
import type { Conn } from "./database";

export type Doc = Record<string, any>;

/**
 * What the MongoDB driver would have stored: `undefined` becomes null (ignoreUndefined is off), Dates become ISO text
 * (this provider keeps every timestamp as an ISO string, `ttlAt` included). Applying it on the way in keeps the
 * repositories' `x ?? undefined` read mappings behaving exactly as they do against MongoDB, and makes the value a
 * write returns equal to what a later read returns.
 */
export function Stored<T>(value: T): T {
    return Normalize(value) as T;
}

function Normalize(value: unknown): unknown {
    if (value === undefined) return null;
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(Normalize);
    const Out: Record<string, unknown> = {};
    for (const [Key, Entry] of Object.entries(value)) Out[Key] = Normalize(Entry);
    return Out;
}

/** A row read for a read-modify-write: the stored text is kept so the following UPDATE can fence on it. */
export interface StoredRow {
    id: string;
    text: string;
    /** The document with `_id` attached first, like a MongoDB document. */
    doc: Doc;
}

function ToRow(row: Record<string, unknown>): StoredRow {
    const Text = String(row.doc);
    const Id = String(row._id);
    return { id: Id, text: Text, doc: { _id: Id, ...JSON.parse(Text) } };
}

function Serialize(doc: Doc): string {
    const { _id: _ignored, ...Rest } = doc;
    return JSON.stringify(Stored(Rest));
}

/** The shape a write returns: the document as a later read would give it (JSON round trip, `_id` attached). */
export function RoundTrip(id: string, doc: Doc): Doc {
    return { _id: id, ...JSON.parse(Serialize(doc)) };
}

/** `?, ?, ?` for an IN list. */
export function Placeholders(count: number): string {
    return Array.from({ length: count }, () => "?").join(", ");
}

/** A LIMIT/OFFSET operand: inlined (JS numbers bind as REAL, which LIMIT may reject) after validation. */
export function SqlInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
    return value;
}

export interface FindOptions {
    /** SQL ORDER BY expression list, trusted (never user input). */
    orderBy?: string;
    limit?: number;
    offset?: number;
}

/** CRUD over one `_id` + JSON `doc` table. All methods are synchronous and take the connection to run on. */
export class DocTable {
    readonly quoted: string;

    constructor(readonly name: string) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe table name ${JSON.stringify(name)}`);
        this.quoted = `"${name}"`;
    }

    // ---- reads ----

    row(c: Conn, id: string): StoredRow | undefined {
        const Row = c.get(`SELECT _id, doc FROM ${this.quoted} WHERE _id = ?`, id);
        return Row === undefined ? undefined : ToRow(Row);
    }

    get(c: Conn, id: string): Doc | undefined {
        return this.row(c, id)?.doc;
    }

    rows(c: Conn, where: string, params: SQLInputValue[] = [], options: FindOptions = {}): StoredRow[] {
        let Sql = `SELECT _id, doc FROM ${this.quoted}${where ? ` WHERE ${where}` : ""}`;
        // rowid order = insertion order, MongoDB's natural order.
        Sql += ` ORDER BY ${options.orderBy ?? "rowid"}`;
        if (options.limit !== undefined) Sql += ` LIMIT ${SqlInteger(options.limit, "limit")}`;
        if (options.offset !== undefined) {
            if (options.limit === undefined) Sql += " LIMIT -1";
            Sql += ` OFFSET ${SqlInteger(options.offset, "offset")}`;
        }
        return c.all(Sql, ...params).map(ToRow);
    }

    find(c: Conn, where: string, params: SQLInputValue[] = [], options: FindOptions = {}): Doc[] {
        return this.rows(c, where, params, options).map((Row) => Row.doc);
    }

    findOneRow(c: Conn, where: string, params: SQLInputValue[] = [], orderBy?: string): StoredRow | undefined {
        return this.rows(c, where, params, { orderBy, limit: 1 })[0];
    }

    findOne(c: Conn, where: string, params: SQLInputValue[] = [], orderBy?: string): Doc | undefined {
        return this.findOneRow(c, where, params, orderBy)?.doc;
    }

    count(c: Conn, where = "", params: SQLInputValue[] = []): number {
        return Number(c.get(`SELECT COUNT(*) AS n FROM ${this.quoted}${where ? ` WHERE ${where}` : ""}`, ...params)?.n ?? 0);
    }

    // ---- writes ----

    /** Plain insert; a duplicate `_id` or UNIQUE index violation throws the E11000 equivalent. */
    insert(c: Conn, id: string, doc: Doc): void {
        c.run(`INSERT INTO ${this.quoted} (_id, doc) VALUES (?, ?)`, id, Serialize(doc));
    }

    /** Inserts unless a row with that `_id` exists. Returns whether it inserted. */
    insertIfAbsent(c: Conn, id: string, doc: Doc): boolean {
        return c.run(`INSERT OR IGNORE INTO ${this.quoted} (_id, doc) VALUES (?, ?)`, id, Serialize(doc)) === 1;
    }

    /**
     * Replaces the document of a row that was read as `previous`, only if it is still byte-for-byte what was read.
     * This is the compare-and-set fence behind every read-modify-write: under BEGIN IMMEDIATE it cannot fail, and if a
     * caller ever runs outside it, a concurrent change makes this return false instead of overwriting it.
     */
    replaceFrom(c: Conn, previous: StoredRow, doc: Doc): boolean {
        return c.run(`UPDATE ${this.quoted} SET doc = ? WHERE _id = ? AND doc = ?`, Serialize(doc), previous.id, previous.text) === 1;
    }

    /** Merges `set` into the row's document and removes the `unset` fields. Returns the new document. */
    patch(c: Conn, previous: StoredRow, set: Doc, unset: string[] = []): Doc {
        const Next: Doc = { ...previous.doc, ...Stored(set) };
        for (const Field of unset) delete Next[Field];
        if (!this.replaceFrom(c, previous, Next)) {
            throw new Error(`SQLITE_CONCURRENT_MODIFICATION: ${this.name}/${previous.id} changed during a read-modify-write`);
        }
        return RoundTrip(previous.id, Next);
    }

    deleteById(c: Conn, id: string): number {
        return c.run(`DELETE FROM ${this.quoted} WHERE _id = ?`, id);
    }

    delete(c: Conn, where: string, params: SQLInputValue[] = []): number {
        return c.run(`DELETE FROM ${this.quoted}${where ? ` WHERE ${where}` : ""}`, ...params);
    }
}
