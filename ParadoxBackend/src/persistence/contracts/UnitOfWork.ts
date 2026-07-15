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
import { AccountRepository } from "./AccountRepository";
import { ApiKeyRepository } from "./ApiKeyRepository";
import { BreadcrumbRepository } from "./BreadcrumbRepository";
import { CharacterRepository } from "./CharacterRepository";
import { EncounteredContentRepository } from "./EncounteredContentRepository";
import { InventoryRepository } from "./InventoryRepository";
import { LoadoutRepository } from "./LoadoutRepository";
import { PlayerJourneyRepository } from "./PlayerJourneyRepository";
import { WalletRepository } from "./WalletRepository";
import { ProgressionTrackRepository } from "./ProgressionTrackRepository";
import { LauncherAccountRepository } from "./LauncherAccountRepository";
import { AuthIdentityRepository } from "./AuthIdentityRepository";
import { RefreshSessionRepository } from "./RefreshSessionRepository";
import { GameExchangeCodeRepository } from "./GameExchangeCodeRepository";
import { DiscordOAuthTransactionRepository } from "./DiscordOAuthTransactionRepository";
import { InventoryTransactionRepository } from "./InventoryTransactionRepository";
import { FriendshipRepository } from "./FriendshipRepository";
import { AdminRepository } from "./AdminRepository";




export interface RepositoryProvider {
    accounts: AccountRepository;
    characters: CharacterRepository;
    inventories: InventoryRepository;
    loadouts: LoadoutRepository;
    wallets: WalletRepository;
    playerJourney: PlayerJourneyRepository;
    breadcrumbs: BreadcrumbRepository;
    encounteredContent: EncounteredContentRepository;
    apiKeys: ApiKeyRepository;
    progressionTracks: ProgressionTrackRepository;

    
    
    launcherAccounts: LauncherAccountRepository;
    authIdentities: AuthIdentityRepository;
    refreshSessions: RefreshSessionRepository;
    gameExchangeCodes: GameExchangeCodeRepository;
    discordOAuthTransactions: DiscordOAuthTransactionRepository;

    
    inventoryTransactions: InventoryTransactionRepository;

    
    friendships: FriendshipRepository;
    admin: AdminRepository;
}








export interface UnitOfWork {
    withTransaction<T>(fn: (repos: RepositoryProvider, session: ClientSession) => Promise<T>): Promise<T>;
}




export interface PersistenceLifecycle {
    
    start(): Promise<void>;

    
    isHealthy(): Promise<boolean>;

    
    stop(): Promise<void>;
}
