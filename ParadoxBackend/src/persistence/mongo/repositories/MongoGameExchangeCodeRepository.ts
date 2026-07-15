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
import { GameExchangeCodeRepository, GameExchangeCodeRecord } from "../../contracts/GameExchangeCodeRepository";

function ToRecord(Doc: any): GameExchangeCodeRecord {
    return {
        codeHash: Doc.codeHash,
        userId: Doc.userId,
        launcherSessionId: Doc.launcherSessionId,
        buildChangelist: Doc.buildChangelist,
        executableSha256: Doc.executableSha256,
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt,
        consumedAt: Doc.consumedAt ?? undefined
    };
}

export class MongoGameExchangeCodeRepository implements GameExchangeCodeRepository {
    async create(code: GameExchangeCodeRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.GameExchangeCodes).insertOne({
            ...code,
            _id: code.codeHash as any,
            
            ttlAt: new Date(code.expiresAt)
        });
    }

    async consumeByCodeHash(codeHash: string): Promise<GameExchangeCodeRecord | undefined> {
        const Db = await GetMongoDb();
        const Result = await Db.collection(Collections.GameExchangeCodes).findOneAndUpdate(
            
            
            
            { _id: codeHash as any, consumedAt: null, expiresAt: { $gt: new Date().toISOString() } },
            { $set: { consumedAt: new Date().toISOString() } },
            { returnDocument: "after" }
        );

        return Result == null ? undefined : ToRecord(Result);
    }

    async revokeUnusedForUser(userId: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.GameExchangeCodes).updateMany(
            { userId, consumedAt: null },
            { $set: { consumedAt: new Date().toISOString(), revoked: true } }
        );
    }
}
