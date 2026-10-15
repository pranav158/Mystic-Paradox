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

    // [2026-10-14] Per-account, per-UTC-day economy totals (diagnostics/economyLedgerMonitor.ts; monitoring only, ~400 days).
    // _id = `${userId}:${day}:${currency}`.
    EconomyDaily: "economyDaily",

    // [2026-10-14] Activity monitor (src/activity; monitoring only, ~400 days, every collection in the account deletion plan):
    // per-account, per-UTC-day counters; hunt participation rows (dedicated and P2P); Slayer's Path unlock history; review flags.
    PlayerActivityDaily: "playerActivityDaily",
    ActivityHunts: "activityHunts",
    SlayersPathUnlocks: "slayersPathUnlocks",
    ActivityFlags: "activityFlags",

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
    // [2026-10-15] The live one-time codes of email verification and password reset. _id = "<userId>:<purpose>"; only an HMAC of the
    // code is stored; a row is removed when used, expired or out of tries, and ttlAt (the expiry) purges the rest.
    EmailCodes: "emailCodes",
    AdminSessions: "adminSessions",
    AdminAudit: "adminAudit",
    // [2026-10-14] One pseudonymous tombstone per erased account (scripts/process_account_deletions.ts). _id = pseudonymousId.
    // Nothing else about the account is kept: no id, email, name or game data.
    AccountDeletions: "accountDeletions",

    // Social graph for the Epic-compatible friends service (routes/friends.ts).
    Friendships: "friendships",

    // Account-level entitlement grants served by GET /entitlementsv2 and granted by store SKUs
    // whose payload is an entitlement rather than an inventory item (see
    // contracts/EntitlementRepository.ts and Progress/33_PLATINUM_STORE.md).
    Entitlements: "entitlements",

    // Short-lived, challenge-bound launcher Guard sessions and the operator policy singleton.
    LauncherGuardSessions: "launcherGuardSessions",
    // [2026-10-14] Module findings from the Guard heartbeats (file name, hash, signer, accounts that reported it); 90 days.
    GuardFindings: "guardFindings",
    OperationsPolicy: "operationsPolicy",

    // [2026-10-15] The launcher notices (contracts/LauncherNoticesRepository.ts): one singleton document, _id "current".
    LauncherNotices: "launcherNotices",

    // Durable social party authority. Membership is a separate one-row-per-account collection so
    // Mongo can enforce that an account belongs to at most one party even under concurrent writes.
    Parties: "parties",
    PartyMemberships: "partyMemberships",
    PartyInvites: "partyInvites",
    PartyOutbox: "partyOutbox"
} as const;
