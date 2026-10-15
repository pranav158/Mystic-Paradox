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

import { RepositoryProvider } from "../contracts/UnitOfWork";
import { ReadSqliteRuntimeConfig } from "./config";
import { SqliteDatabase } from "./database";
import { SqliteAccountRepository } from "./repositories/SqliteAccountRepository";
import { SqliteAdminRepository } from "./repositories/SqliteAdminRepository";
import { SqliteApiKeyRepository } from "./repositories/SqliteApiKeyRepository";
import { SqliteAuthIdentityRepository } from "./repositories/SqliteAuthIdentityRepository";
import { SqliteBreadcrumbRepository } from "./repositories/SqliteBreadcrumbRepository";
import { SqliteCharacterRepository } from "./repositories/SqliteCharacterRepository";
import { SqliteDiscordOAuthTransactionRepository } from "./repositories/SqliteDiscordOAuthTransactionRepository";
import { SqliteEmailCodeRepository } from "./repositories/SqliteEmailCodeRepository";
import { SqliteLauncherNoticesRepository } from "./repositories/SqliteLauncherNoticesRepository";
import { SqliteEconomyRollupRepository } from "./repositories/SqliteEconomyRollupRepository";
import { SqliteActivityRepository } from "./repositories/SqliteActivityRepository";
import { SqliteEncounteredContentRepository } from "./repositories/SqliteEncounteredContentRepository";
import { SqliteEntitlementRepository } from "./repositories/SqliteEntitlementRepository";
import { SqliteFriendshipRepository } from "./repositories/SqliteFriendshipRepository";
import { SqliteGameExchangeCodeRepository } from "./repositories/SqliteGameExchangeCodeRepository";
import { SqliteInventoryRepository } from "./repositories/SqliteInventoryRepository";
import { SqliteInventoryTransactionRepository } from "./repositories/SqliteInventoryTransactionRepository";
import { SqliteLauncherAccountRepository } from "./repositories/SqliteLauncherAccountRepository";
import { SqliteLauncherGuardRepository } from "./repositories/SqliteLauncherGuardRepository";
import { SqliteLoadoutRepository } from "./repositories/SqliteLoadoutRepository";
import { SqlitePartyRepository } from "./repositories/SqlitePartyRepository";
import { SqlitePlayerJourneyRepository } from "./repositories/SqlitePlayerJourneyRepository";
import { SqliteProgressionGrantRepository } from "./repositories/SqliteProgressionGrantRepository";
import { SqliteProgressionTrackRepository } from "./repositories/SqliteProgressionTrackRepository";
import { SqliteRefreshSessionRepository } from "./repositories/SqliteRefreshSessionRepository";
import {
    SqliteBountyStateRepository,
    SqliteCooldownStateRepository,
    SqliteEscalationProgressRepository
} from "./repositories/SqliteVersionedStateRepositories";
import { SqliteWalletRepository } from "./repositories/SqliteWalletRepository";

export { SqliteDatabase, SqliteSession } from "./database";
export { SqliteUnitOfWork } from "./SqliteUnitOfWork";
export { SqlitePersistenceLifecycle } from "./SqlitePersistenceLifecycle";
export type { SqliteDatabaseSource } from "./SqlitePersistenceLifecycle";
export { ReadSqliteRuntimeConfig } from "./config";
export type { SqliteRuntimeConfig } from "./config";
export * from "./directAccess";

/** Builds the SQLite-backed RepositoryProvider: every core repository contract, over one database. */
export function CreateSqliteRepositoryProvider(db: SqliteDatabase): RepositoryProvider {
    return {
        accounts: new SqliteAccountRepository(db),
        characters: new SqliteCharacterRepository(db),
        inventories: new SqliteInventoryRepository(db),
        loadouts: new SqliteLoadoutRepository(db),
        wallets: new SqliteWalletRepository(db),
        playerJourney: new SqlitePlayerJourneyRepository(db),
        breadcrumbs: new SqliteBreadcrumbRepository(db),
        encounteredContent: new SqliteEncounteredContentRepository(db),
        apiKeys: new SqliteApiKeyRepository(db),
        progressionTracks: new SqliteProgressionTrackRepository(db),
        progressionGrants: new SqliteProgressionGrantRepository(db),
        escalationProgress: new SqliteEscalationProgressRepository(db),
        bountyStates: new SqliteBountyStateRepository(db),
        cooldownStates: new SqliteCooldownStateRepository(db),
        economyRollups: new SqliteEconomyRollupRepository(db),
        activity: new SqliteActivityRepository(db),
        launcherAccounts: new SqliteLauncherAccountRepository(db),
        authIdentities: new SqliteAuthIdentityRepository(db),
        refreshSessions: new SqliteRefreshSessionRepository(db),
        gameExchangeCodes: new SqliteGameExchangeCodeRepository(db),
        discordOAuthTransactions: new SqliteDiscordOAuthTransactionRepository(db),
        emailCodes: new SqliteEmailCodeRepository(db),
        launcherNotices: new SqliteLauncherNoticesRepository(db),
        inventoryTransactions: new SqliteInventoryTransactionRepository(db),
        friendships: new SqliteFriendshipRepository(db),
        admin: new SqliteAdminRepository(db),
        entitlements: new SqliteEntitlementRepository(db),
        parties: new SqlitePartyRepository(db),
        launcherGuard: new SqliteLauncherGuardRepository(db)
    };
}

// The process-wide database, opened from the environment on first use (settings in config.ts). Opening applies the
// schema, so repositories work without start(); start() adds the housekeeping.
let CachedDatabase: SqliteDatabase | undefined;

export function GetSqliteDatabase(): SqliteDatabase {
    if (CachedDatabase === undefined || !CachedDatabase.isOpen) {
        CachedDatabase = SqliteDatabase.open(ReadSqliteRuntimeConfig());
    }
    return CachedDatabase;
}

/** The open process-wide database, or undefined (never opens one). */
export function PeekSqliteDatabase(): SqliteDatabase | undefined {
    return CachedDatabase !== undefined && CachedDatabase.isOpen ? CachedDatabase : undefined;
}

export async function CloseSqliteDatabase(): Promise<void> {
    const Db = CachedDatabase;
    CachedDatabase = undefined;
    if (Db !== undefined) await Db.close();
}
