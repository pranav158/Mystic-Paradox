/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession, Collection } from "mongodb";
import { ReadMongoRuntimeConfig } from "../../../config/mongoRuntime";
import { GetMongoClient, GetMongoDb } from "../../../persistence/mongo/client";
import {
    DecideEntryRequest,
    IsPresenceLive,
    PRESENCE_EXPIRING_STATES,
    PRESENCE_LIVE_STATES,
    PRESENCE_TRANSITIONS,
    PresencePurgeAt
} from "../../realm/realmHubRules";
import {
    EntryRequestOutcome,
    HubEntryBatchResult,
    HubEntryRequest,
    RealmHubPresenceRecord,
    RealmHubPresenceState,
    RealmHubRepository
} from "../contracts/RealmHubRepository";
import { P2PCollections } from "./collections";

// [2026-10-13 realms S1] MongoDB implementation of RealmHubRepository, collection realmHubPresence. Row id is
// `${sessionId}:${accountId}`. Every state change is one findOneAndUpdate (or updateMany) whose filter carries the
// transition's from-states (realm/realmHubRules.ts PRESENCE_TRANSITIONS), so racing requests cannot both win; the same
// calls take part in a transaction when given the session. purgeAt is a BSON date (the TTL index needs one) and is turned
// back into an ISO string on read.

const CONNECTION_FIELDS_TO_CLEAR = {
    localBridgePort: "", localBridgeReadyAt: "", admissionId: "", route: "", ticketedAt: "", admittedAt: "",
    lostAt: "", leftAt: "", leftReason: "", purgeAt: ""
} as const;

function RowId(sessionId: string, accountId: string): string {
    return `${sessionId}:${accountId}`;
}

/** The gate document of one hub generation (collection realmHubGates; see requestEntries). */
function GateId(sessionId: string, generation: number): string {
    return `${sessionId}:${generation}`;
}

function ToRecord(doc: any): RealmHubPresenceRecord {
    const { _id, purgeAt, ...rest } = doc;
    const record = { ...rest } as RealmHubPresenceRecord;
    if (purgeAt instanceof Date) record.purgeAt = purgeAt.toISOString();
    return record;
}

function Optional(doc: any): RealmHubPresenceRecord | undefined {
    return doc == undefined ? undefined : ToRecord(doc);
}

export class MongoRealmHubRepository implements RealmHubRepository {
    private async rows(): Promise<Collection> {
        return (await GetMongoDb()).collection(P2PCollections.RealmHubPresence);
    }

    private async gates(): Promise<Collection> {
        return (await GetMongoDb()).collection(P2PCollections.RealmHubGates);
    }

    async requestEntry(input: {
        sessionId: string; generation: number; realmId: string; accountId: string; peerId: string;
        candidateId: string; now: string; expiresAt: string;
    }, session?: ClientSession): Promise<{ record: RealmHubPresenceRecord; outcome: EntryRequestOutcome }> {
        return this.requestEntryRow(input, session);
    }

    /**
     * [realms wave 2, capacity] See RealmHubRepository.requestEntries. The unit is one transaction whose first write is the hub
     * generation's gate document: two units for one hub conflict on it, so one of them is run again on a fresh snapshot and never
     * counts the seats before the other has written its entries. A unit that already runs in the caller's transaction joins it.
     */
    async requestEntries(input: {
        sessionId: string; generation: number; realmId: string; maxPeers: number; entries: HubEntryRequest[];
        now: string; expiresAt: string;
    }, session?: ClientSession): Promise<HubEntryBatchResult> {
        if (session !== undefined) return this.entryBatchInUnit(input, session);
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.inOwnTransaction((own) => this.entryBatchInUnit(input, own));
            } catch (error) {
                // A duplicate key from two first gate writes racing is retried; anything else is the caller's error.
                if ((error as { code?: number }).code !== 11000 || attempt >= 2) throw error;
            }
        }
    }

    private async entryBatchInUnit(input: {
        sessionId: string; generation: number; realmId: string; maxPeers: number; entries: HubEntryRequest[];
        now: string; expiresAt: string;
    }, session: ClientSession): Promise<HubEntryBatchResult> {
        // The gate write must CHANGE the document every time: MongoDB treats an update that leaves a document as it was (two
        // racers setting the same `now`) as a no-op that takes no write lock, so the racers would never conflict and every one
        // would be placed (14 Oct: 16 of 16 racers placed in a 5-seat hub on a real replica set). `$inc` always changes it.
        await (await this.gates()).updateOne(
            { _id: GateId(input.sessionId, input.generation) as any },
            {
                $set: { touchedAt: input.now, purgeAt: new Date(PresencePurgeAt(Date.parse(input.now))) },
                $inc: { entryBatches: 1 },
                $setOnInsert: { sessionId: input.sessionId, generation: input.generation }
            },
            { upsert: true, session }
        );
        const requests = [...new Map(input.entries.map((entry) => [entry.accountId, entry])).values()];
        const live = await (await this.rows()).countDocuments(
            { sessionId: input.sessionId, generation: input.generation, ...LiveAndNotExpired(input.now) }, { session });
        const own = await (await this.rows()).find(
            { _id: { $in: requests.map((entry) => RowId(input.sessionId, entry.accountId)) as any[] } }, { session }).toArray();
        const alreadyLive = new Set(own.map(ToRecord).filter((row) => IsPresenceLive(row, input.now)).map((row) => row.accountId));
        const newcomers = requests.filter((entry) => !alreadyLive.has(entry.accountId)).length;
        if (newcomers > 0 && live + newcomers > input.maxPeers) return { placed: false, reason: "FULL", live, maxPeers: input.maxPeers };
        const entries: Array<{ accountId: string; record: RealmHubPresenceRecord; outcome: EntryRequestOutcome }> = [];
        for (const entry of requests) {
            const { record, outcome } = await this.requestEntryRow({
                sessionId: input.sessionId, generation: input.generation, realmId: input.realmId, accountId: entry.accountId,
                peerId: entry.peerId, candidateId: entry.candidateId, now: input.now, expiresAt: input.expiresAt
            }, session);
            entries.push({ accountId: entry.accountId, record, outcome });
        }
        return { placed: true, entries };
    }

    /** Runs `unit` in a transaction of its own (the same options as MongoUnitOfWork); `unit` must be safe to run again. */
    private async inOwnTransaction<T>(unit: (session: ClientSession) => Promise<T>): Promise<T> {
        const session = (await GetMongoClient()).startSession();
        try {
            let result: T;
            await session.withTransaction(async () => {
                result = await unit(session);
            }, {
                readPreference: "primary",
                readConcern: { level: "majority" },
                writeConcern: { w: "majority" },
                maxCommitTimeMS: ReadMongoRuntimeConfig().transactionMaxCommitTimeMS
            });
            return result!;
        } finally {
            await session.endSession();
        }
    }

    private async requestEntryRow(input: {
        sessionId: string; generation: number; realmId: string; accountId: string; peerId: string;
        candidateId: string; now: string; expiresAt: string;
    }, session?: ClientSession): Promise<{ record: RealmHubPresenceRecord; outcome: EntryRequestOutcome }> {
        const rows = await this.rows();
        const _id = RowId(input.sessionId, input.accountId);
        for (let attempt = 0; attempt < 5; attempt++) {
            const existingDoc = await rows.findOne({ _id: _id as any }, { session });
            const existing = Optional(existingDoc);
            const decision = DecideEntryRequest(existing, input.now);
            if (decision === "CREATE") {
                const fresh = {
                    sessionId: input.sessionId, generation: input.generation, realmId: input.realmId,
                    accountId: input.accountId, peerId: input.peerId, state: "PENDING", candidateId: input.candidateId,
                    entryEpoch: 1, requestedAt: input.now, expiresAt: input.expiresAt
                };
                // An upsert with $setOnInsert never throws on a racing insert of the same row; the loser re-reads.
                const result = await rows.updateOne({ _id: _id as any }, { $setOnInsert: fresh }, { upsert: true, session });
                if (result.upsertedCount === 1) return { record: { ...fresh, state: "PENDING" } as RealmHubPresenceRecord, outcome: "CREATED" };
                continue;
            }
            if (decision === "REUSE") {
                const reused = await rows.findOneAndUpdate(
                    { _id: _id as any, entryEpoch: existing!.entryEpoch, state: { $in: [...PRESENCE_EXPIRING_STATES] } },
                    { $max: { expiresAt: input.expiresAt } },
                    { returnDocument: "after", session }
                );
                if (reused != undefined) return { record: ToRecord(reused), outcome: "REUSED" };
                continue;
            }
            const restarted = await rows.findOneAndUpdate(
                { _id: _id as any, entryEpoch: existing!.entryEpoch },
                {
                    $set: {
                        generation: input.generation, realmId: input.realmId, peerId: input.peerId, state: "PENDING",
                        candidateId: input.candidateId, requestedAt: input.now, expiresAt: input.expiresAt
                    },
                    $unset: CONNECTION_FIELDS_TO_CLEAR,
                    $inc: { entryEpoch: 1 }
                },
                { returnDocument: "after", session }
            );
            if (restarted != undefined) return { record: ToRecord(restarted), outcome: "REENTERED" };
        }
        throw new Error("realm hub entry request kept racing; try again");
    }

    async admitHost(input: {
        sessionId: string; generation: number; realmId: string; accountId: string; peerId: string;
        localBridgePort: number; now: string;
    }, session?: ClientSession): Promise<RealmHubPresenceRecord> {
        const rows = await this.rows();
        const _id = RowId(input.sessionId, input.accountId);
        for (let attempt = 0; attempt < 5; attempt++) {
            const existing = await rows.findOne({ _id: _id as any }, { session });
            const admitted = {
                generation: input.generation, realmId: input.realmId, peerId: input.peerId, state: "ADMITTED",
                localBridgePort: input.localBridgePort, localBridgeReadyAt: input.now, admittedAt: input.now
            };
            if (existing == undefined) {
                const fresh = {
                    sessionId: input.sessionId, accountId: input.accountId, candidateId: `host:${input.sessionId}`,
                    entryEpoch: 1, requestedAt: input.now, expiresAt: input.now, ...admitted
                };
                const result = await rows.updateOne({ _id: _id as any }, { $setOnInsert: fresh }, { upsert: true, session });
                if (result.upsertedCount === 1) return fresh as unknown as RealmHubPresenceRecord;
                continue;
            }
            const updated = await rows.findOneAndUpdate(
                { _id: _id as any, entryEpoch: existing.entryEpoch },
                {
                    $set: admitted,
                    $unset: { ticketedAt: "", lostAt: "", leftAt: "", leftReason: "", purgeAt: "", admissionId: "", route: "" },
                    $inc: { entryEpoch: 1 }
                },
                { returnDocument: "after", session }
            );
            if (updated != undefined) return ToRecord(updated);
        }
        throw new Error("realm hub host admission kept racing; try again");
    }

    async findPresence(sessionId: string, accountId: string, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        return Optional(await (await this.rows()).findOne({ _id: RowId(sessionId, accountId) as any }, { session }));
    }

    async findForAccount(accountId: string, states: readonly RealmHubPresenceState[] = PRESENCE_LIVE_STATES,
        session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const docs = await (await this.rows()).find({ accountId, state: { $in: [...states] } }, { session })
            .sort({ requestedAt: -1 }).limit(1).toArray();
        return Optional(docs[0]);
    }

    async listByState(sessionId: string, generation: number, states: readonly RealmHubPresenceState[], limit: number,
        session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        const docs = await (await this.rows()).find({ sessionId, generation, state: { $in: [...states] } }, { session })
            .sort({ requestedAt: 1 }).limit(limit).toArray();
        return docs.map(ToRecord);
    }

    async countByState(sessionId: string, generation: number, states: readonly RealmHubPresenceState[],
        session?: ClientSession): Promise<number> {
        return (await this.rows()).countDocuments({ sessionId, generation, state: { $in: [...states] } }, { session });
    }

    async markTicketed(input: { sessionId: string; generation: number; accountId: string; now: string; ticketExpiresAt: string },
        session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        return Optional(await (await this.rows()).findOneAndUpdate(
            {
                _id: RowId(input.sessionId, input.accountId) as any, generation: input.generation,
                state: { $in: [...PRESENCE_TRANSITIONS.TICKET_ISSUED.from] }, expiresAt: { $gt: input.now }
            },
            { $set: { state: "TICKETED", ticketedAt: input.now }, $max: { expiresAt: input.ticketExpiresAt } },
            { returnDocument: "after", session }
        ));
    }

    async markRouteReady(input: { sessionId: string; generation: number; accountId: string; localBridgePort: number;
        readyAt: string; now: string }, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        return Optional(await (await this.rows()).findOneAndUpdate(
            { _id: RowId(input.sessionId, input.accountId) as any, generation: input.generation, ...LiveAndNotExpired(input.now) },
            { $set: { localBridgePort: input.localBridgePort, localBridgeReadyAt: input.readyAt } },
            { returnDocument: "after", session }
        ));
    }

    async markAdmitted(input: { sessionId: string; generation: number; accountId: string; admissionId: string;
        admittedAt: string; now: string; route?: "relay" | "direct" }, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const set: Record<string, unknown> = { state: "ADMITTED", admissionId: input.admissionId, admittedAt: input.admittedAt };
        if (input.route !== undefined) set.route = input.route;
        return Optional(await (await this.rows()).findOneAndUpdate(
            { _id: RowId(input.sessionId, input.accountId) as any, generation: input.generation, ...LiveAndNotExpired(input.now) },
            { $set: set, $unset: { lostAt: "", leftAt: "", leftReason: "", purgeAt: "" } },
            { returnDocument: "after", session }
        ));
    }

    async markLost(input: { sessionId: string; generation: number; accountId: string; admissionId?: string; lostAt: string;
        purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const filter: Record<string, unknown> = {
            _id: RowId(input.sessionId, input.accountId), generation: input.generation,
            state: { $in: [...PRESENCE_TRANSITIONS.DISCONNECTED.from] }
        };
        if (input.admissionId !== undefined) filter.admissionId = input.admissionId;
        return Optional(await (await this.rows()).findOneAndUpdate(filter,
            { $set: { state: "LOST", lostAt: input.lostAt, purgeAt: new Date(input.purgeAt) } },
            { returnDocument: "after", session }));
    }

    async markLeft(input: { sessionId: string; generation: number; accountId: string; reason: string; leftAt: string;
        purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        return Optional(await (await this.rows()).findOneAndUpdate(
            {
                _id: RowId(input.sessionId, input.accountId) as any, generation: input.generation,
                state: { $in: [...PRESENCE_TRANSITIONS.TRAVELLED.from] }
            },
            { $set: { state: "LEFT", leftAt: input.leftAt, leftReason: input.reason, purgeAt: new Date(input.purgeAt) } },
            { returnDocument: "after", session }
        ));
    }

    async removeAccountFromRealm(input: { realmId: string; accountId: string; at: string; purgeAt: string },
        session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        return this.bulk({ realmId: input.realmId, accountId: input.accountId },
            PRESENCE_TRANSITIONS.REMOVED.from, { state: "REMOVED", leftAt: input.at, leftReason: "REMOVED", purgeAt: new Date(input.purgeAt) }, session);
    }

    async removeRealm(input: { realmId: string; at: string; purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        return this.bulk({ realmId: input.realmId },
            PRESENCE_TRANSITIONS.REMOVED.from, { state: "REMOVED", leftAt: input.at, leftReason: "REALM_RELEASED", purgeAt: new Date(input.purgeAt) }, session);
    }

    async expireStale(input: { sessionId?: string; now: string; purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        const filter: Record<string, unknown> = { expiresAt: { $lte: input.now } };
        if (input.sessionId !== undefined) filter.sessionId = input.sessionId;
        return this.bulk(filter, PRESENCE_TRANSITIONS.EXPIRED.from, { state: "EXPIRED", purgeAt: new Date(input.purgeAt) }, session);
    }

    async endSession(input: { sessionId: string; generation: number; at: string; purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        return this.bulk({ sessionId: input.sessionId, generation: input.generation },
            PRESENCE_TRANSITIONS.SESSION_ENDED.from, { state: "LOST", lostAt: input.at, purgeAt: new Date(input.purgeAt) }, session);
    }

    /** Reads the rows `filter` selects in the from-states, then moves exactly those to the new state; returns them as they were. */
    private async bulk(filter: Record<string, unknown>, from: readonly RealmHubPresenceState[], set: Record<string, unknown>,
        session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        const rows = await this.rows();
        const selected = { ...filter, state: { $in: [...from] } };
        const before = await rows.find(selected, { session }).limit(10_000).toArray();
        if (before.length === 0) return [];
        await rows.updateMany({ _id: { $in: before.map((doc) => doc._id) }, state: { $in: [...from] } }, { $set: set }, { session });
        return before.map(ToRecord);
    }
}

/** ADMITTED, or waiting (PENDING / TICKETED) and not yet expired. */
function LiveAndNotExpired(now: string): Record<string, unknown> {
    return {
        $or: [
            { state: "ADMITTED" },
            { state: { $in: [...PRESENCE_EXPIRING_STATES] }, expiresAt: { $gt: now } }
        ]
    };
}
