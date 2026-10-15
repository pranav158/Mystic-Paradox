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

import { DiscordOAuthTransactionRecord, DiscordOAuthTransactionRepository } from "../../contracts/DiscordOAuthTransactionRepository";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { IsNullOrMissing, Tables } from "../tables";

// The row lives through two expiries (state/PKCE window, then the completion-code window); the TTL mirror is set
// generously past whichever is current, so a slow completion never races the row's deletion.
const TTL_GRACE_MS = 60 * 60 * 1000;

function ToRecord(Doc: Doc): DiscordOAuthTransactionRecord {
    return {
        state: Doc.state,
        codeVerifier: Doc.codeVerifier,
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt,
        consumedAt: Doc.consumedAt ?? undefined,
        completionCodeHash: Doc.completionCodeHash ?? undefined,
        completionExpiresAt: Doc.completionExpiresAt ?? undefined,
        completionConsumedAt: Doc.completionConsumedAt ?? undefined,
        userId: Doc.userId ?? undefined,
        linkUserId: Doc.linkUserId ?? undefined
    };
}

export class SqliteDiscordOAuthTransactionRepository implements DiscordOAuthTransactionRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async create(transaction: DiscordOAuthTransactionRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.discordOAuthTransactions.insert(c, transaction.state, {
                ...transaction,
                ttlAt: new Date(new Date(transaction.expiresAt).getTime() + TTL_GRACE_MS)
            });
        });
    }

    async consumeByState(state: string): Promise<DiscordOAuthTransactionRecord | undefined> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.discordOAuthTransactions.findOneRow(
                c,
                `_id = ? AND ${IsNullOrMissing("consumedAt")} AND json_extract(doc, '$.expiresAt') > ?`,
                [state, new Date().toISOString()]
            );
            if (Row === undefined) return undefined;
            return ToRecord(Tables.discordOAuthTransactions.patch(c, Row, { consumedAt: new Date().toISOString() }));
        });
    }

    async attachCompletionCode(state: string, completionCodeHash: string, completionExpiresAt: string, userId: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.discordOAuthTransactions.row(c, state);
            if (Row === undefined) return;
            Tables.discordOAuthTransactions.patch(c, Row, {
                completionCodeHash,
                completionExpiresAt,
                userId,
                ttlAt: new Date(new Date(completionExpiresAt).getTime() + TTL_GRACE_MS)
            });
        });
    }

    async consumeByCompletionCodeHash(completionCodeHash: string): Promise<DiscordOAuthTransactionRecord | undefined> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.discordOAuthTransactions.findOneRow(
                c,
                `completionCodeHash = ? AND json_extract(doc, '$.completionExpiresAt') > ? AND ${IsNullOrMissing("completionConsumedAt")}`,
                [completionCodeHash, new Date().toISOString()]
            );
            if (Row === undefined) return undefined;
            return ToRecord(Tables.discordOAuthTransactions.patch(c, Row, { completionConsumedAt: new Date().toISOString() }));
        });
    }
}
