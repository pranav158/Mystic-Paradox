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
import { IsValidBalanceCatalogId, WalletRepository } from "../../contracts/WalletRepository";
import { WalletRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { Tables } from "../tables";

// _id = userId, `balances` a {catalogId: quantity} object. incrementBalance is the atomic path: the balance check and
// the write happen in one BEGIN IMMEDIATE transaction (or inside the caller's unit of work), never as a read in one
// request and a write in another, so two concurrent AddCurrency calls both land and a debit can never go negative.
export class SqliteWalletRepository implements WalletRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByUserId(userId: string, session?: ClientSession): Promise<WalletRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.wallets.get(c, userId);
            return Doc === undefined
                ? undefined
                : { userId: Doc.userId, balances: (Doc.balances as Record<string, number>) ?? {}, bootstrapVersion: Doc.bootstrapVersion };
        });
    }

    async create(wallet: WalletRecord, session?: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            Tables.wallets.insert(c, wallet.userId, {
                userId: wallet.userId,
                balances: wallet.balances,
                bootstrapVersion: wallet.bootstrapVersion
            });
        });
    }

    /** Creates the wallet only when missing; an existing wallet keeps its balances (only an explicit tag is applied). */
    async createIfMissing(wallet: WalletRecord, session?: ClientSession): Promise<WalletRecord> {
        for (const CatalogId of Object.keys(wallet.balances ?? {})) {
            if (!IsValidBalanceCatalogId(CatalogId)) {
                throw new Error(`Refusing wallet create: unsafe balance field path ${JSON.stringify(CatalogId)}`);
            }
        }
        return this.db.write(session, (c) => {
            const Row = Tables.wallets.row(c, wallet.userId);
            let Doc;
            if (Row === undefined) {
                Doc = {
                    userId: wallet.userId,
                    balances: wallet.balances,
                    ...(wallet.bootstrapVersion !== undefined ? { bootstrapVersion: wallet.bootstrapVersion } : {})
                };
                Tables.wallets.insert(c, wallet.userId, Doc);
            } else if (wallet.bootstrapVersion !== undefined) {
                Doc = Tables.wallets.patch(c, Row, { bootstrapVersion: wallet.bootstrapVersion });
            } else {
                Doc = Row.doc;
            }
            return {
                userId: Doc.userId,
                balances: (Doc.balances as Record<string, number>) ?? {},
                bootstrapVersion: Doc.bootstrapVersion
            };
        });
    }

    /**
     * Applies `delta` to balances[catalogId]. A debit applies only when the current balance covers it (a missing balance
     * or wallet never does), so nothing is ever clamped; returns undefined when it did not apply.
     */
    async incrementBalance(userId: string, catalogId: string, delta: number, session?: ClientSession): Promise<WalletRecord | undefined> {
        if (!IsValidBalanceCatalogId(catalogId)) {
            throw new Error(`Refusing wallet increment: unsafe balance field path ${JSON.stringify(catalogId)}`);
        }
        return this.db.write(session, (c) => {
            const Row = Tables.wallets.row(c, userId);
            if (Row === undefined) return undefined;
            const Balances: Record<string, number> = { ...((Row.doc.balances as Record<string, number> | null) ?? {}) };
            const Current = Balances[catalogId];
            if (delta < 0 && !(typeof Current === "number" && Current >= -delta)) return undefined;
            Balances[catalogId] = (typeof Current === "number" ? Current : 0) + delta;
            const Next = Tables.wallets.patch(c, Row, { balances: Balances });
            return { userId: Next.userId, balances: (Next.balances as Record<string, number>) ?? {} };
        });
    }

    /** Legacy rows stored `balances` as a JSON string; rewrites them as an object. No-op for current rows. */
    async migrateLegacyStringBalances(userId: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.wallets.row(c, userId);
            if (Row === undefined || typeof Row.doc.balances !== "string") return;
            let Parsed: Record<string, number> = {};
            try {
                const Raw = JSON.parse(Row.doc.balances);
                if (Raw && typeof Raw === "object") Parsed = Raw;
            } catch {
                Parsed = {};
            }
            Tables.wallets.patch(c, Row, { balances: Parsed });
        });
    }
}
