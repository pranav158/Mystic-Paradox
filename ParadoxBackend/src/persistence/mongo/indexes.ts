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

import { Db } from "mongodb";
import { Collections } from "./collections";
import { MongoWalletRepository } from "./repositories/MongoWalletRepository";
import { GetP2PExtension } from "../../extensions/p2p";
import { DAY_MS, GUARD_SESSION_RETENTION_DAYS } from "../../legal/retentionPolicy";
import {
    AssertMongoSchemaVersionSupported,
    CURRENT_MONGO_SCHEMA_VERSION,
    EnsureMongoSchemaMigrationIndex,
    MONGO_SCHEMA_MIGRATION_ID,
    RecordMongoSchemaMigration
} from "./schemaMigrations";

// Index plan for the WP-MONGO-1 scope, mirroring Mongo migration plan section 9's
// table for the entities this phase actually migrates. Progression-collection
// indexes (progressionTracks, progressionClaims, etc.) are deferred to Phase M10.
//
// `_id` indexes are automatic (every collection already has one); this only
// creates the SECONDARY indexes the plan calls for. Called once at startup
// (plan section M4 exit criterion: "implement versioned index migrations"),
// not ad hoc from controllers.
export async function EnsureMongoIndexes(Db: Db): Promise<void> {
    // The ledger is created before any data/index work. The completion marker is written at
    // the very end below, so a crash or failed index build leaves startup retryable instead of
    // claiming that a partial migration completed.
    await EnsureMongoSchemaMigrationIndex(Db);
    const ExistingMigration = await Db.collection(Collections.SchemaMigrations).findOne(
        { _id: MONGO_SCHEMA_MIGRATION_ID as any },
        { projection: { version: 1 } }
    ) as { version?: unknown } | null;
    AssertMongoSchemaVersionSupported(ExistingMigration?.version, ExistingMigration !== null);

    // Existing operator Guard/diagnostics policy is never overwritten.
    await Db.collection(Collections.OperationsPolicy).updateOne(
        { _id: "global" as any },
        { $setOnInsert: {
            guardEnforcement: "ENFORCE",
            diagnosticsProfile: "PRODUCTION",
            version: 0
        } },
        { upsert: true }
    );

    await Db.collection(Collections.Characters).createIndex({ userId: 1 });
    await Db.collection(Collections.Inventories).createIndex({ userId: 1 });
    await Db.collection(Collections.Loadouts).createIndex({ userId: 1 });
    await Db.collection(Collections.Breadcrumbs).createIndex({ userId: 1 });
    await Db.collection(Collections.EncounteredContent).createIndex({ userId: 1 });

    // Direct hash lookup for API keys. The repository still performs the same
    // full-scan + timingSafeEqual comparison as the SQLite adapter (matching
    // plan section 6.10's "this optimization must retain the same accepted
    // credentials" — the index here only speeds up findAll*, it doesn't change
    // the lookup's semantics). A non-unique index (not the unique index the
    // final plan section 9 table specifies) is used deliberately for this phase:
    // the SQLite table has no uniqueness constraint on keyHash today, and
    // WP-MONGO-1 is a behavior-preserving migration, not a data-integrity
    // upgrade. Tightening to unique is follow-up work once duplicates (if any)
    // are audited.
    await Db.collection(Collections.GameServerApiKeys).createIndex({ keyHash: 1 });
    await Db.collection(Collections.UserApiKeys).createIndex({ keyHash: 1 });

    // WP-1 progression collections (Plans/PROGRESSION_XP_COMBAT_DATA_IMPLEMENTATION_PLAN.md
    // section 5.1/16). _id is already the unique {userId, progressionId} composite string
    // (see MongoProgressionTrackRepository), so this secondary index exists purely to make
    // getAllForUser(userId) an index-scan instead of a full collection scan.
    await Db.collection(Collections.ProgressionTracks).createIndex({ userId: 1 });
    // Backfill the server-owned Player Journey CAS token for rows created before revisioned
    // writes existed. This is idempotent and leaves the client-facing updateVersion untouched.
    await Db.collection(Collections.PlayerJourney).updateMany(
        { revision: { $exists: false } },
        { $set: { revision: 0 } }
    );
    // The grant id is the authoritative exactly-once key and is also the document _id. The
    // secondary account/time index supports audit and retention jobs without changing replay
    // semantics.
    await Db.collection(Collections.ProgressionTransactions).createIndex({ userId: 1, createdAt: -1 });

    // Resolved mastery/objective state — same "_id already unique, secondary index for
    // getAllObjectivesForUser scans" reasoning as ProgressionTracks above.
    await Db.collection(Collections.ProgressionObjectives).createIndex({ userId: 1 });

    // Raw event log is append-only and always queried by userId (for future reducer work that
    // replays a user's event history) — no uniqueness constraint, this is intentionally a log.
    await Db.collection(Collections.ProgressionObjectiveEvents).createIndex({ userId: 1, receivedAt: 1 });

    // Durable per-account/per-season Escalation progress. The composite string _id is already
    // unique; this secondary index supports account audits and future admin views.
    await Db.collection(Collections.EscalationProgress).createIndex({ userId: 1, seasonId: 1 });

    // --- Launcher auth (Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md) ---
    //
    // email/displayNameNormalized live on the SAME `accounts` collection dev/API-key
    // accounts already use (MongoLauncherAccountRepository's header comment explains
    // why). Existing accounts have neither field, so these MUST be partial indexes
    // scoped to documents that actually have the field — a plain unique index would
    // treat every account missing the field as colliding on the same "missing" value
    // and refuse to let a second dev account be created.
    await Db.collection(Collections.Accounts).createIndex(
        { email: 1 },
        { unique: true, partialFilterExpression: { email: { $type: "string" } } }
    );
    await Db.collection(Collections.Accounts).createIndex(
        { displayNameNormalized: 1 },
        { unique: true, partialFilterExpression: { displayNameNormalized: { $type: "string" } } }
    );
    // [2026-10-15] The registration sweep (controllers/launcherEmail.ts) finds the unverified registrations pending since a time. Partial,
    // like the two indexes above: existing accounts have no such field and are not indexed.
    await Db.collection(Collections.Accounts).createIndex(
        { emailVerificationPendingSince: 1 },
        { partialFilterExpression: { emailVerificationPendingSince: { $type: "string" } } }
    );

    await Db.collection(Collections.AuthIdentities).createIndex({ provider: 1, providerSubject: 1 }, { unique: true });
    await Db.collection(Collections.AuthIdentities).createIndex({ userId: 1 });

    await Db.collection(Collections.RefreshSessions).createIndex({ tokenHash: 1 }, { unique: true });
    await Db.collection(Collections.RefreshSessions).createIndex({ familyId: 1 });
    await Db.collection(Collections.RefreshSessions).createIndex({ userId: 1 });

    await Db.collection(Collections.GameExchangeCodes).createIndex({ userId: 1 });
    await Db.collection(Collections.AdminSessions).createIndex({ tokenHash: 1 }, { unique: true });
    await Db.collection(Collections.AdminSessions).createIndex({ userId: 1 });
    await Db.collection(Collections.AdminSessions).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.AdminAudit).createIndex({ targetUserId: 1, createdAt: -1 });
    await Db.collection(Collections.AdminAudit).createIndex({ actorUserId: 1, createdAt: -1 });

    await Db.collection(Collections.DiscordOAuthTransactions).createIndex({ completionCodeHash: 1 });
    await Db.collection(Collections.DiscordOAuthTransactions).createIndex({ userId: 1 });
    await Db.collection(Collections.InventoryTransactions).createIndex({ userId: 1, characterId: 1 });
    // Daily store claims (controllers/store.ts FindClaimInInventoryLedger) look one row up by (userId, transactionId) on
    // every Ramsgate arrival; without this the lookup reads the player's whole ledger.
    await Db.collection(Collections.InventoryTransactions).createIndex({ userId: 1, transactionId: 1 });
    await Db.collection(Collections.Friendships).createIndex({ ownerId: 1 });
    await Db.collection(Collections.Friendships).createIndex({ otherId: 1 });

    await Db.collection(Collections.LauncherGuardSessions).createIndex({ accountId: 1, status: 1, expiresAt: -1 });
    // Role is part of the authorization predicate: a healthy client session must never
    // satisfy a host-process check (or vice versa). Keep the older index for rolling
    // compatibility while the role-aware index is built on existing deployments.
    await Db.collection(Collections.LauncherGuardSessions).createIndex({ accountId: 1, role: 1, status: 1, expiresAt: -1 });

    await Db.collection(Collections.Parties).createIndex({ members: 1 });
    await Db.collection(Collections.PartyMemberships).createIndex({ partyId: 1 });
    await Db.collection(Collections.PartyInvites).createIndex({ recipientPlayerId: 1, status: 1, expiresAt: 1 });
    await Db.collection(Collections.PartyOutbox).createIndex({ state: 1, createdAt: 1 });
    await Db.collection(Collections.PartyOutbox).createIndex({ partyId: 1, partyRevision: 1 });

    // TTL cleanup for the three short-lived launcher-auth collections. Every business-logic
    // expiry check above compares the ISO-string expiresAt/completionExpiresAt fields directly
    // (Mongo TTL only deletes in the background on its own schedule, it must never be the thing
    // that makes an expired code stop working) — `ttlAt` is a storage-only BSON Date mirror each
    // repository's create()/attachCompletionCode() keeps in sync, purely so dead rows don't
    // accumulate forever.
    await Db.collection(Collections.RefreshSessions).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.GameExchangeCodes).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.DiscordOAuthTransactions).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    // [2026-10-15] One-time email codes: found by account (the erasure and the registration sweep delete them) and purged past their expiry.
    await Db.collection(Collections.EmailCodes).createIndex({ userId: 1 });
    await Db.collection(Collections.EmailCodes).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });

    // [2026-10-14] Daily economy rollups (diagnostics/economyLedgerMonitor.ts): kept about 400 days, then purged by TTL.
    await Db.collection(Collections.EconomyDaily).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.EconomyDaily).createIndex({ userId: 1, day: -1 });

    // [2026-10-14] Activity monitor (src/activity): counters per account and day, hunt rows, unlock history and flags. Kept about
    // 400 days, then purged by TTL (ttlAt, set by MongoActivityRepository and by the monitor).
    await Db.collection(Collections.PlayerActivityDaily).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.PlayerActivityDaily).createIndex({ day: 1 });
    await Db.collection(Collections.ActivityHunts).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.ActivityHunts).createIndex({ userId: 1, kind: 1, startedAt: -1 });
    await Db.collection(Collections.ActivityHunts).createIndex({ userId: 1, startedAt: -1 });
    await Db.collection(Collections.SlayersPathUnlocks).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.SlayersPathUnlocks).createIndex({ userId: 1, unlockedAt: -1 });
    await Db.collection(Collections.ActivityFlags).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(Collections.ActivityFlags).createIndex({ status: 1, createdAt: -1 });
    await Db.collection(Collections.ActivityFlags).createIndex({ userId: 1, createdAt: -1 });
    // [2026-10-14] The admin player timeline reads an account's recent ledger rows (no index existed for that read).
    await Db.collection(Collections.InventoryTransactions).createIndex({ userId: 1, createdAt: -1 });
    await Db.collection(Collections.ProgressionTransactions).createIndex({ userId: 1, createdAt: -1 });

    // [2026-10-14] Privacy Policy section 5: launcher Guard sessions are kept 90 days after their last update. ttlAt is the BSON
    // date of that (set by MongoLauncherGuardRepository on create, heartbeat and revoke). Rows written before it existed take
    // the last heartbeat (or creation) time, once, so they age out with the rest.
    await Db.collection(Collections.LauncherGuardSessions).updateMany(
        { ttlAt: { $exists: false } },
        [{ $set: { ttlAt: { $add: [{ $toDate: { $ifNull: ["$lastHeartbeatAt", "$createdAt"] } }, GUARD_SESSION_RETENTION_DAYS * DAY_MS] } } }]
    );
    await Db.collection(Collections.LauncherGuardSessions).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    // [2026-10-14] Admin listings (newest sessions first; findings most seen first). A finding is one module file (name + hash), kept
    // 90 days after it was last seen (ttlAt, retentionPolicy.ts).
    await Db.collection(Collections.LauncherGuardSessions).createIndex({ createdAt: -1 });
    await Db.collection(Collections.GuardFindings).createIndex({ fileName: 1, sha256: 1 }, { unique: true });
    await Db.collection(Collections.GuardFindings).createIndex({ sessionCount: -1, lastSeenAt: -1 });
    await Db.collection(Collections.GuardFindings).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });

    // [hardening] One-time, idempotent migration: wallets created before the wallet-hardening
    // pass stored `balances` as a JSON-string blob. Sweep and convert any remaining legacy rows
    // to a real BSON number subdocument in place, BEFORE the app accepts traffic — so every
    // request from process start onward sees the new shape and AddCurrency's atomic $inc always
    // has real number fields to increment. Delegates to MongoWalletRepository so the conversion
    // logic lives in one place (repositories own persistence details, not this startup module).
    const LegacyStringWalletIds = await Db.collection(Collections.Wallets)
        .find({ balances: { $type: "string" } })
        .project({ _id: 1 })
        .toArray();
    if (LegacyStringWalletIds.length > 0) {
        const WalletRepo = new MongoWalletRepository();
        for (const Row of LegacyStringWalletIds) {
            await WalletRepo.migrateLegacyStringBalances(String(Row._id));
        }
    }

    // [launcher hardening] One-time, idempotent backfill: launcher accounts created
    // before MongoLauncherAccountRepository.create() started seeding name/notes have
    // neither field, which makes the game show their raw userId (a UUID) as the
    // player's in-game name. Every launcher account has displayNameNormalized set
    // (game/dev accounts never do — see the partial-index comment above), so that's
    // the safe selector; only touches rows genuinely missing `name`, never overwrites
    // a value already there.
    await Db.collection(Collections.Accounts).updateMany(
        { displayNameNormalized: { $exists: true }, name: { $exists: false } },
        [{ $set: { name: "$displayName", notes: 0 } }]
    );

    // Collections and indexes of the optional P2P module (none in a dedicated-only build).
    await GetP2PExtension().server.ensureDatabase(Db);

    // This marker is intentionally last: all indexes, policy bootstrap and idempotent data
    // backfills above must succeed before the database advertises the current schema version.
    await RecordMongoSchemaMigration(Db, {
        _id: MONGO_SCHEMA_MIGRATION_ID,
        version: CURRENT_MONGO_SCHEMA_VERSION
    });
}
