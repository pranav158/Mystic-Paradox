/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { EmailCodePurpose, EmailCodeRecord, EmailCodeRepository } from "../../contracts/EmailCodeRepository";

// [2026-10-15] One document per account and purpose: _id is "<userId>:<purpose>" (a UUID holds no colon). Each write that decides a
// code is one conditional operation, so two parallel requests cannot both use a code or both spend the last try.
function DocumentId(userId: string, purpose: EmailCodePurpose): string {
    return `${userId}:${purpose}`;
}

function ToRecord(Doc: any): EmailCodeRecord {
    return {
        userId: Doc.userId,
        purpose: Doc.purpose,
        codeHash: Doc.codeHash,
        attempts: Doc.attempts,
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt
    };
}

export class MongoEmailCodeRepository implements EmailCodeRepository {
    async replace(record: EmailCodeRecord): Promise<void> {
        const Db = await GetMongoDb();
        const Id = DocumentId(record.userId, record.purpose);
        await Db.collection(Collections.EmailCodes).replaceOne(
            { _id: Id as any },
            {
                _id: Id as any,
                userId: record.userId,
                purpose: record.purpose,
                codeHash: record.codeHash,
                attempts: record.attempts,
                createdAt: record.createdAt,
                expiresAt: record.expiresAt,
                // Storage-only BSON Date for the TTL index (indexes.ts); the business checks compare the ISO expiresAt.
                ttlAt: new Date(record.expiresAt)
            },
            { upsert: true }
        );
    }

    // [2026-10-15] A read only: the live code, if any. The use itself is the conditional delete in consume().
    async peekLive(userId: string, purpose: EmailCodePurpose, nowIso: string, maxTries: number): Promise<EmailCodeRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.EmailCodes).findOne({
            _id: DocumentId(userId, purpose) as any,
            expiresAt: { $gt: nowIso },
            attempts: { $lt: maxTries }
        });
        return Doc == null ? undefined : ToRecord(Doc);
    }

    // [2026-10-15] The use of a right code: one delete that holds only while the row is still this code, unexpired and with tries left.
    async consume(userId: string, purpose: EmailCodePurpose, codeHash: string, nowIso: string, maxTries: number): Promise<boolean> {
        const Db = await GetMongoDb();
        const Result = await Db.collection(Collections.EmailCodes).deleteOne({
            _id: DocumentId(userId, purpose) as any,
            codeHash,
            expiresAt: { $gt: nowIso },
            attempts: { $lt: maxTries }
        });
        return Result.deletedCount === 1;
    }

    async reserveTry(userId: string, purpose: EmailCodePurpose, nowIso: string, maxTries: number): Promise<EmailCodeRecord | undefined> {
        const Db = await GetMongoDb();
        const Id = DocumentId(userId, purpose);
        const Doc = await Db.collection(Collections.EmailCodes).findOneAndUpdate(
            { _id: Id as any, expiresAt: { $gt: nowIso }, attempts: { $lt: maxTries } },
            { $inc: { attempts: 1 } },
            { returnDocument: "after" }
        );
        if (Doc != null) return ToRecord(Doc);

        // Expired or out of tries: the row goes now (the TTL index would purge it later, but nothing may use it meanwhile).
        await Db.collection(Collections.EmailCodes).deleteOne({
            _id: Id as any,
            $or: [{ expiresAt: { $lte: nowIso } }, { attempts: { $gte: maxTries } }]
        });
        return undefined;
    }

    async remove(userId: string, purpose: EmailCodePurpose, codeHash: string): Promise<boolean> {
        const Db = await GetMongoDb();
        const Result = await Db.collection(Collections.EmailCodes).deleteOne({ _id: DocumentId(userId, purpose) as any, codeHash });
        return Result.deletedCount === 1;
    }

    async deleteForUser(userId: string): Promise<number> {
        const Db = await GetMongoDb();
        const Result = await Db.collection(Collections.EmailCodes).deleteMany({ userId });
        return Result.deletedCount;
    }
}
