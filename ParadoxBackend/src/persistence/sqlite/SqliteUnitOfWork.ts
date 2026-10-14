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

import type { ClientSession } from "mongodb";
import { RepositoryProvider, UnitOfWork } from "../contracts/UnitOfWork";
import { SqliteDatabase } from "./database";

// The transaction-boundary abstraction for SQLite: one `BEGIN IMMEDIATE ... COMMIT` on the write connection
// (see database.ts for the queueing rules). `fn` receives the shared repositories and a session token in place of
// MongoDB's ClientSession: the contracts type that parameter as ClientSession, so the token is cast, and callers only
// pass it back to repository methods. Repository calls made inside `fn` join the transaction even without the token.
//
// Unlike MongoDB's withTransaction, `fn` is invoked exactly once: an in-process transaction cannot hit a transient
// write conflict, and a lock held by another process is waited for by busy_timeout and then reported as an error.
export class SqliteUnitOfWork implements UnitOfWork {
    constructor(private readonly db: SqliteDatabase, private readonly repositories: RepositoryProvider) {}

    async withTransaction<T>(fn: (repos: RepositoryProvider, session: ClientSession) => Promise<T>): Promise<T> {
        return this.db.transaction((session) => fn(this.repositories, session as unknown as ClientSession));
    }
}
