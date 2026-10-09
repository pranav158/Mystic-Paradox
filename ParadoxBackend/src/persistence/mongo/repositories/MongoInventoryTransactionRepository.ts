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

import { ClientSession, MongoServerError } from "mongodb";
import crypto from "node:crypto";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { InventoryTransactionRepository } from "../../contracts/InventoryTransactionRepository";
import { InventoryTransactionRecord } from "../../mapping/domainTypes";

// Mongo's `_id` field has an automatic unique index on every collection — using transactionId AS
// `_id` means a duplicate insert is rejected by the database itself (E11000 duplicate key), which
// is exactly the idempotency guarantee this ledger needs, with no separate index to create/manage.
const DUPLICATE_KEY_ERROR_CODE = 11000;

// [hardening] The ledger `_id` is a hash of the FULL (userId, characterId, transactionId) tuple,
// not the client-supplied transactionId alone. This binds idempotency to the acting user AND
// character: two different users (or a client replaying someone else's transactionId) produce
// different keys, so they can never collide on the unique `_id` or read back each other's stored
// result. JSON.stringify of an array gives an unambiguous, delimiter-injection-proof encoding.
function LedgerId(userId: string, characterId: string, transactionId: string): string {
    return crypto.createHash("sha256").update(JSON.stringify([userId, characterId, transactionId])).digest("hex");
}

export class MongoInventoryTransactionRepository implements InventoryTransactionRepository {
    constructor(private readonly getDb: typeof GetMongoDb = GetMongoDb) {}

    async tryBegin(transactionId: string, userId: string, characterId: string, requestHash: string, session: ClientSession): Promise<InventoryTransactionRecord | undefined> {
        const Db = await this.getDb();
        const Now = new Date().toISOString();
        const Id = LedgerId(userId, characterId, transactionId);

        try {
            await Db.collection(Collections.InventoryTransactions).insertOne(
                {
                    _id: Id as any,
                    transactionId,
                    userId,
                    characterId,
                    requestHash,
                    status: "pending",
                    createdAt: Now
                },
                { session }
            );
            // Insert succeeded — this (user, character, transaction) tuple is genuinely new.
            return undefined;
        } catch (Err) {
            if (!(Err instanceof MongoServerError && Err.code === DUPLICATE_KEY_ERROR_CODE)) {
                throw Err;
            }

            // [hardening] A failed write inside a Mongo transaction ABORTS the transaction
            // server-side — the `session` this insertOne used is now dead. The caller
            // (controllers/inventory.ts RunInventoryTransaction) MUST NOT keep issuing operations
            // against this session, and MUST NOT let `session.withTransaction()` attempt to
            // commit — both would hang or fail on a transaction that no longer exists.
            //
            // The re-fetch below deliberately runs WITHOUT `session` — a fresh, non-transactional
            // read, safe here because we are only reading an already-durably-committed ledger row
            // (either "completed" from an earlier successful run, or "pending" from a still
            // in-flight concurrent duplicate). Signaling this back as a thrown error (rather than
            // a normal return value) forces the caller to unwind out of withTransaction entirely,
            // instead of trying to keep using the now-dead session.
            const Existing = await Db.collection(Collections.InventoryTransactions).findOne(
                { _id: Id as any }
            );

            if (Existing == undefined) {
                // Shouldn't happen (we just got a duplicate-key error on this exact _id), but
                // don't fabricate a record if it genuinely isn't there.
                throw Err;
            }

            throw new InventoryTransactionAlreadyExistsError({
                transactionId: Existing.transactionId,
                userId: Existing.userId,
                characterId: Existing.characterId,
                requestHash: Existing.requestHash,
                status: Existing.status,
                result: Existing.result,
                createdAt: Existing.createdAt,
                completedAt: Existing.completedAt
            });
        }
    }

    async complete(transactionId: string, userId: string, characterId: string, result: unknown, session: ClientSession,
        extraFields?: Record<string, unknown>): Promise<void> {
        const Db = await this.getDb();
        await Db.collection(Collections.InventoryTransactions).updateOne(
            { _id: LedgerId(userId, characterId, transactionId) as any },
            { $set: { ...(extraFields ?? {}), status: "completed", result, completedAt: new Date().toISOString() } },
            { session }
        );
    }
}

// [hardening] Thrown by tryBegin instead of returning a value, specifically so the caller is
// forced to unwind out of `session.withTransaction()` (whose transaction is already dead after
// the duplicate-key write above) rather than attempt any further operation on that session or
// let withTransaction try to commit a transaction that no longer exists. Carries the existing
// ledger record so the caller can decide what to do (replay a completed result, or report a
// conflict for a still-pending one) AFTER it has left the transaction.
export class InventoryTransactionAlreadyExistsError extends Error {
    constructor(public readonly existing: InventoryTransactionRecord) {
        super(`Inventory transaction ${existing.transactionId} already exists (status=${existing.status})`);
        this.name = "InventoryTransactionAlreadyExistsError";
    }
}
