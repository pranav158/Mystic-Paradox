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

import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import { ProgressionTrackRepository } from "../../contracts/ProgressionTrackRepository";
import {
    ProgressionObjectiveEventRecord,
    ProgressionObjectiveRecord,
    ProgressionTrackRecord,
    WeaponReforgeState
} from "../../mapping/domainTypes";
import { Conn, SqliteDatabase } from "../database";
import { Doc, Placeholders, RoundTrip, Stored, StoredRow } from "../docTable";
import { Tables } from "../tables";

function ToTrack(Doc: Doc): ProgressionTrackRecord {
    return {
        userId: Doc.userId,
        progressionId: Doc.progressionId,
        progress: Doc.progress,
        confirmedFremiumRank: Doc.confirmedFremiumRank,
        confirmedPremiumRank: Doc.confirmedPremiumRank,
        updateVersion: Doc.updateVersion,
        createdAt: Doc.createdAt,
        updatedAt: Doc.updatedAt,
        reforge: Doc.reforge ?? undefined,
        prestigeClaimed: Doc.prestigeClaimed ?? undefined
    };
}

function ToObjective(Doc: Doc): ProgressionObjectiveRecord {
    return {
        userId: Doc.userId,
        objectiveId: Doc.objectiveId,
        value: Doc.value,
        completedCount: Doc.completedCount,
        updatedAt: Doc.updatedAt
    };
}

/** MongoDB's $max on a field: the greater of the stored and the given number; a missing or non-number field takes the value. */
function Max(current: unknown, value: number): number {
    return typeof current === "number" && current >= value ? current : value;
}

// Tracks are keyed "userId::progressionId", objectives "userId::objectiveId" (as in MongoDB). Every mutator reads and
// writes the row in one transaction, which is what MongoDB's single-document $inc / $max / filtered updates give: two
// simultaneous kills granting the same amount both land; a stale or replayed write can never lower a value.
export class SqliteProgressionTrackRepository implements ProgressionTrackRepository {
    constructor(private readonly db: SqliteDatabase) {}

    private TrackId(userId: string, progressionId: string): string {
        return `${userId}::${progressionId}`;
    }

    /** The row, or a fresh one (not yet stored) with the insert defaults every upsert here shares. */
    private upsertBase(c: Conn, userId: string, progressionId: string, insertDefaults: Doc, now: string): { id: string; row?: StoredRow; doc: Doc } {
        const Id = this.TrackId(userId, progressionId);
        const Row = Tables.progressionTracks.row(c, Id);
        if (Row !== undefined) return { id: Id, row: Row, doc: { ...Row.doc } };
        return { id: Id, doc: { confirmedFremiumRank: 0, confirmedPremiumRank: 0, createdAt: now, ...insertDefaults } };
    }

    private store(c: Conn, base: { id: string; row?: StoredRow }, doc: Doc): ProgressionTrackRecord {
        if (base.row === undefined) {
            Tables.progressionTracks.insert(c, base.id, doc);
            return ToTrack(RoundTrip(base.id, doc));
        }
        return ToTrack(Tables.progressionTracks.patch(c, base.row, doc));
    }

    async getAllForUser(userId: string): Promise<ProgressionTrackRecord[]> {
        return this.db.read(undefined, (c) => Tables.progressionTracks.find(c, "userId = ?", [userId]).map(ToTrack));
    }

    async get(userId: string, progressionId: string, session?: ClientSession): Promise<ProgressionTrackRecord | undefined> {
        return this.db.read(session, (c) => {
            const Doc = Tables.progressionTracks.get(c, this.TrackId(userId, progressionId));
            return Doc === undefined ? undefined : ToTrack(Doc);
        });
    }

    /** Adds `amount` to progress, creating the row at `amount` if missing; returns the row AFTER the increment. */
    async increment(userId: string, progressionId: string, amount: number, session?: ClientSession): Promise<ProgressionTrackRecord> {
        return this.db.write(session, (c) => {
            const Now = new Date().toISOString();
            const Base = this.upsertBase(c, userId, progressionId, {}, Now);
            const Doc = Base.doc;
            Doc.progress = (typeof Doc.progress === "number" ? Doc.progress : 0) + amount;
            Doc.updateVersion = (typeof Doc.updateVersion === "number" ? Doc.updateVersion : 0) + 1;
            Doc.userId = userId;
            Doc.progressionId = progressionId;
            Doc.updatedAt = Now;
            return this.store(c, Base, Doc);
        });
    }

    /** Monotonic max-guard for progress (MasteryTrack_* absolute values): a stale or reordered write cannot regress it. */
    async setProgressIfGreater(userId: string, progressionId: string, value: number): Promise<ProgressionTrackRecord> {
        return this.db.write(undefined, (c) => {
            const Now = new Date().toISOString();
            const Base = this.upsertBase(c, userId, progressionId, {}, Now);
            const Doc = Base.doc;
            Doc.progress = Max(Doc.progress, value);
            Doc.updateVersion = (typeof Doc.updateVersion === "number" ? Doc.updateVersion : 0) + 1;
            Doc.userId = userId;
            Doc.progressionId = progressionId;
            Doc.updatedAt = Now;
            return this.store(c, Base, Doc);
        });
    }

    /** confirmedFremiumRank with a max-guard; creates the row with progress 0 when missing. */
    async setConfirmedFremiumRank(userId: string, progressionId: string, rank: number): Promise<ProgressionTrackRecord> {
        return this.db.write(undefined, (c) => {
            const Now = new Date().toISOString();
            const Base = this.upsertBase(c, userId, progressionId, { progress: 0 }, Now);
            const Doc = Base.doc;
            Doc.confirmedFremiumRank = Max(Doc.confirmedFremiumRank, rank);
            Doc.updateVersion = (typeof Doc.updateVersion === "number" ? Doc.updateVersion : 0) + 1;
            Doc.userId = userId;
            Doc.progressionId = progressionId;
            Doc.updatedAt = Now;
            return this.store(c, Base, Doc);
        });
    }

    /** Subtracts `amount` only when progress already covers it (never negative); undefined when it did not apply. */
    async spend(userId: string, progressionId: string, amount: number, session?: ClientSession): Promise<ProgressionTrackRecord | undefined> {
        return this.db.write(session, (c) => {
            const Row = Tables.progressionTracks.row(c, this.TrackId(userId, progressionId));
            if (Row === undefined || typeof Row.doc.progress !== "number" || !(Row.doc.progress >= amount)) return undefined;
            return ToTrack(Tables.progressionTracks.patch(c, Row, {
                progress: Row.doc.progress - amount,
                updateVersion: (typeof Row.doc.updateVersion === "number" ? Row.doc.updateVersion : 0) + 1,
                userId,
                progressionId,
                updatedAt: new Date().toISOString()
            }));
        });
    }

    async appendObjectiveEvent(event: ProgressionObjectiveEventRecord): Promise<void> {
        await this.db.write(undefined, (c) => {
            Tables.progressionObjectiveEvents.insert(c, crypto.randomUUID(), {
                userId: event.userId,
                rawBody: event.rawBody,
                receivedAt: event.receivedAt
            });
        });
    }

    async getAllObjectivesForUser(userId: string): Promise<ProgressionObjectiveRecord[]> {
        return this.db.read(undefined, (c) => Tables.progressionObjectives.find(c, "userId = ?", [userId]).map(ToObjective));
    }

    /**
     * Weapon reforge reset: progress and both confirmed ranks to 0 and `reforge` stored, only if the row still holds
     * exactly `expectedProgress` / `expectedVersion` and has no open reforge.
     */
    async beginReforge(userId: string, progressionId: string, expectedProgress: number, expectedVersion: number,
        reforge: WeaponReforgeState): Promise<ProgressionTrackRecord | undefined> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.progressionTracks.row(c, this.TrackId(userId, progressionId));
            if (Row === undefined) return undefined;
            if (Row.doc.progress !== expectedProgress || Row.doc.updateVersion !== expectedVersion || Row.doc.reforge?.status === "open") {
                return undefined;
            }
            return ToTrack(Tables.progressionTracks.patch(c, Row, {
                progress: 0,
                confirmedFremiumRank: 0,
                confirmedPremiumRank: 0,
                reforge,
                updatedAt: reforge.openedAt,
                updateVersion: Row.doc.updateVersion + 1
            }));
        });
    }

    /** Compare-and-set on the stored reforge: applies `set` only if it has `reforgeId` and every `expected` field holds. */
    async updateReforge(userId: string, progressionId: string, reforgeId: string, expected: Partial<WeaponReforgeState>,
        set: Partial<WeaponReforgeState>, session?: ClientSession): Promise<boolean> {
        return this.db.write(session, (c) => {
            const Row = Tables.progressionTracks.row(c, this.TrackId(userId, progressionId));
            const Current = Row?.doc.reforge as Record<string, unknown> | null | undefined;
            if (Row === undefined || Current == undefined || Current.reforgeId !== reforgeId) return false;
            // `{ $eq: undefined }` is stored as null by the driver and matches an absent or null field.
            for (const [Key, Value] of Object.entries(expected)) {
                const Held = Current[Key];
                if (Value === undefined || Value === null ? (Held !== undefined && Held !== null) : Held !== Value) return false;
            }
            const Next: Record<string, unknown> = { ...Current };
            let Modified = false;
            for (const [Key, Value] of Object.entries(set)) {
                const Normalized = Stored(Value);
                if (!(Key in Current) || JSON.stringify(Current[Key]) !== JSON.stringify(Normalized)) Modified = true;
                Next[Key] = Normalized;
            }
            // A $set that changes nothing is not a modification (modifiedCount is 0 in MongoDB).
            if (!Modified) return false;
            Tables.progressionTracks.patch(c, Row, { reforge: Next });
            return true;
        });
    }

    /** Adds `levels` to prestigeClaimed only if it still equals `claimedBefore` and progress is at least `minProgress`. */
    async claimPrestigeLevels(userId: string, progressionId: string, claimedBefore: number, levels: number, minProgress: number,
        session?: ClientSession): Promise<boolean> {
        return this.db.write(session, (c) => {
            const Row = Tables.progressionTracks.row(c, this.TrackId(userId, progressionId));
            if (Row === undefined || typeof Row.doc.progress !== "number" || !(Row.doc.progress >= minProgress)) return false;
            const Claimed = Row.doc.prestigeClaimed;
            const Matches = claimedBefore === 0 ? (Claimed === undefined || Claimed === 0) : Claimed === claimedBefore;
            if (!Matches) return false;
            Tables.progressionTracks.patch(c, Row, {
                prestigeClaimed: (typeof Claimed === "number" ? Claimed : 0) + levels,
                updatedAt: new Date().toISOString()
            });
            return true;
        });
    }

    async getObjectives(userId: string, objectiveIds: string[], session?: ClientSession): Promise<ProgressionObjectiveRecord[]> {
        if (objectiveIds.length === 0) return [];
        return this.db.read(session, (c) => {
            const Ids = objectiveIds.map((ObjectiveId) => `${userId}::${ObjectiveId}`);
            return Tables.progressionObjectives
                .find(c, `_id IN (${Placeholders(Ids.length)}) AND userId = ?`, [...Ids, userId])
                .map(ToObjective);
        });
    }

    /** setObjectiveIfGreater for a whole report in one bulk write (value and completedCount each max-guarded, upsert). */
    async mergeObjectives(userId: string, rows: { objectiveId: string; value: number; completedCount: number }[], session?: ClientSession): Promise<void> {
        if (rows.length === 0) return;
        await this.db.write(session, (c) => {
            const Now = new Date().toISOString();
            for (const Row of rows) this.mergeObjective(c, userId, Row.objectiveId, Row.value, Row.completedCount, Now);
        });
    }

    async setObjectiveIfGreater(userId: string, objectiveId: string, value: number, completedCount: number): Promise<ProgressionObjectiveRecord> {
        return this.db.write(undefined, (c) =>
            this.mergeObjective(c, userId, objectiveId, value, completedCount, new Date().toISOString()));
    }

    private mergeObjective(c: Conn, userId: string, objectiveId: string, value: number, completedCount: number, now: string): ProgressionObjectiveRecord {
        const Id = `${userId}::${objectiveId}`;
        const Row = Tables.progressionObjectives.row(c, Id);
        const Next = {
            value: Max(Row?.doc.value, value),
            completedCount: Max(Row?.doc.completedCount, completedCount),
            userId,
            objectiveId,
            updatedAt: now
        };
        if (Row === undefined) {
            Tables.progressionObjectives.insert(c, Id, Next);
            return ToObjective(RoundTrip(Id, Next));
        }
        return ToObjective(Tables.progressionObjectives.patch(c, Row, Next));
    }
}
