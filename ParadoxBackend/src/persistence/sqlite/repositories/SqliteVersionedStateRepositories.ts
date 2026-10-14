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
import { BountyStateRepository } from "../../contracts/BountyStateRepository";
import { CooldownStateRepository } from "../../contracts/CooldownStateRepository";
import { EscalationProgressRepository } from "../../contracts/EscalationProgressRepository";
import { BountyStateRecord, CooldownStateRecord, EscalationProgressRecord } from "../../mapping/domainTypes";
import { SqliteDatabase } from "../database";
import { Doc, DocTable, RoundTrip } from "../docTable";
import { IsDuplicateKeyError } from "../errors";
import { Tables } from "../tables";

// The three per-account state documents (escalation per season, bounty, cooldowns) share one write rule,
// `saveIfVersion`: `expectedVersion === undefined` means insert only (undefined back when the row exists); otherwise the
// whole document is replaced only if the stored updateVersion equals it (undefined back on a conflict), so a stale
// writer re-reads, merges and retries instead of overwriting.

function SaveIfVersion(
    Table: DocTable,
    Db: SqliteDatabase,
    session: ClientSession | undefined,
    Id: string,
    Document: Doc,
    Original: unknown,
    expectedVersion: number | undefined,
    Map: (Doc: Doc) => unknown
): Promise<unknown> {
    return Db.write(session, (c) => {
        if (expectedVersion === undefined) {
            try {
                Table.insert(c, Id, Document);
                return Original;
            } catch (Err) {
                if (IsDuplicateKeyError(Err)) return undefined;
                throw Err;
            }
        }
        const Row = Table.row(c, Id);
        if (Row === undefined || Row.doc.updateVersion !== expectedVersion) return undefined;
        if (!Table.replaceFrom(c, Row, Document)) return undefined;
        return Map(RoundTrip(Id, Document));
    });
}

export class SqliteEscalationProgressRepository implements EscalationProgressRepository {
    constructor(private readonly db: SqliteDatabase) {}

    private RecordId(userId: string, seasonId: string): string {
        return `${userId}::${seasonId}`;
    }

    private MapDocument(Doc: Doc): EscalationProgressRecord {
        return {
            userId: Doc.userId,
            seasonId: Doc.seasonId,
            escalationLevel: Doc.escalationLevel,
            nextLevelXp: Doc.nextLevelXp,
            talentsProgress: Doc.talentsProgress ?? [],
            unlockProgress: Doc.unlockProgress ?? [],
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async get(userId: string, seasonId: string): Promise<EscalationProgressRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.escalationProgress.get(c, this.RecordId(userId, seasonId));
            return Doc === undefined ? undefined : this.MapDocument(Doc);
        });
    }

    async saveIfVersion(record: EscalationProgressRecord, expectedVersion: number | undefined): Promise<EscalationProgressRecord | undefined> {
        return SaveIfVersion(
            Tables.escalationProgress, this.db, undefined, this.RecordId(record.userId, record.seasonId),
            {
                userId: record.userId,
                seasonId: record.seasonId,
                escalationLevel: record.escalationLevel,
                nextLevelXp: record.nextLevelXp,
                talentsProgress: record.talentsProgress,
                unlockProgress: record.unlockProgress,
                updateVersion: record.updateVersion,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt
            },
            record, expectedVersion, (Doc) => this.MapDocument(Doc)
        ) as Promise<EscalationProgressRecord | undefined>;
    }
}

// One document per account, _id = userId.
export class SqliteBountyStateRepository implements BountyStateRepository {
    constructor(private readonly db: SqliteDatabase) {}

    private MapDocument(Doc: Doc): BountyStateRecord {
        return {
            userId: Doc.userId,
            bounties: Array.isArray(Doc.bounties) ? Doc.bounties : [],
            draftData: Doc.draftData ?? {},
            ...(typeof Doc.dailyRewardCreditedOn === "string" ? { dailyRewardCreditedOn: Doc.dailyRewardCreditedOn } : {}),
            ...(typeof Doc.dailyPremiumDraftGrantedOn === "string" ? { dailyPremiumDraftGrantedOn: Doc.dailyPremiumDraftGrantedOn } : {}),
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async get(userId: string, session?: ClientSession): Promise<BountyStateRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.bountyStates.get(c, userId);
            return Doc === undefined ? undefined : this.MapDocument(Doc);
        });
    }

    async saveIfVersion(record: BountyStateRecord, expectedVersion: number | undefined, session?: ClientSession): Promise<BountyStateRecord | undefined> {
        return SaveIfVersion(
            Tables.bountyStates, this.db, session, record.userId,
            {
                userId: record.userId,
                bounties: record.bounties,
                draftData: record.draftData,
                ...(record.dailyRewardCreditedOn !== undefined ? { dailyRewardCreditedOn: record.dailyRewardCreditedOn } : {}),
                ...(record.dailyPremiumDraftGrantedOn !== undefined ? { dailyPremiumDraftGrantedOn: record.dailyPremiumDraftGrantedOn } : {}),
                updateVersion: record.updateVersion,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt
            },
            record, expectedVersion, (Doc) => this.MapDocument(Doc)
        ) as Promise<BountyStateRecord | undefined>;
    }
}

// One document per account, _id = userId. Cooldown ids are array entries, not field names.
export class SqliteCooldownStateRepository implements CooldownStateRepository {
    constructor(private readonly db: SqliteDatabase) {}

    private MapDocument(Doc: Doc): CooldownStateRecord {
        return {
            userId: Doc.userId,
            entries: Array.isArray(Doc.entries) ? Doc.entries : [],
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async get(userId: string): Promise<CooldownStateRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Doc = Tables.cooldownStates.get(c, userId);
            return Doc === undefined ? undefined : this.MapDocument(Doc);
        });
    }

    async saveIfVersion(record: CooldownStateRecord, expectedVersion: number | undefined): Promise<CooldownStateRecord | undefined> {
        return SaveIfVersion(
            Tables.cooldownStates, this.db, undefined, record.userId,
            {
                userId: record.userId,
                entries: record.entries,
                updateVersion: record.updateVersion,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt
            },
            record, expectedVersion, (Doc) => this.MapDocument(Doc)
        ) as Promise<CooldownStateRecord | undefined>;
    }
}
