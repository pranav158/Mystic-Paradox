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
import { RepositoryProvider, UnitOfWork } from "../contracts/UnitOfWork";
import { GetMongoClient } from "./client";


















export class MongoUnitOfWork implements UnitOfWork {
    constructor(private readonly repositories: RepositoryProvider) {}

    async withTransaction<T>(fn: (repos: RepositoryProvider, session: ClientSession) => Promise<T>): Promise<T> {
        const Client = await GetMongoClient();
        const Session = Client.startSession();

        try {
            let Result: T;
            await Session.withTransaction(async () => {
                Result = await fn(this.repositories, Session);
            });
            return Result!;
        } finally {
            await Session.endSession();
        }
    }
}
