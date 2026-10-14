/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { ActivityDailyKey, ActivityFlagRecord, ActivityFlagStatus, ActivityHuntRecord, ActivityHuntResult, ActivityRepository,
    SlayersPathUnlockRecord } from "../../contracts/ActivityRepository";
import { GetMongoDb } from "../client";
import { Collections } from "../collections";

// [2026-10-14] Activity monitor storage (src/activity). Inserts that must happen once use an upsert with $setOnInsert, so a repeated
// call inserts nothing (upsertedCount 0) instead of failing on a duplicate key.
export class MongoActivityRepository implements ActivityRepository {
    async addToDaily(key: ActivityDailyKey, increments: Record<string, number>, ttlAt: Date): Promise<Record<string, any>> {
        const Db = await GetMongoDb();
        const Id = `${key.userId}:${key.day}`;
        const Result = await Db.collection(Collections.PlayerActivityDaily).findOneAndUpdate(
            { _id: { $eq: Id as any } },
            {
                $inc: increments as any,
                $set: { ttlAt },
                $setOnInsert: { userId: key.userId, day: key.day }
            },
            { upsert: true, returnDocument: "after" }
        );
        return (Result ?? {}) as Record<string, any>;
    }

    async findDailyRows(userId: string, fromDay: string, toDay: string, limit: number): Promise<Record<string, any>[]> {
        const Db = await GetMongoDb();
        return Db.collection(Collections.PlayerActivityDaily)
            .find({ userId, day: { $gte: fromDay, $lte: toDay } })
            .sort({ day: 1 })
            .limit(limit)
            .toArray() as unknown as Promise<Record<string, any>[]>;
    }

    async findDailyRowsInRange(fromDay: string, toDay: string, limit: number): Promise<Record<string, any>[]> {
        const Db = await GetMongoDb();
        return Db.collection(Collections.PlayerActivityDaily)
            .find({ day: { $gte: fromDay, $lte: toDay } })
            .sort({ day: 1 })
            .limit(limit)
            .toArray() as unknown as Promise<Record<string, any>[]>;
    }

    async insertHuntIfAbsent(record: ActivityHuntRecord): Promise<boolean> {
        const Db = await GetMongoDb();
        const { _id, ...Body } = record;
        const Result = await Db.collection(Collections.ActivityHunts).updateOne(
            { _id: { $eq: _id as any } },
            { $setOnInsert: Body as any },
            { upsert: true }
        );
        return Result.upsertedCount === 1;
    }

    async findHunt(id: string): Promise<ActivityHuntRecord | undefined> {
        const Db = await GetMongoDb();
        const Row = await Db.collection(Collections.ActivityHunts).findOne({ _id: { $eq: id as any } });
        return (Row ?? undefined) as ActivityHuntRecord | undefined;
    }

    async findOpenDedicatedHunts(userId: string): Promise<ActivityHuntRecord[]> {
        const Db = await GetMongoDb();
        return Db.collection(Collections.ActivityHunts)
            .find({ userId, kind: "dedicated", endedAt: { $exists: false } })
            .limit(50)
            .toArray() as unknown as Promise<ActivityHuntRecord[]>;
    }

    async findDedicatedHuntsCovering(userId: string, atIso: string, notBeforeIso: string, graceFloorIso: string): Promise<ActivityHuntRecord[]> {
        const Db = await GetMongoDb();
        return Db.collection(Collections.ActivityHunts)
            .find({
                userId,
                kind: "dedicated",
                startedAt: { $gte: notBeforeIso, $lte: atIso },
                $or: [{ endedAt: { $exists: false } }, { endedAt: { $gte: graceFloorIso } }]
            })
            .limit(10)
            .toArray() as unknown as Promise<ActivityHuntRecord[]>;
    }

    async closeHuntIfOpen(id: string, close: { endedAt: string; endReason: string; result: ActivityHuntResult }): Promise<boolean> {
        const Db = await GetMongoDb();
        const Result = await Db.collection(Collections.ActivityHunts).updateOne(
            { _id: { $eq: id as any }, endedAt: { $exists: false } },
            { $set: { endedAt: close.endedAt, endReason: close.endReason, result: close.result } }
        );
        return Result.modifiedCount === 1;
    }

    async addHuntKills(id: string, kills: number): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.ActivityHunts).updateOne({ _id: { $eq: id as any } }, { $inc: { kills } });
    }

    async findHuntsForAccount(userId: string, limit: number): Promise<ActivityHuntRecord[]> {
        const Db = await GetMongoDb();
        return Db.collection(Collections.ActivityHunts)
            .find({ userId })
            .sort({ startedAt: -1 })
            .limit(limit)
            .toArray() as unknown as Promise<ActivityHuntRecord[]>;
    }

    async insertUnlockIfAbsent(record: SlayersPathUnlockRecord): Promise<boolean> {
        const Db = await GetMongoDb();
        const { _id, ...Body } = record;
        const Result = await Db.collection(Collections.SlayersPathUnlocks).updateOne(
            { _id: { $eq: _id as any } },
            { $setOnInsert: Body as any },
            { upsert: true }
        );
        return Result.upsertedCount === 1;
    }

    async findUnlocksForAccount(userId: string, limit: number): Promise<SlayersPathUnlockRecord[]> {
        const Db = await GetMongoDb();
        return Db.collection(Collections.SlayersPathUnlocks)
            .find({ userId })
            .sort({ unlockedAt: -1 })
            .limit(limit)
            .toArray() as unknown as Promise<SlayersPathUnlockRecord[]>;
    }

    async insertFlagIfAbsent(record: ActivityFlagRecord): Promise<boolean> {
        const Db = await GetMongoDb();
        const { _id, ...Body } = record;
        const Result = await Db.collection(Collections.ActivityFlags).updateOne(
            { _id: { $eq: _id as any } },
            { $setOnInsert: Body as any },
            { upsert: true }
        );
        return Result.upsertedCount === 1;
    }

    async findFlag(id: string): Promise<ActivityFlagRecord | undefined> {
        const Db = await GetMongoDb();
        const Row = await Db.collection(Collections.ActivityFlags).findOne({ _id: { $eq: id as any } });
        return (Row ?? undefined) as ActivityFlagRecord | undefined;
    }

    async listFlags(status: ActivityFlagStatus | "all", skip: number, limit: number): Promise<{ records: ActivityFlagRecord[]; total: number }> {
        const Db = await GetMongoDb();
        const Filter = status === "all" ? {} : { status };
        const Collection = Db.collection(Collections.ActivityFlags);
        const [Records, Total] = await Promise.all([
            Collection.find(Filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
            Collection.countDocuments(Filter)
        ]);
        return { records: Records as unknown as ActivityFlagRecord[], total: Total };
    }

    async findFlagsForAccount(userId: string, limit: number): Promise<ActivityFlagRecord[]> {
        const Db = await GetMongoDb();
        return Db.collection(Collections.ActivityFlags)
            .find({ userId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray() as unknown as Promise<ActivityFlagRecord[]>;
    }

    async acknowledgeFlag(id: string, by: { actorUserId: string; at: string; note?: string }): Promise<ActivityFlagRecord | undefined> {
        const Db = await GetMongoDb();
        const Updated = await Db.collection(Collections.ActivityFlags).findOneAndUpdate(
            { _id: { $eq: id as any }, status: "open" },
            { $set: { status: "acknowledged", acknowledgedAt: by.at, acknowledgedBy: by.actorUserId, ...(by.note ? { note: by.note } : {}) } },
            { returnDocument: "after" }
        );
        if (Updated) return Updated as unknown as ActivityFlagRecord;
        return this.findFlag(id);
    }
}
