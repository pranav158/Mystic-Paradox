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

import { MongoServerError } from "mongodb";

// A unique-index violation must look like MongoDB's E11000 to the callers: launcherAuth.ts tests
// `error instanceof MongoServerError && error.code === 11000`, other controllers only `error.code === 11000`.
// The driver's error class is constructible without a connection, so one error satisfies both checks.
export const DUPLICATE_KEY_CODE = 11000;

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export function IsSqliteUniqueViolation(error: unknown): boolean {
    const Code = (error as { errcode?: unknown } | null)?.errcode;
    return Code === SQLITE_CONSTRAINT_PRIMARYKEY || Code === SQLITE_CONSTRAINT_UNIQUE;
}

export function MakeDuplicateKeyError(collection: string, keyPattern: Record<string, 1>, cause?: unknown): MongoServerError {
    const Keys = Object.keys(keyPattern).join(", ");
    const Error_ = new MongoServerError({
        message: `E11000 duplicate key error collection: ${collection} index: ${Keys}`,
        code: DUPLICATE_KEY_CODE,
        keyPattern
    });
    if (cause !== undefined) (Error_ as { cause?: unknown }).cause = cause;
    return Error_;
}

/** Turns a SQLite unique/primary-key violation into the E11000 equivalent; any other error is returned unchanged. */
export function MapSqliteError(error: unknown): unknown {
    if (!IsSqliteUniqueViolation(error)) return error;
    // "UNIQUE constraint failed: accounts.email" / "...: authIdentities.provider, authIdentities.providerSubject"
    const Message = String((error as { message?: unknown }).message ?? "");
    const Failed = /UNIQUE constraint failed: (.+)$/.exec(Message)?.[1] ?? "";
    const Columns = Failed.split(",").map((Part) => Part.trim()).filter(Boolean);
    const Collection = Columns[0]?.split(".")[0]?.replace(/^index '?|'$/g, "") ?? "unknown";
    const KeyPattern: Record<string, 1> = {};
    for (const Column of Columns) KeyPattern[Column.split(".").slice(1).join(".") || Column] = 1;
    return MakeDuplicateKeyError(Collection, KeyPattern, error);
}

export function IsDuplicateKeyError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY_CODE;
}
