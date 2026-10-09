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

/**
 * Monotonically increasing identifier for the schema contract that the current startup
 * migration set establishes. This is deliberately separate from the application version:
 * a binary can be rolled back while the database keeps its additive schema.
 */
export const CURRENT_MONGO_SCHEMA_VERSION = 1;
export const MONGO_SCHEMA_MIGRATION_ID = "central-guard-schema-v1";

export interface MongoSchemaMigrationRecord {
    _id: string;
    version: number;
    status: "APPLIED";
    appliedAt: Date;
}

/**
 * Create the metadata index without depending on a marker already existing. Index creation
 * is idempotent and is safe to repeat after a process crash.
 */
export async function EnsureMongoSchemaMigrationIndex(db: Db): Promise<void> {
    await db.collection(Collections.SchemaMigrations).createIndex({ version: 1 }, { unique: true });
}

/**
 * Record a completed migration with an upsert. A second API/worker process can race this
 * write during a rolling start; duplicate-key from the unique version index means another
 * process already recorded the same successful migration and is therefore safe to ignore.
 */
export async function RecordMongoSchemaMigration(
    db: Db,
    migration: Pick<MongoSchemaMigrationRecord, "_id" | "version"> = {
        _id: MONGO_SCHEMA_MIGRATION_ID,
        version: CURRENT_MONGO_SCHEMA_VERSION
    }
): Promise<void> {
    const Collection = db.collection(Collections.SchemaMigrations);
    const Existing = await Collection.findOne(
        { _id: migration._id as any },
        { projection: { version: 1 } }
    ) as { version?: unknown } | null;

    // A marker from an older additive migration must be advanced after the complete
    // current startup sequence succeeds. Use the observed version as a compare-and-set
    // fence so two API/worker processes cannot overwrite one another's progress.
    if (Existing?.version !== undefined) {
        AssertMongoSchemaVersionSupported(Existing.version, true);
        if (Existing.version === migration.version) return;

        const Updated = await Collection.updateOne(
            { _id: migration._id as any, version: Existing.version as any },
            { $set: { version: migration.version, status: "APPLIED", appliedAt: new Date() } }
        );
        if ((Updated as any).matchedCount === 1 || (Updated as any).modifiedCount === 1) return;

        // Another process may have won the compare-and-set. Re-read and accept only
        // the exact requested version; anything else is an explicit migration conflict.
        const AfterRace = await Collection.findOne(
            { _id: migration._id as any },
            { projection: { version: 1 } }
        ) as { version?: unknown } | null;
        if (AfterRace?.version === migration.version) return;
        throw new Error("MONGODB_SCHEMA_MIGRATION_CONFLICT");
    }
    if (Existing !== null) {
        throw new Error("MONGODB_SCHEMA_VERSION_UNSUPPORTED");
    }

    try {
        await Collection.updateOne(
            { _id: migration._id as any },
            {
                $setOnInsert: {
                    version: migration.version,
                    status: "APPLIED",
                    appliedAt: new Date()
                }
            },
            { upsert: true }
        );
    } catch (error: any) {
        if (error?.code !== 11000) throw error;
    }
}

/**
 * Reject a database that advertises a newer schema than this binary understands. Older
 * markers are compatible with the additive migration model and may be upgraded by the
 * caller's current startup sequence.
 */
export function AssertMongoSchemaVersionSupported(version: unknown, markerPresent = false): void {
    if (version === undefined || version === null) {
        if (markerPresent) throw new Error("MONGODB_SCHEMA_VERSION_UNSUPPORTED");
        return;
    }
    if (!Number.isSafeInteger(version) || (version as number) > CURRENT_MONGO_SCHEMA_VERSION) {
        throw new Error("MONGODB_SCHEMA_VERSION_UNSUPPORTED");
    }
}
