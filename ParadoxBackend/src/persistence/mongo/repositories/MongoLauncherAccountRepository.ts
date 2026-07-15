/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import {
    AccountApprovalStatus,
    AccountOperationalStatus,
    LauncherAccountRepository,
    LauncherAccountRecord
} from "../../contracts/LauncherAccountRepository";






function ToRecord(Doc: any): LauncherAccountRecord {
    return {
        userId: Doc.userId,
        email: Doc.email ?? undefined,
        displayNameNormalized: Doc.displayNameNormalized,
        displayName: Doc.displayName,
        passwordHash: Doc.passwordHash ?? undefined,
        status: Doc.status,
        approvalStatus: Doc.approvalStatus ?? undefined,
        approvalUpdatedAt: Doc.approvalUpdatedAt ?? undefined,
        approvalUpdatedBy: Doc.approvalUpdatedBy ?? undefined,
        approvalReason: Doc.approvalReason ?? undefined,
        roles: Doc.roles ?? ["player"],
        createdAt: Doc.createdAt,
        lastLoginAt: Doc.lastLoginAt ?? undefined,
        usernameSet: Doc.usernameSet ?? undefined
    };
}

export class MongoLauncherAccountRepository implements LauncherAccountRepository {
    async findByUserId(userId: string): Promise<LauncherAccountRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Accounts).findOne({ _id: userId as any, displayNameNormalized: { $exists: true } });

        return Doc == undefined ? undefined : ToRecord(Doc);
    }

    async findByEmail(normalizedEmail: string): Promise<LauncherAccountRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Accounts).findOne({ email: normalizedEmail });

        return Doc == undefined ? undefined : ToRecord(Doc);
    }

    async findByDisplayNameNormalized(normalizedDisplayName: string): Promise<LauncherAccountRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.Accounts).findOne({ displayNameNormalized: normalizedDisplayName });

        return Doc == undefined ? undefined : ToRecord(Doc);
    }

    async create(account: LauncherAccountRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Accounts).insertOne({
            _id: account.userId as any,
            userId: account.userId,
            email: account.email,
            displayNameNormalized: account.displayNameNormalized,
            displayName: account.displayName,
            passwordHash: account.passwordHash,
            status: account.status,
            approvalStatus: account.approvalStatus,
            approvalUpdatedAt: account.approvalUpdatedAt,
            approvalUpdatedBy: account.approvalUpdatedBy,
            approvalReason: account.approvalReason,
            roles: account.roles,
            createdAt: account.createdAt,
            lastLoginAt: account.lastLoginAt,
            usernameSet: account.usernameSet,
            
            
            name: account.displayName,
            notes: 0
        });
    }

    async updateLastLogin(userId: string, whenIso: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.Accounts).updateOne({ _id: userId as any }, { $set: { lastLoginAt: whenIso } });
    }

    async setUsername(userId: string, displayName: string, displayNameNormalized: string): Promise<void> {
        const Db = await GetMongoDb();
        
        await Db.collection(Collections.Accounts).updateOne(
            { _id: userId as any },
            { $set: { displayName, displayNameNormalized, name: displayName, usernameSet: true } }
        );
    }

    async listForAdmin(filters: {
        approvalStatus?: AccountApprovalStatus;
        status?: AccountOperationalStatus;
        search?: string;
        skip: number;
        limit: number;
    }): Promise<{ accounts: LauncherAccountRecord[]; total: number }> {
        const Db = await GetMongoDb();
        const And: any[] = [{ displayNameNormalized: { $exists: true } }];

        if (filters.approvalStatus === "approved") {
            And.push({ $or: [{ approvalStatus: "approved" }, { approvalStatus: { $exists: false } }] });
        } else if (filters.approvalStatus != undefined) {
            And.push({ approvalStatus: filters.approvalStatus });
        }
        if (filters.status != undefined) {
            And.push({ status: filters.status });
        }
        if (filters.search) {
            const Escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const Pattern = new RegExp(Escaped, "i");
            And.push({ $or: [{ displayName: Pattern }, { email: Pattern }, { userId: Pattern }] });
        }

        const Query = { $and: And };
        const Collection = Db.collection(Collections.Accounts);
        const [Docs, Total] = await Promise.all([
            Collection.find(Query).sort({ createdAt: -1 }).skip(filters.skip).limit(filters.limit).toArray(),
            Collection.countDocuments(Query)
        ]);

        return { accounts: Docs.map(ToRecord), total: Total };
    }

    async setAccessState(
        userId: string,
        changes: {
            approvalStatus?: AccountApprovalStatus;
            status?: AccountOperationalStatus;
            approvalUpdatedAt: string;
            approvalUpdatedBy: string;
            approvalReason?: string;
        }
    ): Promise<LauncherAccountRecord | undefined> {
        const Db = await GetMongoDb();
        const Set: Record<string, unknown> = {
            approvalUpdatedAt: changes.approvalUpdatedAt,
            approvalUpdatedBy: changes.approvalUpdatedBy,
            approvalReason: changes.approvalReason ?? ""
        };
        if (changes.approvalStatus != undefined) Set.approvalStatus = changes.approvalStatus;
        if (changes.status != undefined) Set.status = changes.status;

        const Result = await Db.collection(Collections.Accounts).findOneAndUpdate(
            { _id: userId as any, displayNameNormalized: { $exists: true } },
            { $set: Set },
            { returnDocument: "after" }
        );
        return Result == null ? undefined : ToRecord(Result);
    }
}
