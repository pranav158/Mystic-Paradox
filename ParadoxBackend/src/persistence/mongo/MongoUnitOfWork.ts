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
import { ReadMongoRuntimeConfig } from "../../config/mongoRuntime";
import { GetMongoClient } from "./client";

// [hardening] Real MongoDB implementation of the transaction-boundary abstraction, using
// `client.startSession()` + `session.withTransaction(...)`. Atlas is a genuine replica set with
// a writable primary (confirmed independently — see the audit that flagged this as a
// placeholder), so multi-document transactions work here.
//
// `fn` receives the SAME repository instances passed to the constructor — the session is not
// threaded through automatically, because most repository methods don't take one (this was a
// deliberate choice: only the specific methods that actually participate in a transaction today,
// e.g. WalletRepository.incrementBalance / InventoryRepository.findByCharacterId/create/
// updateBoth / InventoryTransactionRepository, accept an optional `session` parameter). Callers
// inside `fn` must pass the `session` argument explicitly to every repository call that needs to
// be part of the atomic unit; calls that omit it run outside the transaction.
//
// `session.withTransaction` retries the callback on Mongo's own transient transaction errors
// (e.g. a write conflict from a concurrent transaction) per the driver's documented retry
// behavior — `fn` must therefore be safe to invoke more than once for the same logical operation
// (i.e. it should not have side effects outside the session before it succeeds).
export class MongoUnitOfWork implements UnitOfWork {
    constructor(private readonly repositories: RepositoryProvider) {}

    async withTransaction<T>(fn: (repos: RepositoryProvider, session: ClientSession) => Promise<T>): Promise<T> {
        const Client = await GetMongoClient();
        const Session = Client.startSession();

        try {
            let Result: T;
            const maxCommitTimeMS = ReadMongoRuntimeConfig().transactionMaxCommitTimeMS;
            await Session.withTransaction(async () => {
                Result = await fn(this.repositories, Session);
            }, {
                readPreference: "primary",
                readConcern: { level: "majority" },
                writeConcern: { w: "majority" },
                maxCommitTimeMS
            });
            return Result!;
        } finally {
            await Session.endSession();
        }
    }
}
