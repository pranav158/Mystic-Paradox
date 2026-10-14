import { Db } from "mongodb";
import { Collections } from "../../../persistence/mongo/collections";
import { GetAntiCheatExtension } from "../../antiCheat";
import { P2PCollections } from "./collections";

// Indexes and bootstrap data of the player-hosted hunt module. Called from the shared
// EnsureMongoIndexes before it records the schema version, so a failure here leaves startup retryable.
export async function EnsureP2PDatabase(Db: Db): Promise<void> {
    await GetAntiCheatExtension().server.ensureDatabase(Db);

    // Player-hosted hunt control records. Admission and capability lookups use only digests;
    // raw bearer secrets and ticket JTIs are never indexed or stored.
    await Db.collection(P2PCollections.P2PSteamLinks).createIndex({ steamId: 1 }, { unique: true });
    await Db.collection(P2PCollections.P2PHuntSessions).createIndex(
        { activePartyKey: 1 },
        { unique: true, partialFilterExpression: { activePartyKey: { $type: "string" } } }
    );
    await Db.collection(P2PCollections.P2PHuntSessions).createIndex({ "roster.accountId": 1 });
    await Db.collection(P2PCollections.P2PHuntSessions).createIndex({ createdAt: -1 });
    await Db.collection(P2PCollections.P2PHostCapabilities).createIndex({ secretDigest: 1 }, { unique: true });
    await Db.collection(P2PCollections.P2PHostCapabilities).createIndex({ sessionId: 1, generation: 1 });
    await Db.collection(P2PCollections.P2PAdmissionTickets).createIndex({ sessionId: 1, generation: 1, accountId: 1 });
    await Db.collection(P2PCollections.P2PPeerAdmissions).createIndex(
        { activeAdmissionKey: 1 },
        { unique: true, partialFilterExpression: { activeAdmissionKey: { $type: "string" } } }
    );
    await Db.collection(P2PCollections.P2PControlMessages).createIndex({ accountId: 1, sequence: 1 }, { unique: true });
    await Db.collection(P2PCollections.P2PControlMessages).createIndex({ expiresAt: 1 });
    // [2026-10-14] Control messages are deleted by TTL once expired. A TTL index needs a BSON date, and expiresAt is ISO text
    // (listControlMessages compares it as text), so ttlAt mirrors it (MongoP2PHuntRepository.enqueueControlMessage). Rows written
    // before the mirror existed take it once from expiresAt.
    await Db.collection(P2PCollections.P2PControlMessages).updateMany(
        { ttlAt: { $exists: false } },
        [{ $set: { ttlAt: { $toDate: "$expiresAt" } } }]
    );
    await Db.collection(P2PCollections.P2PControlMessages).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    await Db.collection(P2PCollections.P2PHostPresences).createIndex({ expiresAt: 1 });
    await Db.collection(P2PCollections.P2PHostOffers).createIndex({ sessionId: 1, generation: 1, rank: 1 });
    await Db.collection(P2PCollections.P2PHostOffers).createIndex(
        { sessionId: 1, generation: 1, status: 1 },
        { unique: true, partialFilterExpression: { status: "ACCEPTED" } }
    );
    await Db.collection(P2PCollections.P2PParticipantObservations).createIndex({ sessionId: 1, generation: 1, observedAt: -1 });
    await Db.collection(P2PCollections.P2PParticipantObservations).createIndex({ accountId: 1, observedAt: -1 });
    await Db.collection(P2PCollections.P2PHuntTransitions).createIndex({ sessionId: 1, at: 1, stateVersion: 1 });
    await Db.collection(P2PCollections.P2PHuntSessions).createIndex({ state: 1, offerExpiresAt: 1, startupDeadline: 1, leaseExpiresAt: 1 });
    // [2026-10-13 realms S3] Host write tags: per session (reversal), per player and per host over time (analysis).
    await Db.collection(P2PCollections.P2PHostWrites).createIndex({ sessionId: 1, generation: 1 });
    await Db.collection(P2PCollections.P2PHostWrites).createIndex({ targetUserId: 1, at: -1 });
    await Db.collection(P2PCollections.P2PHostWrites).createIndex({ hostAccountId: 1, at: -1 });
    // [2026-10-14 realms S4] A realm's host writes over time (the realm dashboard, per-realm analysis). Only realm sessions
    // carry realmId; an official hunt's rows index as null here.
    await Db.collection(P2PCollections.P2PHostWrites).createIndex({ realmId: 1, at: -1 });
    // [2026-10-14] Per-hunt XP summaries: by hunt, by member over time, and the TTL purge (about 400 days).
    await Db.collection(P2PCollections.P2PHuntXpSummaries).createIndex({ sessionId: 1 });
    await Db.collection(P2PCollections.P2PHuntXpSummaries).createIndex({ member: 1, endedAt: -1 });
    await Db.collection(P2PCollections.P2PHuntXpSummaries).createIndex({ ttlAt: 1 }, { expireAfterSeconds: 0 });
    // [2026-10-13 realms S1] A realm's live sessions (countActiveRealmServers), and the hub presence rows: by hub and state
    // (the host's peer list, the present count), by account (restoring a candidate), by realm (kick, ban, release); rows
    // are deleted by the TTL index a week after they stopped being live (purgeAt, a BSON date, is cleanup only).
    await Db.collection(P2PCollections.P2PHuntSessions).createIndex(
        { realmId: 1, state: 1 },
        { partialFilterExpression: { realmId: { $type: "string" } } }
    );
    await Db.collection(P2PCollections.RealmHubPresence).createIndex({ sessionId: 1, state: 1 });
    await Db.collection(P2PCollections.RealmHubPresence).createIndex({ accountId: 1, state: 1 });
    await Db.collection(P2PCollections.RealmHubPresence).createIndex({ realmId: 1, state: 1 });
    await Db.collection(P2PCollections.RealmHubPresence).createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    // Hub seat gates (requestEntries): storage cleanup only; the gate is re-created by the next entry.
    await Db.collection(P2PCollections.RealmHubGates).createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    // Distributed Guard windows expire after their fixed window; TTL is storage cleanup only.
    await Db.collection(P2PCollections.GuardTrafficWindows).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // P2P monitor data is embedded in the existing idempotency ledger completion, so it adds no
    // new event collection or retention job. This compound index supports recent additions for
    // the bounded set of recent hunt sessions.
    await Db.collection(Collections.InventoryTransactions).createIndex({
        "p2pMonitor.sessionId": 1, "p2pMonitor.generation": 1, "p2pMonitor.createdAt": -1
    });
    // Economic invariant alerts are durable operator work items. Keep open alerts
    // queryable for the authenticated operations overview; they are acknowledged
    // explicitly and are not TTL-deleted as an implicit loss of evidence.
    await Db.collection(P2PCollections.OperationsAlerts).createIndex({ status: 1, createdAt: -1 });
    // Delivery claims are independently leased. These fields coordinate bounded
    // retries; delivered alerts remain available for audit and are never TTL-deleted.
    await Db.collection(P2PCollections.OperationsAlerts).createIndex({
        status: 1, deliveryState: 1, deliveryNextAttemptAt: 1, deliveryLeaseUntil: 1, createdAt: 1
    });
}
