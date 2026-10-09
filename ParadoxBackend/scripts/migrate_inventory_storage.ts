/*
 * Explicit inventory storage migration for Dauntless 1.12.
 * Dry-run is the default. Applying requires both --apply and the exact confirmation token.
 */

import fs from "node:fs";
import path from "node:path";
import { GetPersistenceLifecycle, GetRepositories } from "../src/persistence";
import { GetMongoDb } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";
import { MigrateInventoryStorageArrays, GetInventoryStoragePolicyMetadata } from "../src/inventoryStoragePolicy";

const APPLY_CONFIRMATION = "APPLY_INVENTORY_STORAGE_MIGRATION";

function GetArg(name: string): string | undefined {
    const Prefix = `--${name}=`;
    return process.argv.find((Arg) => Arg.startsWith(Prefix))?.slice(Prefix.length);
}

const Apply = process.argv.includes("--apply");
const Confirm = GetArg("confirm");
const UserId = GetArg("user-id");
const CharacterId = GetArg("character-id");
const ReportPath = GetArg("report");

if (Apply && Confirm !== APPLY_CONFIRMATION) {
    throw new Error(`Refusing write: --apply requires --confirm=${APPLY_CONFIRMATION}`);
}

async function Main(): Promise<void> {
const Lifecycle = GetPersistenceLifecycle();
const StartedAt = new Date().toISOString();
const Report: any = {
    schema: 1,
    mode: Apply ? "apply" : "dry-run",
    startedAt: StartedAt,
    policy: GetInventoryStoragePolicyMetadata(),
    filters: { userId: UserId ?? null, characterId: CharacterId ?? null },
    summary: {
        recordsScanned: 0,
        recordsNeedingMigration: 0,
        recordsUpdated: 0,
        revisionConflicts: 0,
        parseErrors: 0,
        changes: 0,
        manualReviewIssues: 0,
    },
    records: [] as any[],
};

try {
    // Connect directly instead of calling lifecycle.start(): startup runs index migrations, which
    // would violate the promise that a dry-run performs no database writes.
    const Db = await GetMongoDb();
    await Db.command({ ping: 1 });
    const Query: Record<string, unknown> = {};
    if (UserId) Query.userId = UserId;
    if (CharacterId) Query._id = CharacterId;

    const Cursor = Db.collection(Collections.Inventories).find(Query, {
        projection: { _id: 1, characterId: 1, userId: 1, instancedItems: 1, stackedItems: 1, revision: 1 },
    });

    for await (const Doc of Cursor) {
        Report.summary.recordsScanned++;
        const CurrentCharacterId = String(Doc.characterId ?? Doc._id);
        const CurrentUserId = typeof Doc.userId === "string" ? Doc.userId : null;
        let InstancedItems: any[];
        let StackedItems: any[];

        try {
            InstancedItems = JSON.parse(typeof Doc.instancedItems === "string" ? Doc.instancedItems : "[]");
            StackedItems = JSON.parse(typeof Doc.stackedItems === "string" ? Doc.stackedItems : "[]");
            if (!Array.isArray(InstancedItems) || !Array.isArray(StackedItems)) throw new Error("inventory blobs are not arrays");
        } catch (Err) {
            Report.summary.parseErrors++;
            Report.records.push({
                userId: CurrentUserId,
                characterId: CurrentCharacterId,
                status: "parse-error",
                error: String(Err),
            });
            continue;
        }

        const Migration = MigrateInventoryStorageArrays(InstancedItems, StackedItems);
        if (Migration.changes.length === 0 && Migration.issues.length === 0) continue;

        Report.summary.recordsNeedingMigration++;
        Report.summary.changes += Migration.changes.length;
        Report.summary.manualReviewIssues += Migration.issues.length;

        const RecordReport: any = {
            userId: CurrentUserId,
            characterId: CurrentCharacterId,
            expectedRevision: Number(Doc.revision ?? 0),
            status: Apply ? "pending" : "dry-run",
            changes: Migration.changes,
            issues: Migration.issues,
        };

        if (Apply && Migration.changes.length > 0) {
            const Updated = await GetRepositories().inventories.updateBothIfRevisionMatches(
                CurrentCharacterId,
                JSON.stringify(Migration.instancedItems),
                JSON.stringify(Migration.stackedItems),
                Number(Doc.revision ?? 0)
            );
            if (Updated == undefined) {
                RecordReport.status = "revision-conflict";
                Report.summary.revisionConflicts++;
            } else {
                RecordReport.status = "updated";
                RecordReport.newRevision = Updated.revision;
                Report.summary.recordsUpdated++;
            }
        }

        Report.records.push(RecordReport);
    }
} finally {
    Report.completedAt = new Date().toISOString();
    if (ReportPath) {
        const AbsoluteReportPath = path.resolve(ReportPath);
        fs.mkdirSync(path.dirname(AbsoluteReportPath), { recursive: true });
        fs.writeFileSync(AbsoluteReportPath, JSON.stringify(Report, null, 2) + "\n", "utf8");
        console.log(`Report written: ${AbsoluteReportPath}`);
    }
    console.log(JSON.stringify(Report.summary, null, 2));
    await Lifecycle.stop();
}
}

Main().catch((Err) => {
    console.error(Err);
    process.exitCode = 1;
});
