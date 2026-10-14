/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14] Retention periods the Privacy Policy (ParadoxLauncher/src/legal/privacy.md, sections 5 and 9) promises. Each one is
// enforced by code: the Mongo TTL indexes (persistence/mongo/indexes.ts, p2p/persistence/mongo/indexes.ts), the account deletion
// operator script (scripts/process_account_deletions.ts) and the log retention of the server log and the uploaded launcher logs.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A deletion request keeps the account deactivated and restorable for this many days, then the account is erased. */
export const DELETION_HOLD_DAYS = 30;

/** Launcher Guard sessions (integrity summaries) are kept this many days after their last update. */
export const GUARD_SESSION_RETENTION_DAYS = 90;
/** Guard module findings are kept this many days after they were last seen (they name the accounts that reported them). */
export const GUARD_FINDING_RETENTION_DAYS = 90;

/** Uploaded launcher log sessions (PUT /launcher/v1/logs/sessions/...) are kept this many days after their last upload. */
export const UPLOADED_LAUNCHER_LOG_RETENTION_DAYS = 90;

/** Each server start archives the previous run's log; archives are kept MYSTICPARADOX_LOG_RETENTION_DAYS (this many by default). */
export const SERVER_LOG_DEFAULT_RETENTION_DAYS = 90;

/** The instant `days` after `iso`, as a Date for a Mongo TTL index (storage cleanup only; business checks compare the ISO text). */
export function RetentionDateAfter(iso: string, days: number): Date {
    return new Date(Date.parse(iso) + days * DAY_MS);
}
