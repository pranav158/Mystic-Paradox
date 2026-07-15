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
import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { WalletRepository, IsValidBalanceCatalogId } from "../../contracts/WalletRepository";
import { WalletRecord } from "../../mapping/domainTypes";




export class MongoWalletRepository implements WalletRepository {
    async findByUserId(userId: string, session?: ClientSession): Promise<WalletRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Wallets).findOne({ _id: userId as any }, { session });

        if (Doc == undefined) {
            return undefined;
        }

        return { userId: Doc.userId, balances: (Doc.balances as Record<string, number>) ?? {}, bootstrapVersion: Doc.bootstrapVersion };
    }

    async create(wallet: WalletRecord, session?: ClientSession): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Wallets).insertOne(
            {
                _id: wallet.userId as any,
                userId: wallet.userId,
                balances: wallet.balances,
                bootstrapVersion: wallet.bootstrapVersion
            },
            { session }
        );
    }

    async createIfMissing(wallet: WalletRecord, session?: ClientSession): Promise<WalletRecord> {
        
        
        for (const CatalogId of Object.keys(wallet.balances ?? {})) {
            if (!IsValidBalanceCatalogId(CatalogId)) {
                throw new Error(`Refusing wallet create: unsafe balance field path ${JSON.stringify(CatalogId)}`);
            }
        }
        const Db = await GetMongoDb();
        
        
        
        
        
        const Update: Record<string, any> = {
            $setOnInsert: {
                _id: wallet.userId as any,
                userId: wallet.userId,
                balances: wallet.balances,
            }
        };
        if (wallet.bootstrapVersion !== undefined) {
            Update.$set = { bootstrapVersion: wallet.bootstrapVersion };
        }

        const Result = await Db.collection(Collections.Wallets).findOneAndUpdate(
            { _id: wallet.userId as any },
            Update,
            { upsert: true, returnDocument: "after", session }
        );

        
        
        
        if (Result == undefined) {
            throw new Error(`Unable to create or read wallet for ${wallet.userId}`);
        }

        return {
            userId: (Result as any).userId,
            balances: ((Result as any).balances as Record<string, number>) ?? {},
            bootstrapVersion: (Result as any).bootstrapVersion,
        };
    }

    async incrementBalance(userId: string, catalogId: string, delta: number, session?: ClientSession): Promise<WalletRecord | undefined> {
        
        
        
        
        if (!IsValidBalanceCatalogId(catalogId)) {
            throw new Error(`Refusing wallet increment: unsafe balance field path ${JSON.stringify(catalogId)}`);
        }
        const Db = await GetMongoDb();
        const BalanceField = `balances.${catalogId}`;

        
        
        
        
        const Filter: Record<string, any> = { _id: userId as any };
        if (delta < 0) {
            Filter[BalanceField] = { $gte: -delta };
        }

        const Result = await Db.collection(Collections.Wallets).findOneAndUpdate(
            Filter,
            { $inc: { [BalanceField]: delta } },
            { returnDocument: "after", session }
        );

        if (Result == undefined) {
            return undefined;
        }

        return { userId: (Result as any).userId, balances: ((Result as any).balances as Record<string, number>) ?? {} };
    }

    async migrateLegacyStringBalances(userId: string): Promise<void> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Wallets).findOne({ _id: userId as any });

        if (Doc == undefined || typeof Doc.balances !== "string") {
            return;
        }

        let Parsed: Record<string, number> = {};
        try {
            const Raw = JSON.parse(Doc.balances);
            if (Raw && typeof Raw === "object") Parsed = Raw;
        } catch {
            
            
            Parsed = {};
        }

        await Db.collection(Collections.Wallets).updateOne(
            { _id: userId as any },
            { $set: { balances: Parsed } }
        );
    }
}
