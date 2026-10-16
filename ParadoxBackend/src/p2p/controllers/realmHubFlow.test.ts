import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import { NormalizeRequestId } from "../../observability/requestContext";
import { P2PHostCapabilityRecord, P2PHuntSessionRecord } from "../persistence";
import {
    CreateHubKit, FRIEND, HOST, HubKit, InstallHubTestEnvironment, LOCAL_BRIDGE_PORT, MEMBER, REALM_ID, RunningHub, StartRunningHub, STRANGER
} from "../realm/realmHubTestKit";
import { HashAdmissionJti, VerifyAdmissionTicket } from "../security/admissionTickets";
import { HashHostCapabilitySecret, ListHubPresentAccounts } from "../security/hostCapabilities";
import { DeriveIcePairKey } from "../security/iceSessionRules";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import { UseP2POperationsPolicyForTest } from "../services/p2pOperationsPolicy";
import { ConsumeAdmissionTicket, MarkHostReady, RecordPeerDisconnected } from "./p2pAdmission";
import { AbortHunt, EndHunt, GetHuntStatus } from "./p2pHuntStatus";
import { P2PHuntLifecycleMonitor, RecordParticipantObservation, RenewHostLease } from "./p2pHostLifecycle";
import { CreateHostBootstrap, CreateJoinBootstrap, MarkLocalRouteReady } from "./p2pLauncher";
import { CreateIceTransportConfig, RelayTtlCapSeconds, RelayTtlSeconds, SubmitIceSignal } from "./p2pIce";
import { ReadP2PIceConfig } from "../config/p2pIcePolicy";
import {
    CreateRealmHubSession, EndRealmHub, HandleRealmEvent, RemoveRealmMemberFromHubs, StopRealmHubSession, TickRealmHub
} from "./realmHubLifecycle";

/*
 * The realm hub flows end to end, as the host's and the members' launchers drive them, with the real controllers on in-memory
 * repositories: bootstrap, host-ready, the host's route-ready (RUNNING), tickets, consume, disconnect, the lease, the monitor,
 * the ICE signalling, the realms module's events, and that hunts behave as before.
 */

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => { restoreEnvironment(); });

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const PAST = () => iso(-60_000);

async function WithKit(body: (kit: HubKit) => Promise<void>, options: Parameters<typeof CreateHubKit>[0] = {}): Promise<void> {
    const kit = CreateHubKit(options);
    try { await body(kit); } finally { kit.dispose(); }
}

function Hub(kit: HubKit, hub: RunningHub | string): P2PHuntSessionRecord {
    return kit.hunts.hunts.get(typeof hub === "string" ? hub : hub.sessionId)!;
}

function CapabilityOf(kit: HubKit, hub: RunningHub): P2PHostCapabilityRecord {
    return kit.hunts.capabilities.get(hub.capabilityId)!;
}

async function Enter(kit: HubKit, hub: RunningHub, accountId: string, link = true) {
    if (link) kit.linkAccount(accountId);
    return kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: REALM_ID, accountId,
        peerId: DeriveIcePeerId(accountId), candidateId: crypto.randomUUID(), now: iso(), expiresAt: iso(90_000) });
}

/** A member's whole entry as the launchers drive it: matchmaking row, join bootstrap (ticket), the host's consume. */
async function Admit(kit: HubKit, hub: RunningHub, accountId: string, requestId: string = crypto.randomUUID()) {
    await Enter(kit, hub, accountId);
    const join = await CreateJoinBootstrap(accountId, hub.sessionId);
    const consumed = await ConsumeAdmissionTicket({
        sessionId: hub.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(accountId),
        bridgeInstanceId: hub.bridgeInstanceId, connectionHandle: "handle-1", requestId, capability: CapabilityOf(kit, hub)
    });
    return { join, consumed };
}

function HunkRoster(accounts: string[]) {
    return accounts.map((accountId, index) => ({
        accountId, steamId: DeriveIcePeerId(accountId), candidateId: `candidate-${index}`, reconnectEpoch: 0, admissionState: "PENDING" as const
    }));
}

function HuntRecord(overrides: Partial<P2PHuntSessionRecord> = {}): P2PHuntSessionRecord {
    return {
        sessionId: crypto.randomUUID(), generation: 1, state: "HOST_OFFERED", stateVersion: 1, partyId: "party-1", activePartyKey: "party-1",
        partyRevision: 1, huntDefinitionId: "ShatteredIsles_IslandA", gameMode: "ISLAND", build: 647472, bridgeProtocol: 1, virtualPort: 1,
        hostAccountId: HOST, hostSteamId: DeriveIcePeerId(HOST), bridgeInstanceId: "", coopTransport: "ICE",
        roster: HunkRoster([HOST, MEMBER]), createdAt: iso(), expiresAt: iso(2 * 3_600_000),
        matchmakerHuntId: "CR19_MatchmakerHunt_ShatteredIsles_IslandA", mapPath: "/Game/Maps/islands/1705/dia_moss_triforce",
        behemothPath: "/Game/Characters/Behemoth/Embermane", expectedPlayerString: "host,member", guardCompletionMode: "FIRST_DEFEAT",
        trustTier: 0, ...overrides
    };
}

async function SeedHunt(kit: HubKit, overrides: Partial<P2PHuntSessionRecord> = {}): Promise<P2PHuntSessionRecord> {
    const offerId = crypto.randomUUID();
    const hunt = HuntRecord({ hostOfferId: offerId, ...overrides });
    await kit.hunts.createHunt(hunt);
    await kit.hunts.createHostOffer({ offerId, sessionId: hunt.sessionId, generation: hunt.generation, accountId: hunt.hostAccountId, steamId: hunt.hostSteamId,
        rank: 1, score: 1, scoreBreakdown: { latencyRisk: 0, networkRisk: 0, memoryRisk: 0, cpuRisk: 0, stabilityRisk: 0, hostLoadRisk: 0, integrityRisk: 0 },
        status: "ACCEPTED", offeredAt: iso(), expiresAt: iso(15_000) });
    return hunt;
}

async function ThrowsCode(action: () => Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(action, (error: any) => {
        assert.equal(error?.code, code, `expected ${code}, got ${error?.code} (${error?.message})`);
        return true;
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------------------------------------------

test("hub host bootstrap: hub scopes (no evidence, no completion), a 24 hour capability, the hub's peer limit and its extra fields", async () => {
    await WithKit(async (kit) => {
        const started = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE", maxPlayers: 24 });
        const bootstrap = await CreateHostBootstrap(HOST, started.sessionId);
        assert.equal(bootstrap.sessionId, started.sessionId);
        assert.equal(bootstrap.generation, 1);
        assert.equal(bootstrap.coopTransport, "ICE");
        assert.equal(bootstrap.maximumPeers, 24);
        assert.equal(bootstrap.sessionKind, "REALM_HUB");
        assert.equal(bootstrap.hubKind, "RAMSGATE");
        assert.equal(bootstrap.hubRoomId, kit.realms.hubRoomId(REALM_ID, "RAMSGATE"));
        assert.equal(bootstrap.maxPlayers, 24);
        assert.equal(bootstrap.hostParticipates, true);
        assert.equal(bootstrap.hostLocalClient, true);
        assert.equal(bootstrap.partyId, `realmhub:${REALM_ID}:ramsgate`);
        assert.equal(bootstrap.guardCompletionMode, "NO_COMPLETION");
        assert.equal(bootstrap.matchmakerHuntId, "NO_MM_HUNTID");
        assert.equal(bootstrap.behemothPath, "NO_BEHEMOTH");
        assert.equal(bootstrap.expectedPlayers, "NO_EXPECTED_PLAYERS");
        assert.equal(bootstrap.mapPath, "/Game/Maps/ramsgate/ramsgate_01_persistent");
        assert.equal(bootstrap.backendUrl, "https://backend.test");
        assert.equal(bootstrap.hostPeerId, DeriveIcePeerId(HOST));
        assert.equal(typeof bootstrap.bridgeInstanceId, "string");
        assert.equal(typeof bootstrap.metadataNonce, "string");

        const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
        assert.deepEqual([...capability.scopes].sort(), ["ABORT", "GAME_SERVER_RUNTIME", "HOST_READY", "LEASE_HEARTBEAT", "PEER_ADMITTED"]);
        assert.equal(capability.scopes.includes("EVENTS_WRITE"), false);
        assert.equal(capability.scopes.includes("COMPLETE_REQUEST"), false);
        const lifetime = Date.parse(capability.expiresAt) - Date.parse(capability.issuedAt);
        assert.ok(Math.abs(lifetime - 24 * 3_600_000) < 5_000, `24 hours, got ${lifetime}`);
        assert.equal(capability.hostSteamId, DeriveIcePeerId(HOST));
        assert.equal(capability.bridgeInstanceId, bootstrap.bridgeInstanceId);

        // A participating host always has a ticket (a non-participating realm host does not: see p2pRealmHunts.test.ts).
        const hostTicket = VerifyAdmissionTicket(bootstrap.hostTicket!);
        assert.equal(hostTicket.accountId, HOST);
        assert.equal(hostTicket.joinerSteamId, DeriveIcePeerId(HOST));
        assert.equal(hostTicket.hostSteamId, DeriveIcePeerId(HOST));
        assert.equal(hostTicket.sessionId, started.sessionId);
        assert.equal(hostTicket.partyId, `realmhub:${REALM_ID}:ramsgate`);
        assert.equal(hostTicket.huntDefinitionId, "ShatteredIsles_ReturnToRamsgate");

        const hub = Hub(kit, started.sessionId);
        assert.equal(hub.state, "STARTING");
        assert.equal(hub.bridgeInstanceId, bootstrap.bridgeInstanceId);
        assert.ok(hub.startupDeadline && Date.parse(hub.startupDeadline) > Date.now());
        assert.deepEqual(kit.hunts.transitions.map((entry) => entry.toState), ["HOST_OFFERED", "STARTING"]);
        assert.equal(kit.hunts.transitions[1].reason, "HOST_OFFER_ACCEPTED");
    });
});

test("hub host bootstrap: P2P_REALM_HUB_CAPABILITY_TTL_HOURS sets the capability's life, capped by the session's", async () => {
    await WithKit(async (kit) => {
        process.env.P2P_REALM_HUB_CAPABILITY_TTL_HOURS = "6";
        const started = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        const bootstrap = await CreateHostBootstrap(HOST, started.sessionId);
        const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
        assert.ok(Math.abs(Date.parse(capability.expiresAt) - Date.parse(capability.issuedAt) - 6 * 3_600_000) < 5_000);
        delete process.env.P2P_REALM_HUB_CAPABILITY_TTL_HOURS;
        // A capability never outlives the session record.
        await EndRealmHub(started.sessionId, 1, "TEST", "ABORTED");
        const second = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        Hub(kit, second.sessionId).expiresAt = iso(3 * 3_600_000);
        const bootstrapTwo = await CreateHostBootstrap(HOST, second.sessionId);
        const capabilityTwo = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrapTwo.capability)))!;
        assert.ok(Math.abs(Date.parse(capabilityTwo.expiresAt) - (Date.now() + 3 * 3_600_000)) < 5_000);
    });
});

test("hub host bootstrap: only the host, once, with its transport link, while realm hosting is on", async () => {
    await WithKit(async (kit) => {
        const started = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        await ThrowsCode(() => CreateHostBootstrap(MEMBER, started.sessionId), "P2P_CAPABILITY_INVALID");
        await ThrowsCode(() => CreateHostBootstrap(HOST, "44444444-4444-4444-8444-444444444444"), "P2P_SESSION_NOT_FOUND");
        kit.hunts.steamLinks.delete(HOST);
        await ThrowsCode(() => CreateHostBootstrap(HOST, started.sessionId), "P2P_STEAM_LINK_REQUIRED");
        kit.linkAccount(HOST);
        const hosting = process.env.MYSTICPARADOX_REALMS_HOSTING;
        process.env.MYSTICPARADOX_REALMS_HOSTING = "off";
        await ThrowsCode(() => CreateHostBootstrap(HOST, started.sessionId), "P2P_DISABLED");
        process.env.MYSTICPARADOX_REALMS_HOSTING = hosting;
        UseP2POperationsPolicyForTest({ p2pEmergencyStop: true, coopTransport: "ICE" });
        await ThrowsCode(() => CreateHostBootstrap(HOST, started.sessionId), "P2P_DISABLED");
        UseP2POperationsPolicyForTest({ p2pEmergencyStop: false, coopTransport: "ICE" });
        assert.equal(Hub(kit, started.sessionId).state, "HOST_OFFERED", "none of the refusals moved the hub");
        await CreateHostBootstrap(HOST, started.sessionId);
        await ThrowsCode(() => CreateHostBootstrap(HOST, started.sessionId), "P2P_GENERATION_FENCED");
    });
});

// ---------------------------------------------------------------------------------------------------------------
// Host ready and the host's own route
// ---------------------------------------------------------------------------------------------------------------

test("the host's route-ready takes a hub HOST_READY -> ADMITTING -> RUNNING and admits the host locally", async () => {
    await WithKit(async (kit) => {
        const started = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        const bootstrap = await CreateHostBootstrap(HOST, started.sessionId);
        const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
        const ready = await MarkHostReady({ sessionId: started.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        assert.equal(ready.ready, true);
        assert.equal(Hub(kit, started.sessionId).state, "HOST_READY");
        assert.equal(Hub(kit, started.sessionId).lobbyId, "ICE");
        assert.ok(Hub(kit, started.sessionId).leaseExpiresAt);
        assert.equal(await kit.presence.findPresence(started.sessionId, HOST), undefined, "no presence row before the host's route");
        kit.realms.hostingPatches.length = 0;

        const routed = await MarkLocalRouteReady(HOST, started.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId,
            localHost: "127.0.0.1", localPort: LOCAL_BRIDGE_PORT });
        assert.deepEqual(routed, { ready: true, sessionId: started.sessionId, generation: 1, localHost: "127.0.0.1", localPort: LOCAL_BRIDGE_PORT });
        const hub = Hub(kit, started.sessionId);
        assert.equal(hub.state, "RUNNING");
        assert.equal(hub.hostLocalBridgePort, LOCAL_BRIDGE_PORT);
        assert.ok(hub.hostLocalBridgeReadyAt);
        assert.equal(hub.startupDeadline, undefined, "a running hub has no startup deadline");
        assert.equal(hub.offerExpiresAt, undefined);
        assert.deepEqual(hub.roster, [], "nothing is ever written on the roster");
        assert.deepEqual(kit.hunts.transitions.map((entry) => entry.reason),
            ["REALM_HUB_CREATED", "HOST_OFFER_ACCEPTED", "ICE_HOST_BRIDGE_READY", "HOST_LOCAL_ROUTE_READY", "HOST_ADMITTED_LOCALLY"]);
        assert.deepEqual(kit.hunts.transitions.map((entry) => entry.toState), ["HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING"]);
        const row = (await kit.presence.findPresence(started.sessionId, HOST))!;
        assert.equal(row.state, "ADMITTED");
        assert.equal(row.localBridgePort, LOCAL_BRIDGE_PORT);
        assert.equal(row.peerId, DeriveIcePeerId(HOST));
        assert.equal(kit.hunts.hostReliability.get(HOST)!.startsSucceeded, 1);
        assert.equal(kit.hunts.controlMessages.filter((entry) => entry.messageType === "JOIN_RENDEZVOUS").length, 0, "nobody is rostered to be rendezvoused");
        // The realm directory shows a serving hub.
        assert.deepEqual(kit.realms.shown(REALM_ID), { hubState: "RUNNING", hubSessionId: started.sessionId, activeServers: 1 });
        assert.deepEqual(await ListHubPresentAccounts(started.sessionId, 1), [HOST]);
    });
});

test("a repeated host route-ready only moves the port; a stale generation or a bad route is refused", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const version = Hub(kit, hub).stateVersion;
        kit.realms.hostingPatches.length = 0;
        await MarkLocalRouteReady(HOST, hub.sessionId, { generation: 1, bridgeInstanceId: hub.bridgeInstanceId, localHost: "127.0.0.1", localPort: LOCAL_BRIDGE_PORT + 1 });
        assert.equal(Hub(kit, hub).state, "RUNNING");
        assert.equal(Hub(kit, hub).hostLocalBridgePort, LOCAL_BRIDGE_PORT + 1);
        assert.equal((await kit.presence.findPresence(hub.sessionId, HOST))!.localBridgePort, LOCAL_BRIDGE_PORT + 1);
        assert.ok(Hub(kit, hub).stateVersion > version);
        assert.deepEqual(kit.realms.hostingPatches, [], "the directory is told once, when the hub starts running");
        const same = Hub(kit, hub).stateVersion;
        await MarkLocalRouteReady(HOST, hub.sessionId, { generation: 1, bridgeInstanceId: hub.bridgeInstanceId, localHost: "127.0.0.1", localPort: LOCAL_BRIDGE_PORT + 1 });
        assert.equal(Hub(kit, hub).stateVersion, same, "the same port changes nothing");

        await ThrowsCode(() => MarkLocalRouteReady(HOST, hub.sessionId, { generation: 2, bridgeInstanceId: hub.bridgeInstanceId, localHost: "127.0.0.1", localPort: 5000 }), "P2P_GENERATION_FENCED");
        await ThrowsCode(() => MarkLocalRouteReady(HOST, hub.sessionId, { generation: 1, bridgeInstanceId: "short", localHost: "127.0.0.1", localPort: 5000 }), "P2P_TICKET_INVALID");
        await ThrowsCode(() => MarkLocalRouteReady(HOST, hub.sessionId, { generation: 1, bridgeInstanceId: hub.bridgeInstanceId, localHost: "10.0.0.1", localPort: 5000 }), "P2P_TICKET_INVALID");
        await ThrowsCode(() => MarkLocalRouteReady(HOST, hub.sessionId, { generation: 1, bridgeInstanceId: hub.bridgeInstanceId, localHost: "127.0.0.1", localPort: 70000 }), "P2P_TICKET_INVALID");
        kit.hunts.steamLinks.delete(HOST);
        await ThrowsCode(() => MarkLocalRouteReady(HOST, hub.sessionId, { generation: 1, bridgeInstanceId: hub.bridgeInstanceId, localHost: "127.0.0.1", localPort: 5000 }), "P2P_STEAM_LINK_REQUIRED");
    });
});

test("a hub that is not ready yet takes no route from the host", async () => {
    await WithKit(async (kit) => {
        const started = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        await CreateHostBootstrap(HOST, started.sessionId);
        await ThrowsCode(() => MarkLocalRouteReady(HOST, started.sessionId, { generation: 1, bridgeInstanceId: "a".repeat(32), localHost: "127.0.0.1", localPort: 5000 }), "P2P_GENERATION_FENCED");
        assert.equal(Hub(kit, started.sessionId).state, "STARTING");
        assert.equal(await kit.presence.findPresence(started.sessionId, HOST), undefined);
    });
});

test("a member's route-ready lands on its presence row, and is refused without an entry", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const body = { generation: 1, bridgeInstanceId: "b".repeat(32), localHost: "127.0.0.1", localPort: 56001 };
        kit.linkAccount(MEMBER);
        await ThrowsCode(() => MarkLocalRouteReady(MEMBER, hub.sessionId, body), "P2P_GENERATION_FENCED");
        await Enter(kit, hub, MEMBER);
        const reply = await MarkLocalRouteReady(MEMBER, hub.sessionId, body);
        assert.equal(reply.localPort, 56001);
        const row = (await kit.presence.findPresence(hub.sessionId, MEMBER))!;
        assert.equal(row.localBridgePort, 56001);
        assert.equal(row.state, "PENDING", "a route does not admit");
        assert.equal(Hub(kit, hub).hostLocalBridgePort, LOCAL_BRIDGE_PORT, "and is never taken for the host's");
        await ThrowsCode(() => MarkLocalRouteReady(MEMBER, hub.sessionId, { ...body, generation: 3 }), "P2P_GENERATION_FENCED");
    });
});

// ---------------------------------------------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------------------------------------------

test("the hub's lease takes up to 64 admitted peers; a hunt's still takes four", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const capability = CapabilityOf(kit, hub);
        const heartbeat = (leaseSequence: number, admittedPeerCount: number, extra: object = {}) =>
            RenewHostLease(capability, { leaseSequence, bridgeAlive: true, serverReady: true, admittedPeerCount, queuePressure: 0, ...extra });
        const renewed = await heartbeat(1, 64);
        assert.equal(renewed.renewed, true);
        assert.equal(renewed.state, "RUNNING");
        assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.now());
        assert.equal((await heartbeat(2, 0)).renewed, true);
        await ThrowsCode(() => heartbeat(3, 65), "P2P_TICKET_INVALID");
        await ThrowsCode(() => heartbeat(3, -1), "P2P_TICKET_INVALID");
        await ThrowsCode(() => heartbeat(3, 2.5), "P2P_TICKET_INVALID");
        await ThrowsCode(() => heartbeat(2, 1), "P2P_GENERATION_FENCED");

        // A hunt: four, not five.
        const hunt = await SeedHunt(kit, { state: "RUNNING", bridgeInstanceId: "hunt-bridge", leaseExpiresAt: iso(10_000) });
        const huntCapability: P2PHostCapabilityRecord = { capabilityId: "cap-hunt", secretDigest: "c".repeat(64), sessionId: hunt.sessionId, generation: 1,
            hostAccountId: HOST, hostSteamId: hunt.hostSteamId, bridgeInstanceId: "hunt-bridge", scopes: ["LEASE_HEARTBEAT"], issuedAt: iso(), expiresAt: iso(3_600_000), lastSequence: 0 };
        await kit.hunts.createHostCapability(huntCapability);
        const huntBeat = (leaseSequence: number, admittedPeerCount: number) =>
            RenewHostLease(huntCapability, { leaseSequence, bridgeAlive: true, serverReady: true, admittedPeerCount, queuePressure: 0 });
        assert.equal((await huntBeat(1, 4)).renewed, true);
        await ThrowsCode(() => huntBeat(2, 5), "P2P_TICKET_INVALID");
    });
});

test("a hub whose server or bridge is gone ends ABORTED, with no recovery and no cooldown for the host", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Admit(kit, hub, MEMBER);
        await ThrowsCode(() => RenewHostLease(CapabilityOf(kit, hub), { leaseSequence: 1, bridgeAlive: true, serverReady: false, admittedPeerCount: 1, queuePressure: 0 }), "P2P_GENERATION_FENCED");
        const record = Hub(kit, hub);
        assert.equal(record.state, "ABORTED");
        assert.equal(record.failureReason, "HOST_PROCESS_UNHEALTHY");
        assert.equal(record.activePartyKey, undefined);
        assert.deepEqual(kit.hunts.transitions.slice(-1)[0].toState, "ABORTED");
        assert.equal(kit.hunts.hostReliability.get(HOST)!.unexpectedFailures, 1);
        assert.equal(kit.hunts.hostReliability.get(HOST)!.cooldownUntil, undefined, "the launcher restarts a dead hub at once");
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "LOST");
        assert.equal(kit.hunts.controlMessages.filter((entry) => entry.messageType === "RETURN_TO_RAMSGATE" || entry.messageType === "HOST_OFFER_CANCELLED").length, 0);
        assert.deepEqual(kit.realms.offline, [REALM_ID]);
        // The next start is not blocked.
        assert.equal((await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" })).state, "HOST_OFFERED");
    });
});

// ---------------------------------------------------------------------------------------------------------------
// Admission of a member
// ---------------------------------------------------------------------------------------------------------------

test("join bootstrap: a fresh ticket for an open entry, bound to the member's peer id, and the entry becomes TICKETED", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Enter(kit, hub, MEMBER);
        const versionBefore = Hub(kit, hub).stateVersion;
        const join = await CreateJoinBootstrap(MEMBER, hub.sessionId);
        assert.equal(join.lobbyId, "ICE");
        assert.equal(join.coopTransport, "ICE");
        assert.equal(join.sessionId, hub.sessionId);
        assert.equal(join.generation, 1);
        assert.equal(join.partyId, `realmhub:${REALM_ID}:ramsgate`);
        assert.equal(join.hostPeerId, DeriveIcePeerId(HOST));
        const claims = VerifyAdmissionTicket(join.ticket);
        assert.equal(claims.accountId, MEMBER);
        assert.equal(claims.joinerSteamId, DeriveIcePeerId(MEMBER));
        assert.equal(claims.hostSteamId, DeriveIcePeerId(HOST));
        assert.equal(claims.sessionId, hub.sessionId);
        assert.equal(claims.generation, 1);
        assert.equal(claims.partyId, `realmhub:${REALM_ID}:ramsgate`);
        assert.equal(claims.partyRevision, 1);
        assert.equal(claims.huntDefinitionId, "ShatteredIsles_ReturnToRamsgate");
        assert.equal(claims.expiresAt - claims.issuedAt, 180);
        const row = (await kit.presence.findPresence(hub.sessionId, MEMBER))!;
        assert.equal(row.state, "TICKETED");
        assert.ok(Date.parse(row.expiresAt) >= claims.expiresAt * 1000, "the row lives as long as its ticket");
        assert.equal([...kit.hunts.tickets.values()].filter((ticket) => ticket.accountId === MEMBER && ticket.status === "ISSUED").length, 1);
        assert.equal(Hub(kit, hub).stateVersion, versionBefore, "nothing is written on the session");
        assert.deepEqual(Hub(kit, hub).roster, []);
        // Asking again before the ticket is used gives another valid ticket (a restarted launcher), for the same entry.
        const again = await CreateJoinBootstrap(MEMBER, hub.sessionId);
        assert.notEqual(again.ticket, join.ticket);
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.entryEpoch, row.entryEpoch);
    });
});

test("join bootstrap is refused without an open entry, for the host, for a banned or removed member, without the transport link and when the hub is not running", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        kit.linkAccount(MEMBER);
        await ThrowsCode(() => CreateJoinBootstrap(MEMBER, hub.sessionId), "P2P_NOT_ROSTERED");
        await ThrowsCode(() => CreateJoinBootstrap(HOST, hub.sessionId), "P2P_NOT_ROSTERED");
        await ThrowsCode(() => CreateJoinBootstrap(MEMBER, "55555555-5555-4555-8555-555555555555"), "P2P_SESSION_NOT_FOUND");

        await Enter(kit, hub, MEMBER);
        kit.realms.bans.add(`${REALM_ID}:${MEMBER}`);
        await ThrowsCode(() => CreateJoinBootstrap(MEMBER, hub.sessionId), "REALM_BANNED");
        kit.realms.bans.clear();
        kit.realms.members.delete(`${REALM_ID}:${MEMBER}`);
        await ThrowsCode(() => CreateJoinBootstrap(MEMBER, hub.sessionId), "REALM_NOT_MEMBER");
        kit.realms.members.add(`${REALM_ID}:${MEMBER}`);
        assert.ok((await CreateJoinBootstrap(MEMBER, hub.sessionId)).ticket);

        await Enter(kit, hub, FRIEND, false);
        await ThrowsCode(() => CreateJoinBootstrap(FRIEND, hub.sessionId), "P2P_STEAM_LINK_REQUIRED");
        kit.hunts.steamLinks.set(FRIEND, { accountId: FRIEND, steamId: "999", status: "VERIFIED", revision: 1, verifiedAt: iso(), lastUsedAt: iso() });
        await ThrowsCode(() => CreateJoinBootstrap(FRIEND, hub.sessionId), "P2P_STEAM_LINK_REQUIRED");
        kit.linkAccount(FRIEND);
        assert.ok((await CreateJoinBootstrap(FRIEND, hub.sessionId)).ticket);

        // An entry whose time ran out, and a hub that is not running.
        await Enter(kit, hub, STRANGER);
        kit.realms.members.add(`${REALM_ID}:${STRANGER}`);
        kit.presence.rows.get(`${hub.sessionId}:${STRANGER}`)!.expiresAt = PAST();
        await ThrowsCode(() => CreateJoinBootstrap(STRANGER, hub.sessionId), "P2P_NOT_ROSTERED");
        Hub(kit, hub).state = "SUSPECT";
        await ThrowsCode(() => CreateJoinBootstrap(MEMBER, hub.sessionId), "P2P_SESSION_NOT_READY");
        Hub(kit, hub).state = "ADMITTING";
        await ThrowsCode(() => CreateJoinBootstrap(MEMBER, hub.sessionId), "P2P_SESSION_NOT_READY");
    });
});

test("consume: the member's row becomes ADMITTED without writing the session; the consume is idempotent and a ticket cannot be replayed", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Enter(kit, hub, MEMBER);
        const join = await CreateJoinBootstrap(MEMBER, hub.sessionId);
        const versionBefore = Hub(kit, hub).stateVersion;
        const input = { sessionId: hub.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(MEMBER), bridgeInstanceId: hub.bridgeInstanceId,
            connectionHandle: "handle-1", requestId: "request-1", capability: CapabilityOf(kit, hub) };
        const consumed = await ConsumeAdmissionTicket(input);
        const jti = VerifyAdmissionTicket(join.ticket).jti;
        assert.deepEqual(consumed, { admitted: true, idempotent: false, admissionId: HashAdmissionJti(jti), accountId: MEMBER,
            steamId: DeriveIcePeerId(MEMBER), sessionId: hub.sessionId, generation: 1 });
        const row = (await kit.presence.findPresence(hub.sessionId, MEMBER))!;
        assert.equal(row.state, "ADMITTED");
        assert.equal(row.admissionId, consumed.admissionId);
        assert.ok(row.admittedAt);
        assert.equal(Hub(kit, hub).stateVersion, versionBefore, "admitting a member never touches the session document");
        assert.deepEqual(Hub(kit, hub).roster, []);
        assert.equal(Hub(kit, hub).state, "RUNNING");
        assert.deepEqual((await ListHubPresentAccounts(hub.sessionId, 1)).sort(), [HOST, MEMBER].sort());
        assert.equal(kit.hunts.peerAdmissions.size, 2, "the host's own local admission and the member's");

        const again = await ConsumeAdmissionTicket(input);
        assert.equal(again.idempotent, true);
        assert.equal(again.admissionId, consumed.admissionId);
        assert.equal(kit.hunts.peerAdmissions.size, 2);
        await ThrowsCode(() => ConsumeAdmissionTicket({ ...input, requestId: "request-2" }), "P2P_TICKET_REPLAYED");
        await ThrowsCode(() => ConsumeAdmissionTicket({ ...input, authenticatedSteamId: DeriveIcePeerId(FRIEND) }), "P2P_TICKET_INVALID");
        await ThrowsCode(() => ConsumeAdmissionTicket({ ...input, sessionId: "66666666-6666-4666-8666-666666666666" }), "P2P_TICKET_INVALID");
    });
});

test("consume: a hub that is ADMITTING goes RUNNING with the first admitted peer; one that ended refuses", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Enter(kit, hub, MEMBER);
        const join = await CreateJoinBootstrap(MEMBER, hub.sessionId);
        Hub(kit, hub).state = "ADMITTING";
        await ConsumeAdmissionTicket({ sessionId: hub.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(MEMBER),
            bridgeInstanceId: hub.bridgeInstanceId, connectionHandle: "h", requestId: "r", capability: CapabilityOf(kit, hub) });
        assert.equal(Hub(kit, hub).state, "RUNNING");
        assert.equal(kit.hunts.transitions.at(-1)!.reason, "PARTICIPANT_ADMITTED");

        await Enter(kit, hub, FRIEND);
        const friendJoin = await CreateJoinBootstrap(FRIEND, hub.sessionId);
        await EndRealmHub(hub.sessionId, 1, "TEST", "ABORTED");
        await ThrowsCode(() => ConsumeAdmissionTicket({ sessionId: hub.sessionId, ticket: friendJoin.ticket, authenticatedSteamId: DeriveIcePeerId(FRIEND),
            bridgeInstanceId: hub.bridgeInstanceId, connectionHandle: "h", requestId: "r2", capability: CapabilityOf(kit, hub) }), "P2P_GENERATION_FENCED");
    });
});

test("disconnect: the member's row becomes LOST; the report is for one connection only and counts once", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const { consumed } = await Admit(kit, hub, MEMBER);
        const capability = CapabilityOf(kit, hub);
        assert.deepEqual(await RecordPeerDisconnected({ admissionId: consumed.admissionId, capability }), { disconnected: true });
        const row = (await kit.presence.findPresence(hub.sessionId, MEMBER))!;
        assert.equal(row.state, "LOST");
        assert.ok(row.lostAt);
        assert.ok(row.purgeAt);
        assert.deepEqual(await RecordPeerDisconnected({ admissionId: consumed.admissionId, capability }), { disconnected: false });
        assert.deepEqual(await RecordPeerDisconnected({ admissionId: "f".repeat(64), capability }), { disconnected: false });
        await assert.rejects(() => RecordPeerDisconnected({ admissionId: "nope", capability }), (error: any) => error?.code === "P2P_TICKET_INVALID");
        assert.deepEqual(await ListHubPresentAccounts(hub.sessionId, 1), [HOST]);
        // A lost member needs a fresh entry; the same ticket cannot bring it back.
        assert.equal((await Enter(kit, hub, MEMBER)).outcome, "REENTERED");
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.entryEpoch, 2);
    });
});

test("a member that re-enters before the host reported its old link closed is admitted again, and the old link's late report cannot end the new one", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const first = await Admit(kit, hub, MEMBER);
        const second = await Admit(kit, hub, MEMBER);       // no disconnect in between: the old admission is still "connected"
        assert.notEqual(second.consumed.admissionId, first.consumed.admissionId);
        const row = (await kit.presence.findPresence(hub.sessionId, MEMBER))!;
        assert.equal(row.state, "ADMITTED");
        assert.equal(row.admissionId, second.consumed.admissionId);
        assert.equal(row.entryEpoch, 2);
        const old = kit.hunts.peerAdmissions.get(first.consumed.admissionId)!;
        assert.ok(old.disconnectedAt, "the old admission was closed to make room");
        assert.equal(old.activeAdmissionKey, undefined);
        assert.equal(kit.hunts.peerAdmissions.get(second.consumed.admissionId)!.activeAdmissionKey, `${hub.sessionId}:1:${DeriveIcePeerId(MEMBER)}`);
        // The host's late report for the old link.
        assert.deepEqual(await RecordPeerDisconnected({ admissionId: first.consumed.admissionId, capability: CapabilityOf(kit, hub) }), { disconnected: false });
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "ADMITTED");
        // The current link's report ends it.
        assert.deepEqual(await RecordPeerDisconnected({ admissionId: second.consumed.admissionId, capability: CapabilityOf(kit, hub) }), { disconnected: true });
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "LOST");
    });
});

test("the transport's request ids count links (adm-<gen>-ice<N>, disc-<gen>-<peer>-<N>): they are valid request ids and a rejoin with a new N is admitted", async () => {
    await WithKit(async (kit) => {
        for (const id of ["adm-1-ice1", "adm-12-ice4096", "adm-4294967295-ice123456", "disc-1-4611686018427387904-1", "disc-4294967295-9223372036854775807-123456"]) {
            assert.equal(NormalizeRequestId(id), id, id);
        }
        const hub = await StartRunningHub(kit);
        const capability = CapabilityOf(kit, hub);
        const consume = (ticket: string, requestId: string) => ConsumeAdmissionTicket({ sessionId: hub.sessionId, ticket, authenticatedSteamId: DeriveIcePeerId(MEMBER),
            bridgeInstanceId: hub.bridgeInstanceId, connectionHandle: "handle", requestId, capability });
        // The first link of the session, and a retry of the same request (same N): idempotent.
        await Enter(kit, hub, MEMBER);
        const first = await CreateJoinBootstrap(MEMBER, hub.sessionId);
        const admitted = await consume(first.ticket, "adm-1-ice1");
        assert.equal(admitted.idempotent, false);
        assert.equal((await consume(first.ticket, "adm-1-ice1")).idempotent, true);
        // The same ticket under another link's request id is a replay: the ticket's jti is the one-use guard.
        await ThrowsCode(() => consume(first.ticket, "adm-1-ice2"), "P2P_TICKET_REPLAYED");
        // The member leaves and comes back: a new entry, a new ticket, a new link number - admitted, whatever it consumed before.
        assert.deepEqual(await RecordPeerDisconnected({ admissionId: admitted.admissionId, capability }), { disconnected: true });
        await Enter(kit, hub, MEMBER);
        const second = await CreateJoinBootstrap(MEMBER, hub.sessionId);
        const again = await consume(second.ticket, "adm-1-ice2");
        assert.equal(again.admitted, true);
        assert.notEqual(again.admissionId, admitted.admissionId);
        assert.deepEqual(await RecordPeerDisconnected({ admissionId: again.admissionId, capability }), { disconnected: true });
        await Enter(kit, hub, MEMBER);
        const third = await CreateJoinBootstrap(MEMBER, hub.sessionId);
        assert.equal((await consume(third.ticket, "adm-1-ice10")).admitted, true);
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.entryEpoch, 3);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// ICE signalling and transport configuration
// ---------------------------------------------------------------------------------------------------------------

test("transport config: the host gets the members that are expected or connected, a member gets the host, a stranger or a lost member nothing", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Admit(kit, hub, MEMBER);
        await Enter(kit, hub, FRIEND);
        const { consumed: strangerAdmission } = await (async () => { kit.realms.members.add(`${REALM_ID}:${STRANGER}`); return Admit(kit, hub, STRANGER); })();
        await RecordPeerDisconnected({ admissionId: strangerAdmission.admissionId, capability: CapabilityOf(kit, hub) });
        const secret = process.env.P2P_TRANSPORT_KEY_SECRET!;

        const host = await CreateIceTransportConfig(HOST, hub.sessionId, { generation: 1 });
        assert.equal(host.role, "HOST");
        assert.equal(host.localPeerId, DeriveIcePeerId(HOST));
        assert.equal(host.hostPeerId, DeriveIcePeerId(HOST));
        assert.deepEqual(host.peers.map((peer) => [peer.accountId, peer.role, peer.peerId]),
            [[MEMBER, "JOIN", DeriveIcePeerId(MEMBER)], [FRIEND, "JOIN", DeriveIcePeerId(FRIEND)]]);
        for (const peer of host.peers) assert.equal(peer.transportKey, DeriveIcePairKey(secret, hub.sessionId, 1, HOST, peer.accountId));

        const member = await CreateIceTransportConfig(MEMBER, hub.sessionId, { generation: 1 });
        assert.equal(member.role, "JOIN");
        assert.equal(member.localPeerId, DeriveIcePeerId(MEMBER));
        assert.deepEqual(member.peers.map((peer) => [peer.accountId, peer.role, peer.peerId]), [[HOST, "HOST", DeriveIcePeerId(HOST)]]);
        assert.equal(member.peers[0].transportKey, host.peers[0].transportKey, "host and member hold the same pair key");
        const waiting = await CreateIceTransportConfig(FRIEND, hub.sessionId, { generation: 1 });
        assert.equal(waiting.role, "JOIN", "an expected member may already build its link");

        // A hub lives for days: its credentials are capped by the hub's own bound (P2P_REALM_HUB_TURN_TTL_SECONDS, default
        // 24 h - its transport cannot take a new credential while it runs); a hunt by P2P_TURN_MAX_TTL_SECONDS (a hunt of
        // 2 hours gets its life plus grace).
        const Caps = { maxCredentialTtlSeconds: 10_800, realmHubCredentialTtlSeconds: 86_400 };
        assert.equal(RelayTtlCapSeconds(Hub(kit, hub), Caps), 86_400);
        assert.equal(RelayTtlCapSeconds({ sessionKind: undefined }, Caps), 10_800, "a hunt keeps the general cap");
        assert.equal(RelayTtlCapSeconds(Hub(kit, hub), { maxCredentialTtlSeconds: 10_800 }), 10_800, "no hub bound: the general cap");
        assert.equal(RelayTtlSeconds(Hub(kit, hub).expiresAt, Date.now(), RelayTtlCapSeconds(Hub(kit, hub), Caps)), 86_400);
        assert.equal(RelayTtlSeconds(iso(2 * 3_600_000), Date.now(), 10_800), 2 * 3600 + 600);
        assert.equal(ReadP2PIceConfig({}).realmHubCredentialTtlSeconds, 86_400);
        assert.equal(ReadP2PIceConfig({ P2P_REALM_HUB_TURN_TTL_SECONDS: "999999" }).realmHubCredentialTtlSeconds, 86_400,
            "out of range (Cloudflare allows at most 48 h): the default");
        await ThrowsCode(() => CreateIceTransportConfig(STRANGER, hub.sessionId, { generation: 1 }), "P2P_NOT_ROSTERED");
        await ThrowsCode(() => CreateIceTransportConfig("nobody-account", hub.sessionId, { generation: 1 }), "P2P_NOT_ROSTERED");
        await ThrowsCode(() => CreateIceTransportConfig(MEMBER, hub.sessionId, { generation: 2 }), "P2P_GENERATION_FENCED");
        await RemoveRealmMemberFromHubs(REALM_ID, FRIEND, "KICK");
        await ThrowsCode(() => CreateIceTransportConfig(FRIEND, hub.sessionId, { generation: 1 }), "P2P_NOT_ROSTERED");
    });
});

test("transport config: a realm's members may ask more often than a hunt's party (120 an hour)", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const account = "chatty-member-account";
        kit.realms.members.add(`${REALM_ID}:${account}`);
        await Enter(kit, hub, account);
        for (let index = 0; index < 120; index++) await CreateIceTransportConfig(account, hub.sessionId, { generation: 1 });
        await ThrowsCode(() => CreateIceTransportConfig(account, hub.sessionId, { generation: 1 }), "P2P_RELAY_RATE_LIMITED");
    });
});

test("signals go between the host and a member with an entry, never between two members; a hub's host may send many more", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Admit(kit, hub, MEMBER);
        await Enter(kit, hub, FRIEND);
        const signal = (toAccountId: string) => ({ generation: 1, toAccountId, kind: "GATHERING_DONE", data: "" });
        const toHost = await SubmitIceSignal(MEMBER, hub.sessionId, signal(HOST));
        assert.equal(toHost.delivered, true);
        const queued = kit.hunts.controlMessages.filter((entry) => entry.messageType === "ICE_SIGNAL");
        assert.equal(queued.length, 1);
        assert.equal(queued[0].accountId, HOST);
        assert.equal(queued[0].payload.fromAccountId, MEMBER);
        assert.equal(queued[0].payload.fromRole, "JOIN");
        assert.equal((await SubmitIceSignal(HOST, hub.sessionId, signal(MEMBER))).delivered, true);
        assert.equal((await SubmitIceSignal(HOST, hub.sessionId, signal(FRIEND))).delivered, true, "the host may signal a member that is only expected");
        assert.equal((await SubmitIceSignal(FRIEND, hub.sessionId, signal(HOST))).delivered, true);
        await ThrowsCode(() => SubmitIceSignal(MEMBER, hub.sessionId, signal(FRIEND)), "P2P_NOT_ROSTERED");
        await ThrowsCode(() => SubmitIceSignal(MEMBER, hub.sessionId, signal(MEMBER)), "P2P_NOT_ROSTERED");
        await ThrowsCode(() => SubmitIceSignal(STRANGER, hub.sessionId, signal(HOST)), "P2P_NOT_ROSTERED");
        await ThrowsCode(() => SubmitIceSignal(HOST, hub.sessionId, signal(STRANGER)), "P2P_NOT_ROSTERED");

        // 300 an hour per sender for a member; the hub host, who signals for every member, gets 3000.
        for (let index = 0; index < 400; index++) assert.equal((await SubmitIceSignal(HOST, hub.sessionId, signal(MEMBER))).delivered, true);
        let delivered = 1;      // the member's first signal above
        for (let index = 0; index < 299; index++) { await SubmitIceSignal(MEMBER, hub.sessionId, signal(HOST)); delivered++; }
        assert.equal(delivered, 300);
        await ThrowsCode(() => SubmitIceSignal(MEMBER, hub.sessionId, signal(HOST)), "P2P_SIGNAL_LIMIT");
        // After the member is gone nobody can signal it.
        await RemoveRealmMemberFromHubs(REALM_ID, MEMBER, "BAN");
        await ThrowsCode(() => SubmitIceSignal(HOST, hub.sessionId, signal(MEMBER)), "P2P_NOT_ROSTERED");
    });
});

// ---------------------------------------------------------------------------------------------------------------
// The lifecycle monitor
// ---------------------------------------------------------------------------------------------------------------

const monitor = () => new P2PHuntLifecycleMonitor();

test("monitor: a healthy hub with an empty roster is left alone (no participant-observation quorum, no recovery)", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const version = Hub(kit, hub).stateVersion;
        await monitor().tick();
        await monitor().tick();
        assert.equal(Hub(kit, hub).state, "RUNNING");
        assert.equal(Hub(kit, hub).stateVersion, version);
        assert.equal(kit.hunts.controlMessages.length, 0);
    });
});

test("monitor: a lapsed lease makes the hub SUSPECT, the lease coming back makes it RUNNING again", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Admit(kit, hub, MEMBER);
        Hub(kit, hub).leaseExpiresAt = PAST();
        await monitor().tick();
        const suspect = Hub(kit, hub);
        assert.equal(suspect.state, "SUSPECT");
        assert.equal(suspect.preSuspectState, "RUNNING");
        assert.equal(suspect.failureReason, "HOST_LEASE_MISSED");
        assert.ok(Date.parse(suspect.suspectDeadline!) > Date.now() && Date.parse(suspect.suspectDeadline!) <= Date.now() + 120_000);
        assert.equal(kit.hunts.transitions.at(-1)!.toState, "SUSPECT");
        // Still serving: its runtime credential still works and its members are untouched.
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "ADMITTED");

        // The host's heartbeat is back (the lease renews through SUSPECT).
        await RenewHostLease(CapabilityOf(kit, hub), { leaseSequence: 1, bridgeAlive: true, serverReady: true, admittedPeerCount: 1, queuePressure: 0 });
        await monitor().tick();
        const back = Hub(kit, hub);
        assert.equal(back.state, "RUNNING");
        assert.equal(back.suspectDeadline, undefined);
        assert.equal(back.preSuspectState, undefined);
        assert.equal(kit.hunts.transitions.at(-1)!.reason, "LEASE_RECOVERED");
    });
});

test("monitor: a suspect hub whose host never comes back is aborted HOST_LEASE_LOST, with everything that goes with the end of a hub", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const { consumed } = await Admit(kit, hub, MEMBER);
        await Enter(kit, hub, FRIEND);
        const friendTicket = await CreateJoinBootstrap(FRIEND, hub.sessionId);
        const record = Hub(kit, hub);
        record.leaseExpiresAt = PAST();
        await monitor().tick();
        assert.equal(Hub(kit, hub).state, "SUSPECT");
        Hub(kit, hub).suspectDeadline = PAST();
        kit.realms.hostingPatches.length = 0;
        await monitor().tick();

        const ended = Hub(kit, hub);
        assert.equal(ended.state, "ABORTED");
        assert.equal(ended.failureReason, "HOST_LEASE_LOST");
        assert.equal(ended.completionReason, "HOST_LEASE_LOST");
        assert.equal(ended.activePartyKey, undefined);
        assert.equal(ended.leaseExpiresAt, undefined);
        assert.equal(ended.suspectDeadline, undefined);
        assert.ok(ended.terminalAt);
        assert.equal(kit.hunts.transitions.at(-1)!.toState, "ABORTED");
        assert.equal(kit.hunts.transitions.at(-1)!.actorType, "SYSTEM");

        // Presence: host, the member present and the member waiting are all LOST.
        for (const account of [HOST, MEMBER, FRIEND]) assert.equal((await kit.presence.findPresence(hub.sessionId, account))!.state, "LOST", account);
        const leave = kit.hunts.controlMessages.filter((entry) => entry.messageType === "REALM_SESSION_LEAVE");
        assert.deepEqual(leave.map((entry) => entry.accountId).sort(), [FRIEND, MEMBER].sort());
        assert.equal(leave[0].payload.reason, "HOST_LEASE_LOST");
        assert.deepEqual(kit.hunts.controlMessages.filter((entry) => entry.messageType === "FENCE_NOW").map((entry) => entry.accountId), [HOST]);
        // The credentials are dead: the capability, and the ticket the waiting member held.
        assert.ok(CapabilityOf(kit, hub).revokedAt);
        const friendClaims = VerifyAdmissionTicket(friendTicket.ticket);
        assert.equal(kit.hunts.tickets.get(HashAdmissionJti(friendClaims.jti))!.status, "REVOKED");
        assert.equal(kit.hunts.peerAdmissions.has(consumed.admissionId), true);
        // The host failed, without a cooldown; the realm shows no hub and is offline now.
        assert.equal(kit.hunts.hostReliability.get(HOST)!.unexpectedFailures, 1);
        assert.equal(kit.hunts.hostReliability.get(HOST)!.cooldownUntil, undefined);
        assert.deepEqual(kit.realms.hostingPatches.map((entry) => entry.patch.hubState), ["NONE"]);
        assert.equal(kit.realms.hostingPatches[0].patch.hubSessionId, null);
        assert.deepEqual(kit.realms.offline, [REALM_ID]);
        // Later ticks leave it alone, and the key is free for a new hub.
        await monitor().tick();
        assert.equal(kit.realms.offline.length, 1);
        assert.equal((await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" })).state, "HOST_OFFERED");
    });
});

test("monitor: an offer nobody bootstrapped, a start that never finished and a host that never published its route are aborted", async () => {
    await WithKit(async (kit) => {
        const offered = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        Hub(kit, offered.sessionId).offerExpiresAt = PAST();
        await monitor().tick();
        assert.equal(Hub(kit, offered.sessionId).state, "ABORTED");
        assert.equal(Hub(kit, offered.sessionId).failureReason, "HUB_OFFER_EXPIRED");
        assert.equal(kit.hunts.hostReliability.get(HOST), undefined, "an unused offer is not the host's failure");

        const starting = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        await CreateHostBootstrap(HOST, starting.sessionId);
        Hub(kit, starting.sessionId).startupDeadline = PAST();
        await monitor().tick();
        assert.equal(Hub(kit, starting.sessionId).state, "ABORTED");
        assert.equal(Hub(kit, starting.sessionId).failureReason, "HUB_STARTUP_TIMEOUT");
        assert.equal(kit.hunts.hostReliability.get(HOST)!.startsFailed, 1);

        const unrouted = await CreateRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        const bootstrap = await CreateHostBootstrap(HOST, unrouted.sessionId);
        const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
        await MarkHostReady({ sessionId: unrouted.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        Hub(kit, unrouted.sessionId).startupDeadline = PAST();
        await monitor().tick();
        assert.equal(Hub(kit, unrouted.sessionId).state, "ABORTED");
        assert.equal(Hub(kit, unrouted.sessionId).failureReason, "HUB_STARTUP_TIMEOUT");
    });
});

test("monitor: the operator's emergency stop and the hosting switch end every hub; hunts are not affected by the hub branch", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const hunt = await SeedHunt(kit, { state: "RUNNING", bridgeInstanceId: "b", leaseExpiresAt: iso(30_000), activePartyKey: "party-live" });
        await monitor().tick();
        assert.equal(Hub(kit, hub).state, "RUNNING");
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "RUNNING", "a healthy hunt stays as it is");

        const hosting = process.env.MYSTICPARADOX_REALMS_HOSTING;
        process.env.MYSTICPARADOX_REALMS_HOSTING = "off";
        await monitor().tick();
        process.env.MYSTICPARADOX_REALMS_HOSTING = hosting;
        assert.equal(Hub(kit, hub).state, "ABORTED");
        assert.equal(Hub(kit, hub).failureReason, "REALM_HOSTING_DISABLED");
        assert.equal(kit.hunts.hostReliability.get(HOST)?.unexpectedFailures ?? 0, 0, "switching the feature off is nobody's failure");
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "RUNNING");
        // (The operator stop below would also put the hunt through recovery, which needs the Director; not this test.)
        kit.hunts.hunts.delete(hunt.sessionId);

        const second = await CreateRealmHubSession(HOST, { hubKind: "TRAINING" });
        UseP2POperationsPolicyForTest({ p2pEmergencyStop: true, coopTransport: "ICE" });
        await monitor().tick();
        assert.equal(Hub(kit, second.sessionId).state, "ABORTED");
        assert.equal(Hub(kit, second.sessionId).failureReason, "OPERATOR_P2P_STOP");
    });
});

test("monitor: entries that never came in expire, connected members stay", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Admit(kit, hub, MEMBER);
        await Enter(kit, hub, FRIEND);
        kit.presence.rows.get(`${hub.sessionId}:${FRIEND}`)!.expiresAt = PAST();
        await monitor().tick();
        assert.equal((await kit.presence.findPresence(hub.sessionId, FRIEND))!.state, "EXPIRED");
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "ADMITTED");
        assert.equal(Hub(kit, hub).state, "RUNNING");
        assert.equal(kit.hunts.controlMessages.filter((entry) => entry.messageType === "REALM_SESSION_LEAVE").length, 0);
    });
});

test("one hub failing its tick does not stop the monitor for the others", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const training = await StartRunningHubOf(kit, "TRAINING");
        Hub(kit, hub).leaseExpiresAt = PAST();
        Hub(kit, training).leaseExpiresAt = PAST();
        const original = kit.hunts.compareAndSetHunt.bind(kit.hunts);
        let failed = false;
        kit.hunts.compareAndSetHunt = async (input) => {
            if (!failed) { failed = true; throw new Error("database hiccup"); }
            return original(input);
        };
        await monitor().tick();
        kit.hunts.compareAndSetHunt = original;
        assert.deepEqual([Hub(kit, hub).state, Hub(kit, training).state].sort(), ["RUNNING", "SUSPECT"]);
        await monitor().tick();
        assert.equal(Hub(kit, hub).state, "SUSPECT");
        assert.equal(Hub(kit, training).state, "SUSPECT");
    });
});

async function StartRunningHubOf(kit: HubKit, hubKind: "RAMSGATE" | "TRAINING"): Promise<string> {
    const started = await CreateRealmHubSession(HOST, { hubKind });
    const bootstrap = await CreateHostBootstrap(HOST, started.sessionId);
    const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
    await MarkHostReady({ sessionId: started.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
        bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
    await MarkLocalRouteReady(HOST, started.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId, localHost: "127.0.0.1", localPort: 55300 });
    return started.sessionId;
}

test("TickRealmHub on its own: a SUSPECT hub with no way back waits for its deadline", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const record = Hub(kit, hub);
        record.state = "SUSPECT";
        record.leaseExpiresAt = iso(5_000);
        record.preSuspectState = undefined;
        record.suspectDeadline = iso(5_000);
        await TickRealmHub(record, Date.now(), { emergencyStop: false });
        assert.equal(Hub(kit, hub).state, "SUSPECT");
    });
});

// ---------------------------------------------------------------------------------------------------------------
// The end of a hub, and what the realms module tells us
// ---------------------------------------------------------------------------------------------------------------

test("ending a hub twice, with the wrong generation, or after it ended does nothing", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        assert.equal(await EndRealmHub(hub.sessionId, 2, "TEST", "ABORTED"), undefined);
        assert.equal(Hub(kit, hub).state, "RUNNING");
        const ended = await EndRealmHub(hub.sessionId, 1, "TEST", "COMPLETED");
        assert.equal(ended!.record.state, "COMPLETED");
        assert.deepEqual(ended!.endedAccountIds, [HOST]);
        assert.equal(await EndRealmHub(hub.sessionId, 1, "TEST", "ABORTED"), undefined);
        assert.equal(Hub(kit, hub).state, "COMPLETED", "an ended hub stays as it ended");
        assert.equal(await EndRealmHub("77777777-7777-4777-8777-777777777777", 1, "TEST", "ABORTED"), undefined);
        // A hunt is never ended through here.
        const hunt = await SeedHunt(kit, { state: "RUNNING", activePartyKey: "party-h" });
        assert.equal(await EndRealmHub(hunt.sessionId, 1, "TEST", "ABORTED"), undefined);
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.state, "RUNNING");
    });
});

test("ending the realm's Ramsgate ends the realm's hunts of the same host with it; ending Training does not", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const realmHunt = await SeedHunt(kit, { state: "RUNNING", realmId: REALM_ID, activePartyKey: "party-realm", partyId: "party-realm", bridgeInstanceId: "hb" });
        const otherHost = await SeedHunt(kit, { state: "RUNNING", realmId: REALM_ID, hostAccountId: STRANGER, activePartyKey: "party-other", partyId: "party-other", bridgeInstanceId: "ob" });
        const official = await SeedHunt(kit, { state: "RUNNING", activePartyKey: "party-official", partyId: "party-official", bridgeInstanceId: "fb" });
        const training = await StartRunningHubOf(kit, "TRAINING");
        await StopRealmHubSession(HOST, { hubKind: "TRAINING" });
        assert.equal(Hub(kit, training).state, "COMPLETED");
        assert.equal(kit.hunts.hunts.get(realmHunt.sessionId)!.state, "RUNNING");

        await StopRealmHubSession(HOST, { hubKind: "RAMSGATE" });
        assert.equal(Hub(kit, hub).state, "COMPLETED");
        assert.equal(kit.hunts.hunts.get(realmHunt.sessionId)!.state, "COMPLETED");
        assert.equal(kit.hunts.hunts.get(realmHunt.sessionId)!.completionReason, "REALM_HUB_ENDED_HOST_STOPPED");
        assert.equal(kit.hunts.hunts.get(otherHost.sessionId)!.state, "RUNNING", "another host's hunt is not ours to end");
        assert.equal(kit.hunts.hunts.get(official.sessionId)!.state, "RUNNING", "an official hunt has no realm");
        assert.ok(kit.hunts.controlMessages.some((entry) => entry.sessionId === realmHunt.sessionId && entry.messageType === "FENCE_NOW"));
    });
});

test("realm event MEMBER_REMOVED: the member's rows are REMOVED, its tickets revoked, the host told to re-read its peers, the member to leave", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Admit(kit, hub, MEMBER);
        await Enter(kit, hub, FRIEND);
        const friendTicket = await CreateJoinBootstrap(FRIEND, hub.sessionId);
        assert.deepEqual((await ListHubPresentAccounts(hub.sessionId, 1)).sort(), [HOST, MEMBER].sort());

        // A member that is present.
        await HandleRealmEvent({ type: "MEMBER_REMOVED", realmId: REALM_ID, accountId: MEMBER, reason: "BAN" });
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "REMOVED");
        assert.equal((await kit.presence.findPresence(hub.sessionId, FRIEND))!.state, "TICKETED", "other members are untouched");
        assert.deepEqual(await ListHubPresentAccounts(hub.sessionId, 1), [HOST], "the presence cache saw the write");
        const expected = kit.hunts.controlMessages.filter((entry) => entry.messageType === "REALM_PEER_EXPECTED");
        assert.deepEqual(expected.map((entry) => [entry.accountId, entry.payload]), [[HOST, { sessionId: hub.sessionId, generation: 1 }]]);
        const leave = kit.hunts.controlMessages.filter((entry) => entry.messageType === "REALM_SESSION_LEAVE");
        assert.deepEqual(leave.map((entry) => [entry.accountId, entry.payload.reason]), [[MEMBER, "BANNED"]]);
        assert.equal(kit.hunts.tickets.get(HashAdmissionJti(VerifyAdmissionTicket(friendTicket.ticket).jti))!.status, "ISSUED");

        // A member that holds a ticket but is not connected yet: its ticket dies with its entry.
        await HandleRealmEvent({ type: "MEMBER_REMOVED", realmId: REALM_ID, accountId: FRIEND, reason: "KICK" });
        assert.equal((await kit.presence.findPresence(hub.sessionId, FRIEND))!.state, "REMOVED");
        assert.equal(kit.hunts.tickets.get(HashAdmissionJti(VerifyAdmissionTicket(friendTicket.ticket).jti))!.status, "REVOKED");
        assert.equal(kit.hunts.controlMessages.filter((entry) => entry.messageType === "REALM_SESSION_LEAVE").at(-1)!.payload.reason, "KICKED");
        await ThrowsCode(() => ConsumeAdmissionTicket({ sessionId: hub.sessionId, ticket: friendTicket.ticket, authenticatedSteamId: DeriveIcePeerId(FRIEND),
            bridgeInstanceId: hub.bridgeInstanceId, connectionHandle: "h", requestId: "r", capability: CapabilityOf(kit, hub) }), "P2P_TICKET_INVALID");

        // Nothing to do for an account that is in no hub, or another realm's.
        const messages = kit.hunts.controlMessages.length;
        await HandleRealmEvent({ type: "MEMBER_REMOVED", realmId: REALM_ID, accountId: STRANGER, reason: "KICK" });
        await HandleRealmEvent({ type: "MEMBER_REMOVED", realmId: "another-realm", accountId: HOST, reason: "LEAVE" });
        assert.equal(kit.hunts.controlMessages.length, messages);
        assert.equal((await kit.presence.findPresence(hub.sessionId, HOST))!.state, "ADMITTED");
    });
});

test("realm event REALM_RELEASED ends the realm's hubs cleanly without touching the released realm; HOST_OFFLINE changes nothing", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const training = await StartRunningHubOf(kit, "TRAINING");
        await Admit(kit, hub, MEMBER);
        kit.realms.hostingPatches.length = 0;
        await HandleRealmEvent({ type: "HOST_OFFLINE", realmId: REALM_ID, hostAccountId: HOST });
        assert.equal(Hub(kit, hub).state, "RUNNING");

        await HandleRealmEvent({ type: "REALM_RELEASED", realmId: REALM_ID, hostAccountId: HOST });
        for (const id of [hub.sessionId, training]) {
            assert.equal(Hub(kit, id).state, "COMPLETED", id);
            assert.equal(Hub(kit, id).completionReason, "REALM_RELEASED", id);
            assert.equal(Hub(kit, id).activePartyKey, undefined, id);
        }
        assert.equal((await kit.presence.findPresence(hub.sessionId, MEMBER))!.state, "REMOVED");
        assert.deepEqual(kit.realms.hostingPatches, [], "the realm is gone: nothing is written into it");
        assert.deepEqual(kit.realms.offline, []);
        assert.ok(kit.hunts.controlMessages.some((entry) => entry.messageType === "REALM_SESSION_LEAVE" && entry.accountId === MEMBER));
    });
});

// ---------------------------------------------------------------------------------------------------------------
// The other hub-aware routes
// ---------------------------------------------------------------------------------------------------------------

test("the host's abort and clean end of a hub end it (ABORTED / COMPLETED) with no recovery and no hunt logic", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        const aborted = await AbortHunt(CapabilityOf(kit, hub), { reason: "SERVER_CRASHED" });
        assert.equal(aborted.accepted, true);
        assert.equal(aborted.recoveryStarted, false);
        assert.equal(Hub(kit, hub).state, "ABORTED");
        assert.equal(Hub(kit, hub).failureReason, "HOST_ABORT_SERVER_CRASHED");
        assert.equal(kit.hunts.controlMessages.filter((entry) => entry.messageType === "RETURN_TO_RAMSGATE").length, 0);

        const second = await StartRunningHub(kit);
        const end = await EndHunt(CapabilityOf(kit, second), { reason: "HOST_CLOSED" });
        assert.equal(end.cleanEnd, true);
        assert.equal(end.state, "COMPLETED");
        assert.equal(Hub(kit, second).completionReason, "HOST_END_HOST_CLOSED");
        await ThrowsCode(() => EndHunt(CapabilityOf(kit, second), {}), "P2P_GENERATION_FENCED");
        await ThrowsCode(() => EndHunt({ ...CapabilityOf(kit, second), hostAccountId: MEMBER }, {}), "P2P_GENERATION_FENCED");
    });
});

test("hub status and observations: accepted for the host and for members with an entry, never stored, refused for strangers", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Enter(kit, hub, MEMBER);
        for (const account of [HOST, MEMBER]) {
            const status = await GetHuntStatus(account, hub.sessionId);
            assert.equal(status.state, "RUNNING");
            assert.equal(status.sessionKind, "REALM_HUB");
            assert.equal(status.rewardsApplied, false);
            assert.equal(status.evidenceCollected, false);
        }
        await ThrowsCode(() => GetHuntStatus(STRANGER, hub.sessionId), "P2P_SESSION_NOT_FOUND");
        const observation = { generation: 1, observedAt: iso(), hostReachable: true, localBridgeAlive: true, metricsAvailable: false, routeKind: "UNKNOWN" };
        const accepted = await RecordParticipantObservation(MEMBER, hub.sessionId, observation);
        assert.deepEqual(accepted, { accepted: true, sessionId: hub.sessionId, generation: 1, stored: false, state: "RUNNING" });
        assert.equal(kit.hunts.observations.length, 0);
        assert.equal((await RecordParticipantObservation(HOST, hub.sessionId, observation)).accepted, true);
        await ThrowsCode(() => RecordParticipantObservation(STRANGER, hub.sessionId, observation), "P2P_GENERATION_FENCED");
        await ThrowsCode(() => RecordParticipantObservation(MEMBER, hub.sessionId, { ...observation, generation: 2 }), "P2P_GENERATION_FENCED");
    });
});

// ---------------------------------------------------------------------------------------------------------------
// Hunts behave as before
// ---------------------------------------------------------------------------------------------------------------

test("a hunt still bootstraps with its own scopes and limits, runs on its host's route, and never sees a hub as its own", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        kit.linkAccount(MEMBER);
        const hunt = await SeedHunt(kit);
        const bootstrap = await CreateHostBootstrap(HOST, hunt.sessionId);
        assert.equal(bootstrap.maximumPeers, 2, "min(4, roster)");
        assert.equal("sessionKind" in bootstrap, false);
        assert.equal("hostLocalClient" in bootstrap, false);
        assert.equal(bootstrap.guardCompletionMode, "FIRST_DEFEAT");
        const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
        assert.deepEqual([...capability.scopes].sort(),
            ["ABORT", "COMPLETE_REQUEST", "EVENTS_WRITE", "GAME_SERVER_RUNTIME", "HOST_READY", "LEASE_HEARTBEAT", "PEER_ADMITTED"]);
        assert.ok(Date.parse(capability.expiresAt) - Date.parse(capability.issuedAt) <= 2 * 3_600_000 + 1000, "a hunt's capability stays at most two hours");
        await MarkHostReady({ sessionId: hunt.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        await MarkLocalRouteReady(HOST, hunt.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId, localHost: "127.0.0.1", localPort: 55400 });
        const running = kit.hunts.hunts.get(hunt.sessionId)!;
        assert.equal(running.state, "RUNNING");
        assert.equal(kit.hunts.transitions.filter((entry) => entry.sessionId === hunt.sessionId).at(-1)!.reason, "HOST_ADMITTED_LOCALLY");
        assert.equal(running.roster.find((entry) => entry.accountId === HOST)!.admissionState, "ADMITTED");
        assert.equal(running.roster.find((entry) => entry.accountId === HOST)!.localBridgePort, 55400);
        assert.ok(kit.hunts.controlMessages.some((entry) => entry.messageType === "JOIN_RENDEZVOUS" && entry.accountId === MEMBER), "the roster's other members are rendezvoused");
        assert.equal(running.hostLocalBridgePort, undefined);
        // The hub is neither found as the host's hunt nor counted as one.
        assert.equal((await kit.hunts.findActiveHuntForAccount(HOST))!.sessionId, hunt.sessionId);
        assert.equal(await kit.hunts.countActiveHostSessions(HOST), 2);
        assert.equal(Hub(kit, hub).state, "RUNNING");
        // A hunt's member still goes through its roster entry.
        const join = await CreateJoinBootstrap(MEMBER, hunt.sessionId);
        assert.ok(join.ticket);
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.roster.find((entry) => entry.accountId === MEMBER)!.admissionState, "ISSUED");
        assert.equal(await kit.presence.findPresence(hunt.sessionId, MEMBER), undefined, "and writes no hub presence");
    });
});

test("a hunt's member consume and disconnect still use the roster", async () => {
    await WithKit(async (kit) => {
        kit.linkAccount(MEMBER);
        const hunt = await SeedHunt(kit);
        const bootstrap = await CreateHostBootstrap(HOST, hunt.sessionId);
        const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
        await MarkHostReady({ sessionId: hunt.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
            bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
        await MarkLocalRouteReady(HOST, hunt.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId, localHost: "127.0.0.1", localPort: 55401 });
        const join = await CreateJoinBootstrap(MEMBER, hunt.sessionId);
        const consumed = await ConsumeAdmissionTicket({ sessionId: hunt.sessionId, ticket: join.ticket, authenticatedSteamId: DeriveIcePeerId(MEMBER),
            bridgeInstanceId: bootstrap.bridgeInstanceId, connectionHandle: "h", requestId: "r", capability });
        assert.equal(consumed.admitted, true);
        assert.equal(kit.hunts.hunts.get(hunt.sessionId)!.roster.find((entry) => entry.accountId === MEMBER)!.admissionState, "ADMITTED");
        assert.deepEqual(await RecordPeerDisconnected({ admissionId: consumed.admissionId, capability }), { disconnected: true });
        const member = kit.hunts.hunts.get(hunt.sessionId)!.roster.find((entry) => entry.accountId === MEMBER)!;
        assert.equal(member.admissionState, "LOST");
        assert.ok(member.rejoinDeadline);
        assert.equal(kit.presence.rows.size, 0, "no hub rows for a hunt");
    });
});
