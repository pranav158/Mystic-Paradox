/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession } from "mongodb";

// [2026-10-15] The launcher notices: sticky announcements and tags the operator sets in the manager and the launcher shows
// (SteamDocs/LAUNCHER_NOTICES_2026_10_15.md is the contract). One singleton document: Mongo collection `launcherNotices`,
// _id "current"; SQLite one row with the same _id. A missing document is the empty set at version 0.

export type LauncherNoticeTone = "info" | "warning" | "critical";
export type LauncherNoticeTagTone = "info" | "warning" | "danger" | "success";

export interface LauncherNotice {
    /** Server-assigned UUID when the write did not carry one. */
    id: string;
    /** 1-280 characters of plain text; may contain one "{time}" token, which the launcher expands to eventAt. */
    text: string;
    tone: LauncherNoticeTone;
    /** The moment "{time}" shows. Required when the text contains "{time}". */
    eventAt?: string;
    /** Optional window: the notice is served from showFrom (inclusive) until showUntil (exclusive). */
    showFrom?: string;
    showUntil?: string;
}

export interface LauncherNoticeTag {
    id: string;
    /** 1-24 characters, shown as written (for example "EXPERIMENTAL BUILD"). */
    text: string;
    tone: LauncherNoticeTagTone;
    showFrom?: string;
    showUntil?: string;
}

export interface LauncherNoticesRecord {
    /** 0 when nothing was ever saved; every save is the stored version + 1 (optimistic concurrency). */
    version: number;
    /** ISO time of the last save; absent while version is 0. */
    updatedAt?: string;
    /** The operator's actor id from the manager's signed header (`manager:<operatorId>`); absent while version is 0. */
    updatedBy?: string;
    announcements: LauncherNotice[];
    tags: LauncherNoticeTag[];
}

export interface LauncherNoticesRepository {
    /** The stored document, or undefined when nothing was ever saved (the empty set at version 0). */
    get(session?: ClientSession): Promise<LauncherNoticesRecord | undefined>;

    /**
     * Compare-and-set by version: writes `record` only while the stored version equals `expectedVersion` (0 means "nothing saved
     * yet"). Returns whether this call wrote it; a stale or racing writer gets false and must re-read. The caller sets
     * record.version to expectedVersion + 1.
     */
    replaceIfVersion(record: LauncherNoticesRecord, expectedVersion: number, session?: ClientSession): Promise<boolean>;
}
