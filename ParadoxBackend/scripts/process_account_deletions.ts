// Erases the accounts whose 30-day deletion hold has ended (Privacy Policy section 5). Dry run by default: it prints, per account and
// per collection, what an erasure would change, and changes nothing. Erasing needs both --apply and
// --confirm=APPLY_ACCOUNT_DELETIONS. An account with live activity (a hunt or an online realm it hosts or is in) is skipped for this run
// and reported; run again when the activity has ended.
//
//   npm run account:process-deletions                                  (dry run)
//   npm run account:process-deletions -- --apply --confirm=APPLY_ACCOUNT_DELETIONS
//
// MongoDB only: PERSISTENCE_PROVIDER=sqlite refuses (a local realm has no 30-day process of its own).

import { GetRepositories, ReadPersistenceProvider } from "../src/persistence";
import { GetMongoClient, GetMongoDb, MongoPersistenceLifecycle } from "../src/persistence/mongo/client";
import { EraseAccount, ErasureOutcome } from "../src/accountDeletion/erasure";
import { LOG_STORAGE_ROOT } from "../src/routes/launcherLogs";
import { DELETION_HOLD_DAYS } from "../src/legal/retentionPolicy";

const BATCH_LIMIT = 500;

function argument(name: string): string | undefined {
    const Prefix = `--${name}=`;
    return process.argv.find((Value) => Value.startsWith(Prefix))?.slice(Prefix.length);
}

function PrintOutcome(outcome: ErasureOutcome, userId: string, username: string): void {
    console.log(`${outcome.status} userId=${userId} username=${username}`);
    if (outcome.status === "BLOCKED") {
        for (const blocker of outcome.blockers) console.log(`  skipped, live activity: ${blocker}`);
    }
    for (const count of outcome.counts) {
        if (count.rows === 0) continue;
        const Verb = count.kind === "guard" ? "live rows" : count.kind === "update" ? "changed" : "removed";
        console.log(`  ${count.collection}: ${count.rows} ${Verb} (${count.description})`);
    }
    if (outcome.status === "ERASED") {
        console.log(`  uploaded log sessions removed: ${outcome.logSessionsRemoved}`);
    }
}

async function main(): Promise<void> {
    if (ReadPersistenceProvider() === "sqlite") {
        throw new Error("Account erasure runs on the MongoDB provider only; PERSISTENCE_PROVIDER=sqlite is refused.");
    }
    const Apply = process.argv.includes("--apply");
    const Confirm = argument("confirm");
    if (Apply && Confirm !== "APPLY_ACCOUNT_DELETIONS") {
        throw new Error("--apply requires --confirm=APPLY_ACCOUNT_DELETIONS");
    }

    const Lifecycle = new MongoPersistenceLifecycle();
    await Lifecycle.start();
    try {
        const Db = await GetMongoDb();
        const Client = await GetMongoClient();
        const Now = new Date().toISOString();
        const Due = await GetRepositories().launcherAccounts.listDeletionsDue(Now, BATCH_LIMIT);

        console.log(`Accounts whose ${DELETION_HOLD_DAYS}-day hold ended by ${Now}: ${Due.length}${Due.length === BATCH_LIMIT ? " (batch limit; run again for more)" : ""}`);
        for (const account of Due) {
            const Outcome = await EraseAccount(Client, Db, account, { logRoot: LOG_STORAGE_ROOT, nowIso: Now, apply: Apply });
            PrintOutcome(Outcome, account.userId, account.displayName);
        }

        if (!Apply) {
            console.log("Dry run only. Nothing was changed. Re-run with --apply --confirm=APPLY_ACCOUNT_DELETIONS to erase.");
        }
    } finally {
        await Lifecycle.stop();
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
