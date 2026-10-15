/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { LauncherNoticesRecord, LauncherNoticesRepository } from "../../contracts/LauncherNoticesRepository";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { Tables } from "../tables";

// [2026-10-15] The same contract as MongoLauncherNoticesRepository: one row, _id "current". Version 0 means no row. Writes run in the
// serialized write transaction, so the version check and the replacement cannot interleave with another request's.
const ROW_ID = "current";

function ToRecord(Doc: Doc): LauncherNoticesRecord {
    return {
        version: Doc.version,
        ...(typeof Doc.updatedAt === "string" ? { updatedAt: Doc.updatedAt } : {}),
        ...(typeof Doc.updatedBy === "string" ? { updatedBy: Doc.updatedBy } : {}),
        announcements: Array.isArray(Doc.announcements) ? Doc.announcements : [],
        tags: Array.isArray(Doc.tags) ? Doc.tags : []
    };
}

export class SqliteLauncherNoticesRepository implements LauncherNoticesRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async get(session?: unknown): Promise<LauncherNoticesRecord | undefined> {
        return this.db.read(session, (c) => {
            const Stored = Tables.launcherNotices.get(c, ROW_ID);
            return Stored === undefined ? undefined : ToRecord(Stored);
        });
    }

    async replaceIfVersion(record: LauncherNoticesRecord, expectedVersion: number, session?: unknown): Promise<boolean> {
        const Document: Doc = {
            version: record.version,
            ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
            ...(record.updatedBy !== undefined ? { updatedBy: record.updatedBy } : {}),
            announcements: record.announcements,
            tags: record.tags
        };
        return this.db.write(session, (c) => {
            const Row = Tables.launcherNotices.row(c, ROW_ID);
            if (Row === undefined) {
                // Nothing saved yet: only the first save (expectedVersion 0) may create the row.
                return expectedVersion === 0 && Tables.launcherNotices.insertIfAbsent(c, ROW_ID, Document);
            }
            if (Row.doc.version !== expectedVersion) return false;
            return Tables.launcherNotices.replaceFrom(c, Row, Document);
        });
    }
}
