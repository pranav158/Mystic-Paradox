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
import { ProgressionGrantRepository } from "./ProgressionGrantRepository";
import { LauncherAccountRepository } from "./LauncherAccountRepository";
import { AuthIdentityRepository } from "./AuthIdentityRepository";
import { RefreshSessionRepository } from "./RefreshSessionRepository";
import { GameExchangeCodeRepository } from "./GameExchangeCodeRepository";
import { DiscordOAuthTransactionRepository } from "./DiscordOAuthTransactionRepository";
import { InventoryTransactionRepository } from "./InventoryTransactionRepository";
import { FriendshipRepository } from "./FriendshipRepository";
import { AdminRepository } from "./AdminRepository";
import { EscalationProgressRepository } from "./EscalationProgressRepository";
import { BountyStateRepository } from "./BountyStateRepository";
import { CooldownStateRepository } from "./CooldownStateRepository";
import { EntitlementRepository } from "./EntitlementRepository";
import { PartyRepository } from "./PartyRepository";
import { LauncherGuardRepository } from "./LauncherGuardRepository";

// The set of repositories the MongoDB provider supplies. This is the
// "composition root" surface — controllers/services obtain repositories
// through this interface rather than importing the MongoDB driver directly.
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
    progressionGrants: ProgressionGrantRepository;
    escalationProgress: EscalationProgressRepository;
    bountyStates: BountyStateRepository;
    cooldownStates: CooldownStateRepository;

    // Launcher auth (Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md) — additive,
    // does not change any existing game route's behavior.
    launcherAccounts: LauncherAccountRepository;
    authIdentities: AuthIdentityRepository;
    refreshSessions: RefreshSessionRepository;
    gameExchangeCodes: GameExchangeCodeRepository;
    discordOAuthTransactions: DiscordOAuthTransactionRepository;

    // [hardening] Idempotency ledger for POST /inventory (see InventoryTransactionRepository.ts).
    inventoryTransactions: InventoryTransactionRepository;

    // Epic-compatible friends service social graph (routes/friends.ts).
    friendships: FriendshipRepository;
    admin: AdminRepository;

    // Account-level entitlements (GET /entitlementsv2, entitlement-payload store SKUs).
    entitlements: EntitlementRepository;

    // Durable Phoenix party authority and revisioned realtime outbox.
    parties: PartyRepository;

    // Short-lived, challenge-bound launcher integrity sessions. Raw session secrets are never stored.
    launcherGuard: LauncherGuardRepository;
}

// Transaction boundary abstraction. The MongoDB adapter (MongoUnitOfWork) implements this with
// a real `client.startSession()` + `session.withTransaction(...)` — Atlas is a genuine replica
// set with a writable primary, so multi-document transactions work. `fn` receives the shared
// RepositoryProvider AND the active ClientSession; callers must pass `session` explicitly to
// every repository method that needs to participate in the atomic unit (only specific methods
// accept an optional session parameter — see e.g. WalletRepository.incrementBalance,
// InventoryRepository.findByCharacterId/create/updateBoth, InventoryTransactionRepository).
export interface UnitOfWork {
    withTransaction<T>(fn: (repos: RepositoryProvider, session: ClientSession) => Promise<T>): Promise<T>;
}

// Lifecycle contract the MongoDB provider implements: connect, ping/health,
// and clean shutdown, invoked explicitly at server startup before the app
// accepts requests.
export interface PersistenceLifecycle {
    /** Establish the connection and verify the database is reachable. Must be
     *  called once, before the app starts accepting requests. */
    start(): Promise<void>;

    /** Report whether the provider can currently serve reads/writes. */
    isHealthy(): Promise<boolean>;

    /** Release the connection cleanly. */
    stop(): Promise<void>;
}
