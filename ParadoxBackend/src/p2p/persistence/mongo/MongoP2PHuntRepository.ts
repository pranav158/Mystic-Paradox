import { ClientSession } from "mongodb";
import {
    P2PAdmissionTicketRecord,
    P2PHuntRepository,
    P2PHuntSessionRecord,
    P2PHostCapabilityRecord,
    P2PPeerAdmissionRecord,
    P2PSteamLinkRecord,
    P2PTicketConsumeResult,
    P2PControlMessageRecord,
    P2PHostOfferRecord,
    P2PHostPresenceRecord,
    P2PHostReliabilityRecord,
    P2PHuntState,
    P2PHuntTransitionRecord,
    P2PParticipantObservationRecord
} from "../contracts/P2PHuntRepository";
import crypto from "node:crypto";
import { P2PCollections } from "./collections";
import { GetMongoDb } from "../../../persistence/mongo/client";

export class MongoP2PHuntRepository implements P2PHuntRepository {
    async findHunt(sessionId: string, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOne({ _id: sessionId as any }, { session });
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async appendHuntTransition(record: Omit<P2PHuntTransitionRecord, "transitionId">, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        await db.collection(P2PCollections.P2PHuntTransitions).insertOne({
            _id: crypto.randomUUID() as any,
            ...record
        }, { session });
    }

    async findActiveHuntForParty(partyId: string, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOne({ activePartyKey: partyId }, { session });
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async findActiveHuntForAccount(accountId: string, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        // [2026-10-13 realms plan step 5] Newest first. An account can hold two sessions for a while: a recovering
        // dedicated fallback of an earlier party (the game makes a new party id per hunt, so the party-keyed close does
        // not see it) and the hunt it plays now. An unordered findOne returned the old one, so the hub return was not
        // recorded for the RUNNING hunt and its clean end became a missed host lease.
        // [2026-10-13 realms S1] A realm hub is never "the account's hunt": it has no roster, and NoteHubReturn,
        // RestoreP2PCandidate and RecordParticipantObservation must not see it (its members are in realmHubPresence).
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOne({
            activePartyKey: { $type: "string" },
            sessionKind: { $ne: "REALM_HUB" },
            "roster.accountId": accountId
        }, { session, sort: { createdAt: -1 } });
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async createHunt(record: P2PHuntSessionRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { sessionId, ...document } = record;
        await db.collection(P2PCollections.P2PHuntSessions).insertOne({ _id: sessionId as any, ...document }, { session });
    }

    async findRecoverableHuntForAccount(accountId: string, now: string, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOne({
            "roster.accountId": accountId,
            state: "RECOVERING",
            expiresAt: { $gt: now }
        }, { sort: { createdAt: -1 }, session });
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async listLifecycleHunts(states: P2PHuntState[], limit: number, session?: ClientSession): Promise<P2PHuntSessionRecord[]> {
        const db = await GetMongoDb();
        const docs = await db.collection(P2PCollections.P2PHuntSessions)
            .find({ state: { $in: states } }, { session })
            .sort({ createdAt: 1 })
            .limit(limit)
            .toArray();
        return docs.map((doc) => ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord));
    }

    async compareAndSetHunt(input: {
        sessionId: string;
        generation: number;
        expectedStates: P2PHuntState[];
        expectedStateVersion: number;
        set: Partial<P2PHuntSessionRecord>;
        unset?: Array<keyof P2PHuntSessionRecord>;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const unset = Object.fromEntries((input.unset ?? []).map((field) => [field, ""]));
        const update: Record<string, unknown> = {
            $set: input.set,
            $inc: { stateVersion: 1 }
        };
        if (Object.keys(unset).length > 0) update.$unset = unset;
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOneAndUpdate(
            {
                _id: input.sessionId as any,
                generation: input.generation,
                state: { $in: input.expectedStates },
                stateVersion: input.expectedStateVersion
            },
            update,
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async beginHostStartup(input: {
        sessionId: string;
        hostAccountId: string;
        bridgeInstanceId: string;
        metadataNonce: string;
        startupDeadline: string;
        serverUdpPort?: number;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOneAndUpdate(
            {
                _id: input.sessionId as any,
                hostAccountId: input.hostAccountId,
                state: "HOST_OFFERED",
                expiresAt: { $gt: new Date().toISOString() }
            },
            {
                $set: {
                    state: "STARTING",
                    bridgeInstanceId: input.bridgeInstanceId,
                    metadataNonce: input.metadataNonce,
                    startupDeadline: input.startupDeadline,
                    ...(input.serverUdpPort !== undefined ? { serverUdpPort: input.serverUdpPort } : {})
                },
                $unset: { lobbyId: "", leaseExpiresAt: "", suspectSince: "", suspectDeadline: "", preSuspectState: "" },
                $inc: { stateVersion: 1 }
            },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async markHostReady(input: {
        sessionId: string;
        generation: number;
        hostSteamId: string;
        bridgeInstanceId: string;
        lobbyId: string;
        virtualPort: number;
        leaseExpiresAt: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOneAndUpdate(
            {
                _id: input.sessionId as any,
                generation: input.generation,
                hostSteamId: input.hostSteamId,
                bridgeInstanceId: input.bridgeInstanceId,
                virtualPort: input.virtualPort,
                state: { $in: ["STARTING", "HOST_READY"] }
            },
            {
                $set: {
                    state: "HOST_READY",
                    lobbyId: input.lobbyId,
                    leaseExpiresAt: input.leaseExpiresAt,
                    lastHeartbeatAt: new Date().toISOString(),
                    lastLeaseSequence: 0
                },
                $inc: { stateVersion: 1 }
            },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async renewHostLease(input: {
        sessionId: string;
        generation: number;
        hostSteamId: string;
        bridgeInstanceId: string;
        leaseSequence: number;
        heartbeatAt: string;
        leaseExpiresAt: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOneAndUpdate(
            {
                _id: input.sessionId as any,
                generation: input.generation,
                hostSteamId: input.hostSteamId,
                bridgeInstanceId: input.bridgeInstanceId,
                // [2026-10-15] A drained session's server keeps its lease until it ends (BeginDrainPartySession).
                state: { $in: ["HOST_READY", "ADMITTING", "RUNNING", "DRAINING", "SUSPECT"] },
                $or: [
                    { lastLeaseSequence: { $lt: input.leaseSequence } },
                    { lastLeaseSequence: { $exists: false } }
                ]
            },
            {
                $set: {
                    lastLeaseSequence: input.leaseSequence,
                    lastHeartbeatAt: input.heartbeatAt,
                    leaseExpiresAt: input.leaseExpiresAt
                },
                $inc: { stateVersion: 1 }
            },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async findSteamLink(accountId: string, session?: ClientSession): Promise<P2PSteamLinkRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PSteamLinks).findOne({ _id: accountId as any }, { session });
        return doc == undefined ? undefined : ({ ...doc, accountId: String(doc._id) } as unknown as P2PSteamLinkRecord);
    }

    async findSteamLinkBySteamId(steamId: string, session?: ClientSession): Promise<P2PSteamLinkRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PSteamLinks).findOne({ steamId }, { session });
        return doc == undefined ? undefined : ({ ...doc, accountId: String(doc._id) } as unknown as P2PSteamLinkRecord);
    }

    async upsertSteamLink(record: P2PSteamLinkRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { accountId, ...document } = record;
        await db.collection(P2PCollections.P2PSteamLinks).updateOne(
            { _id: accountId as any },
            { $set: document },
            { upsert: true, session }
        );
    }

    async deleteSteamLink(accountId: string, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        await db.collection(P2PCollections.P2PSteamLinks).deleteOne({ _id: accountId as any }, { session });
    }

    async createHostCapability(record: P2PHostCapabilityRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { capabilityId, ...document } = record;
        await db.collection(P2PCollections.P2PHostCapabilities).insertOne({ _id: capabilityId as any, ...document }, { session });
    }

    async findHostCapabilityByDigest(secretDigest: string, session?: ClientSession): Promise<P2PHostCapabilityRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHostCapabilities).findOne({ secretDigest }, { session });
        return doc == undefined ? undefined : ({ ...doc, capabilityId: String(doc._id) } as unknown as P2PHostCapabilityRecord);
    }

    async advanceHostCapabilitySequence(capabilityId: string, sequence: number, session?: ClientSession): Promise<boolean> {
        const db = await GetMongoDb();
        const result = await db.collection(P2PCollections.P2PHostCapabilities).updateOne(
            { _id: capabilityId as any, revokedAt: { $exists: false }, lastSequence: { $lt: sequence } },
            { $set: { lastSequence: sequence } },
            { session }
        );
        return result.modifiedCount === 1;
    }

    async revokeGeneration(sessionId: string, generation: number, revokedAt: string, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        await db.collection(P2PCollections.P2PHostCapabilities).updateMany(
            { sessionId, generation, revokedAt: { $exists: false } },
            { $set: { revokedAt } },
            { session }
        );
    }

    async markParticipantRouteReady(input: {
        sessionId: string;
        generation: number;
        accountId: string;
        steamId: string;
        bridgeInstanceId: string;
        localBridgePort: number;
        readyAt: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOneAndUpdate(
            {
                _id: input.sessionId as any,
                generation: input.generation,
                state: { $in: ["HOST_READY", "ADMITTING", "RUNNING"] },
                roster: { $elemMatch: { accountId: input.accountId, steamId: input.steamId } }
            },
            {
                $set: {
                    "roster.$.localBridgeInstanceId": input.bridgeInstanceId,
                    "roster.$.localBridgePort": input.localBridgePort,
                    "roster.$.localBridgeReadyAt": input.readyAt
                }
            },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async markParticipantAdmitted(input: {
        sessionId: string;
        generation: number;
        accountId: string;
        admittedAt: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOneAndUpdate(
            {
                _id: input.sessionId as any,
                generation: input.generation,
                state: { $in: ["HOST_READY", "ADMITTING", "RUNNING"] },
                "roster.accountId": input.accountId
            },
            {
                $set: {
                    "roster.$.admissionState": "ADMITTED",
                    "roster.$.admittedAt": input.admittedAt
                },
                $unset: { "roster.$.disconnectedAt": "", "roster.$.rejoinDeadline": "" },
                $inc: { stateVersion: 1 }
            },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async createAdmissionTicket(record: P2PAdmissionTicketRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { jtiDigest, ...document } = record;
        await db.collection(P2PCollections.P2PAdmissionTickets).insertOne({ _id: jtiDigest as any, ...document }, { session });
    }

    async revokeAdmissionTickets(sessionId: string, generation: number, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        await db.collection(P2PCollections.P2PAdmissionTickets).updateMany(
            { sessionId, generation, status: "ISSUED" },
            { $set: { status: "REVOKED" } },
            { session }
        );
    }

    async revokeAdmissionTicketsForAccount(sessionId: string, accountId: string, session?: ClientSession): Promise<number> {
        const db = await GetMongoDb();
        const result = await db.collection(P2PCollections.P2PAdmissionTickets).updateMany(
            { sessionId, accountId, status: "ISSUED" },
            { $set: { status: "REVOKED" } },
            { session }
        );
        return result.modifiedCount;
    }

    async reserveParticipantTicket(input: {
        sessionId: string;
        generation: number;
        accountId: string;
        now: string;
        rejoinDeadline: string;
        maxReconnects: number;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOneAndUpdate(
            {
                _id: input.sessionId as any,
                generation: input.generation,
                state: { $in: ["HOST_READY", "ADMITTING", "RUNNING"] },
                roster: {
                    $elemMatch: {
                        accountId: input.accountId,
                        reconnectEpoch: { $lt: input.maxReconnects },
                        $or: [
                            { disconnectedAt: { $exists: false } },
                            { rejoinDeadline: { $gt: input.now } }
                        ]
                    }
                }
            },
            {
                $inc: { "roster.$.reconnectEpoch": 1 },
                $set: {
                    "roster.$.admissionState": "ISSUED",
                    "roster.$.rejoinDeadline": input.rejoinDeadline
                }
            },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async markParticipantDisconnected(input: {
        sessionId: string;
        generation: number;
        accountId: string;
        disconnectedAt: string;
        rejoinDeadline: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHuntSessions).findOneAndUpdate(
            {
                _id: input.sessionId as any,
                generation: input.generation,
                // [2026-10-15] A drained session still records its members' disconnects (no ticket is issued to them).
                state: { $in: ["HOST_READY", "ADMITTING", "RUNNING", "DRAINING", "SUSPECT"] },
                "roster.accountId": input.accountId
            },
            {
                $set: {
                    "roster.$.admissionState": "LOST",
                    "roster.$.disconnectedAt": input.disconnectedAt,
                    "roster.$.rejoinDeadline": input.rejoinDeadline
                }
            },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord);
    }

    async consumeAdmissionTicket(input: {
        jtiDigest: string;
        sessionId: string;
        generation: number;
        accountId: string;
        joinerSteamId: string;
        hostSteamId: string;
        bridgeInstanceId: string;
        requestId: string;
        now: string;
    }, session?: ClientSession): Promise<P2PTicketConsumeResult> {
        const db = await GetMongoDb();
        const collection = db.collection(P2PCollections.P2PAdmissionTickets);
        const consumed = await collection.findOneAndUpdate(
            {
                _id: input.jtiDigest as any,
                status: "ISSUED",
                sessionId: input.sessionId,
                generation: input.generation,
                accountId: input.accountId,
                joinerSteamId: input.joinerSteamId,
                hostSteamId: input.hostSteamId,
                expiresAt: { $gt: input.now }
            },
            {
                $set: {
                    status: "CONSUMED",
                    consumedAt: input.now,
                    consumerBridgeInstanceId: input.bridgeInstanceId,
                    consumerRequestId: input.requestId
                }
            },
            { returnDocument: "after", session }
        );
        if (consumed != undefined) {
            return {
                outcome: "CONSUMED",
                record: { ...consumed, jtiDigest: String(consumed._id) } as unknown as P2PAdmissionTicketRecord
            };
        }

        const existing = await collection.findOne({ _id: input.jtiDigest as any }, { session });
        if (existing == undefined) return { outcome: "INVALID" };
        if (existing.status === "CONSUMED") {
            if (existing.consumerBridgeInstanceId === input.bridgeInstanceId &&
                existing.consumerRequestId === input.requestId &&
                existing.sessionId === input.sessionId &&
                existing.generation === input.generation &&
                existing.joinerSteamId === input.joinerSteamId) {
                return {
                    outcome: "IDEMPOTENT",
                    record: { ...existing, jtiDigest: String(existing._id) } as unknown as P2PAdmissionTicketRecord
                };
            }
            return { outcome: "REPLAY" };
        }
        if (Date.parse(String(existing.expiresAt)) <= Date.parse(input.now)) return { outcome: "EXPIRED" };
        return { outcome: "INVALID" };
    }

    async recordPeerAdmission(record: P2PPeerAdmissionRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { admissionId, ...document } = record;
        await db.collection(P2PCollections.P2PPeerAdmissions).insertOne({ _id: admissionId as any, ...document }, { session });
    }

    async findPeerAdmission(admissionId: string, session?: ClientSession): Promise<P2PPeerAdmissionRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PPeerAdmissions).findOne({ _id: admissionId as any }, { session });
        return doc == undefined ? undefined : ({ ...doc, admissionId: String(doc._id) } as unknown as P2PPeerAdmissionRecord);
    }

    async disconnectPeer(input: {
        admissionId: string;
        sessionId: string;
        generation: number;
        bridgeInstanceId: string;
        disconnectedAt: string;
    }, session?: ClientSession): Promise<boolean> {
        const db = await GetMongoDb();
        const result = await db.collection(P2PCollections.P2PPeerAdmissions).updateOne(
            {
                _id: input.admissionId as any,
                sessionId: input.sessionId,
                generation: input.generation,
                bridgeInstanceId: input.bridgeInstanceId,
                disconnectedAt: { $exists: false }
            },
            {
                $set: { disconnectedAt: input.disconnectedAt },
                $unset: { activeAdmissionKey: "" }
            },
            { session }
        );
        return result.modifiedCount === 1;
    }

    async enqueueControlMessage(
        input: Omit<P2PControlMessageRecord, "messageId" | "sequence">,
        session?: ClientSession
    ): Promise<P2PControlMessageRecord> {
        const db = await GetMongoDb();
        const counter = await db.collection(P2PCollections.P2PControlSequences).findOneAndUpdate(
            { _id: input.accountId as any },
            { $inc: { nextSequence: 1 } },
            { upsert: true, returnDocument: "after", session }
        );
        const record: P2PControlMessageRecord = {
            ...input,
            messageId: crypto.randomUUID(),
            sequence: Number(counter?.nextSequence ?? 1)
        };
        const { messageId, ...document } = record;
        // [2026-10-14] ttlAt: a BSON date of expiresAt for the TTL index (p2p indexes); the business check still reads expiresAt.
        await db.collection(P2PCollections.P2PControlMessages).insertOne({
            _id: messageId as any,
            ...document,
            ttlAt: new Date(Date.parse(record.expiresAt))
        }, { session });
        return record;
    }

    async listControlMessages(accountId: string, afterSequence: number, now: string, limit: number,
        options: { unacknowledgedOnly?: boolean } = {}): Promise<P2PControlMessageRecord[]> {
        const db = await GetMongoDb();
        const docs = await db.collection(P2PCollections.P2PControlMessages).find({
            accountId: { $eq: accountId },
            sequence: { $gt: afterSequence },
            expiresAt: { $gt: now },
            ...(options.unacknowledgedOnly ? { acknowledgedAt: { $exists: false } } : {})
        }).sort({ sequence: 1 }).limit(limit).toArray();
        return docs.map((doc) => ({ ...doc, messageId: String(doc._id) } as unknown as P2PControlMessageRecord));
    }

    async latestControlSequence(accountId: string): Promise<number> {
        const db = await GetMongoDb();
        // enqueueControlMessage stores the last assigned sequence as nextSequence ($inc, returnDocument after).
        const counter = await db.collection(P2PCollections.P2PControlSequences).findOne({ _id: { $eq: accountId as any } });
        const value = Number(counter?.nextSequence ?? 0);
        return Number.isSafeInteger(value) && value > 0 ? value : 0;
    }

    async acknowledgeControlMessage(accountId: string, messageId: string, acknowledgedAt: string): Promise<boolean> {
        const db = await GetMongoDb();
        const result = await db.collection(P2PCollections.P2PControlMessages).updateOne(
            { _id: messageId as any, accountId },
            { $set: { acknowledgedAt } }
        );
        return result.modifiedCount === 1 || result.matchedCount === 1;
    }

    async upsertHostPresence(record: P2PHostPresenceRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { accountId, ...document } = record;
        await db.collection(P2PCollections.P2PHostPresences).updateOne(
            { _id: accountId as any },
            { $set: document },
            { upsert: true, session }
        );
    }

    async listHostPresences(accountIds: string[], observedAfter: string, session?: ClientSession): Promise<P2PHostPresenceRecord[]> {
        const db = await GetMongoDb();
        const docs = await db.collection(P2PCollections.P2PHostPresences).find({
            _id: { $in: accountIds as any[] },
            observedAt: { $gte: observedAfter },
            expiresAt: { $gt: new Date().toISOString() }
        }, { session }).toArray();
        return docs.map((doc) => ({ ...doc, accountId: String(doc._id) } as unknown as P2PHostPresenceRecord));
    }

    // [2026-10-15] A drained hunt has no activePartyKey, so these filters leave it out: it is inactive for its host's one-hunt rule
    // and for its realm's server limit, and it is not listed as a realm hunt. ConfirmsRealmHost uses countRunningRealmServers.
    async countActiveHostSessions(accountId: string, session?: ClientSession): Promise<number> {
        const db = await GetMongoDb();
        return db.collection(P2PCollections.P2PHuntSessions).countDocuments({
            hostAccountId: accountId,
            activePartyKey: { $type: "string" },
            state: { $in: ["HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"] }
        }, { session });
    }

    async countActiveRealmServers(realmId: string, session?: ClientSession): Promise<number> {
        const db = await GetMongoDb();
        return db.collection(P2PCollections.P2PHuntSessions).countDocuments({
            realmId,
            activePartyKey: { $type: "string" },
            state: { $in: ["HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"] }
        }, { session });
    }

    // [2026-10-15] Every realm session whose server still runs on the host's PC, a draining one included (ConfirmsRealmHost).
    async countRunningRealmServers(realmId: string, session?: ClientSession): Promise<number> {
        const db = await GetMongoDb();
        return db.collection(P2PCollections.P2PHuntSessions).countDocuments({
            realmId,
            $or: [
                {
                    activePartyKey: { $type: "string" },
                    state: { $in: ["HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"] }
                },
                { state: "DRAINING" }
            ]
        }, { session });
    }

    async listLiveRealmHunts(realmId: string, hostAccountId: string, session?: ClientSession): Promise<P2PHuntSessionRecord[]> {
        const db = await GetMongoDb();
        const docs = await db.collection(P2PCollections.P2PHuntSessions).find({
            realmId,
            hostAccountId,
            sessionKind: { $ne: "REALM_HUB" },
            activePartyKey: { $type: "string" },
            state: { $in: ["HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"] }
        }, { session }).limit(64).toArray();
        return docs.map((doc) => ({ ...doc, sessionId: String(doc._id) } as unknown as P2PHuntSessionRecord));
    }

    async supersedeActivePeerAdmission(activeAdmissionKey: string, at: string, session?: ClientSession): Promise<boolean> {
        const db = await GetMongoDb();
        const result = await db.collection(P2PCollections.P2PPeerAdmissions).updateOne(
            { activeAdmissionKey },
            { $set: { disconnectedAt: at, supersededAt: at }, $unset: { activeAdmissionKey: "" } },
            { session }
        );
        return result.modifiedCount === 1;
    }

    async findHostReliability(accountId: string, session?: ClientSession): Promise<P2PHostReliabilityRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHostReliability).findOne({ _id: accountId as any }, { session });
        return doc == undefined ? undefined : ({ ...doc, accountId: String(doc._id) } as unknown as P2PHostReliabilityRecord);
    }

    async incrementHostReliability(
        accountId: string,
        increments: Partial<Record<keyof P2PHostReliabilityRecord, number>>,
        now: string,
        cooldownUntil?: string,
        session?: ClientSession
    ): Promise<void> {
        const db = await GetMongoDb();
        const numeric = Object.fromEntries(Object.entries(increments).filter(([, value]) => typeof value === "number"));
        const set: Record<string, string> = { updatedAt: now };
        if (cooldownUntil != undefined) set.cooldownUntil = cooldownUntil;
        await db.collection(P2PCollections.P2PHostReliability).updateOne(
            { _id: accountId as any },
            { $inc: numeric, $set: set, $setOnInsert: { accountId } },
            { upsert: true, session }
        );
    }

    async createHostOffer(record: P2PHostOfferRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { offerId, ...document } = record;
        await db.collection(P2PCollections.P2PHostOffers).insertOne({ _id: offerId as any, ...document }, { session });
    }

    async findHostOffer(offerId: string, session?: ClientSession): Promise<P2PHostOfferRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHostOffers).findOne({ _id: offerId as any }, { session });
        return doc == undefined ? undefined : ({ ...doc, offerId: String(doc._id) } as unknown as P2PHostOfferRecord);
    }

    async listHostOffers(sessionId: string, generation: number, session?: ClientSession): Promise<P2PHostOfferRecord[]> {
        const db = await GetMongoDb();
        const docs = await db.collection(P2PCollections.P2PHostOffers)
            .find({ sessionId, generation }, { session })
            .sort({ rank: 1 })
            .toArray();
        return docs.map((doc) => ({ ...doc, offerId: String(doc._id) } as unknown as P2PHostOfferRecord));
    }

    async updateHostOffer(input: {
        offerId: string;
        accountId: string;
        expectedStatus: P2PHostOfferRecord["status"];
        status: P2PHostOfferRecord["status"];
        respondedAt: string;
        responseReason?: string;
    }, session?: ClientSession): Promise<P2PHostOfferRecord | undefined> {
        const db = await GetMongoDb();
        const doc = await db.collection(P2PCollections.P2PHostOffers).findOneAndUpdate(
            { _id: input.offerId as any, accountId: input.accountId, status: input.expectedStatus },
            { $set: { status: input.status, respondedAt: input.respondedAt, responseReason: input.responseReason } },
            { returnDocument: "after", session }
        );
        return doc == undefined ? undefined : ({ ...doc, offerId: String(doc._id) } as unknown as P2PHostOfferRecord);
    }

    async recordParticipantObservation(record: P2PParticipantObservationRecord, session?: ClientSession): Promise<void> {
        const db = await GetMongoDb();
        const { observationId, ...document } = record;
        await db.collection(P2PCollections.P2PParticipantObservations).insertOne({ _id: observationId as any, ...document }, { session });
    }

    async listRecentParticipantObservations(
        sessionId: string,
        generation: number,
        observedAfter: string,
        session?: ClientSession
    ): Promise<P2PParticipantObservationRecord[]> {
        const db = await GetMongoDb();
        const docs = await db.collection(P2PCollections.P2PParticipantObservations)
            .find({ sessionId, generation, observedAt: { $gte: observedAfter } }, { session })
            .sort({ observedAt: -1 })
            .toArray();
        return docs.map((doc) => ({ ...doc, observationId: String(doc._id) } as unknown as P2PParticipantObservationRecord));
    }
}
