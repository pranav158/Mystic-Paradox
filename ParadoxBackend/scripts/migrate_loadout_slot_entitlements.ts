/*
 * Reconciles loadout contents/entitlement with persisted Slayer's Path LoadoutSlot_01..05 nodes.
 *
 * Dry-run is the default. Applying requires both --apply and the exact confirmation token.
 * Existing slot contents are never deleted; missing slots clone slot zero with fresh slot metadata.
 */

import { GetPersistenceLifecycle } from "../src/persistence";
import { GetMongoDb } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";
import {
    ResolvePlayerJourneyTotalLoadoutSlots,
    ResolveVisibleTotalLoadoutSlots
} from "../src/loadoutSlots";

const MIGRATION_VERSION = "slayers-path-loadout-slots-v2";
const APPLY_CONFIRMATION = "APPLY_LOADOUT_SLOT_ENTITLEMENT_MIGRATION";

function GetArg(Name: string): string | undefined {
    const Prefix = `--${Name}=`;
    return process.argv.find((Arg) => Arg.startsWith(Prefix))?.slice(Prefix.length);
}

function CloneLoadoutForSlot(Source: any, SlotIndex: number): any {
    const Clone = JSON.parse(JSON.stringify(Source));
    Clone.slot_index = SlotIndex;
    Clone.update_version = 0;
    Clone.custom_name = "";
    return Clone;
}

const Apply = process.argv.includes("--apply");
const Confirm = GetArg("confirm");
const UserId = GetArg("user-id");
const CharacterId = GetArg("character-id");

if (Apply && Confirm !== APPLY_CONFIRMATION) {
    throw new Error(`Refusing write: --apply requires --confirm=${APPLY_CONFIRMATION}`);
}

async function Main(): Promise<void> {
    const Lifecycle = GetPersistenceLifecycle();
    const Records: Array<Record<string, unknown>> = [];
    const Summary = {
        mode: Apply ? "apply" : "dry-run",
        recordsScanned: 0,
        recordsNeedingMigration: 0,
        recordsUpdated: 0,
        alreadyCorrect: 0,
        missingJourney: 0,
        parseErrors: 0,
        revisionConflicts: 0
    };

    try {
        // Keep dry-run read-only: do not invoke lifecycle.start() and its index/backfill work.
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
                loadouts: 1,
                unlockedTotalSlots: 1,
                revision: 1
            }
        });

        for await (const Loadout of Cursor) {
            Summary.recordsScanned++;
            const CurrentUserId = typeof Loadout.userId === "string" ? Loadout.userId : "";
            const CurrentCharacterId = String(Loadout.characterId ?? Loadout._id);
            const Journey = CurrentUserId.length > 0
                ? await Db.collection(Collections.PlayerJourney).findOne(
                    { _id: CurrentUserId as any },
                    { projection: { nodes: 1 } }
                )
                : null;

            if (!Journey || typeof Journey.nodes !== "string") {
                Summary.missingJourney++;
                Records.push({
                    userId: CurrentUserId || null,
                    characterId: CurrentCharacterId,
                    status: "missing-journey"
                });
                continue;
            }

            let StoredLoadouts: any[];
            let Nodes: unknown;
            try {
                StoredLoadouts = JSON.parse(Loadout.loadouts);
                Nodes = JSON.parse(Journey.nodes);
                if (!Array.isArray(StoredLoadouts) || StoredLoadouts.length === 0) {
                    throw new Error("loadouts is not a non-empty JSON array");
                }
            } catch (Err) {
                Summary.parseErrors++;
                Records.push({
                    userId: CurrentUserId || null,
                    characterId: CurrentCharacterId,
                    status: "parse-error",
                    detail: Err instanceof Error ? Err.message : String(Err)
                });
                continue;
            }

            let CurrentVisible: number;
            try {
                CurrentVisible = ResolveVisibleTotalLoadoutSlots(
                    StoredLoadouts.length, Loadout.unlockedTotalSlots);
            } catch (Err) {
                Summary.parseErrors++;
                Records.push({
                    userId: CurrentUserId,
                    characterId: CurrentCharacterId,
                    status: "invalid-entitlement",
                    detail: Err instanceof Error ? Err.message : String(Err)
                });
                continue;
            }

            const JourneyTotal = ResolvePlayerJourneyTotalLoadoutSlots(Nodes);
            // Never relock a legitimately higher existing entitlement. Reconciliation only exposes
            // newly proven slots or normalizes a legacy missing entitlement field.
            const TargetTotal = Math.max(CurrentVisible, JourneyTotal);
            const Extended = [...StoredLoadouts];
            while (Extended.length < TargetTotal) {
                Extended.push(CloneLoadoutForSlot(StoredLoadouts[0], Extended.length));
            }

            const NeedsMigration = Loadout.unlockedTotalSlots !== TargetTotal
                || Extended.length !== StoredLoadouts.length;
            if (!NeedsMigration) {
                Summary.alreadyCorrect++;
                continue;
            }

            Summary.recordsNeedingMigration++;
            const ExpectedRevision = Number(Loadout.revision ?? 0);
            const Record: Record<string, unknown> = {
                userId: CurrentUserId,
                characterId: CurrentCharacterId,
                status: "migrate",
                storedSlotsBefore: StoredLoadouts.length,
                visibleSlotsBefore: CurrentVisible,
                journeyTotal: JourneyTotal,
                targetTotal: TargetTotal,
                expectedRevision: ExpectedRevision
            };

            if (Apply) {
                const RevisionFilter = Loadout.revision === undefined
                    ? { revision: { $exists: false } }
                    : { revision: Loadout.revision };
                const EntitlementFilter = Loadout.unlockedTotalSlots === undefined
                    ? { unlockedTotalSlots: { $exists: false } }
                    : { unlockedTotalSlots: Loadout.unlockedTotalSlots };
                const Result = await Db.collection(Collections.Loadouts).updateOne(
                    {
                        _id: Loadout._id,
                        userId: CurrentUserId,
                        loadouts: Loadout.loadouts,
                        ...RevisionFilter,
                        ...EntitlementFilter
                    },
                    {
                        $set: {
                            loadouts: JSON.stringify(Extended),
                            unlockedTotalSlots: TargetTotal,
                            loadoutSlotMigrationVersion: MIGRATION_VERSION,
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
            version: MIGRATION_VERSION,
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
