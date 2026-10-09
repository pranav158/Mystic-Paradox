/*
 * Repairs legacy persistent.banner values that contain a BN_* catalog ID instead of the owned
 * non-stackable banner's inventory instance ID.
 *
 * Dry-run is the default. Applying requires both --apply and the exact confirmation token.
 */

import { GetPersistenceLifecycle } from "../src/persistence";
import { GetMongoDb } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";
import {
    BANNER_INSTANCE_MIGRATION_VERSION,
    BannerInstanceMigrationStatus,
    PlanBannerInstanceMigration
} from "../src/bannerInstanceMigration";
import { BOOTSTRAP_VERSION } from "../src/controllers/starterManifest";

const APPLY_CONFIRMATION = "APPLY_BANNER_INSTANCE_ID_MIGRATION";

function GetArg(Name: string): string | undefined {
    const Prefix = `--${Name}=`;
    return process.argv.find((Arg) => Arg.startsWith(Prefix))?.slice(Prefix.length);
}

const Apply = process.argv.includes("--apply");
const Confirm = GetArg("confirm");
const UserId = GetArg("user-id");
const CharacterId = GetArg("character-id");

if (Apply && Confirm !== APPLY_CONFIRMATION) {
    throw new Error(`Refusing write: --apply requires --confirm=${APPLY_CONFIRMATION}`);
}

interface MigrationRecord {
    userId: string | null;
    characterId: string;
    status: BannerInstanceMigrationStatus | "parse-error" | "revision-conflict" | "updated";
    from?: string | null;
    to?: string;
    detail?: string;
    expectedRevision?: number;
    newRevision?: number;
}

async function Main(): Promise<void> {
    const Lifecycle = GetPersistenceLifecycle();
    const Records: MigrationRecord[] = [];
    const Summary = {
        mode: Apply ? "apply" : "dry-run",
        recordsScanned: 0,
        recordsNeedingMigration: 0,
        recordsUpdated: 0,
        alreadyValid: 0,
        noBanner: 0,
        manualReview: 0,
        parseErrors: 0,
        revisionConflicts: 0
    };

    try {
        // Do not call lifecycle.start(): startup index/backfill work would violate dry-run's
        // read-only contract. GetMongoDb + ping only establishes the connection.
        const Db = await GetMongoDb();
        await Db.command({ ping: 1 });

        const Query: Record<string, unknown> = {};
        if (UserId) Query.userId = UserId;
        if (CharacterId) Query._id = CharacterId;

        const Cursor = Db.collection(Collections.Loadouts).find(Query, {
            projection: {
                _id: 1,
                characterId: 1,
                userId: 1,
                persistent: 1,
                revision: 1
            }
        });

        for await (const Loadout of Cursor) {
            Summary.recordsScanned++;
            const CurrentCharacterId = String(Loadout.characterId ?? Loadout._id);
            const CurrentUserId = typeof Loadout.userId === "string" ? Loadout.userId : null;
            const Inventory = await Db.collection(Collections.Inventories).findOne(
                { _id: Loadout._id },
                { projection: { userId: 1, instancedItems: 1 } }
            );

            let Persistent: unknown;
            let InstancedItems: unknown;
            try {
                if (typeof Loadout.persistent !== "string") throw new Error("loadout.persistent is not a JSON string");
                if (!Inventory || typeof Inventory.instancedItems !== "string") {
                    throw new Error("matching inventory document or instancedItems JSON string is missing");
                }
                if (CurrentUserId && typeof Inventory.userId === "string" && Inventory.userId !== CurrentUserId) {
                    throw new Error("loadout and inventory userId values do not match");
                }
                Persistent = JSON.parse(Loadout.persistent);
                InstancedItems = JSON.parse(Inventory.instancedItems);
            } catch (Err) {
                Summary.parseErrors++;
                Records.push({
                    userId: CurrentUserId,
                    characterId: CurrentCharacterId,
                    status: "parse-error",
                    detail: Err instanceof Error ? Err.message : String(Err)
                });
                continue;
            }

            const Plan = PlanBannerInstanceMigration(InstancedItems, Persistent);
            if (Plan.status === "already-valid") {
                Summary.alreadyValid++;
                continue;
            }
            if (Plan.status === "no-banner") {
                Summary.noBanner++;
                continue;
            }
            if (Plan.status !== "migrate" || !Plan.persistent || !Plan.targetBanner) {
                Summary.manualReview++;
                Records.push({
                    userId: CurrentUserId,
                    characterId: CurrentCharacterId,
                    status: Plan.status,
                    from: Plan.currentBanner,
                    detail: Plan.detail
                });
                continue;
            }

            Summary.recordsNeedingMigration++;
            const ExpectedRevision = Number(Loadout.revision ?? 0);
            const Record: MigrationRecord = {
                userId: CurrentUserId,
                characterId: CurrentCharacterId,
                status: "migrate",
                from: Plan.currentBanner,
                to: Plan.targetBanner,
                expectedRevision: ExpectedRevision
            };

            if (Apply) {
                const Filter: Record<string, unknown> = {
                    _id: Loadout._id,
                    persistent: Loadout.persistent
                };
                if (CurrentUserId) Filter.userId = CurrentUserId;
                Filter.revision = Loadout.revision == null
                    ? { $exists: false }
                    : Loadout.revision;

                const Result = await Db.collection(Collections.Loadouts).updateOne(
                    Filter,
                    {
                        $set: {
                            persistent: JSON.stringify(Plan.persistent),
                            bootstrapVersion: BOOTSTRAP_VERSION,
                            bannerInstanceMigrationVersion: BANNER_INSTANCE_MIGRATION_VERSION,
                            revision: ExpectedRevision + 1
                        }
                    }
                );

                if (Result.modifiedCount !== 1) {
                    Record.status = "revision-conflict";
                    Summary.revisionConflicts++;
                } else {
                    Record.status = "updated";
                    Record.newRevision = ExpectedRevision + 1;
                    Summary.recordsUpdated++;
                }
            }

            Records.push(Record);
        }

        console.log(JSON.stringify({
            version: BANNER_INSTANCE_MIGRATION_VERSION,
            filters: { userId: UserId ?? null, characterId: CharacterId ?? null },
            summary: Summary,
            records: Records
        }, null, 2));
    } finally {
        await Lifecycle.stop();
    }
}

Main().catch((Err) => {
    console.error(Err);
    process.exitCode = 1;
});
