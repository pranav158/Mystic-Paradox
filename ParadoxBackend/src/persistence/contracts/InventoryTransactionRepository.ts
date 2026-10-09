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

import { ClientSession } from "mongodb";
import { InventoryTransactionRecord } from "../mapping/domainTypes";

// Repository contract for the `inventoryTransactions` idempotency ledger.
//
// [hardening] POST /inventory's transactionId used to be logged only, never checked — repeating
// the same request re-applied the same currency/item grant every time. This repository makes the
// (userId, characterId, transactionId) tuple a real idempotency key: `_id` is a hash of that
// whole tuple, so a duplicate insert fails with a unique-key violation instead of silently
// succeeding twice, and one user's transactionId can never collide with another user's.
export interface InventoryTransactionRepository {
    /**
     * Attempts to claim `(userId, characterId, transactionId)` as a NEW transaction by inserting
     * a "pending" ledger row keyed by that full tuple (NOT the transactionId alone). Returns
     * `undefined` if this is genuinely new (caller should proceed with the mutation).
     *
     * [hardening] The idempotency key is bound to userId AND characterId, not just the client-
     * supplied transactionId, so one user replaying (or a malicious client reusing) another
     * user's transactionId can never collide with or read back that other user's stored result.
     *
     * If this exact tuple was already seen, throws `InventoryTransactionAlreadyExistsError` (see
     * the Mongo implementation) carrying the existing record — INCLUDING its stored requestHash,
     * so the caller can distinguish a legitimate replay (same requestHash) from a transactionId
     * reused with a different body (different requestHash, which must be rejected without
     * mutating). It does NOT return a value in that case, because the duplicate-key write that
     * detected this already aborted the Mongo transaction `session` belongs to. The caller MUST
     * let that error propagate out of `session.withTransaction(...)` entirely and handle the
     * replay/mismatch/conflict decision after unwinding.
     */
    tryBegin(transactionId: string, userId: string, characterId: string, requestHash: string, session: ClientSession): Promise<InventoryTransactionRecord | undefined>;

    /** Marks a pending transaction (identified by the same userId+characterId+transactionId tuple
     *  as tryBegin) completed and stores the result to serve on any future replay. xtraFields (from
     *  an onGrant annotator) are stored on the same row; they never replace the core ledger fields. */
    complete(transactionId: string, userId: string, characterId: string, result: unknown, session: ClientSession,
        extraFields?: Record<string, unknown>): Promise<void>;
}
