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
import { GetMongoDb } from "../client";
import { Collections } from "../collections";
import { ProgressionTrackRepository } from "../../contracts/ProgressionTrackRepository";
import { ProgressionTrackRecord, ProgressionObjectiveEventRecord, ProgressionObjectiveRecord } from "../../mapping/domainTypes";

// WP-1 (Plans/PROGRESSION_XP_COMBAT_DATA_IMPLEMENTATION_PLAN.md section 5.1/16). _id is the
// composite "userId::progressionId" string — Mongo has no native composite-key _id without a
// nested-document key, and a flat string _id is simplest to reason about for a unique
// {userId, progressionId} pair while still supporting the plan's required unique index shape
// (a secondary compound index is ALSO created in indexes.ts so lookups by userId alone stay
// fast without depending on _id's internal format).
//
// increment() uses $inc, which MongoDB documents as atomic on a single document (plan section
// 11.3: "For Mongo use atomic $inc" for concurrent-grant safety) — this is deliberately NOT a
// read-modify-write like the wallet/inventory JSON-blob repositories, because two legitimate
// simultaneous kills granting the identical amount must both land (plan section 7.2: never
// dedupe by amount+short-time-window).
export class MongoProgressionTrackRepository implements ProgressionTrackRepository {
    private TrackId(userId: string, progressionId: string): string {
        return `${userId}::${progressionId}`;
    }

    async getAllForUser(userId: string): Promise<ProgressionTrackRecord[]> {
        const Db = await GetMongoDb();
        const Docs = await Db.collection(Collections.ProgressionTracks).find({ userId }).toArray();

        return Docs.map((Doc) => ({
            userId: Doc.userId,
            progressionId: Doc.progressionId,
            progress: Doc.progress,
            confirmedFremiumRank: Doc.confirmedFremiumRank,
            confirmedPremiumRank: Doc.confirmedPremiumRank,
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        }));
    }

    async get(userId: string, progressionId: string, session?: ClientSession): Promise<ProgressionTrackRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.ProgressionTracks).findOne({ _id: this.TrackId(userId, progressionId) as any }, { session });

        if (Doc == undefined) {
            return undefined;
        }

        return {
            userId: Doc.userId,
            progressionId: Doc.progressionId,
            progress: Doc.progress,
            confirmedFremiumRank: Doc.confirmedFremiumRank,
            confirmedPremiumRank: Doc.confirmedPremiumRank,
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async increment(userId: string, progressionId: string, amount: number, session?: ClientSession): Promise<ProgressionTrackRecord> {
        const Db = await GetMongoDb();
        const Now = new Date().toISOString();
        const Id = this.TrackId(userId, progressionId);

        // findOneAndUpdate with upsert:true + $inc is atomic even on first-creation: if two
        // concurrent requests race to create the same track, MongoDB guarantees only one insert
        // succeeds and the other's $inc applies to the just-created document (no lost update).
        const Result = await Db.collection(Collections.ProgressionTracks).findOneAndUpdate(
            { _id: Id as any },
            {
                $inc: { progress: amount, updateVersion: 1 },
                $set: { userId, progressionId, updatedAt: Now },
                $setOnInsert: {
                    confirmedFremiumRank: 0,
                    confirmedPremiumRank: 0,
                    createdAt: Now
                }
            },
            { upsert: true, returnDocument: "after", session }
        );

        const Doc = Result as any;

        if (Doc == undefined) {
            // Should be unreachable with upsert:true, but keeps the return type honest rather
            // than asserting past a theoretical null from the driver.
            throw new Error(`ProgressionTrack upsert for ${Id} unexpectedly returned no document.`);
        }

        return {
            userId: Doc.userId,
            progressionId: Doc.progressionId,
            progress: Doc.progress,
            confirmedFremiumRank: Doc.confirmedFremiumRank,
            confirmedPremiumRank: Doc.confirmedPremiumRank,
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async setProgressIfGreater(userId: string, progressionId: string, value: number): Promise<ProgressionTrackRecord> {
        const Db = await GetMongoDb();
        const Now = new Date().toISOString();
        const Id = this.TrackId(userId, progressionId);

        // $max is Mongo's native atomic "set field to the greater of its current value and the
        // given value" operator — exactly the monotonic max-guard rule proven from real traffic
        // (see ProgressionObjectiveRecord's doc comment), with no read-then-compare race window.
        const Result = await Db.collection(Collections.ProgressionTracks).findOneAndUpdate(
            { _id: Id as any },
            {
                $max: { progress: value },
                $set: { userId, progressionId, updatedAt: Now },
                $inc: { updateVersion: 1 },
                $setOnInsert: {
                    confirmedFremiumRank: 0,
                    confirmedPremiumRank: 0,
                    createdAt: Now
                }
            },
            { upsert: true, returnDocument: "after" }
        );

        const Doc = Result as any;
        if (Doc == undefined) {
            throw new Error(`ProgressionTrack setProgressIfGreater upsert for ${Id} unexpectedly returned no document.`);
        }

        return {
            userId: Doc.userId,
            progressionId: Doc.progressionId,
            progress: Doc.progress,
            confirmedFremiumRank: Doc.confirmedFremiumRank,
            confirmedPremiumRank: Doc.confirmedPremiumRank,
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async setConfirmedFremiumRank(userId: string, progressionId: string, rank: number): Promise<ProgressionTrackRecord> {
        const Db = await GetMongoDb();
        const Now = new Date().toISOString();
        const Id = this.TrackId(userId, progressionId);

        // [stage 4 fix] $max instead of $set — a stale/replayed confirm (e.g. out-of-order
        // network retry) can never LOWER an already-higher confirmed rank. The controller
        // (ConfirmPublicProgressionRank) has already validated `rank` is in-range and the
        // account's persisted XP qualifies for it before this is called; $max is the second
        // layer, guarding against replay/reordering, not against a malicious rank value.
        const Result = await Db.collection(Collections.ProgressionTracks).findOneAndUpdate(
            { _id: Id as any },
            {
                $max: { confirmedFremiumRank: rank },
                $set: { userId, progressionId, updatedAt: Now },
                $inc: { updateVersion: 1 },
                $setOnInsert: {
                    progress: 0,
                    confirmedPremiumRank: 0,
                    createdAt: Now
                }
            },
            { upsert: true, returnDocument: "after" }
        );

        const Doc = Result as any;
        if (Doc == undefined) {
            throw new Error(`ProgressionTrack setConfirmedFremiumRank upsert for ${Id} unexpectedly returned no document.`);
        }

        return {
            userId: Doc.userId,
            progressionId: Doc.progressionId,
            progress: Doc.progress,
            confirmedFremiumRank: Doc.confirmedFremiumRank,
            confirmedPremiumRank: Doc.confirmedPremiumRank,
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async spend(userId: string, progressionId: string, amount: number, session?: ClientSession): Promise<ProgressionTrackRecord | undefined> {
        const Db = await GetMongoDb();
        const Now = new Date().toISOString();
        const Id = this.TrackId(userId, progressionId);

        // Same overspend-guard shape as WalletRepository.incrementBalance: the filter only matches
        // (and therefore only applies the $inc) when progress is already >= amount, so this can
        // never drive progress negative and never needs a separate read-then-write race window.
        const Result = await Db.collection(Collections.ProgressionTracks).findOneAndUpdate(
            { _id: Id as any, progress: { $gte: amount } },
            {
                $inc: { progress: -amount, updateVersion: 1 },
                $set: { userId, progressionId, updatedAt: Now }
            },
            { session, returnDocument: "after" }
        );

        const Doc = Result as any;
        if (Doc == undefined) {
            return undefined;
        }

        return {
            userId: Doc.userId,
            progressionId: Doc.progressionId,
            progress: Doc.progress,
            confirmedFremiumRank: Doc.confirmedFremiumRank,
            confirmedPremiumRank: Doc.confirmedPremiumRank,
            updateVersion: Doc.updateVersion,
            createdAt: Doc.createdAt,
            updatedAt: Doc.updatedAt
        };
    }

    async appendObjectiveEvent(event: ProgressionObjectiveEventRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.ProgressionObjectiveEvents).insertOne({
            userId: event.userId,
            rawBody: event.rawBody,
            receivedAt: event.receivedAt
        });
    }

    async getAllObjectivesForUser(userId: string): Promise<ProgressionObjectiveRecord[]> {
        const Db = await GetMongoDb();
        const Docs = await Db.collection(Collections.ProgressionObjectives).find({ userId }).toArray();

        return Docs.map((Doc) => ({
            userId: Doc.userId,
            objectiveId: Doc.objectiveId,
            value: Doc.value,
            completedCount: Doc.completedCount,
            updatedAt: Doc.updatedAt
        }));
    }

    async setObjectiveIfGreater(userId: string, objectiveId: string, value: number, completedCount: number): Promise<ProgressionObjectiveRecord> {
        const Db = await GetMongoDb();
        const Now = new Date().toISOString();
        const Id = `${userId}::${objectiveId}`;

        const Result = await Db.collection(Collections.ProgressionObjectives).findOneAndUpdate(
            { _id: Id as any },
            {
                $max: { value, completedCount },
                $set: { userId, objectiveId, updatedAt: Now }
            },
            { upsert: true, returnDocument: "after" }
        );

        const Doc = Result as any;
        if (Doc == undefined) {
            throw new Error(`ProgressionObjective setObjectiveIfGreater upsert for ${Id} unexpectedly returned no document.`);
        }

        return {
            userId: Doc.userId,
            objectiveId: Doc.objectiveId,
            value: Doc.value,
            completedCount: Doc.completedCount,
            updatedAt: Doc.updatedAt
        };
    }
}
