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

import type { Conn } from "./database";

// One table per MongoDB collection, with the Mongo collection's name (so deletion counts and diagnostics keep their
// keys). Every table is `_id TEXT PRIMARY KEY` + `doc TEXT` (the record as a JSON document, without `_id`) plus
// VIRTUAL generated key columns that read the fields the contracts look up by; those columns carry the indexes and the
// UNIQUE constraints, so a lookup never scans and a record can never be stored in a way the index misses.
//
// Rows keep their insertion order (the implicit rowid): MongoDB returns an unsorted find() in insertion order and
// callers such as the character list rely on it.

export const CURRENT_SQLITE_SCHEMA_VERSION = 1;
export const SQLITE_SCHEMA_MIGRATION_ID = "realm-sqlite-schema-v1";

export interface IndexSpec {
    name: string;
    /** Column names; append " DESC" for a descending key. */
    columns: string[];
    unique?: boolean;
    where?: string;
}

export interface TableSpec {
    name: string;
    /** Generated key column -> JSON field (top level). */
    columns?: Record<string, string>;
    indexes?: IndexSpec[];
}

/** Collections whose rows carry a storage-only `ttlAt` (ISO) mirror, purged once it is in the past. */
// [2026-10-15] emailCodes: the one-time email codes, purged past their expiry (contracts/EmailCodeRepository.ts).
export const TTL_TABLES = ["refreshSessions", "gameExchangeCodes", "discordOAuthTransactions", "emailCodes", "adminSessions", "economyDaily",
    // [2026-10-14] Activity monitor rows, kept about 400 days (persistence/mongo/indexes.ts has the matching TTL indexes).
    "playerActivityDaily", "activityHunts", "slayersPathUnlocks", "activityFlags"] as const;

/**
 * [2026-10-14] Tables whose ttlAt lives in the document only (no generated column, so an existing database needs no migration):
 * launcher Guard sessions and module findings, kept 90 days (Privacy Policy section 5, as the MongoDB TTL index does).
 */
export const TTL_DOC_TABLES = ["launcherGuardSessions", "guardFindings"] as const;

export const TABLES: TableSpec[] = [
    // accounts is shared by AccountRepository (dev/game accounts) and LauncherAccountRepository. email and
    // displayNameNormalized are unique only where present, exactly like the Mongo partial indexes.
    {
        name: "accounts",
        columns: { email: "email", displayNameNormalized: "displayNameNormalized", createdAt: "createdAt" },
        indexes: [
            { name: "accounts_email", columns: ["email"], unique: true, where: "email IS NOT NULL" },
            { name: "accounts_displayNameNormalized", columns: ["displayNameNormalized"], unique: true, where: "displayNameNormalized IS NOT NULL" }
        ]
    },
    { name: "characters", columns: { userId: "userId" }, indexes: [{ name: "characters_userId", columns: ["userId"] }] },
    { name: "inventories", columns: { userId: "userId" }, indexes: [{ name: "inventories_userId", columns: ["userId"] }] },
    { name: "loadouts", columns: { userId: "userId" }, indexes: [{ name: "loadouts_userId", columns: ["userId"] }] },
    // _id = userId; the userId key column serves the player-deletion cascade ({$or: [{userId}, {_id: userId}]}).
    { name: "wallets", columns: { userId: "userId" }, indexes: [{ name: "wallets_userId", columns: ["userId"] }] },
    { name: "playerJourney", columns: { userId: "userId" }, indexes: [{ name: "playerJourney_userId", columns: ["userId"] }] },
    { name: "breadcrumbs", columns: { userId: "userId" }, indexes: [{ name: "breadcrumbs_userId", columns: ["userId"] }] },
    { name: "encounteredContent", columns: { userId: "userId" }, indexes: [{ name: "encounteredContent_userId", columns: ["userId"] }] },
    // The Mongo keyHash indexes are deliberately non-unique ("behaviour-preserving migration"): same here.
    { name: "gameServerApiKeys", columns: { keyHash: "keyHash" }, indexes: [{ name: "gameServerApiKeys_keyHash", columns: ["keyHash"] }] },
    {
        name: "userApiKeys",
        columns: { keyHash: "keyHash", userId: "userId" },
        indexes: [
            { name: "userApiKeys_keyHash", columns: ["keyHash"] },
            { name: "userApiKeys_userId", columns: ["userId"] }
        ]
    },
    { name: "progressionTracks", columns: { userId: "userId" }, indexes: [{ name: "progressionTracks_userId", columns: ["userId"] }] },
    { name: "progressionObjectives", columns: { userId: "userId" }, indexes: [{ name: "progressionObjectives_userId", columns: ["userId"] }] },
    {
        name: "progressionObjectiveEvents",
        columns: { userId: "userId", receivedAt: "receivedAt" },
        indexes: [{ name: "progressionObjectiveEvents_user_received", columns: ["userId", "receivedAt"] }]
    },
    {
        name: "progressionTransactions",
        columns: { userId: "userId", createdAt: "createdAt" },
        indexes: [{ name: "progressionTransactions_user_created", columns: ["userId", "createdAt DESC"] }]
    },
    {
        name: "escalationProgress",
        columns: { userId: "userId", seasonId: "seasonId" },
        indexes: [{ name: "escalationProgress_user_season", columns: ["userId", "seasonId"] }]
    },
    { name: "bountyStates" },
    { name: "cooldownStates" },
    {
        name: "inventoryTransactions",
        columns: { userId: "userId", characterId: "characterId", transactionId: "transactionId" },
        indexes: [
            { name: "inventoryTransactions_user_character", columns: ["userId", "characterId"] },
            { name: "inventoryTransactions_user_transaction", columns: ["userId", "transactionId"] }
        ]
    },
    {
        name: "authIdentities",
        columns: { provider: "provider", providerSubject: "providerSubject", userId: "userId" },
        indexes: [
            { name: "authIdentities_provider_subject", columns: ["provider", "providerSubject"], unique: true },
            { name: "authIdentities_userId", columns: ["userId"] }
        ]
    },
    {
        name: "refreshSessions",
        columns: { tokenHash: "tokenHash", familyId: "familyId", userId: "userId", ttlAt: "ttlAt" },
        indexes: [
            { name: "refreshSessions_tokenHash", columns: ["tokenHash"], unique: true },
            { name: "refreshSessions_familyId", columns: ["familyId"] },
            { name: "refreshSessions_userId", columns: ["userId"] },
            { name: "refreshSessions_ttlAt", columns: ["ttlAt"] }
        ]
    },
    {
        name: "gameExchangeCodes",
        columns: { userId: "userId", ttlAt: "ttlAt" },
        indexes: [
            { name: "gameExchangeCodes_userId", columns: ["userId"] },
            { name: "gameExchangeCodes_ttlAt", columns: ["ttlAt"] }
        ]
    },
    {
        name: "discordOAuthTransactions",
        columns: { completionCodeHash: "completionCodeHash", userId: "userId", ttlAt: "ttlAt" },
        indexes: [
            { name: "discordOAuthTransactions_completionCodeHash", columns: ["completionCodeHash"] },
            { name: "discordOAuthTransactions_userId", columns: ["userId"] },
            { name: "discordOAuthTransactions_ttlAt", columns: ["ttlAt"] }
        ]
    },
    // [2026-10-15] The one-time email codes (one row per account and purpose). Added without a schema version change: EnsureTablesExist
    // creates it on existing databases, as guardFindings was added.
    {
        name: "emailCodes",
        columns: { userId: "userId", ttlAt: "ttlAt" },
        indexes: [
            { name: "emailCodes_userId", columns: ["userId"] },
            { name: "emailCodes_ttlAt", columns: ["ttlAt"] }
        ]
    },
    {
        name: "adminSessions",
        columns: { tokenHash: "tokenHash", userId: "userId", ttlAt: "ttlAt" },
        indexes: [
            { name: "adminSessions_tokenHash", columns: ["tokenHash"], unique: true },
            { name: "adminSessions_userId", columns: ["userId"] },
            { name: "adminSessions_ttlAt", columns: ["ttlAt"] }
        ]
    },
    {
        // [2026-10-14] economy rollups (persistence/contracts/EconomyRollupRepository.ts): ttlAt mirror, purged when past.
        name: "economyDaily",
        columns: { userId: "userId", ttlAt: "ttlAt" },
        indexes: [
            { name: "economyDaily_ttlAt", columns: ["ttlAt"] },
            { name: "economyDaily_userId", columns: ["userId"] }
        ]
    },
    {
        name: "adminAudit",
        columns: { targetUserId: "targetUserId", actorUserId: "actorUserId", createdAt: "createdAt" },
        indexes: [
            { name: "adminAudit_target_created", columns: ["targetUserId", "createdAt DESC"] },
            { name: "adminAudit_actor_created", columns: ["actorUserId", "createdAt DESC"] },
            { name: "adminAudit_created", columns: ["createdAt DESC"] }
        ]
    },
    {
        name: "friendships",
        columns: { ownerId: "ownerId", otherId: "otherId" },
        indexes: [
            { name: "friendships_ownerId", columns: ["ownerId"] },
            { name: "friendships_otherId", columns: ["otherId"] }
        ]
    },
    {
        name: "launcherGuardSessions",
        columns: { accountId: "accountId", role: "role", status: "status", expiresAt: "expiresAt", createdAt: "createdAt" },
        indexes: [
            { name: "launcherGuardSessions_account_status", columns: ["accountId", "status", "expiresAt DESC"] },
            { name: "launcherGuardSessions_account_role_status", columns: ["accountId", "role", "status", "expiresAt DESC"] }
        ]
    },
    // [2026-10-14] Module findings from the Guard heartbeats. Added without a schema version change: ApplySchema creates it on
    // existing databases through its idempotent path (see EnsureTablesExist).
    { name: "guardFindings" },
    // [2026-10-14] Activity monitor (src/activity): counters per account and UTC day, hunt participation, unlock history and flags.
    // ttlAt is the storage-only mirror both providers purge on (400 days). Added without a schema version change, as guardFindings.
    {
        name: "playerActivityDaily",
        columns: { userId: "userId", day: "day", ttlAt: "ttlAt" },
        indexes: [
            { name: "playerActivityDaily_userId_day", columns: ["userId", "day"], unique: true },
            { name: "playerActivityDaily_day", columns: ["day"] },
            { name: "playerActivityDaily_ttlAt", columns: ["ttlAt"] }
        ]
    },
    {
        name: "activityHunts",
        columns: { userId: "userId", kind: "kind", startedAt: "startedAt", endedAt: "endedAt", ttlAt: "ttlAt" },
        indexes: [
            { name: "activityHunts_userId_kind_started", columns: ["userId", "kind", "startedAt"] },
            { name: "activityHunts_userId_started", columns: ["userId", "startedAt DESC"] },
            { name: "activityHunts_ttlAt", columns: ["ttlAt"] }
        ]
    },
    {
        name: "slayersPathUnlocks",
        columns: { userId: "userId", unlockedAt: "unlockedAt", ttlAt: "ttlAt" },
        indexes: [
            { name: "slayersPathUnlocks_userId_unlockedAt", columns: ["userId", "unlockedAt DESC"] },
            { name: "slayersPathUnlocks_ttlAt", columns: ["ttlAt"] }
        ]
    },
    {
        name: "activityFlags",
        columns: { userId: "userId", status: "status", createdAt: "createdAt", ttlAt: "ttlAt" },
        indexes: [
            { name: "activityFlags_status_created", columns: ["status", "createdAt DESC"] },
            { name: "activityFlags_userId_created", columns: ["userId", "createdAt DESC"] },
            { name: "activityFlags_ttlAt", columns: ["ttlAt"] }
        ]
    },
    { name: "operationsPolicy" },
    // [2026-10-15] The launcher notices singleton (one row, _id "current"). Added without a schema version change: EnsureTablesExist
    // creates it on existing databases, as emailCodes was added.
    { name: "launcherNotices" },
    { name: "entitlements" },
    { name: "parties" },
    { name: "partyMemberships", columns: { partyId: "partyId" }, indexes: [{ name: "partyMemberships_partyId", columns: ["partyId"] }] },
    {
        name: "partyInvites",
        columns: { recipientPlayerId: "recipientPlayerId", status: "status", expiresAt: "expiresAt" },
        indexes: [{ name: "partyInvites_recipient_status", columns: ["recipientPlayerId", "status", "expiresAt"] }]
    },
    {
        name: "partyOutbox",
        columns: { state: "state", createdAt: "createdAt", partyId: "partyId", partyRevision: "partyRevision" },
        indexes: [
            { name: "partyOutbox_state_created", columns: ["state", "createdAt"] },
            { name: "partyOutbox_party_revision", columns: ["partyId", "partyRevision"] }
        ]
    }
];

function Quote(identifier: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier ${JSON.stringify(identifier)}`);
    return `"${identifier}"`;
}

export function CreateTableSql(table: TableSpec): string[] {
    const Generated = Object.entries(table.columns ?? {}).map(([Column, Field]) => {
        if (!/^[A-Za-z0-9_]+$/.test(Field)) throw new Error(`Unsafe JSON field ${JSON.stringify(Field)}`);
        // No declared type: a typed column would apply TEXT/NUMERIC affinity to the extracted value.
        return `, ${Quote(Column)} GENERATED ALWAYS AS (json_extract(doc, '$.${Field}')) VIRTUAL`;
    }).join("");
    const Statements = [
        `CREATE TABLE IF NOT EXISTS ${Quote(table.name)} (` +
        `_id TEXT PRIMARY KEY NOT NULL, doc TEXT NOT NULL CHECK (json_valid(doc))${Generated})`
    ];
    for (const Index of table.indexes ?? []) {
        const Columns = Index.columns.map((Column) => {
            const [Name, Direction] = Column.split(" ");
            return `${Quote(Name)}${Direction === "DESC" ? " DESC" : ""}`;
        }).join(", ");
        Statements.push(
            `CREATE ${Index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${Quote(Index.name)} ON ${Quote(table.name)} (${Columns})` +
            `${Index.where ? ` WHERE ${Index.where}` : ""}`
        );
    }
    return Statements;
}

export class SqliteSchemaVersionError extends Error {
    constructor(public readonly found: number) {
        super(`SQLITE_SCHEMA_VERSION_UNSUPPORTED: the database is at schema version ${found}, this build understands up to ${CURRENT_SQLITE_SCHEMA_VERSION}`);
        this.name = "SqliteSchemaVersionError";
    }
}

/** Reject a database written by a newer build, like AssertMongoSchemaVersionSupported. */
export function AssertSqliteSchemaVersionSupported(version: number): void {
    if (!Number.isSafeInteger(version) || version < 0 || version > CURRENT_SQLITE_SCHEMA_VERSION) {
        throw new SqliteSchemaVersionError(version);
    }
}

export function ReadSchemaVersion(c: Conn): number {
    return Number(c.get("PRAGMA user_version")?.user_version ?? 0);
}

/**
 * Apply the schema. Additive and idempotent (CREATE ... IF NOT EXISTS), so an interrupted start is simply retried: the
 * version marker (`PRAGMA user_version` plus the schemaMigrations ledger row) is written last, in the same transaction.
 * Returns true when the database was created or upgraded by this call.
 */
/**
 * [2026-10-14] Creates any table of TABLES that an existing database lacks (every statement is CREATE ... IF NOT EXISTS, so present
 * tables are untouched). It runs when the version is already current, so a table added without a version change still appears.
 */
function EnsureTablesExist(c: Conn): void {
    c.exec("BEGIN IMMEDIATE");
    try {
        for (const Table of TABLES) {
            for (const Statement of CreateTableSql(Table)) c.exec(Statement);
        }
        c.exec("COMMIT");
    } catch (error) {
        if (c.inTransaction) {
            try { c.exec("ROLLBACK"); } catch { /* the original error is the one that matters */ }
        }
        throw error;
    }
}

export function ApplySchema(c: Conn, now: string = new Date().toISOString()): boolean {
    const Current = ReadSchemaVersion(c);
    AssertSqliteSchemaVersionSupported(Current);
    if (Current === CURRENT_SQLITE_SCHEMA_VERSION) {
        EnsureTablesExist(c);
        return false;
    }

    c.exec("BEGIN IMMEDIATE");
    try {
        c.exec("CREATE TABLE IF NOT EXISTS schemaMigrations (version INTEGER PRIMARY KEY NOT NULL, id TEXT NOT NULL, appliedAt TEXT NOT NULL)");
        for (const Table of TABLES) {
            for (const Statement of CreateTableSql(Table)) c.exec(Statement);
        }
        // Existing operator policy is never overwritten (same as EnsureMongoIndexes).
        c.run(
            "INSERT OR IGNORE INTO operationsPolicy (_id, doc) VALUES ('global', ?)",
            JSON.stringify({ guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION", version: 0 })
        );
        c.run(
            "INSERT OR REPLACE INTO schemaMigrations (version, id, appliedAt) VALUES (?, ?, ?)",
            CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_SCHEMA_MIGRATION_ID, now
        );
        c.exec(`PRAGMA user_version = ${CURRENT_SQLITE_SCHEMA_VERSION}`);
        c.exec("COMMIT");
    } catch (error) {
        if (c.inTransaction) {
            try { c.exec("ROLLBACK"); } catch { /* the original error is the one that matters */ }
        }
        throw error;
    }
    return true;
}
