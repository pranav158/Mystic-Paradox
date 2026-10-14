import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { GetMongoDb, MongoPersistenceLifecycle } from "../../persistence/mongo/client";
import { Collections } from "../../persistence/mongo/collections";
import { ConsumeAdmissionTicket, MarkHostReady, RecordPeerDisconnected } from "../controllers/p2pAdmission";
import { P2PHuntLifecycleMonitor, RenewHostLease } from "../controllers/p2pHostLifecycle";
import { CreateHostBootstrap, CreateJoinBootstrap, MarkLocalRouteReady } from "../controllers/p2pLauncher";
import { ListHubPeers } from "../controllers/realmHubAdmission";
import { CreateRealmHubSession, StopRealmHubSession } from "../controllers/realmHubLifecycle";
import { GetP2PRepositories } from "../persistence";
import { P2PCollections } from "../persistence/mongo/collections";
import { EnsureP2PDatabase } from "../persistence/mongo/indexes";
import { HashHostCapabilitySecret, ListHubPresentAccounts } from "../security/hostCapabilities";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { FakeRealms, HOST, InstallHubTestEnvironment, REALM_ID } from "./realmHubTestKit";
import { SetRealmsPort } from "./realmsPort";

// The hub flow over a real MongoDB: transactions, the unique live-hub key, concurrent entries. Opt-in like the other Mongo
// integration checks, and for the same reason it needs an isolated database - and a replica set, because the P2P controllers
// run in transactions (a single-node replica set is enough):
//   ALLOW_DB_INTEGRATION_TESTS=true MONGODB_URI="mongodb://127.0.0.1:27991/?replicaSet=rs0" MONGODB_DB=scratch \
//     node --import tsx --test src/p2p/realm/realmHubMongoFlow.integration.test.ts
const SKIP = process.env.ALLOW_DB_INTEGRATION_TESTS !== "true"
    && "set ALLOW_DB_INTEGRATION_TESTS=true with an isolated replica set MONGODB_URI and MONGODB_DB";

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
let restoreEnvironment: () => void;
let realms: FakeRealms;

const COLLECTIONS = [P2PCollections.P2PHuntSessions, P2PCollections.P2PSteamLinks, P2PCollections.P2PHostCapabilities,
    P2PCollections.P2PAdmissionTickets, P2PCollections.P2PPeerAdmissions, P2PCollections.P2PControlMessages,
    P2PCollections.P2PControlSequences, P2PCollections.P2PHostPresences, P2PCollections.P2PHostOffers,
    P2PCollections.P2PHostReliability, P2PCollections.P2PHuntTransitions, P2PCollections.RealmHubPresence,
    P2PCollections.RealmHubGates];

async function Reset(): Promise<void> {
    const db = await GetMongoDb();
    for (const name of COLLECTIONS) await db.collection(name).deleteMany({});
    await db.collection(Collections.OperationsPolicy).deleteMany({});
    await db.collection(Collections.OperationsPolicy).insertOne({ _id: "global" as any, guardEnforcement: "ENFORCE", diagnosticsProfile: "PRODUCTION", version: 0 });
}

async function SeedAccount(accountId: string): Promise<void> {
    await GetP2PRepositories().p2pHunts.upsertSteamLink({
        accountId, steamId: DeriveIcePeerId(accountId), status: "VERIFIED", revision: 1, verifiedAt: iso(), lastUsedAt: iso(), verificationMethod: "ICE_ACCOUNT_DERIVED"
    });
}

async function SeedHost(): Promise<void> {
    const hash = "a".repeat(64);
    await SeedAccount(HOST);
    await GetP2PRepositories().p2pHunts.upsertHostPresence({
        accountId: HOST, revision: 1, consentToHost: true, observedAt: iso(), expiresAt: iso(25_000), freePhysicalMemoryMiB: 16384, commitHeadroomMiB: 16384,
        logicalCpuCount: 8, cpuLoadPercent: 10, powerSaver: false, runtimeSupported: true, steamRuntimeReady: true, steamId: DeriveIcePeerId(HOST),
        backendRttMs: 30, worstPeerRttMs: 30, jitterMs: 3, packetLossPercent: 0,
        artifacts: { gameExe: hash, internalServer: hash, winmmProxy: hash, steamBridge: hash, steamRuntime: hash, admissionPublicKey: hash },
        artifactsVerified: true, launcherVersion: "0.1.55", guardVerified: true
    });
}

before(async () => {
    if (SKIP) return;
    assert.ok(process.env.MONGODB_URI, "MONGODB_URI is required for the isolated integration test");
    assert.ok(process.env.MONGODB_DB, "MONGODB_DB is required for the isolated integration test");
    restoreEnvironment = InstallHubTestEnvironment();
    await EnsureP2PDatabase(await GetMongoDb());
    realms = new FakeRealms();
    SetRealmsPort(realms);
});

after(async () => {
    if (SKIP) return;
    SetRealmsPort(undefined);
    await Reset();
    restoreEnvironment();
    await new MongoPersistenceLifecycle().stop();
});

async function StartHub() {
    const started = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE", maxPlayers: 32 });
    const bootstrap = await CreateHostBootstrap(HOST, started.sessionId);
    const repos = GetP2PRepositories();
    const capability = (await repos.p2pHunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
    await MarkHostReady({ sessionId: started.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
        bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
    await MarkLocalRouteReady(HOST, started.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId, localHost: "127.0.0.1", localPort: 55123 });
    return { sessionId: started.sessionId, bootstrap, capability };
}

async function Admit(hub: Awaited<ReturnType<typeof StartHub>>, accountId: string) {
    const repos = GetP2PRepositories();
    realms.members.add(`${REALM_ID}:${accountId}`);
    await SeedAccount(accountId);
    await repos.realmHub.requestEntry({ sessionId: hub.sessionId, generation: 1, realmId: REALM_ID, accountId, peerId: DeriveIcePeerId(accountId),
        candidateId: crypto.randomUUID(), now: iso(), expiresAt: iso(90_000) });
    const join = await CreateJoinBootstrap(accountId, hub.sessionId);
    return ConsumeAdmissionTicket({ sessionId: hub.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(accountId),
        bridgeInstanceId: hub.bootstrap.bridgeInstanceId, connectionHandle: "h", requestId: crypto.randomUUID(), capability: hub.capability });
}

test("MongoDB flow: a hub from offer to RUNNING, members in and out, a lapsed host, the end", { skip: SKIP }, async () => {
    await Reset();
    realms = new FakeRealms();
    realms.addRealm({ realmId: REALM_ID, hostAccountId: HOST, name: "friends" });
    SetRealmsPort(realms);
    await SeedHost();
    const repos = GetP2PRepositories();

    const hub = await StartHub();
    const record = (await repos.p2pHunts.findHunt(hub.sessionId))!;
    assert.equal(record.state, "RUNNING");
    assert.equal(record.sessionKind, "REALM_HUB");
    assert.equal(record.hostLocalBridgePort, 55123);
    assert.equal(record.startupDeadline, undefined);
    assert.equal((await repos.realmHub.findPresence(hub.sessionId, HOST))!.state, "ADMITTED");
    assert.equal((await repos.p2pHunts.findActiveHuntForAccount(HOST)), undefined);
    assert.deepEqual(realms.shown(REALM_ID), { hubState: "RUNNING", hubSessionId: hub.sessionId, activeServers: 1 });

    // One live hub per kind: a second start - also two at once - is REALM_HUB_EXISTS and creates nothing.
    const racing = await Promise.allSettled([CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" }), CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" })]);
    assert.deepEqual(racing.map((outcome) => outcome.status === "rejected" ? (outcome.reason as any).code : "ok"), ["REALM_HUB_EXISTS", "REALM_HUB_EXISTS"]);
    assert.equal(await repos.p2pHunts.countActiveRealmServers(REALM_ID), 1);

    // A dozen members enter at once (tickets, consume, presence), none of them touching the session document.
    const version = (await repos.p2pHunts.findHunt(hub.sessionId))!.stateVersion;
    const accounts = Array.from({ length: 12 }, (_, index) => `mongo-member-${String(index).padStart(2, "0")}-account`);
    const admitted = await Promise.all(accounts.map((account) => Admit(hub, account)));
    assert.ok(admitted.every((entry) => entry.admitted));
    assert.equal((await repos.p2pHunts.findHunt(hub.sessionId))!.stateVersion, version);
    assert.deepEqual((await ListHubPresentAccounts(hub.sessionId, 1)).sort(), [HOST, ...accounts].sort());
    const peers = await ListHubPeers(HOST, hub.sessionId, { generation: 1 });
    assert.equal(peers.peers.length, 12);

    // A member's link drops; the same member comes back before the host reported it (supersede), then a late report of the old link.
    const first = admitted[0];
    assert.deepEqual(await RecordPeerDisconnected({ admissionId: first.admissionId, capability: hub.capability }), { disconnected: true });
    assert.equal((await repos.realmHub.findPresence(hub.sessionId, accounts[0]))!.state, "LOST");
    const again = await Admit(hub, accounts[0]);
    const twice = await Admit(hub, accounts[0]);     // re-entry without any disconnect in between
    assert.notEqual(twice.admissionId, again.admissionId);
    assert.deepEqual(await RecordPeerDisconnected({ admissionId: again.admissionId, capability: hub.capability }), { disconnected: false });
    assert.equal((await repos.realmHub.findPresence(hub.sessionId, accounts[0]))!.state, "ADMITTED");

    // The lease: it takes the hub's peer count; a missed lease makes it SUSPECT, a renewal brings it back; the monitor ends a lost host.
    assert.equal((await RenewHostLease(hub.capability, { leaseSequence: 1, bridgeAlive: true, serverReady: true, admittedPeerCount: 13, queuePressure: 0 })).renewed, true);
    const sessions = (await GetMongoDb()).collection(P2PCollections.P2PHuntSessions);
    await sessions.updateOne({ _id: hub.sessionId as any }, { $set: { leaseExpiresAt: iso(-1000) } });
    const monitor = new P2PHuntLifecycleMonitor();
    await monitor.tick();
    assert.equal((await repos.p2pHunts.findHunt(hub.sessionId))!.state, "SUSPECT");
    await RenewHostLease(hub.capability, { leaseSequence: 2, bridgeAlive: true, serverReady: true, admittedPeerCount: 13, queuePressure: 0 });
    await monitor.tick();
    assert.equal((await repos.p2pHunts.findHunt(hub.sessionId))!.state, "RUNNING");
    await sessions.updateOne({ _id: hub.sessionId as any }, { $set: { leaseExpiresAt: iso(-1000) } });
    await monitor.tick();
    await sessions.updateOne({ _id: hub.sessionId as any }, { $set: { suspectDeadline: iso(-1000) } });
    await monitor.tick();
    const ended = (await repos.p2pHunts.findHunt(hub.sessionId))!;
    assert.equal(ended.state, "ABORTED");
    assert.equal(ended.failureReason, "HOST_LEASE_LOST");
    assert.equal(ended.activePartyKey, undefined);
    assert.equal(await repos.realmHub.countByState(hub.sessionId, 1, ["PENDING", "TICKETED", "ADMITTED"]), 0);
    const leave = await (await GetMongoDb()).collection(P2PCollections.P2PControlMessages).countDocuments({ messageType: "REALM_SESSION_LEAVE" });
    assert.equal(leave, 12);
    assert.ok((await repos.p2pHunts.findHostCapabilityByDigest(HashHostCapabilitySecret(hub.bootstrap.capability)))!.revokedAt);
    assert.deepEqual(realms.shown(REALM_ID), { hubState: "NONE", hubSessionId: null, activeServers: 0 });
    assert.deepEqual(realms.offline, [REALM_ID]);

    // The key is free. Two starts at once on a free key: exactly one creates the hub; the other meets the unique index inside its
    // transaction (or the early check) and answers REALM_HUB_EXISTS.
    const race = await Promise.allSettled([CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" }), CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" })]);
    assert.deepEqual(race.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
    assert.equal((race.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason.code, "REALM_HUB_EXISTS");
    assert.equal(await repos.p2pHunts.countActiveRealmServers(REALM_ID), 1);
    assert.equal((await StopRealmHubSession(HOST, { hubKind: "RAMSGATE" })).stopped, true);

    // And a new hub starts, runs and stops cleanly.
    const next = await StartHub();
    assert.equal((await StopRealmHubSession(HOST, { hubKind: "RAMSGATE" })).stopped, true);
    assert.equal((await repos.p2pHunts.findHunt(next.sessionId))!.state, "COMPLETED");
});
