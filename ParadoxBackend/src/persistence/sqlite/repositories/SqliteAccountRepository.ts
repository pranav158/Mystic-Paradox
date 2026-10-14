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

import { AccountRepository } from "../../contracts/AccountRepository";
import { AccountRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { Tables } from "../tables";

// `accounts` table, _id = userId. Only userId/name/notes are stored, as in MongoAccountRepository; the launcher
// repository adds its fields to the same document.
export class SqliteAccountRepository implements AccountRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByUserId(userId: string): Promise<AccountRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.accounts.get(c, userId);
            return Doc === undefined ? undefined : { userId: Doc.userId, name: Doc.name, notes: Doc.notes };
        });
    }

    async create(account: AccountRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.accounts.insert(c, account.userId, { userId: account.userId, name: account.name, notes: account.notes });
        });
    }
}
