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
import { ProgressionTrackRepository } from "../../contracts/ProgressionTrackRepository";
import { ProgressionTrackRecord, ProgressionObjectiveEventRecord, ProgressionObjectiveRecord } from "../../mapping/domainTypes";













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

    async get(userId: string, progressionId: string): Promise<ProgressionTrackRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.ProgressionTracks).findOne({ _id: this.TrackId(userId, progressionId) as any });

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

    async increment(userId: string, progressionId: string, amount: number): Promise<ProgressionTrackRecord> {
        const Db = await GetMongoDb();
        const Now = new Date().toISOString();
        const Id = this.TrackId(userId, progressionId);

        
        
        
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
            { upsert: true, returnDocument: "after" }
        );

        const Doc = Result as any;

        if (Doc == undefined) {
            
            
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
