// Deletes the uploaded launcher log sessions whose last upload is older than 90 days (Privacy Policy sections 1 and 5). Dry run by default:
// it lists what would go and changes nothing. Deleting needs --apply and --confirm=PURGE_UPLOADED_LOGS. The files are removed from the
// launcher log storage (LAUNCHER_LOG_STORAGE_DIR, or the default folder of routes/launcherLogs.ts).
//
//   npm run logs:purge-uploaded                                        (dry run)
//   npm run logs:purge-uploaded -- --apply --confirm=PURGE_UPLOADED_LOGS

import { LOG_STORAGE_ROOT } from "../src/routes/launcherLogs";
import { UPLOADED_LAUNCHER_LOG_RETENTION_DAYS } from "../src/legal/retentionPolicy";
import { ExpiredUploadedLogSessions, ListUploadedLogSessions, RemoveUploadedLogSessions } from "../src/services/launcherLogRetention";

function argument(name: string): string | undefined {
    const Prefix = `--${name}=`;
    return process.argv.find((Value) => Value.startsWith(Prefix))?.slice(Prefix.length);
}

function main(): void {
    const Apply = process.argv.includes("--apply");
    const Confirm = argument("confirm");
    if (Apply && Confirm !== "PURGE_UPLOADED_LOGS") {
        throw new Error("--apply requires --confirm=PURGE_UPLOADED_LOGS");
    }

    const NowMs = Date.now();
    const All = ListUploadedLogSessions(LOG_STORAGE_ROOT);
    const Expired = ExpiredUploadedLogSessions(All, NowMs, UPLOADED_LAUNCHER_LOG_RETENTION_DAYS);
    const Accounts = new Set(Expired.map((session) => session.userId));

    console.log(`Uploaded launcher log sessions: ${All.length}; older than ${UPLOADED_LAUNCHER_LOG_RETENTION_DAYS} days: ${Expired.length} (${Accounts.size} account folder(s))`);
    for (const session of Expired) {
        console.log(`  ${Apply ? "removing" : "would remove"} userId=${session.userId} session=${session.sessionId} lastUpload=${new Date(session.uploadedAtMs).toISOString()}`);
    }

    if (!Apply) {
        console.log("Dry run only. Nothing was removed. Re-run with --apply --confirm=PURGE_UPLOADED_LOGS to delete them.");
        return;
    }
    const Removed = RemoveUploadedLogSessions(Expired);
    console.log(`Removed ${Removed} session(s).`);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
