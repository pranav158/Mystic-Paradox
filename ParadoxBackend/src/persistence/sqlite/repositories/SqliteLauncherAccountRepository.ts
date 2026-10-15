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

import { ClientSession } from "mongodb";
import {
    AccountApprovalStatus,
    AccountOperationalStatus,
    LauncherAccountRecord,
    LauncherAccountRepository,
    LauncherConsentRecord,
    LauncherDeletionRecord
} from "../../contracts/LauncherAccountRepository";
import { Conn, SqliteDatabase } from "../database";
import { Doc, StoredRow } from "../docTable";
import { IsAbsent, IsNullOrMissing, IsPresent, Tables } from "../tables";

function ToRecord(Doc: Doc): LauncherAccountRecord {
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
        rolesUpdatedAt: Doc.rolesUpdatedAt ?? undefined,
        rolesUpdatedBy: Doc.rolesUpdatedBy ?? undefined,
        createdAt: Doc.createdAt,
        lastLoginAt: Doc.lastLoginAt ?? undefined,
        usernameSet: Doc.usernameSet ?? undefined,
        consent: Doc.consent ?? undefined,
        deletion: Doc.deletion ?? undefined,
        emailVerifiedAt: Doc.emailVerifiedAt ?? undefined,
        emailVerificationPendingSince: Doc.emailVerificationPendingSince ?? undefined
    };
}

// Launcher accounts are the documents of the shared `accounts` table that carry displayNameNormalized (dev/game
// accounts never do). email and displayNameNormalized are UNIQUE where present (schema.ts), so a racing register fails
// with the E11000-equivalent error launcherAuth.ts already handles.
const IS_LAUNCHER_ACCOUNT = IsPresent("displayNameNormalized");

export class SqliteLauncherAccountRepository implements LauncherAccountRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async findByUserId(userId: string, session?: ClientSession): Promise<LauncherAccountRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.accounts.findOne(c, `_id = ? AND ${IS_LAUNCHER_ACCOUNT}`, [userId]);
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async findByEmail(normalizedEmail: string): Promise<LauncherAccountRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.accounts.findOne(c, "email = ?", [normalizedEmail]);
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async findByDisplayNameNormalized(normalizedDisplayName: string): Promise<LauncherAccountRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.accounts.findOne(c, "displayNameNormalized = ?", [normalizedDisplayName]);
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async create(account: LauncherAccountRecord, session?: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            Tables.accounts.insert(c, account.userId, {
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
                rolesUpdatedAt: account.rolesUpdatedAt,
                rolesUpdatedBy: account.rolesUpdatedBy,
                createdAt: account.createdAt,
                lastLoginAt: account.lastLoginAt,
                usernameSet: account.usernameSet,
                consent: account.consent,
                deletion: account.deletion,
                // [2026-10-15] Written only when set, as in the MongoDB repository (an absent field is what the "not verified" queries look for).
                ...(account.emailVerifiedAt === undefined ? {} : { emailVerifiedAt: account.emailVerifiedAt }),
                ...(account.emailVerificationPendingSince === undefined ? {} : { emailVerificationPendingSince: account.emailVerificationPendingSince }),
                // Game-owned fields (AccountRepository): a launcher account needs them too.
                name: account.displayName,
                notes: 0
            });
        });
    }

    async setConsent(userId: string, consent: LauncherConsentRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = this.launcherRow(c, userId);
            if (Row !== undefined) Tables.accounts.patch(c, Row, { consent });
        });
    }

    async setDeletion(userId: string, deletion: LauncherDeletionRecord | undefined): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = this.launcherRow(c, userId);
            if (Row === undefined) return;
            if (deletion === undefined) Tables.accounts.patch(c, Row, {}, ["deletion"]);
            else Tables.accounts.patch(c, Row, { deletion });
        });
    }

    async listDeletionsDue(nowIso: string, limit: number): Promise<LauncherAccountRecord[]> {
        return this.db.read(undefined, (c) => {
            // ISO-8601 UTC text compares in time order, the same as the Mongo query on the stored text.
            const Docs = Tables.accounts.find(c, `${IS_LAUNCHER_ACCOUNT} AND json_extract(doc, '$.deletion.scheduledFor') <= ?`, [nowIso], {
                orderBy: "json_extract(doc, '$.deletion.scheduledFor') ASC",
                limit: limit > 0 ? limit : undefined
            });
            return Docs.map(ToRecord);
        });
    }

    async updateLastLogin(userId: string, whenIso: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.accounts.row(c, userId);
            if (Row !== undefined) Tables.accounts.patch(c, Row, { lastLoginAt: whenIso });
        });
    }

    async setUsername(userId: string, displayName: string, displayNameNormalized: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.accounts.row(c, userId);
            // Also updates `name` (the game-facing display name GetUsernameForUserId reads).
            if (Row !== undefined) {
                Tables.accounts.patch(c, Row, { displayName, displayNameNormalized, name: displayName, usernameSet: true });
            }
        });
    }

    async listForAdmin(filters: {
        approvalStatus?: AccountApprovalStatus;
        status?: AccountOperationalStatus;
        search?: string;
        skip: number;
        limit: number;
    }): Promise<{ accounts: LauncherAccountRecord[]; total: number }> {
        return this.db.read(undefined, (c) => {
            const Where: string[] = [IS_LAUNCHER_ACCOUNT];
            const Params: string[] = [];

            if (filters.approvalStatus === "approved") {
                // Legacy rows without the field count as approved.
                Where.push(`(json_extract(doc, '$.approvalStatus') = 'approved' OR ${IsAbsent("approvalStatus")})`);
            } else if (filters.approvalStatus != undefined) {
                Where.push("json_extract(doc, '$.approvalStatus') = ?");
                Params.push(filters.approvalStatus);
            }
            if (filters.status != undefined) {
                Where.push("json_extract(doc, '$.status') = ?");
                Params.push(filters.status);
            }

            const Clause = Where.join(" AND ");
            const Order = "createdAt DESC, rowid DESC";
            // MongoDB's limit(0) means "no limit".
            const Limit = filters.limit > 0 ? filters.limit : undefined;

            if (!filters.search) {
                const Docs = Tables.accounts.find(c, Clause, Params, { orderBy: Order, limit: Limit, offset: filters.skip });
                return { accounts: Docs.map(ToRecord), total: Tables.accounts.count(c, Clause, Params) };
            }

            // Case-insensitive substring over displayName / email / userId, evaluated with the same RegExp the
            // MongoDB query used (SQLite's lower() is ASCII-only).
            const Escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const Pattern = new RegExp(Escaped, "i");
            const Matches = (Value: unknown) => typeof Value === "string" && Pattern.test(Value);
            const All = Tables.accounts.find(c, Clause, Params, { orderBy: Order })
                .filter((Doc) => Matches(Doc.displayName) || Matches(Doc.email) || Matches(Doc.userId));
            const Page = All.slice(filters.skip, Limit === undefined ? undefined : filters.skip + Limit);
            return { accounts: Page.map(ToRecord), total: All.length };
        });
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
        return this.db.write(undefined, (c) => {
            const Row = this.launcherRow(c, userId);
            if (Row === undefined) return undefined;
            const Set: Record<string, unknown> = {
                approvalUpdatedAt: changes.approvalUpdatedAt,
                approvalUpdatedBy: changes.approvalUpdatedBy,
                approvalReason: changes.approvalReason ?? ""
            };
            if (changes.approvalStatus != undefined) Set.approvalStatus = changes.approvalStatus;
            if (changes.status != undefined) Set.status = changes.status;
            return ToRecord(Tables.accounts.patch(c, Row, Set));
        });
    }

    async updateRoles(
        userId: string,
        roles: string[],
        changes: { rolesUpdatedAt: string; rolesUpdatedBy: string },
        session?: ClientSession
    ): Promise<LauncherAccountRecord | undefined> {
        return this.db.write(session, (c) => {
            const Row = this.launcherRow(c, userId);
            if (Row === undefined) return undefined;
            return ToRecord(Tables.accounts.patch(c, Row, {
                roles,
                rolesUpdatedAt: changes.rolesUpdatedAt,
                rolesUpdatedBy: changes.rolesUpdatedBy
            }));
        });
    }

    // [2026-10-15] Verified: the verification time is set and the pending mark goes (as the MongoDB update does).
    async setEmailVerified(userId: string, verifiedAt: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = this.launcherRow(c, userId);
            if (Row !== undefined) Tables.accounts.patch(c, Row, { emailVerifiedAt: verifiedAt }, ["emailVerificationPendingSince"]);
        });
    }

    // [2026-10-15] A password reset by code replaces the hash.
    async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = this.launcherRow(c, userId);
            if (Row !== undefined) Tables.accounts.patch(c, Row, { passwordHash });
        });
    }

    // [2026-10-15] Unverified registrations pending since before the cut-off, oldest first. ISO text compares in time order.
    async listUnverifiedRegistrations(pendingBeforeIso: string, limit: number): Promise<LauncherAccountRecord[]> {
        return this.db.read(undefined, (c) => {
            const Docs = Tables.accounts.find(
                c,
                `${IS_LAUNCHER_ACCOUNT} AND json_extract(doc, '$.emailVerificationPendingSince') < ? AND ${IsNullOrMissing("emailVerifiedAt")}`,
                [pendingBeforeIso],
                { orderBy: "json_extract(doc, '$.emailVerificationPendingSince') ASC", limit: limit > 0 ? limit : undefined }
            );
            return Docs.map(ToRecord);
        });
    }

    // [2026-10-15] Removes the account only while it is still an unverified registration pending since before the cut-off.
    async deleteUnverifiedRegistration(userId: string, pendingBeforeIso: string): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.accounts.findOneRow(
                c,
                `_id = ? AND ${IS_LAUNCHER_ACCOUNT} AND json_extract(doc, '$.emailVerificationPendingSince') < ? AND ${IsNullOrMissing("emailVerifiedAt")}`,
                [userId, pendingBeforeIso]
            );
            if (Row === undefined) return false;
            return Tables.accounts.deleteById(c, userId) === 1;
        });
    }

    private launcherRow(c: Conn, userId: string): StoredRow | undefined {
        return Tables.accounts.findOneRow(c, `_id = ? AND ${IS_LAUNCHER_ACCOUNT}`, [userId]);
    }
}
