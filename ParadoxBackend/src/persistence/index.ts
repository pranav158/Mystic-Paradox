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
export * from "./contracts/UnitOfWork";
export * from "./contracts/LauncherAccountRepository";
export * from "./contracts/AuthIdentityRepository";
export * from "./contracts/RefreshSessionRepository";
export * from "./contracts/GameExchangeCodeRepository";
export * from "./contracts/DiscordOAuthTransactionRepository";
export * from "./contracts/InventoryTransactionRepository";
export * from "./contracts/FriendshipRepository";
export * from "./contracts/AdminRepository";
export { InventoryTransactionAlreadyExistsError } from "./mongo/repositories/MongoInventoryTransactionRepository";

let CachedRepositories: RepositoryProvider | undefined;
let CachedUnitOfWork: UnitOfWork | undefined;
let CachedLifecycle: PersistenceLifecycle | undefined;

export function GetRepositories(): RepositoryProvider {
    if (CachedRepositories == undefined) {
        CachedRepositories = CreateMongoRepositoryProvider();
    }

    return CachedRepositories;
}

export function GetUnitOfWork(): UnitOfWork {
    if (CachedUnitOfWork == undefined) {
        CachedUnitOfWork = new MongoUnitOfWork(GetRepositories());
    }

    return CachedUnitOfWork;
}

export function GetPersistenceLifecycle(): PersistenceLifecycle {
    if (CachedLifecycle == undefined) {
        CachedLifecycle = new MongoPersistenceLifecycle();
    }

    return CachedLifecycle;
}
