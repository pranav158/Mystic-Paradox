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

// Collection names for the WP-MONGO-1 scope (Mongo migration plan sections 6.2-6.10), plus
// the two WP-1 progression collections (Plans/PROGRESSION_XP_COMBAT_DATA_IMPLEMENTATION_PLAN.md
// section 5.1) added once persistence went Mongo-native (Phase M9) — no SQLite-first detour
// was needed for these two, unlike the original entities above.
export const Collections = {
    // Durable startup migration ledger. Each additive schema/index/data migration records
    // completion only after its work succeeds, so an interrupted startup is retried rather
    // than being inferred from a partially-created collection or index.
    SchemaMigrations: "schemaMigrations",
    Accounts: "accounts",
    Characters: "characters",
    Inventories: "inventories",
    Loadouts: "loadouts",
    Wallets: "wallets",
    PlayerJourney: "playerJourney",
    Breadcrumbs: "breadcrumbs",
    EncounteredContent: "encounteredContent",
    GameServerApiKeys: "gameServerApiKeys",
    UserApiKeys: "userApiKeys",
    ProgressionTracks: "progressionTracks",
    ProgressionObjectives: "progressionObjectives",
    ProgressionObjectiveEvents: "progressionObjectiveEvents",
    ProgressionTransactions: "progressionTransactions",
    EscalationProgress: "escalationProgress",
    // Per-account bounty state for GET/POST /bounty/:userId (src/bountyState.ts). _id = userId.
    BountyStates: "bountyStates",
    // Per-account cooldowns for GET /cooldown/:userId and PUT /cooldown/batch/:userId (src/cooldownState.ts). _id = userId.
    CooldownStates: "cooldownStates",

    // [hardening] Idempotency ledger for POST /inventory transactions (see
    // contracts/InventoryTransactionRepository.ts). _id = sha256(userId, characterId,
    // transactionId), unique automatically.
    InventoryTransactions: "inventoryTransactions",

    // Launcher auth (Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md). LauncherAccountRepository
    // reuses Collections.Accounts above instead of a new collection — see that
    // repository's header comment.
    AuthIdentities: "authIdentities",
    RefreshSessions: "refreshSessions",
    GameExchangeCodes: "gameExchangeCodes",
    DiscordOAuthTransactions: "discordOAuthTransactions",
    AdminSessions: "adminSessions",
    AdminAudit: "adminAudit",

    // Social graph for the Epic-compatible friends service (routes/friends.ts).
    Friendships: "friendships",

    // Account-level entitlement grants served by GET /entitlementsv2 and granted by store SKUs
    // whose payload is an entitlement rather than an inventory item (see
    // contracts/EntitlementRepository.ts and Progress/33_PLATINUM_STORE.md).
    Entitlements: "entitlements",

    // Short-lived, challenge-bound launcher Guard sessions and the operator policy singleton.
    LauncherGuardSessions: "launcherGuardSessions",
    OperationsPolicy: "operationsPolicy",

    // Durable social party authority. Membership is a separate one-row-per-account collection so
    // Mongo can enforce that an account belongs to at most one party even under concurrent writes.
    Parties: "parties",
    PartyMemberships: "partyMemberships",
    PartyInvites: "partyInvites",
    PartyOutbox: "partyOutbox"
} as const;
