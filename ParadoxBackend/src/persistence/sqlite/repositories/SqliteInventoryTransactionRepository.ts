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
import { ClientSession } from "mongodb";
import { InventoryTransactionRepository } from "../../contracts/InventoryTransactionRepository";
import { InventoryTransactionRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { IsDuplicateKeyError } from "../errors";
import { Tables } from "../tables";
// The same class the controllers test with `instanceof` (persistence/index.ts re-exports it).
import { InventoryTransactionAlreadyExistsError } from "../../mongo/repositories/MongoInventoryTransactionRepository";

// The ledger key is a hash of the full (userId, characterId, transactionId) tuple, exactly as in MongoDB (so a database
// imported from MongoDB keeps its keys): one user can never collide with, or read back, another user's transaction.
function LedgerId(userId: string, characterId: string, transactionId: string): string {
    return crypto.createHash("sha256").update(JSON.stringify([userId, characterId, transactionId])).digest("hex");
}

export class SqliteInventoryTransactionRepository implements InventoryTransactionRepository {
    constructor(private readonly db: SqliteDatabase) {}

    /**
     * Claims the tuple with a "pending" row. A repeat throws InventoryTransactionAlreadyExistsError carrying the
     * stored row (with its requestHash), so the caller can tell a replay from a reused id; the caller must unwind out
     * of the unit of work, which rolls back the pending state of the failed attempt.
     */
    async tryBegin(transactionId: string, userId: string, characterId: string, requestHash: string, session: ClientSession): Promise<InventoryTransactionRecord | undefined> {
        return this.db.write(session, (c) => {
            const Id = LedgerId(userId, characterId, transactionId);
            try {
                Tables.inventoryTransactions.insert(c, Id, {
                    transactionId,
                    userId,
                    characterId,
                    requestHash,
                    status: "pending",
                    createdAt: new Date().toISOString()
                });
                return undefined;
            } catch (Err) {
                if (!IsDuplicateKeyError(Err)) throw Err;
                const Existing = Tables.inventoryTransactions.get(c, Id);
                if (Existing === undefined) throw Err;
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
        });
    }

    async complete(transactionId: string, userId: string, characterId: string, result: unknown, session: ClientSession,
        extraFields?: Record<string, unknown>): Promise<void> {
        await this.db.write(session, (c) => {
            const Row = Tables.inventoryTransactions.row(c, LedgerId(userId, characterId, transactionId));
            if (Row === undefined) return;
            Tables.inventoryTransactions.patch(c, Row, {
                ...(extraFields ?? {}),
                status: "completed",
                result,
                completedAt: new Date().toISOString()
            });
        });
    }
    // [2026-10-15] A plain read of one ledger row (the contract's findRecord).
    async findRecord(userId: string, characterId: string, transactionId: string): Promise<InventoryTransactionRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.inventoryTransactions.get(c, LedgerId(userId, characterId, transactionId));
            if (Doc === undefined) return undefined;
            return {
                transactionId: Doc.transactionId,
                userId: Doc.userId,
                characterId: Doc.characterId,
                requestHash: Doc.requestHash,
                status: Doc.status,
                result: Doc.result,
                createdAt: Doc.createdAt,
                completedAt: Doc.completedAt
            };
        });
    }
    // [2026-10-14] The admin player timeline: the newest rows of one account, without the stored results.
    async listRecentForUser(userId: string, limit: number): Promise<Record<string, any>[]> {
        return this.db.read(undefined, (c) => Tables.inventoryTransactions.find(c, "userId = ?", [userId],
            { orderBy: "json_extract(doc, '$.createdAt') DESC", limit }).map((Doc) => ({
            transactionId: Doc.transactionId, characterId: Doc.characterId, status: Doc.status, createdAt: Doc.createdAt,
            completedAt: Doc.completedAt, economySource: Doc.economySource, economySessionId: Doc.economySessionId
        })));
    }

}
