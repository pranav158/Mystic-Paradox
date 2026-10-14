import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { InMemoryRealmPresenceRepository, InMemoryRealmsRepository } from "../../realms/persistence/InMemoryRealmsRepository";
import { HubRoomId, IsRealmOnline, IsRealmServing } from "../../realms/realmRules";
import { CreateRealmsService } from "../../realms/realmsService";
import { ConsumeAdmissionTicket } from "../controllers/p2pAdmission";
import { CreateJoinBootstrap } from "../controllers/p2pLauncher";
import { CreateRealmHubSession, HandleRealmEvent, StopRealmHubSession } from "../controllers/realmHubLifecycle";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { CreateHubKit, FRIEND, HOST, HubKit, InstallHubTestEnvironment, MEMBER, StartRunningHub } from "./realmHubTestKit";
import { AdaptRealmsService, SetRealmsPort } from "./realmsPort";

/*
 * The p2p module against the REAL realms service (in-memory repositories): the port's adapter, the realm record the hub mirrors
 * into, the hub room id, and the events the service emits for kicks, bans and a released realm reaching the hub handler. The
 * hub flow tests use a fake port; this file is the check that the fake and the real service agree.
 */

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => { restoreEnvironment(); });

async function WithRealRealm(body: (context: { kit: HubKit; service: ReturnType<typeof CreateRealmsService>; realmId: string }) => Promise<void>): Promise<void> {
    const kit = CreateHubKit();
    try {
        const service = CreateRealmsService({
            repository: new InMemoryRealmsRepository(),
            presence: new InMemoryRealmPresenceRepository(),
            displayNames: async () => new Map(),
            isRateLimited: () => false,
            events: (event) => HandleRealmEvent(event)
        });
        const { realm } = await service.createRealm(HOST, { name: "friends", hostPublicKey: "KEY-0123456789abcdef", joinPolicy: "INVITE_ONLY", listed: false });
        const invite = (await service.createInvite(HOST, { maxUses: 5, ttlHours: 24 })).invite;
        for (const account of [MEMBER, FRIEND]) await service.join(account, { inviteCode: invite.code });
        await service.heartbeat(HOST, { online: true, hosting: { maxServers: 3, maxPlayers: 20 } } as any);
        SetRealmsPort(AdaptRealmsService(service, HubRoomId));
        await body({ kit, service, realmId: realm.realmId });
    } finally {
        kit.dispose();
    }
}

async function Admit(kit: HubKit, hub: Awaited<ReturnType<typeof StartRunningHub>>, realmId: string, accountId: string) {
    kit.linkAccount(accountId);
    await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: 1, realmId, accountId, peerId: DeriveIcePeerId(accountId),
        candidateId: crypto.randomUUID(), now: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString() });
    const join = await CreateJoinBootstrap(accountId, hub.sessionId);
    return ConsumeAdmissionTicket({ sessionId: hub.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(accountId),
        bridgeInstanceId: hub.bridgeInstanceId, connectionHandle: "h", requestId: crypto.randomUUID(), capability: kit.hunts.capabilities.get(hub.capabilityId)! });
}

test("the real realms service: the host's realm is found, the hub room id is the service's, and the host's own limit applies", async () => {
    await WithRealRealm(async ({ kit, service, realmId }) => {
        const started = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        const hub = kit.hunts.hunts.get(started.sessionId)!;
        assert.equal(hub.realmId, realmId);
        assert.equal(hub.hubRoomId, HubRoomId(realmId, "RAMSGATE"));
        assert.equal((await service.findByHubRoomId(hub.hubRoomId!))!.realmId, realmId, "the chat and the matchmaker find the realm by the hub's room id");
        // The host reported room for one server: Training does not fit beside Ramsgate.
        await service.heartbeat(HOST, { online: true, hosting: { maxServers: 1, maxPlayers: 20 } } as any);
        await assert.rejects(() => CreateRealmHubSession(HOST, { hubKind: "TRAINING" }), (error: any) => error?.code === "REALM_FULL");
        await assert.rejects(() => CreateRealmHubSession(MEMBER, { hubKind: "RAMSGATE" }), (error: any) => error?.code === "REALM_NOT_FOUND");
    });
});

test("the real realms service: the hub's state is mirrored into the realm record, which serves while the hub runs and not after it ends", async () => {
    await WithRealRealm(async ({ kit, service, realmId }) => {
        const started = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE", maxPlayers: 10 });
        let realm = (await service.getRealm(realmId))!;
        assert.equal(realm.hosting!.hubState, "STARTING");
        assert.equal(realm.hosting!.hubSessionId, started.sessionId);
        assert.equal(realm.hosting!.activeServers, 1);
        assert.equal(realm.hosting!.maxServers, 3, "the host's own choice is untouched by the hub's writes");
        assert.equal(realm.hosting!.maxPlayers, 20);
        assert.equal(IsRealmServing(realm, Date.now()), false, "online, but its hub is not running yet");
        await service.heartbeat(HOST, { online: true } as any);

        const second = await StartRunningHub(kit, { hubKind: "TRAINING" });
        realm = (await service.getRealm(realmId))!;
        assert.equal(realm.hosting!.trainingState, "RUNNING");
        assert.equal(realm.hosting!.hubState, "STARTING", "Training running says nothing about Ramsgate");
        await StopRealmHubSession(HOST, { hubKind: "TRAINING" });
        assert.equal(kit.hunts.hunts.get(second.sessionId)!.state, "COMPLETED");
        await StopRealmHubSession(HOST, { hubKind: "RAMSGATE" });

        const running = await StartRunningHub(kit);
        await service.heartbeat(HOST, { online: true } as any);
        realm = (await service.getRealm(realmId))!;
        assert.equal(realm.hosting!.hubState, "RUNNING");
        assert.equal(realm.hosting!.hubSessionId, running.sessionId);
        assert.equal(IsRealmServing(realm, Date.now()), true);

        await StopRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        realm = (await service.getRealm(realmId))!;
        assert.equal(realm.hosting!.hubState, "NONE");
        assert.equal(realm.hosting!.hubSessionId, undefined, "null removes the session id");
        assert.equal(IsRealmOnline(realm, Date.now()), false, "the realm is offline the moment its hub ends, not 90 s later");
        assert.equal(IsRealmServing(realm, Date.now()), false);
        // The host's next heartbeat does not bring a hub back that is not running.
        await service.heartbeat(HOST, { online: true } as any);
        assert.equal(IsRealmServing((await service.getRealm(realmId))!, Date.now()), false);
    });
});

test("the real realms service: kick and ban reach the hub, a banned member's new entry gets no ticket", async () => {
    await WithRealRealm(async ({ kit, service, realmId }) => {
        const hub = await StartRunningHub(kit);
        await Admit(kit, hub, realmId, MEMBER);
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "ADMITTED");

        await service.kick(HOST, MEMBER);
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "REMOVED");
        const kicked = kit.hunts.controlMessages.filter((entry) => entry.messageType === "REALM_SESSION_LEAVE" && entry.accountId === MEMBER);
        assert.equal(kicked.length, 1);
        assert.equal(kicked[0].payload.reason, "KICKED");
        assert.equal(kit.hunts.controlMessages.filter((entry) => entry.messageType === "REALM_PEER_EXPECTED" && entry.accountId === HOST).length, 1);
        // A kicked member is not a member any more: its new entry has no ticket.
        await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: 1, realmId, accountId: MEMBER, peerId: DeriveIcePeerId(MEMBER),
            candidateId: "again", now: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString() });
        await assert.rejects(() => CreateJoinBootstrap(MEMBER, hub.sessionId), (error: any) => error?.code === "REALM_NOT_MEMBER");

        // A member banned while its entry waits.
        kit.linkAccount(FRIEND);
        await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: 1, realmId, accountId: FRIEND, peerId: DeriveIcePeerId(FRIEND),
            candidateId: "friend", now: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString() });
        await service.ban(HOST, FRIEND, "griefing");
        assert.equal((await kit.presence.findPresence(hub.sessionId, FRIEND))!.state, "REMOVED");
        assert.equal(kit.hunts.controlMessages.filter((entry) => entry.messageType === "REALM_SESSION_LEAVE" && entry.accountId === FRIEND)[0].payload.reason, "BANNED");
        await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: 1, realmId, accountId: FRIEND, peerId: DeriveIcePeerId(FRIEND),
            candidateId: "friend-2", now: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString() });
        await assert.rejects(() => CreateJoinBootstrap(FRIEND, hub.sessionId), (error: any) => error?.code === "REALM_BANNED");
        assert.equal(kit.hunts.hunts.get(hub.sessionId)!.state, "RUNNING", "the hub itself is untouched");
    });
});

test("the real realms service: releasing the realm ends its hubs cleanly", async () => {
    await WithRealRealm(async ({ kit, service, realmId }) => {
        const hub = await StartRunningHub(kit);
        await Admit(kit, hub, realmId, MEMBER);
        await service.release(HOST);
        const record = kit.hunts.hunts.get(hub.sessionId)!;
        assert.equal(record.state, "COMPLETED");
        assert.equal(record.completionReason, "REALM_RELEASED");
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "REMOVED");
        assert.equal((await service.getRealm(realmId)), undefined);
        assert.equal(kit.hunts.hostReliability.get(HOST)!.cleanCompletions, 1);
    });
});
