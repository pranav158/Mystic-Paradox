/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { EmailCodePurpose, EmailCodeRecord, EmailCodeRepository } from "../../contracts/EmailCodeRepository";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { Tables } from "../tables";

// [2026-10-15] The same contract as MongoEmailCodeRepository: one row per account and purpose (_id "<userId>:<purpose>"). Every write
// runs in the serialized write transaction, so a read-then-write here cannot interleave with another request's.
function DocumentId(userId: string, purpose: EmailCodePurpose): string {
    return `${userId}:${purpose}`;
}

function ToRecord(Doc: Doc): EmailCodeRecord {
    return {
        userId: Doc.userId,
        purpose: Doc.purpose,
        codeHash: Doc.codeHash,
        attempts: Doc.attempts,
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt
    };
}

export class SqliteEmailCodeRepository implements EmailCodeRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async replace(record: EmailCodeRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Id = DocumentId(record.userId, record.purpose);
            Tables.emailCodes.deleteById(c, Id);
            Tables.emailCodes.insert(c, Id, {
                userId: record.userId,
                purpose: record.purpose,
                codeHash: record.codeHash,
                attempts: record.attempts,
                createdAt: record.createdAt,
                expiresAt: record.expiresAt,
                // The expiry mirror the purge reads (ISO text here, a BSON Date in MongoDB).
                ttlAt: record.expiresAt
            });
        });
    }

    // [2026-10-15] A read only: the live code, if any (the same conditions as the MongoDB filter).
    async peekLive(userId: string, purpose: EmailCodePurpose, nowIso: string, maxTries: number): Promise<EmailCodeRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Row = Tables.emailCodes.row(c, DocumentId(userId, purpose));
            if (Row === undefined || !(Row.doc.expiresAt > nowIso) || !(Row.doc.attempts < maxTries)) return undefined;
            return ToRecord(Row.doc);
        });
    }

    // [2026-10-15] The use of a right code: removed only while the row is still this code, unexpired and with tries left. One write.
    async consume(userId: string, purpose: EmailCodePurpose, codeHash: string, nowIso: string, maxTries: number): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            const Id = DocumentId(userId, purpose);
            const Row = Tables.emailCodes.row(c, Id);
            if (Row === undefined || Row.doc.codeHash !== codeHash || !(Row.doc.expiresAt > nowIso) || !(Row.doc.attempts < maxTries)) {
                return false;
            }
            return Tables.emailCodes.deleteById(c, Id) === 1;
        });
    }

    async reserveTry(userId: string, purpose: EmailCodePurpose, nowIso: string, maxTries: number): Promise<EmailCodeRecord | undefined> {
        return this.db.write(undefined, (c) => {
            const Id = DocumentId(userId, purpose);
            const Row = Tables.emailCodes.row(c, Id);
            if (Row === undefined) return undefined;
            if (Row.doc.expiresAt > nowIso && Row.doc.attempts < maxTries) {
                return ToRecord(Tables.emailCodes.patch(c, Row, { attempts: Row.doc.attempts + 1 }));
            }
            // Expired or out of tries: the row goes now, as in the MongoDB repository.
            Tables.emailCodes.deleteById(c, Id);
            return undefined;
        });
    }

    async remove(userId: string, purpose: EmailCodePurpose, codeHash: string): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            const Id = DocumentId(userId, purpose);
            const Row = Tables.emailCodes.row(c, Id);
            if (Row === undefined || Row.doc.codeHash !== codeHash) return false;
            return Tables.emailCodes.deleteById(c, Id) === 1;
        });
    }

    async deleteForUser(userId: string): Promise<number> {
        return this.db.write(undefined, (c) => Tables.emailCodes.delete(c, "userId = ?", [userId]));
    }
}
