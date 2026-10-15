/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession } from "mongodb";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { LauncherNoticesRecord, LauncherNoticesRepository } from "../../contracts/LauncherNoticesRepository";

// [2026-10-15] One singleton document, _id "current" (contracts/LauncherNoticesRepository.ts). Version 0 means "no document": the first
// save inserts it (an insert that finds it already there is a lost race, reported as false), and every later save replaces it only while
// the stored version is the one the caller read.
const DOCUMENT_ID = "current";

function ToRecord(Doc: any): LauncherNoticesRecord {
    return {
        version: Doc.version,
        ...(typeof Doc.updatedAt === "string" ? { updatedAt: Doc.updatedAt } : {}),
        ...(typeof Doc.updatedBy === "string" ? { updatedBy: Doc.updatedBy } : {}),
        announcements: Array.isArray(Doc.announcements) ? Doc.announcements : [],
        tags: Array.isArray(Doc.tags) ? Doc.tags : []
    };
}

export class MongoLauncherNoticesRepository implements LauncherNoticesRepository {
    async get(session?: ClientSession): Promise<LauncherNoticesRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.LauncherNotices).findOne({ _id: { $eq: DOCUMENT_ID as any } }, { session });
        return Doc == undefined ? undefined : ToRecord(Doc);
    }

    async replaceIfVersion(record: LauncherNoticesRecord, expectedVersion: number, session?: ClientSession): Promise<boolean> {
        const Db = await GetMongoDb();
        const Document = {
            version: record.version,
            ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
            ...(record.updatedBy !== undefined ? { updatedBy: record.updatedBy } : {}),
            announcements: record.announcements,
            tags: record.tags
        };

        if (expectedVersion === 0) {
            try {
                await Db.collection(Collections.LauncherNotices).insertOne({ _id: DOCUMENT_ID as any, ...Document }, { session });
                return true;
            } catch (Error) {
                // A document already there means another save came first; the caller re-reads and reports the conflict.
                if ((Error as { code?: unknown } | null)?.code === 11000) return false;
                throw Error;
            }
        }

        const Result = await Db.collection(Collections.LauncherNotices).replaceOne(
            { _id: { $eq: DOCUMENT_ID as any }, version: { $eq: expectedVersion } },
            { _id: DOCUMENT_ID as any, ...Document },
            { session }
        );
        return Result.matchedCount === 1;
    }
}
