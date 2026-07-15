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
import { AccountRepository } from "../../contracts/AccountRepository";
import { AccountRecord } from "../../mapping/domainTypes";





export class MongoAccountRepository implements AccountRepository {
    async findByUserId(userId: string): Promise<AccountRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Accounts).findOne({ _id: userId as any });

        if (Doc == undefined) {
            return undefined;
        }

        return { userId: Doc.userId, name: Doc.name, notes: Doc.notes };
    }

    async create(account: AccountRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Accounts).insertOne({
            _id: account.userId as any,
            userId: account.userId,
            name: account.name,
            notes: account.notes
        });
    }
}
