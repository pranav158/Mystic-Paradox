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
    AdminAuditRecord,
    AdminRepository,
    AdminSessionRecord,
    PlayerDeletionResult
} from "../../contracts/AdminRepository";
import { Conn, SqliteDatabase } from "../database";
import { Doc, Placeholders } from "../docTable";
import { IsNullOrMissing, IsPresent, Tables } from "../tables";

// [2026-10-14] The account leaves every Guard module finding that lists it, and the count follows (the MongoDB plan's pipeline update).
function RemoveAccountFromGuardFindings(c: Conn, userId: string): number {
    let Changed = 0;
    const Rows = Tables.guardFindings.rows(c, "EXISTS (SELECT 1 FROM json_each(doc, '$.accountIds') WHERE json_each.value = ?)", [userId]);
    for (const Row of Rows) {
        const Accounts = (Array.isArray(Row.doc.accountIds) ? Row.doc.accountIds : []).filter((Id: string) => Id !== userId);
        Tables.guardFindings.patch(c, Row, { accountIds: Accounts, accountCount: Accounts.length });
        Changed += 1;
    }
    return Changed;
}

function ToSession(Doc: Doc): AdminSessionRecord {
    return {
        id: String(Doc._id),
        tokenHash: Doc.tokenHash,
        userId: Doc.userId,
        csrfToken: Doc.csrfToken,
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt,
        ip: Doc.ip,
        userAgent: Doc.userAgent,
        revokedAt: Doc.revokedAt ?? undefined
    };
}

function ToAudit(Doc: Doc): AdminAuditRecord {
    return {
        id: String(Doc._id),
        actorUserId: Doc.actorUserId,
        targetUserId: Doc.targetUserId ?? undefined,
        action: Doc.action,
        oldState: Doc.oldState,
        newState: Doc.newState,
        reason: Doc.reason ?? undefined,
        ip: Doc.ip,
        requestId: Doc.requestId,
        createdAt: Doc.createdAt
    };
}

export class SqliteAdminRepository implements AdminRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async createSession(session: AdminSessionRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.adminSessions.insert(c, session.id, { ...session, ttlAt: new Date(session.expiresAt) });
        });
    }

    async findActiveSessionByTokenHash(tokenHash: string): Promise<AdminSessionRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.adminSessions.findOne(
                c,
                `tokenHash = ? AND ${IsNullOrMissing("revokedAt")} AND json_extract(doc, '$.expiresAt') > ?`,
                [tokenHash, new Date().toISOString()]
            );
            return Doc === undefined ? undefined : ToSession(Doc);
        });
    }

    async revokeSession(id: string): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.adminSessions.row(c, id);
            if (Row !== undefined) Tables.adminSessions.patch(c, Row, { revokedAt: new Date().toISOString() });
        });
    }

    async appendAudit(record: AdminAuditRecord, session?: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            Tables.adminAudit.insert(c, record.id, { ...record });
        });
    }

    async listAudit(targetUserId: string | undefined, skip: number, limit: number): Promise<{ records: AdminAuditRecord[]; total: number }> {
        return this.db.read(undefined, (c) => {
            // Same truthiness test as the MongoDB repository: an empty id lists everything.
            const Where = targetUserId ? "targetUserId = ?" : "";
            const Params = targetUserId ? [targetUserId] : [];
            const Docs = Tables.adminAudit.find(c, Where, Params, {
                orderBy: "createdAt DESC, rowid DESC",
                limit: limit > 0 ? limit : undefined, // limit(0) means "no limit" in MongoDB
                offset: skip
            });
            return { records: Docs.map(ToAudit), total: Tables.adminAudit.count(c, Where, Params) };
        });
    }

    /**
     * The whole cascade is one transaction (a savepoint when the caller already runs one): nothing becomes visible
     * unless every removal and the audit tombstone commit, and a vanished account rolls everything back.
     */
    async deletePlayerData(userId: string, audit: AdminAuditRecord): Promise<PlayerDeletionResult> {
        return this.db.write(undefined, (c) => {
            const DeletedCounts: Record<string, number> = {};
            const CharacterRows = Tables.characters.find(c, "userId = ?", [userId]);
            const CharacterIds = CharacterRows.map((Character) => String(Character.characterId ?? Character._id));

            const Remove = (table: { name: string; delete(c: Conn, where: string, params?: any[]): number }, where: string, params: any[]): void => {
                DeletedCounts[table.name] = table.delete(c, where, params);
            };
            const UserOwned = "userId = ? OR _id = ?";
            const IdList = CharacterIds.length > 0 ? Placeholders(CharacterIds.length) : undefined;
            // inventories / loadouts / breadcrumbs / encounteredContent have characterId === _id by construction
            // (every writer sets both), so `_id IN` covers MongoDB's `characterId IN` clause for them.
            const CharacterOwned = IdList === undefined ? "userId = ?" : `userId = ? OR _id IN (${IdList})`;
            const CharacterOwnedParams = [userId, ...CharacterIds];
            const LedgerOwned = IdList === undefined ? "userId = ?" : `userId = ? OR characterId IN (${IdList}) OR _id IN (${IdList})`;
            const LedgerParams = [userId, ...CharacterIds, ...CharacterIds];

            // Authentication and live-session state first.
            Remove(Tables.refreshSessions, "userId = ?", [userId]);
            Remove(Tables.gameExchangeCodes, "userId = ?", [userId]);
            Remove(Tables.adminSessions, "userId = ?", [userId]);
            Remove(Tables.authIdentities, "userId = ?", [userId]);
            Remove(Tables.discordOAuthTransactions, "userId = ?", [userId]);
            Remove(Tables.userApiKeys, UserOwned, [userId, userId]);
            Remove(Tables.friendships, "ownerId = ? OR otherId = ?", [userId, userId]);
            // [2026-10-14] Guard sessions (the MongoDB plan deletes them too) and the account's place in the module findings.
            Remove(Tables.launcherGuardSessions, "accountId = ?", [userId]);
            DeletedCounts[Tables.guardFindings.name] = RemoveAccountFromGuardFindings(c, userId);

            Remove(Tables.inventoryTransactions, LedgerOwned, LedgerParams);
            Remove(Tables.inventories, CharacterOwned, CharacterOwnedParams);
            Remove(Tables.loadouts, CharacterOwned, CharacterOwnedParams);
            Remove(Tables.breadcrumbs, CharacterOwned, CharacterOwnedParams);
            Remove(Tables.encounteredContent, CharacterOwned, CharacterOwnedParams);
            Remove(Tables.progressionTracks, "userId = ?", [userId]);
            Remove(Tables.progressionObjectives, "userId = ?", [userId]);
            Remove(Tables.progressionObjectiveEvents, "userId = ?", [userId]);
            Remove(Tables.playerJourney, UserOwned, [userId, userId]);
            Remove(Tables.wallets, UserOwned, [userId, userId]);
            // [2026-10-14] The daily economy totals and the activity monitor rows: the MongoDB plan deletes them too (accountDeletionPlan.ts).
            Remove(Tables.economyDaily, "userId = ?", [userId]);
            Remove(Tables.playerActivityDaily, "userId = ?", [userId]);
            Remove(Tables.activityHunts, "userId = ?", [userId]);
            Remove(Tables.slayersPathUnlocks, "userId = ?", [userId]);
            Remove(Tables.activityFlags, "userId = ?", [userId]);
            Remove(Tables.characters, "userId = ?", [userId]);

            const AccountsDeleted = Tables.accounts.delete(c, `_id = ? AND ${IsPresent("displayNameNormalized")}`, [userId]);
            if (AccountsDeleted !== 1) {
                throw new Error("Player account disappeared before deletion completed.");
            }
            DeletedCounts[Tables.accounts.name] = AccountsDeleted;

            // One minimal operational tombstone: opaque ids and state only.
            Tables.adminAudit.insert(c, audit.id, { ...audit });

            return { deletedCounts: DeletedCounts, characterCount: CharacterIds.length };
        });
    }
}
