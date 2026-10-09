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

// Domain persistence types for the persistence boundary (originally introduced for
// WP-MONGO-1 Phase M1, during the SQLite -> MongoDB migration).
//
// These types describe the persisted shape as MongoDB documents (see
// src/persistence/mongo/repositories/*) map them today. They are intentionally NOT the
// wire/response shapes (those are built by controllers via TransformDbCharacterToWireCharacter
// etc.). The SQLite/Drizzle adapter these types originally mirrored has been fully removed
// (see Plans/WP_MONGO_1_M9_SQLITE_REMOVAL.md) — MongoDB is the sole persistence provider.
//
// Field naming intentionally still matches the old Drizzle schema's column names in most
// places; that was a deliberate migration-era choice (Phase M2's mechanical mapping) and
// has simply never needed to change since, not a sign the SQLite adapter is still present.

export interface AccountRecord {
    userId: string;
    name: string;
    notes: number;
}

export interface CharacterRecord {
    characterId: string;
    userId: string;
    createdDate: string;
    lastModifiedDate: string;
    name: string;
    updateVersion: number;
    /** Raw JSON text blob, exactly as persisted. Callers parse/normalize it themselves. */
    data: string;
}

export interface InventoryRecord {
    characterId: string;
    /** Populated on newly-created rows so the existing userId index is actually usable for
     *  lookups/audits. Optional because older migrated rows may not have it (matches how the
     *  SQLite-era rows were, before this field was tracked here at all). */
    userId?: string;
    /** Raw JSON text blob (array), exactly as persisted. */
    instancedItems: string;
    /** Raw JSON text blob (array), exactly as persisted. */
    stackedItems: string;
    /** [hardening] Optimistic-concurrency counter, incremented on every successful write.
     *  Optional because older rows created before this field existed may not have it yet (treated
     *  as revision 0 by the repository). Callers that read-modify-write must pass the revision
     *  they read back to updateBoth() so a concurrent writer's change isn't silently overwritten. */
    revision?: number;
    /** [hardening] Tags which starterManifest.ts manifest version seeded this row at account
     *  creation (or migration) time - e.g. "starter-1.12-v1". Optional/absent on rows created
     *  before this tracking existed. Purely informational (audit trail), never read by any
     *  runtime code path to change behavior. */
    bootstrapVersion?: string;
}

// [hardening] Idempotency ledger for POST /inventory. _id = sha256(userId, characterId,
// transactionId) - the key is bound to the acting user AND character, not the client-supplied
// transactionId alone, so one user can never collide with or replay another user's transactionId.
// A transaction is inserted as "pending" BEFORE any mutation runs (inside the same Mongo
// transaction as the wallet/inventory writes); if the same (user, character, transaction) tuple is
// replayed (network retry, duplicate send), the insert hits a duplicate-key error instead of
// re-applying the grant/spend, and the ORIGINAL stored result is returned instead.
export interface InventoryTransactionRecord {
    transactionId: string;
    userId: string;
    characterId: string;
    /** [hardening] Canonical SHA-256 of the mutation body (add/remove/save collections). Stored
     *  SEPARATELY from `_id` on purpose: the `_id` binds idempotency to who/what/which-transaction,
     *  while requestHash detects a transactionId REUSED with a different body. Same key + same
     *  requestHash replays the stored result; same key + different requestHash is rejected without
     *  mutating. It must NOT be part of `_id`, or a changed body would just execute as new. */
    requestHash: string;
    status: "pending" | "completed";
    /** The exact response payload RunInventoryTransaction returned; replayed verbatim on retry. */
    result?: unknown;
    createdAt: string;
    completedAt?: string;
}

export interface LoadoutRecord {
    characterId: string;
    userId: string;
    /** Raw JSON text blob (array of loadout slots), exactly as persisted. */
    loadouts: string;
    /** Raw JSON text blob (object), exactly as persisted. */
    persistent: string;
    /** Zero-based loadout selected for gameplay. Legacy rows without this field select slot 0. */
    activeIndex?: number;
    /** Total currently entitled/visible slots, including the default account slot. Stored slot
     *  contents may be longer so a corrected entitlement never destroys legacy player data. */
    unlockedTotalSlots?: number;
    /** [hardening] Optimistic-concurrency counter, incremented on every successful write. See
     *  InventoryRecord.revision for the full rationale — same pattern here. */
    revision?: number;
    /** [hardening] See InventoryRecord.bootstrapVersion — same audit-trail purpose. */
    bootstrapVersion?: string;
}

export interface WalletRecord {
    userId: string;
    /** Real BSON subdocument {catalogId: quantity}, each value a genuine number field (not a JSON blob). */
    balances: Record<string, number>;
    /** [hardening] See InventoryRecord.bootstrapVersion — same audit-trail purpose. */
    bootstrapVersion?: string;
}

// Account-level entitlement grants (`entitlements` collection, _id = userId). Matches the real
// captured GET /entitlementsv2 element shape; `grantedAt`/`sourceSkuId` are ours, for audit only,
// and are never serialized to the client.
export interface EntitlementRecord {
    userId: string;
    entitlements: {
        name: string;
        duration: number;
        activatedDate: string | null;
        grantedAt?: string;
        sourceSkuId?: string;
    }[];
}

export interface PlayerJourneyRecord {
    userId: string;
    /** Raw JSON text blob (nodes dict), exactly as persisted. */
    nodes: string;
    updateVersion: number;
    /** Server-owned monotonic revision used exclusively for database CAS. */
    revision: number;
}

export interface BreadcrumbsRecord {
    characterId: string;
    userId: string;
    /** Raw JSON text blob (array), exactly as persisted. */
    breadcrumbs: string;
    updateVersion: number;
}

export interface EncounteredContentRecord {
    characterId: string;
    userId: string;
    /** Raw JSON text blob (array), exactly as persisted. */
    encounteredcontent: string;
}

export interface GameServerApiKeyRecord {
    id: number;
    keyHash: string | null;
}

export interface UserApiKeyRecord {
    userId: string;
    keyHash: string;
}

export interface UserApiKeyToRegisterRecord {
    userId: string;
    key: string;
}

export interface GameServerApiKeyToRegisterRecord {
    key: string;
}

// WP-1 (Plans/PROGRESSION_XP_COMBAT_DATA_IMPLEMENTATION_PLAN.md section 5.1). Canonical raw
// progression total per {userId, progressionId} pair. `progress` is the raw wire-contract total
// exactly as reported by the game server's XP-grant calls — this repository never derives rank
// or reward state; that is future work gated on validated 1.12 rank-table definitions (plan
// section 5.2/Phase 5).
export interface ProgressionTrackRecord {
    userId: string;
    progressionId: string;
    progress: number;
    confirmedFremiumRank: number;
    confirmedPremiumRank: number;
    updateVersion: number;
    createdAt: string;
    updatedAt: string;
}

/** Exactly-once result ledger entry for an authoritative gameserver XP grant. */
export interface ProgressionGrantRecord {
    grantId: string;
    userId: string;
    progressionId: string;
    amount: number;
    requestHash: string;
    status: "applied";
    result: ProgressionTrackRecord;
    createdAt: string;
}

// Durable per-account, per-season Escalation state. The wire endpoint uses snake_case,
// while persistence records use the same camelCase convention as the rest of this file.
// Talent/unlock entries are intentionally retained as opaque JSON-compatible objects:
// their exact wire fields are owned by the 1.12 game serializer and must round-trip
// without the backend deleting fields it does not understand.
export interface EscalationProgressRecord {
    userId: string;
    seasonId: string;
    escalationLevel: number;
    nextLevelXp: number;
    talentsProgress: unknown[];
    unlockProgress: unknown[];
    updateVersion: number;
    createdAt: string;
    updatedAt: string;
}

// WP-1 stage 2 (plan section 6.3): raw capture of every POST /progression/:userId body BEFORE
// any reducer logic exists. Deliberately unstructured/passthrough — the plan explicitly forbids
// guessing delta-vs-absolute semantics before at least two sequential real payloads are compared
// (section 6.3 step 2-4). This is an append-only event log, not player state.
// WP-1 stage 2 (plan section 6.3 steps 3-5). Now that real sequential traffic has proven
// mastery/objective `value` fields are ABSOLUTE running totals (not deltas) — confirmed by
// comparing MasteryObjective_Weapon_Sword_Generic_Kills1 (value=1 -> value=2, completed_count
// 0 -> 1) and MasteryObjective_Behemoth_Embermane_Boop (value=3 -> value=5) across two real
// sequential payloads from the same session — this is the RESOLVED per-objective state,
// written by a monotonic max-guard reducer (never a naive `+=`, which the plan explicitly
// forbids without this proof). `completedCount` follows the same absolute-total rule.
export interface ProgressionObjectiveRecord {
    userId: string;
    objectiveId: string;
    value: number;
    completedCount: number;
    updatedAt: string;
}

export interface ProgressionObjectiveEventRecord {
    userId: string;
    /** Raw JSON text blob of the exact request body received, exactly as posted. */
    rawBody: string;
    receivedAt: string;
}
