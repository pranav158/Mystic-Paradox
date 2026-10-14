import assert from "node:assert/strict";
import test from "node:test";
import { GetMongoDb, MongoPersistenceLifecycle } from "../../../persistence/mongo/client";
import { P2PHuntSessionRecord } from "../contracts/P2PHuntRepository";
import { RunRealmHubRepositoryContract, at } from "../realmHubRepositoryContract";
import { P2PCollections } from "./collections";
import { EnsureP2PDatabase } from "./indexes";
import { MongoP2PHuntRepository } from "./MongoP2PHuntRepository";
import { MongoRealmHubRepository } from "./MongoRealmHubRepository";

// Opt-in like the other Mongo integration checks: it empties the realm hub collections and creates the p2p indexes, so it runs
// only against an isolated database (ALLOW_DB_INTEGRATION_TESTS=true with a scratch MONGODB_URI and MONGODB_DB, never the
// shared cluster):
//   node --import tsx --test src/p2p/persistence/mongo/realmHubMongo.integration.test.ts
const SKIP = process.env.ALLOW_DB_INTEGRATION_TESTS !== "true"
    && "set ALLOW_DB_INTEGRATION_TESTS=true with an isolated MONGODB_URI and MONGODB_DB";

RunRealmHubRepositoryContract("MongoDB repository", async () => {
    assert.ok(process.env.MONGODB_URI, "MONGODB_URI is required for the isolated integration test");
    assert.ok(process.env.MONGODB_DB, "MONGODB_DB is required for the isolated integration test");
    const db = await GetMongoDb();
    await EnsureP2PDatabase(db);
    return {
        repo: new MongoRealmHubRepository(),
        reset: async () => {
            await db.collection(P2PCollections.RealmHubPresence).deleteMany({});
            await db.collection(P2PCollections.RealmHubGates).deleteMany({});
        }
    };
}, { skip: SKIP });

function Hub(overrides: Partial<P2PHuntSessionRecord> = {}): P2PHuntSessionRecord {
    return {
        sessionId: "hub-1", generation: 1, state: "RUNNING", stateVersion: 3, partyId: "realmhub:r1:ramsgate",
        activePartyKey: "realmhub:r1:ramsgate", partyRevision: 1, huntDefinitionId: "ShatteredIsles_ReturnToRamsgate", build: 647472,
        bridgeProtocol: 1, virtualPort: 1, hostAccountId: "host", hostSteamId: "1", bridgeInstanceId: "bridge", roster: [],
        createdAt: at(0), expiresAt: at(7 * 86_400_000), sessionKind: "REALM_HUB", hubKind: "RAMSGATE", realmId: "r1",
        hostParticipates: true, maxPeers: 16, ...overrides
    };
}

test("MongoDB: the indexes exist, and presence rows carry a BSON purge date inside the database layer only", { skip: SKIP }, async () => {
    const db = await GetMongoDb();
    await EnsureP2PDatabase(db);
    const byKey = (indexes: any[], key: string) => indexes.find((index) => JSON.stringify(index.key) === key);
    const presence = await db.collection(P2PCollections.RealmHubPresence).indexes();
    assert.ok(byKey(presence, '{"sessionId":1,"state":1}'));
    assert.ok(byKey(presence, '{"accountId":1,"state":1}'));
    assert.ok(byKey(presence, '{"realmId":1,"state":1}'));
    assert.equal(byKey(presence, '{"purgeAt":1}')?.expireAfterSeconds, 0);
    const sessions = await db.collection(P2PCollections.P2PHuntSessions).indexes();
    assert.equal(byKey(sessions, '{"activePartyKey":1}')?.unique, true);
    assert.ok(byKey(sessions, '{"realmId":1,"state":1}')?.partialFilterExpression);

    const repo = new MongoRealmHubRepository();
    await db.collection(P2PCollections.RealmHubPresence).deleteMany({});
    await repo.requestEntry({ sessionId: "hub-1", generation: 1, realmId: "r1", accountId: "a", peerId: "p", candidateId: "c", now: at(0), expiresAt: at(90_000) });
    await repo.markAdmitted({ sessionId: "hub-1", generation: 1, accountId: "a", admissionId: "adm", admittedAt: at(1_000), now: at(1_000) });
    await repo.markLost({ sessionId: "hub-1", generation: 1, accountId: "a", lostAt: at(2_000), purgeAt: at(604_800_000) });
    const raw = await db.collection(P2PCollections.RealmHubPresence).findOne({ _id: "hub-1:a" as any });
    assert.ok(raw?.purgeAt instanceof Date, "the TTL index needs a date");
    assert.equal(raw?.purgeAt.toISOString(), at(604_800_000));
    assert.equal(typeof (await repo.findPresence("hub-1", "a"))!.purgeAt, "string");
    await db.collection(P2PCollections.RealmHubPresence).deleteMany({});
});

test("MongoDB: hub sessions - one live hub per realm and kind, never the account's hunt, counted as a realm server, scanned by the monitor", { skip: SKIP }, async () => {
    const db = await GetMongoDb();
    await EnsureP2PDatabase(db);
    const sessions = db.collection(P2PCollections.P2PHuntSessions);
    await sessions.deleteMany({});
    const repo = new MongoP2PHuntRepository();
    await repo.createHunt(Hub());
    await assert.rejects(repo.createHunt(Hub({ sessionId: "hub-2" })), (error: any) => error?.code === 11000,
        "a second live hub of the same kind is a duplicate activePartyKey");
    await repo.createHunt(Hub({ sessionId: "hub-training", hubKind: "TRAINING", activePartyKey: "realmhub:r1:training", partyId: "realmhub:r1:training" }));
    await repo.createHunt(Hub({ sessionId: "hub-other", realmId: "r2", activePartyKey: "realmhub:r2:ramsgate", partyId: "realmhub:r2:ramsgate" }));
    assert.equal((await repo.findActiveHuntForParty("realmhub:r1:ramsgate"))!.sessionId, "hub-1");

    // A hunt of the same realm, with a roster.
    const huntRoster = [{ accountId: "host", steamId: "1", candidateId: "c", reconnectEpoch: 0, admissionState: "ADMITTED" as const }];
    await repo.createHunt({ ...Hub({ sessionId: "hunt-1", sessionKind: undefined, hubKind: undefined, activePartyKey: "party-1", partyId: "party-1",
        huntDefinitionId: "ShatteredIsles_IslandA" }), roster: huntRoster });
    assert.equal((await repo.findActiveHuntForAccount("host"))!.sessionId, "hunt-1", "the hub, which has no roster, is never the account's hunt");
    assert.equal(await repo.findActiveHuntForAccount("nobody"), undefined);
    assert.equal(await repo.countActiveRealmServers("r1"), 3, "the hub, the Training hub and the realm hunt");
    assert.equal(await repo.countActiveRealmServers("r2"), 1);
    assert.equal(await repo.countActiveRealmServers("nope"), 0);
    assert.deepEqual((await repo.listLiveRealmHunts("r1", "host")).map((hunt) => hunt.sessionId), ["hunt-1"]);
    assert.deepEqual((await repo.listLiveRealmHunts("r1", "someone-else")).map((hunt) => hunt.sessionId), []);
    assert.deepEqual((await repo.listLifecycleHunts(["RUNNING"], 10)).map((hunt) => hunt.sessionId).sort(),
        ["hub-1", "hub-other", "hub-training", "hunt-1"], "the lifecycle scan includes hubs");

    // Ending the hub frees its key for the next one.
    const ended = await repo.compareAndSetHunt({ sessionId: "hub-1", generation: 1, expectedStates: ["RUNNING"], expectedStateVersion: 3,
        set: { state: "COMPLETED" }, unset: ["activePartyKey"] });
    assert.equal(ended!.state, "COMPLETED");
    assert.equal(await repo.countActiveRealmServers("r1"), 2);
    await repo.createHunt(Hub({ sessionId: "hub-3", stateVersion: 1 }));
    assert.equal((await repo.findActiveHuntForParty("realmhub:r1:ramsgate"))!.sessionId, "hub-3");
    await sessions.deleteMany({});
});

test("MongoDB: a member's unconsumed tickets are revoked, and a still-connected admission is superseded", { skip: SKIP }, async () => {
    const db = await GetMongoDb();
    const tickets = db.collection(P2PCollections.P2PAdmissionTickets);
    const admissions = db.collection(P2PCollections.P2PPeerAdmissions);
    await tickets.deleteMany({});
    await admissions.deleteMany({});
    const repo = new MongoP2PHuntRepository();
    const ticket = (jtiDigest: string, accountId: string, status: "ISSUED" | "CONSUMED" = "ISSUED") => ({
        jtiDigest, keyId: "k", sessionId: "hub-1", generation: 1, accountId, joinerSteamId: "9", hostSteamId: "1", bridgeProtocol: 1,
        virtualPort: 1, issuedAt: at(0), expiresAt: at(180_000), status
    });
    await repo.createAdmissionTicket(ticket("t1", "a"));
    await repo.createAdmissionTicket(ticket("t2", "a"));
    await repo.createAdmissionTicket(ticket("t3", "a", "CONSUMED"));
    await repo.createAdmissionTicket(ticket("t4", "b"));
    assert.equal(await repo.revokeAdmissionTicketsForAccount("hub-1", "a"), 2);
    assert.equal((await tickets.findOne({ _id: "t1" as any }))!.status, "REVOKED");
    assert.equal((await tickets.findOne({ _id: "t3" as any }))!.status, "CONSUMED");
    assert.equal((await tickets.findOne({ _id: "t4" as any }))!.status, "ISSUED");

    const admission = (admissionId: string) => ({ admissionId, activeAdmissionKey: "hub-1:1:9", sessionId: "hub-1", generation: 1,
        accountId: "a", steamId: "9", bridgeInstanceId: "bridge", connectionHandle: "h", admittedAt: at(0) });
    await repo.recordPeerAdmission(admission("adm-1"));
    await assert.rejects(repo.recordPeerAdmission(admission("adm-2")), (error: any) => error?.code === 11000, "one live connection per peer");
    assert.equal(await repo.supersedeActivePeerAdmission("hub-1:1:9", at(5_000)), true);
    assert.equal(await repo.supersedeActivePeerAdmission("hub-1:1:9", at(6_000)), false);
    await repo.recordPeerAdmission(admission("adm-2"));
    assert.equal((await repo.findPeerAdmission("adm-1"))!.disconnectedAt, at(5_000));
    await tickets.deleteMany({});
    await admissions.deleteMany({});
});

test("MongoDB: close the connection", { skip: SKIP }, async () => {
    await new MongoPersistenceLifecycle().stop();
});
