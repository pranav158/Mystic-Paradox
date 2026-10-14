/*
 * [2026-10-14] Repairs starter references stored as catalog ids where the game resolves an owned inventory instance id:
 * each loadout slot's `flask` (FL_*) and `persistent.glider` (GD_*) - src/starterInstanceMigration.ts. Affected slayers had
 * no flask in a hunt (no heals, no revives) and no glider.
 *
 * Dry-run is the default. Applying requires both --apply and the exact confirmation token; --user-id= / --character-id=
 * narrow the run. Same shape as migrate_banner_instance_ids.ts: a row is written only if its loadouts, persistent and
 * revision are unchanged since the read. A signed-in player keeps the old rows until the next sign-in.
 */

import { GetPersistenceLifecycle } from "../src/persistence";
import { GetMongoDb } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";
import {
    STARTER_INSTANCE_MIGRATION_VERSION,
    StarterReferenceChange,
    StarterReferenceStatus,
    PlanFlaskInstanceMigration,
    PlanGliderInstanceMigration
} from "../src/starterInstanceMigration";

const APPLY_CONFIRMATION = "APPLY_STARTER_INSTANCE_REF_MIGRATION";

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
    status: "migrate" | "manual-review" | "parse-error" | "revision-conflict" | "updated";
    flask?: StarterReferenceStatus;
    glider?: StarterReferenceStatus;
    changes?: StarterReferenceChange[];
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
        flaskRepairs: 0,
        gliderRepairs: 0,
        alreadyValid: 0,
        manualReview: 0,
        parseErrors: 0,
        revisionConflicts: 0
    };

    try {
        // No lifecycle.start(): startup index/backfill work would break the dry-run's read-only contract.
        const Db = await GetMongoDb();
        await Db.command({ ping: 1 });

        const Query: Record<string, unknown> = {};
        if (UserId) Query.userId = UserId;
        if (CharacterId) Query._id = CharacterId;

        const Cursor = Db.collection(Collections.Loadouts).find(Query, {
            projection: { _id: 1, characterId: 1, userId: 1, loadouts: 1, persistent: 1, revision: 1 }
        });

        for await (const Loadout of Cursor) {
            Summary.recordsScanned++;
            const CurrentCharacterId = String(Loadout.characterId ?? Loadout._id);
            const CurrentUserId = typeof Loadout.userId === "string" ? Loadout.userId : null;
            const Inventory = await Db.collection(Collections.Inventories).findOne(
                { _id: Loadout._id },
                { projection: { userId: 1, instancedItems: 1 } }
            );

            let Slots: unknown;
            let Persistent: unknown;
            let InstancedItems: unknown;
            try {
                if (typeof Loadout.loadouts !== "string") throw new Error("loadout.loadouts is not a JSON string");
                if (typeof Loadout.persistent !== "string") throw new Error("loadout.persistent is not a JSON string");
                if (!Inventory || typeof Inventory.instancedItems !== "string") {
                    throw new Error("matching inventory document or instancedItems JSON string is missing");
                }
                if (CurrentUserId && typeof Inventory.userId === "string" && Inventory.userId !== CurrentUserId) {
                    throw new Error("loadout and inventory userId values do not match");
                }
                Slots = JSON.parse(Loadout.loadouts);
                Persistent = JSON.parse(Loadout.persistent);
                InstancedItems = JSON.parse(Inventory.instancedItems);
            } catch (Err) {
                Summary.parseErrors++;
                Records.push({ userId: CurrentUserId, characterId: CurrentCharacterId, status: "parse-error",
                    detail: Err instanceof Error ? Err.message : String(Err) });
                continue;
            }

            const Flask = PlanFlaskInstanceMigration(InstancedItems, Slots);
            const Glider = PlanGliderInstanceMigration(InstancedItems, Persistent);
            const Fine = (Status: StarterReferenceStatus) => Status === "already-valid" || Status === "absent" || Status === "migrate";
            if (!Fine(Flask.status) || !Fine(Glider.status)) {
                // A field needing review blocks the row; the other field waits for it rather than being written alone.
                Summary.manualReview++;
                Records.push({ userId: CurrentUserId, characterId: CurrentCharacterId, status: "manual-review",
                    flask: Flask.status, glider: Glider.status, detail: [Flask.detail, Glider.detail].filter(Boolean).join("; ") });
                continue;
            }
            if (Flask.status !== "migrate" && Glider.status !== "migrate") { Summary.alreadyValid++; continue; }

            Summary.recordsNeedingMigration++;
            if (Flask.status === "migrate") Summary.flaskRepairs++;
            if (Glider.status === "migrate") Summary.gliderRepairs++;
            const ExpectedRevision = Number(Loadout.revision ?? 0);
            const Record: MigrationRecord = {
                userId: CurrentUserId,
                characterId: CurrentCharacterId,
                status: "migrate",
                flask: Flask.status,
                glider: Glider.status,
                changes: [...(Flask.changes ?? []), ...(Glider.change ? [Glider.change] : [])],
                expectedRevision: ExpectedRevision
            };

            if (Apply) {
                const Filter: Record<string, unknown> = { _id: Loadout._id, loadouts: Loadout.loadouts, persistent: Loadout.persistent };
                if (CurrentUserId) Filter.userId = CurrentUserId;
                Filter.revision = Loadout.revision == null ? { $exists: false } : Loadout.revision;

                const Set: Record<string, unknown> = {
                    starterInstanceMigrationVersion: STARTER_INSTANCE_MIGRATION_VERSION,
                    revision: ExpectedRevision + 1
                };
                if (Flask.status === "migrate") Set.loadouts = JSON.stringify(Flask.loadouts);
                if (Glider.status === "migrate") Set.persistent = JSON.stringify(Glider.persistent);

                const Result = await Db.collection(Collections.Loadouts).updateOne(Filter, { $set: Set });
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
            version: STARTER_INSTANCE_MIGRATION_VERSION,
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
