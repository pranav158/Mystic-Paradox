/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The names a launcher log upload may use. One definition for the upload route (routes/launcherLogs.ts), the admin reads and
// deletes of uploaded sessions (services/playerLogs.ts) and the retention pass (services/launcherLogRetention.ts), so the admin can read
// exactly the files a tester could upload, and nothing else.

/** A launcher session id: hex and dashes, 8 to 64 characters. */
export const LAUNCHER_LOG_SESSION_ID_PATTERN = /^[a-f0-9-]{8,64}$/i;

// Exactly the files the launcher's launch::logs module writes into a session folder - see ParadoxLauncher/src-tauri/src/launch/logs.rs.
// Anything else is rejected before it reaches disk (upload) and is never listed or read (admin).
const ALLOWED_EXACT_FILENAMES = new Set(["metadata.json", "launcher.log"]);
const ALLOWED_FILENAME_PATTERN = /^runtime-mysticparadox_dll_port\d+\.log$/i;

/** True for the exact names the launcher writes into a session folder (the upload marker `.uploaded-at.json` is not one of them). */
export function isAllowedLauncherLogFileName(name: string): boolean {
    return ALLOWED_EXACT_FILENAMES.has(name) || ALLOWED_FILENAME_PATTERN.test(name);
}

/** A single path segment that cannot leave its folder: letters, digits, '.', '_' and '-', and neither '.' nor '..'. */
export function isSafeSegment(value: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}
