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

import type { ClientSession } from "mongodb";
import { SqliteDatabase } from "./database";
import { Doc } from "./docTable";
import { Tables } from "./tables";

// Three places in core code read MongoDB collections directly instead of through a repository contract:
//   services/operationsPolicy.ts   the `operationsPolicy` singleton (read, and a version-guarded update)
//   controllers/store.ts           FindClaimInInventoryLedger, the daily-claim lookup in the idempotency ledger
//   controllers/adminOperations.ts the latest launcher Guard sessions for the operations overview
// These are the SQLite equivalents, exactly mirroring what each of those call sites asks MongoDB. They are NOT wired in
// yet (those files are outside the SQLite provider): a realm needs the three call sites to dispatch here, or to move
// behind repository contracts, before the policy, the fountain claim and the overview work on SQLite.

/** The raw policy document (with `_id`), or null when missing; `session` is the unit-of-work token, if any. */
export async function SqliteReadOperationsPolicyRecord(db: SqliteDatabase, session?: ClientSession): Promise<Doc | null> {
    return db.read(session, (c) => Tables.operationsPolicy.get(c, "global") ?? null);
}

/**
 * The write of SetOperationsPolicy: applies only when the stored `version` equals `expectedVersion`, sets `fields`,
 * removes `unset` and adds 1 to `version`. Returns whether it applied.
 */
export async function SqliteUpdateOperationsPolicy(
    db: SqliteDatabase,
    expectedVersion: number,
    fields: Record<string, unknown>,
    unset: string[] = [],
    session?: ClientSession
): Promise<boolean> {
    return db.write(session, (c) => {
        const Row = Tables.operationsPolicy.row(c, "global");
        if (Row === undefined || Row.doc.version !== expectedVersion) return false;
        Tables.operationsPolicy.patch(c, Row, { ...fields, version: expectedVersion + 1 }, unset);
        return true;
    });
}

/** The daily-claim ledger lookup: the claiming character of the account's row with that transactionId, if any. */
export async function SqliteFindInventoryLedgerClaim(
    db: SqliteDatabase,
    userId: string,
    transactionId: string
): Promise<{ _id: string; characterId?: unknown } | undefined> {
    return db.read(undefined, (c) => {
        const Doc = Tables.inventoryTransactions.findOne(c, "userId = ? AND transactionId = ?", [userId, transactionId]);
        return Doc === undefined ? undefined : { _id: Doc._id, characterId: Doc.characterId };
    });
}

/** The newest launcher Guard sessions (default 100) with the fields the operations overview shows. */
export async function SqliteListLauncherGuardSessions(db: SqliteDatabase, limit = 100): Promise<Doc[]> {
    return db.read(undefined, (c) => Tables.launcherGuardSessions
        .find(c, "", [], { orderBy: "createdAt DESC, rowid DESC", limit })
        .map((Doc) => {
            const { _id, accountId, launcherVersion, manifestSequence, status, riskScore, lastHeartbeatAt, expiresAt, lastSignals } = Doc;
            return { _id, accountId, launcherVersion, manifestSequence, status, riskScore, lastHeartbeatAt, expiresAt, lastSignals };
        }));
}
