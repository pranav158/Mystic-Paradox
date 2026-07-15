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
import { MongoAccountRepository } from "./repositories/MongoAccountRepository";
import { MongoApiKeyRepository } from "./repositories/MongoApiKeyRepository";
import { MongoBreadcrumbRepository } from "./repositories/MongoBreadcrumbRepository";
import { MongoCharacterRepository } from "./repositories/MongoCharacterRepository";
import { MongoEncounteredContentRepository } from "./repositories/MongoEncounteredContentRepository";
import { MongoInventoryRepository } from "./repositories/MongoInventoryRepository";
import { MongoLoadoutRepository } from "./repositories/MongoLoadoutRepository";
import { MongoPlayerJourneyRepository } from "./repositories/MongoPlayerJourneyRepository";
import { MongoWalletRepository } from "./repositories/MongoWalletRepository";
import { MongoProgressionTrackRepository } from "./repositories/MongoProgressionTrackRepository";
import { MongoLauncherAccountRepository } from "./repositories/MongoLauncherAccountRepository";
import { MongoAuthIdentityRepository } from "./repositories/MongoAuthIdentityRepository";
import { MongoRefreshSessionRepository } from "./repositories/MongoRefreshSessionRepository";
import { MongoGameExchangeCodeRepository } from "./repositories/MongoGameExchangeCodeRepository";
import { MongoDiscordOAuthTransactionRepository } from "./repositories/MongoDiscordOAuthTransactionRepository";
import { MongoInventoryTransactionRepository } from "./repositories/MongoInventoryTransactionRepository";
import { MongoFriendshipRepository } from "./repositories/MongoFriendshipRepository";
import { MongoAdminRepository } from "./repositories/MongoAdminRepository";



export function CreateMongoRepositoryProvider(): RepositoryProvider {
    return {
        accounts: new MongoAccountRepository(),
        characters: new MongoCharacterRepository(),
        inventories: new MongoInventoryRepository(),
        loadouts: new MongoLoadoutRepository(),
        wallets: new MongoWalletRepository(),
        playerJourney: new MongoPlayerJourneyRepository(),
        breadcrumbs: new MongoBreadcrumbRepository(),
        encounteredContent: new MongoEncounteredContentRepository(),
        apiKeys: new MongoApiKeyRepository(),
        progressionTracks: new MongoProgressionTrackRepository(),
        launcherAccounts: new MongoLauncherAccountRepository(),
        authIdentities: new MongoAuthIdentityRepository(),
        refreshSessions: new MongoRefreshSessionRepository(),
        gameExchangeCodes: new MongoGameExchangeCodeRepository(),
        discordOAuthTransactions: new MongoDiscordOAuthTransactionRepository(),
        inventoryTransactions: new MongoInventoryTransactionRepository(),
        friendships: new MongoFriendshipRepository(),
        admin: new MongoAdminRepository()
    };
}
