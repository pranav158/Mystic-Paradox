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
    GUARD_FINDING_ACCOUNT_LIMIT,
    GUARD_HISTORY_LIMIT,
    GuardFindingSighting,
    GuardFindingSummary,
    LauncherGuardRepository,
    LauncherGuardRole,
    LauncherGuardSessionFilter,
    LauncherGuardSessionRecord
} from "../../contracts/LauncherGuardRepository";
import { GUARD_FINDING_RETENTION_DAYS, GUARD_SESSION_RETENTION_DAYS, RetentionDateAfter } from "../../../legal/retentionPolicy";
import { SqliteDatabase } from "../database";
import { Doc } from "../docTable";
import { IsAbsent, Tables } from "../tables";

// Same shape as the MongoDB repository: the stored document plus guardSessionId (= _id) and a normalised role.
function ToRecord(Doc: Doc): LauncherGuardSessionRecord {
    return { ...Doc, guardSessionId: String(Doc._id), role: Doc.role === "host" ? "host" : "client" } as unknown as LauncherGuardSessionRecord;
}

/** Records written before role binding shipped have no role and are client sessions; host sessions need an exact role. */
function RoleClause(role: LauncherGuardRole): string {
    return role === "client" ? `(role = 'client' OR ${IsAbsent("role")})` : "role = 'host'";
}

const LIVE_STATUSES = "('CHALLENGED', 'HEALTHY', 'DEGRADED')";

/** LIKE pattern text with the wildcard characters escaped (ESCAPE '\'). */
function EscapeLike(text: string): string {
    return text.replace(/[\\%_]/g, (Match) => `\\${Match}`);
}

/** Findings are keyed by hash and name: the same file under two names is two findings. */
function FindingId(sha256: string, fileName: string): string {
    return JSON.stringify([sha256, fileName]);
}

/** The finding without its account list and storage-only expiry (the same fields the MongoDB projection leaves out). */
function ToFindingSummary(Doc: Doc): GuardFindingSummary {
    const { _id: _key, accountIds: _accountIds, ttlAt: _ttlAt, ...Summary } = Doc;
    return Summary as GuardFindingSummary;
}

export class SqliteLauncherGuardRepository implements LauncherGuardRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async create(record: LauncherGuardSessionRecord, session?: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            const { guardSessionId, ...Document } = record;
            // [2026-10-14] ttlAt: the storage-only expiry (90 days after creation), purged by SqliteDatabase.purgeExpired.
            Tables.launcherGuardSessions.insert(c, guardSessionId, {
                ...Document,
                ttlAt: RetentionDateAfter(record.createdAt, GUARD_SESSION_RETENTION_DAYS).toISOString()
            });
        });
    }

    async find(guardSessionId: string, session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.launcherGuardSessions.get(c, guardSessionId);
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    async findHealthyForAccount(accountId: string, guardSessionId: string, role: LauncherGuardRole, now: string, session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined> {
        // Same expression as the MongoDB repository (throws RangeError on an unparsable `now`, as it does).
        const HeartbeatFloor = new Date(Date.parse(now) - 45_000).toISOString();
        return this.db.read(session, (c) => {
            const Doc = Tables.launcherGuardSessions.findOne(
                c,
                `_id = ? AND accountId = ? AND ${RoleClause(role)} AND status = 'HEALTHY' AND expiresAt > ? ` +
                `AND json_extract(doc, '$.lastHeartbeatAt') > ?`,
                [guardSessionId, accountId, now, HeartbeatFloor]
            );
            return Doc === undefined ? undefined : ToRecord(Doc);
        });
    }

    /**
     * One heartbeat step. Applies only if the challenge still matches, the sequence moves forward, the session is live
     * and not expired at the heartbeat time; undefined when any of that failed (a replayed or raced heartbeat).
     */
    async advance(input: Parameters<LauncherGuardRepository["advance"]>[0], session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined> {
        return this.db.write(session, (c) => {
            const Row = Tables.launcherGuardSessions.findOneRow(
                c,
                `_id = ? AND accountId = ? AND json_extract(doc, '$.challenge') = ? AND json_extract(doc, '$.lastSequence') < ? ` +
                `AND status IN ${LIVE_STATUSES} AND expiresAt > ?`,
                [input.guardSessionId, input.accountId, input.expectedChallenge, input.sequence, input.heartbeatAt]
            );
            if (Row === undefined) return undefined;
            // [2026-10-14] The last GUARD_HISTORY_LIMIT heartbeats, newest first (the same bound as the MongoDB $push $slice).
            const History = [input.historyEntry, ...(Array.isArray(Row.doc.history) ? Row.doc.history : [])].slice(0, GUARD_HISTORY_LIMIT);
            return ToRecord(Tables.launcherGuardSessions.patch(c, Row, {
                challenge: input.nextChallenge,
                lastSequence: input.sequence,
                status: input.status,
                riskScore: input.riskScore,
                lastHeartbeatAt: input.heartbeatAt,
                expiresAt: input.expiresAt,
                lastSignals: input.signals,
                reasons: input.reasons,
                history: History,
                ttlAt: RetentionDateAfter(input.heartbeatAt, GUARD_SESSION_RETENTION_DAYS).toISOString()
            }));
        });
    }

    async revokeForAccount(accountId: string, role: LauncherGuardRole, revokedAt: string, session?: ClientSession): Promise<void> {
        await this.db.write(session, (c) => {
            for (const Row of Tables.launcherGuardSessions.rows(c, `accountId = ? AND ${RoleClause(role)} AND status IN ${LIVE_STATUSES}`, [accountId])) {
                Tables.launcherGuardSessions.patch(c, Row, {
                    status: "REVOKED",
                    expiresAt: revokedAt,
                    ttlAt: RetentionDateAfter(revokedAt, GUARD_SESSION_RETENTION_DAYS).toISOString()
                });
            }
        });
    }

    async listSessions(filter: LauncherGuardSessionFilter, skip: number, limit: number): Promise<{ records: LauncherGuardSessionRecord[]; total: number }> {
        return this.db.read(undefined, (c) => {
            const Where: string[] = [];
            const Params: Array<string | number> = [];
            if (filter.status !== undefined) {
                Where.push("json_extract(doc, '$.status') = ?");
                Params.push(filter.status);
            }
            if (filter.minRisk !== undefined) {
                Where.push("json_extract(doc, '$.riskScore') >= ?");
                Params.push(filter.minRisk);
            }
            const Clause = Where.join(" AND ");
            const Rows = Tables.launcherGuardSessions.find(c, Clause, Params, {
                orderBy: "json_extract(doc, '$.createdAt') DESC, rowid DESC", limit, offset: skip
            });
            const total = Tables.launcherGuardSessions.count(c, Clause, Params);
            // The history is read per session, so the list leaves it out (as the MongoDB list does).
            return { records: Rows.map((Doc) => { const { history: _history, ...Rest } = Doc; return ToRecord(Rest); }), total };
        });
    }

    async listFindings(filter: { signer?: string }, skip: number, limit: number): Promise<{ records: GuardFindingSummary[]; total: number }> {
        return this.db.read(undefined, (c) => {
            const Where = filter.signer === undefined || filter.signer === ""
                ? ""
                : "LOWER(json_extract(doc, '$.signer')) LIKE ? ESCAPE '\\'";
            const Params: string[] = filter.signer === undefined || filter.signer === ""
                ? []
                : [`%${EscapeLike(filter.signer.toLowerCase())}%`];
            const Rows = Tables.guardFindings.find(c, Where, Params, {
                orderBy: "json_extract(doc, '$.sessionCount') DESC, json_extract(doc, '$.lastSeenAt') DESC, rowid DESC", limit, offset: skip
            });
            return { records: Rows.map(ToFindingSummary), total: Tables.guardFindings.count(c, Where, Params) };
        });
    }

    /**
     * Creates or refreshes the finding and adds the account while the list is below GUARD_FINDING_ACCOUNT_LIMIT. The write runs in
     * BEGIN IMMEDIATE, so the read-modify-write cannot interleave with another heartbeat.
     */
    async recordFindingSighting(input: GuardFindingSighting): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Id = FindingId(input.sha256, input.fileName);
            const Ttl = RetentionDateAfter(input.seenAt, GUARD_FINDING_RETENTION_DAYS).toISOString();
            const Row = Tables.guardFindings.row(c, Id);
            const SessionsSeen = input.newInSession ? 1 : 0;
            if (Row === undefined) {
                Tables.guardFindings.insert(c, Id, {
                    fileName: input.fileName, sha256: input.sha256, signer: input.signer, size: input.size,
                    firstSeenAt: input.seenAt, lastSeenAt: input.seenAt, sessionCount: SessionsSeen,
                    accountCount: 1, accountIds: [input.accountId], ttlAt: Ttl
                });
                return;
            }
            const Accounts: string[] = Array.isArray(Row.doc.accountIds) ? Row.doc.accountIds : [];
            const Add = !Accounts.includes(input.accountId) && Accounts.length < GUARD_FINDING_ACCOUNT_LIMIT;
            const NextAccounts = Add ? [...Accounts, input.accountId] : Accounts;
            Tables.guardFindings.patch(c, Row, {
                signer: input.signer, size: input.size, lastSeenAt: input.seenAt, ttlAt: Ttl,
                sessionCount: (Number(Row.doc.sessionCount) || 0) + SessionsSeen,
                accountIds: NextAccounts, accountCount: NextAccounts.length
            });
        });
    }
}
