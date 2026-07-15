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

import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { DiscordOAuthTransactionRepository, DiscordOAuthTransactionRecord } from "../../contracts/DiscordOAuthTransactionRepository";





const TTL_GRACE_MS = 60 * 60 * 1000;

function ToRecord(Doc: any): DiscordOAuthTransactionRecord {
    return {
        state: Doc.state,
        codeVerifier: Doc.codeVerifier,
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt,
        consumedAt: Doc.consumedAt ?? undefined,
        completionCodeHash: Doc.completionCodeHash ?? undefined,
        completionExpiresAt: Doc.completionExpiresAt ?? undefined,
        completionConsumedAt: Doc.completionConsumedAt ?? undefined,
        userId: Doc.userId ?? undefined
    };
}

export class MongoDiscordOAuthTransactionRepository implements DiscordOAuthTransactionRepository {
    async create(transaction: DiscordOAuthTransactionRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.DiscordOAuthTransactions).insertOne({
            ...transaction,
            _id: transaction.state as any,
            ttlAt: new Date(new Date(transaction.expiresAt).getTime() + TTL_GRACE_MS)
        });
    }

    async consumeByState(state: string): Promise<DiscordOAuthTransactionRecord | undefined> {
        const Db = await GetMongoDb();
        const Result = await Db.collection(Collections.DiscordOAuthTransactions).findOneAndUpdate(
            
            
            { _id: state as any, consumedAt: null, expiresAt: { $gt: new Date().toISOString() } },
            { $set: { consumedAt: new Date().toISOString() } },
            { returnDocument: "after" }
        );

        return Result == null ? undefined : ToRecord(Result);
    }

    async attachCompletionCode(state: string, completionCodeHash: string, completionExpiresAt: string, userId: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.DiscordOAuthTransactions).updateOne(
            { _id: state as any },
            {
                $set: {
                    completionCodeHash,
                    completionExpiresAt,
                    userId,
                    ttlAt: new Date(new Date(completionExpiresAt).getTime() + TTL_GRACE_MS)
                }
            }
        );
    }

    async consumeByCompletionCodeHash(completionCodeHash: string): Promise<DiscordOAuthTransactionRecord | undefined> {
        const Db = await GetMongoDb();
        const Result = await Db.collection(Collections.DiscordOAuthTransactions).findOneAndUpdate(
            {
                completionCodeHash,
                completionExpiresAt: { $gt: new Date().toISOString() },
                completionConsumedAt: null
            },
            { $set: { completionConsumedAt: new Date().toISOString() } },
            { returnDocument: "after" }
        );

        return Result == null ? undefined : ToRecord(Result);
    }
}
