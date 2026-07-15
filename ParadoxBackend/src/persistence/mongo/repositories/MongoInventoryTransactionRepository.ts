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




const DUPLICATE_KEY_ERROR_CODE = 11000;






function LedgerId(userId: string, characterId: string, transactionId: string): string {
    return crypto.createHash("sha256").update(JSON.stringify([userId, characterId, transactionId])).digest("hex");
}

export class MongoInventoryTransactionRepository implements InventoryTransactionRepository {
    async tryBegin(transactionId: string, userId: string, characterId: string, requestHash: string, session: ClientSession): Promise<InventoryTransactionRecord | undefined> {
        const Db = await GetMongoDb();
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
            
            return undefined;
        } catch (Err) {
            if (!(Err instanceof MongoServerError && Err.code === DUPLICATE_KEY_ERROR_CODE)) {
                throw Err;
            }

            
            
            
            
            
            
            
            
            
            
            
            
            const Existing = await Db.collection(Collections.InventoryTransactions).findOne(
                { _id: Id as any }
            );

            if (Existing == undefined) {
                
                
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

    async complete(transactionId: string, userId: string, characterId: string, result: unknown, session: ClientSession): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.InventoryTransactions).updateOne(
            { _id: LedgerId(userId, characterId, transactionId) as any },
            { $set: { status: "completed", result, completedAt: new Date().toISOString() } },
            { session }
        );
    }
}







export class InventoryTransactionAlreadyExistsError extends Error {
    constructor(public readonly existing: InventoryTransactionRecord) {
        super(`Inventory transaction ${existing.transactionId} already exists (status=${existing.status})`);
        this.name = "InventoryTransactionAlreadyExistsError";
    }
}
