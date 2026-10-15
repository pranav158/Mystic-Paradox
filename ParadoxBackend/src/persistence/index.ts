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

// Composition-root barrel for the persistence boundary.
//
// Two providers sit behind the same contracts: MongoDB (the default, the official backend) and SQLite (local realms:
// the backend runs on the host's own PC with no database server; see persistence/sqlite and
// SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md section 6). PERSISTENCE_PROVIDER=mongodb|sqlite selects one at process
// start; an unknown value stops startup, and there is never a silent fallback from one provider to the other (that
// would split player state). The original SQLite/Drizzle adapter was removed (Plans/WP_MONGO_1_M9_SQLITE_REMOVAL.md);
// the current one is new and covers the 1.14.7-era contracts. Controllers/routes obtain repositories through this
// module rather than importing a concrete database client.

import { RepositoryProvider, UnitOfWork, PersistenceLifecycle } from "./contracts/UnitOfWork";
import { CreateMongoRepositoryProvider } from "./mongo";
import { MongoUnitOfWork } from "./mongo/MongoUnitOfWork";
import { MongoPersistenceLifecycle } from "./mongo/client";

export * from "./mapping/domainTypes";
export * from "./contracts/AccountRepository";
export * from "./contracts/ApiKeyRepository";
export * from "./contracts/BreadcrumbRepository";
export * from "./contracts/CharacterRepository";
export * from "./contracts/EncounteredContentRepository";
export * from "./contracts/InventoryRepository";
export * from "./contracts/LoadoutRepository";
export * from "./contracts/PlayerJourneyRepository";
export * from "./contracts/WalletRepository";
export * from "./contracts/ProgressionTrackRepository";
export * from "./contracts/ProgressionGrantRepository";
export * from "./contracts/EscalationProgressRepository";
export * from "./contracts/BountyStateRepository";
export * from "./contracts/CooldownStateRepository";
export * from "./contracts/UnitOfWork";
export * from "./contracts/LauncherAccountRepository";
export * from "./contracts/AuthIdentityRepository";
export * from "./contracts/RefreshSessionRepository";
export * from "./contracts/GameExchangeCodeRepository";
export * from "./contracts/DiscordOAuthTransactionRepository";
export * from "./contracts/EmailCodeRepository";
// [2026-10-15] The launcher notices store (contracts/LauncherNoticesRepository.ts).
export * from "./contracts/LauncherNoticesRepository";
export * from "./contracts/InventoryTransactionRepository";
export * from "./contracts/FriendshipRepository";
export * from "./contracts/AdminRepository";
export * from "./contracts/EntitlementRepository";
export * from "./contracts/LauncherGuardRepository";
export * from "./contracts/PartyRepository";
export * from "./contracts/EconomyRollupRepository";
export * from "./contracts/ActivityRepository";
export { InventoryTransactionAlreadyExistsError } from "./mongo/repositories/MongoInventoryTransactionRepository";

export type PersistenceProviderName = "mongodb" | "sqlite";

/** Reads PERSISTENCE_PROVIDER: unset or "mongodb" (alias "mongo") is MongoDB, "sqlite" is the local-realm provider. */
export function ReadPersistenceProvider(environment: NodeJS.ProcessEnv = process.env): PersistenceProviderName {
    const Raw = environment.PERSISTENCE_PROVIDER?.trim().toLowerCase();
    if (Raw === undefined || Raw === "" || Raw === "mongodb" || Raw === "mongo") return "mongodb";
    if (Raw === "sqlite") return "sqlite";
    throw new Error(`PERSISTENCE_PROVIDER must be "mongodb" or "sqlite" (got ${JSON.stringify(Raw)})`);
}

// Loaded only when selected: node:sqlite needs Node 22.5+ and prints an experimental-feature warning when it loads,
// so a MongoDB deployment (the VPS) must never import it.
function LoadSqliteProvider(): typeof import("./sqlite") {
    try {
        return require("./sqlite");
    } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "ERR_UNKNOWN_BUILTIN_MODULE") {
            throw new Error(
                `PERSISTENCE_PROVIDER=sqlite needs the built-in node:sqlite module (Node 22.5 or newer, and 22.5-22.12 also ` +
                `need --experimental-sqlite); this is Node ${process.version}`
            );
        }
        throw error;
    }
}

let CachedRepositories: RepositoryProvider | undefined;
let CachedUnitOfWork: UnitOfWork | undefined;
let CachedLifecycle: PersistenceLifecycle | undefined;
// Tests only (UsePersistenceForTest): another provider in place of the configured one until it is reset.
let TestPersistence: { repos: RepositoryProvider; uow: UnitOfWork } | undefined;

/** Tests: run the core code against the given repositories and unit of work (undefined restores the configured provider). */
export function UsePersistenceForTest(provider: { repos: RepositoryProvider; uow: UnitOfWork } | undefined): void {
    TestPersistence = provider;
}

export function GetRepositories(): RepositoryProvider {
    if (TestPersistence != undefined) return TestPersistence.repos;
    if (CachedRepositories == undefined) {
        if (ReadPersistenceProvider() === "sqlite") {
            const Sqlite = LoadSqliteProvider();
            CachedRepositories = Sqlite.CreateSqliteRepositoryProvider(Sqlite.GetSqliteDatabase());
        } else {
            CachedRepositories = CreateMongoRepositoryProvider();
        }
    }

    return CachedRepositories;
}

export function GetUnitOfWork(): UnitOfWork {
    if (TestPersistence != undefined) return TestPersistence.uow;
    if (CachedUnitOfWork == undefined) {
        if (ReadPersistenceProvider() === "sqlite") {
            const Sqlite = LoadSqliteProvider();
            CachedUnitOfWork = new Sqlite.SqliteUnitOfWork(Sqlite.GetSqliteDatabase(), GetRepositories());
        } else {
            CachedUnitOfWork = new MongoUnitOfWork(GetRepositories());
        }
    }

    return CachedUnitOfWork;
}

export function GetPersistenceLifecycle(): PersistenceLifecycle {
    if (CachedLifecycle == undefined) {
        if (ReadPersistenceProvider() === "sqlite") {
            const Sqlite = LoadSqliteProvider();
            CachedLifecycle = new Sqlite.SqlitePersistenceLifecycle({
                open: Sqlite.GetSqliteDatabase,
                peek: Sqlite.PeekSqliteDatabase,
                close: Sqlite.CloseSqliteDatabase
            });
        } else {
            CachedLifecycle = new MongoPersistenceLifecycle();
        }
    }

    return CachedLifecycle;
}

/**
 * The SQLite equivalents of the three direct MongoDB reads in core code (operations policy, the store's daily-claim
 * ledger lookup, the operations overview's Guard sessions - persistence/sqlite/directAccess.ts), bound to the open
 * database. undefined under MongoDB: those call sites then keep their own Mongo query.
 */
export type SqliteDirectAccess = {
    readOperationsPolicyRecord(session?: import("mongodb").ClientSession): Promise<any | null>;
    updateOperationsPolicy(expectedVersion: number, fields: Record<string, unknown>, unset: string[],
        session?: import("mongodb").ClientSession): Promise<boolean>;
    findInventoryLedgerClaim(userId: string, transactionId: string): Promise<{ _id: string; characterId?: unknown } | undefined>;
    listLauncherGuardSessions(limit?: number): Promise<any[]>;
};

export function GetSqliteDirectAccess(): SqliteDirectAccess | undefined {
    if (ReadPersistenceProvider() !== "sqlite") return undefined;
    const Sqlite = LoadSqliteProvider();
    const Db = Sqlite.GetSqliteDatabase();
    return {
        readOperationsPolicyRecord: (session) => Sqlite.SqliteReadOperationsPolicyRecord(Db, session),
        updateOperationsPolicy: (expectedVersion, fields, unset, session) =>
            Sqlite.SqliteUpdateOperationsPolicy(Db, expectedVersion, fields, unset, session),
        findInventoryLedgerClaim: (userId, transactionId) => Sqlite.SqliteFindInventoryLedgerClaim(Db, userId, transactionId),
        listLauncherGuardSessions: (limit) => Sqlite.SqliteListLauncherGuardSessions(Db, limit)
    };
}
