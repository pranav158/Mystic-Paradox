/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { ActivityDailyKey, ActivityFlagRecord, ActivityFlagStatus, ActivityHuntRecord, ActivityHuntResult, ActivityRepository,
    SlayersPathUnlockRecord } from "../../contracts/ActivityRepository";
import type { SqliteDatabase } from "../database";
import { Doc, RoundTrip } from "../docTable";
import { Tables } from "../tables";

// [2026-10-14] Activity monitor storage for the SQLite provider (same contract as MongoActivityRepository). The daily counters are a
// read-modify-write inside one write transaction (BEGIN IMMEDIATE), as the economy rollups are.
export class SqliteActivityRepository implements ActivityRepository {
    constructor(private readonly db: SqliteDatabase) {}

    async addToDaily(key: ActivityDailyKey, increments: Record<string, number>, ttlAt: Date): Promise<Record<string, any>> {
        const Id = `${key.userId}:${key.day}`;
        return this.db.write(undefined, (c) => {
            const Row = Tables.playerActivityDaily.row(c, Id);
            const Body: Doc = Row ? { ...Row.doc } : { userId: key.userId, day: key.day };
            delete Body._id;
            for (const [Path, Amount] of Object.entries(increments)) AddAtPath(Body, Path, Amount);
            Body.ttlAt = ttlAt.toISOString();
            if (Row) {
                if (!Tables.playerActivityDaily.replaceFrom(c, Row, Body)) {
                    throw new Error(`SQLITE_CONCURRENT_MODIFICATION: playerActivityDaily/${Id} changed during a read-modify-write`);
                }
            } else {
                Tables.playerActivityDaily.insert(c, Id, Body);
            }
            return RoundTrip(Id, Body);
        });
    }

    async findDailyRows(userId: string, fromDay: string, toDay: string, limit: number): Promise<Record<string, any>[]> {
        return this.db.read(undefined, (c) => Tables.playerActivityDaily.find(c, "userId = ? AND day >= ? AND day <= ?", [userId, fromDay, toDay],
            { orderBy: "day ASC", limit }));
    }

    async findDailyRowsInRange(fromDay: string, toDay: string, limit: number): Promise<Record<string, any>[]> {
        return this.db.read(undefined, (c) => Tables.playerActivityDaily.find(c, "day >= ? AND day <= ?", [fromDay, toDay],
            { orderBy: "day ASC", limit }));
    }

    async insertHuntIfAbsent(record: ActivityHuntRecord): Promise<boolean> {
        return this.db.write(undefined, (c) => Tables.activityHunts.insertIfAbsent(c, record._id, record as unknown as Doc));
    }

    async findHunt(id: string): Promise<ActivityHuntRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Row = Tables.activityHunts.get(c, id);
            return Row === undefined ? undefined : (Row as unknown as ActivityHuntRecord);
        });
    }

    async findOpenDedicatedHunts(userId: string): Promise<ActivityHuntRecord[]> {
        return this.db.read(undefined, (c) => Tables.activityHunts.find(c, "userId = ? AND kind = ? AND endedAt IS NULL", [userId, "dedicated"],
            { limit: 50 }) as unknown as ActivityHuntRecord[]);
    }

    async findDedicatedHuntsCovering(userId: string, atIso: string, notBeforeIso: string, graceFloorIso: string): Promise<ActivityHuntRecord[]> {
        return this.db.read(undefined, (c) => Tables.activityHunts.find(c,
            "userId = ? AND kind = ? AND startedAt >= ? AND startedAt <= ? AND (endedAt IS NULL OR endedAt >= ?)",
            [userId, "dedicated", notBeforeIso, atIso, graceFloorIso], { limit: 10 }) as unknown as ActivityHuntRecord[]);
    }

    async closeHuntIfOpen(id: string, close: { endedAt: string; endReason: string; result: ActivityHuntResult }): Promise<boolean> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.activityHunts.row(c, id);
            if (Row === undefined || (Row.doc.endedAt ?? null) !== null) return false;
            Tables.activityHunts.patch(c, Row, { endedAt: close.endedAt, endReason: close.endReason, result: close.result });
            return true;
        });
    }

    async addHuntKills(id: string, kills: number): Promise<void> {
        await this.db.write(undefined, (c) => {
            const Row = Tables.activityHunts.row(c, id);
            if (Row === undefined) return;
            Tables.activityHunts.patch(c, Row, { kills: (Number(Row.doc.kills) || 0) + kills });
        });
    }

    async findHuntsForAccount(userId: string, limit: number): Promise<ActivityHuntRecord[]> {
        return this.db.read(undefined, (c) => Tables.activityHunts.find(c, "userId = ?", [userId], { orderBy: "startedAt DESC", limit }) as unknown as ActivityHuntRecord[]);
    }

    async insertUnlockIfAbsent(record: SlayersPathUnlockRecord): Promise<boolean> {
        return this.db.write(undefined, (c) => Tables.slayersPathUnlocks.insertIfAbsent(c, record._id, record as unknown as Doc));
    }

    async findUnlocksForAccount(userId: string, limit: number): Promise<SlayersPathUnlockRecord[]> {
        return this.db.read(undefined, (c) => Tables.slayersPathUnlocks.find(c, "userId = ?", [userId], { orderBy: "unlockedAt DESC", limit }) as unknown as SlayersPathUnlockRecord[]);
    }

    async insertFlagIfAbsent(record: ActivityFlagRecord): Promise<boolean> {
        return this.db.write(undefined, (c) => Tables.activityFlags.insertIfAbsent(c, record._id, record as unknown as Doc));
    }

    async findFlag(id: string): Promise<ActivityFlagRecord | undefined> {
        return this.db.read(undefined, (c) => {
            const Row = Tables.activityFlags.get(c, id);
            return Row === undefined ? undefined : (Row as unknown as ActivityFlagRecord);
        });
    }

    async listFlags(status: ActivityFlagStatus | "all", skip: number, limit: number): Promise<{ records: ActivityFlagRecord[]; total: number }> {
        return this.db.read(undefined, (c) => {
            const Where = status === "all" ? "" : "status = ?";
            const Params = status === "all" ? [] : [status];
            return {
                records: Tables.activityFlags.find(c, Where, Params, { orderBy: "createdAt DESC", limit, offset: skip }) as unknown as ActivityFlagRecord[],
                total: Tables.activityFlags.count(c, Where, Params)
            };
        });
    }

    async findFlagsForAccount(userId: string, limit: number): Promise<ActivityFlagRecord[]> {
        return this.db.read(undefined, (c) => Tables.activityFlags.find(c, "userId = ?", [userId], { orderBy: "createdAt DESC", limit }) as unknown as ActivityFlagRecord[]);
    }

    async acknowledgeFlag(id: string, by: { actorUserId: string; at: string; note?: string }): Promise<ActivityFlagRecord | undefined> {
        return this.db.write(undefined, (c) => {
            const Row = Tables.activityFlags.row(c, id);
            if (Row === undefined) return undefined;
            if (Row.doc.status !== "open") return Row.doc as unknown as ActivityFlagRecord;
            return Tables.activityFlags.patch(c, Row, {
                status: "acknowledged",
                acknowledgedAt: by.at,
                acknowledgedBy: by.actorUserId,
                ...(by.note ? { note: by.note } : {})
            }) as unknown as ActivityFlagRecord;
        });
    }
}

/** Adds `amount` at a dotted path (creating the objects on the way), as MongoDB's $inc does. */
function AddAtPath(target: Doc, path: string, amount: number): void {
    const Parts = path.split(".");
    let Node: Doc = target;
    for (const Part of Parts.slice(0, -1)) {
        if (typeof Node[Part] !== "object" || Node[Part] === null) Node[Part] = {};
        Node = Node[Part];
    }
    const Last = Parts[Parts.length - 1];
    Node[Last] = (Number(Node[Last]) || 0) + amount;
}
