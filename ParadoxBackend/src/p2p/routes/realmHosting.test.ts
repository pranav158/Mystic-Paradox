import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import type { AddressInfo } from "node:net";
import express, { NextFunction, Request, Response } from "express";
import { UseP2POperationsPolicyForTest } from "../services/p2pOperationsPolicy";
import { LauncherApiError, SendLauncherError } from "../security/p2pErrors";
import { DeriveIcePairKey } from "../security/iceSessionRules";
import { DeriveIcePeerId } from "../security/transportPeerIds";
import {
    CreateHubKit, FRIEND, HOST, HubKit, InstallHubTestEnvironment, MEMBER, REALM_ID, StartRunningHub, STRANGER
} from "../realm/realmHubTestKit";
import { CreateRealmHostingRouter } from "./realmHosting";

/*
 * The realm host's launcher API over HTTP, with the real router, controllers and rules on in-memory repositories. The launcher
 * sign-in itself (HasLauncherAuth) needs MongoDB, so the router is mounted behind a stand-in that reads the account from the
 * x-test-user header and answers the launcher's 401 envelope without one.
 */

let restoreEnvironment: () => void;
let server: http.Server;
let port: number;

function FakeAuth(req: Request, res: Response, next: NextFunction) {
    const user = req.headers["x-test-user"];
    if (typeof user !== "string") {
        SendLauncherError(res, new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required."));
        return;
    }
    (req as any).LauncherAuthData = { userId: user };
    next();
}

before(async () => {
    restoreEnvironment = InstallHubTestEnvironment();
    const app = express();
    app.use(express.json());
    app.use("/", CreateRealmHostingRouter({ auth: FakeAuth, guards: { hosting: (_req, _res, next) => next(), active: (_req, _res, next) => next() } }));
    app.use((_req, res) => { res.status(404).send(); });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); });
    port = (server.address() as AddressInfo).port;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnvironment();
});

interface Reply { status: number; headers: http.IncomingHttpHeaders; json: any }

function Call(method: string, path: string, user: string | undefined, body?: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (user !== undefined) headers["x-test-user"] = user;
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload !== undefined) headers["content-type"] = "application/json";
        const request = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => {
                let json: any;
                try { json = text.length > 0 ? JSON.parse(text) : undefined; } catch { json = text; }
                resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
            });
        });
        request.on("error", reject);
        request.setTimeout(5000, () => request.destroy(new Error(`no answer: ${method} ${path}`)));
        if (payload !== undefined) request.write(payload);
        request.end();
    });
}

function ExpectError(reply: Reply, status: number, code: string): void {
    assert.equal(reply.status, status, JSON.stringify(reply.json));
    assert.equal(reply.json.error.code, code, JSON.stringify(reply.json));
    assert.equal(typeof reply.json.error.message, "string");
    assert.equal(typeof reply.json.error.requestId, "string");
}

async function WithKit(body: (kit: HubKit) => Promise<void>, options: Parameters<typeof CreateHubKit>[0] = {}): Promise<void> {
    const kit = CreateHubKit(options);
    try { await body(kit); } finally { kit.dispose(); }
}

const START = "/launcher/v1/realm-hosting/hubs/start";
const STOP = "/launcher/v1/realm-hosting/hubs/stop";
const peersPath = (sessionId: string) => `/launcher/v1/p2p/hunts/${sessionId}/peers`;

// ---------------------------------------------------------------------------------------------------------------
// hubs/start
// ---------------------------------------------------------------------------------------------------------------

test("every realm hosting route needs a launcher sign-in and answers the launcher error envelope without one", async () => {
    await WithKit(async (kit) => {
        for (const path of [START, STOP, peersPath("11111111-1111-4111-8111-111111111111")]) {
            const reply = await Call("POST", path, undefined, {});
            ExpectError(reply, 401, "AUTH_UNAUTHORIZED");
        }
        assert.equal(kit.hunts.hunts.size, 0);
    });
});

test("hubs/start creates the realm's Ramsgate hub session at HOST_OFFERED with an accepted host offer", async () => {
    await WithKit(async (kit) => {
        const reply = await Call("POST", START, HOST, { hubKind: "RAMSGATE" });
        assert.equal(reply.status, 200, JSON.stringify(reply.json));
        assert.deepEqual(Object.keys(reply.json).sort(), ["generation", "hubKind", "sessionId", "state"]);
        assert.equal(reply.json.generation, 1);
        assert.equal(reply.json.hubKind, "RAMSGATE");
        assert.equal(reply.json.state, "HOST_OFFERED");
        assert.match(reply.json.sessionId, /^[0-9a-f-]{36}$/);
        assert.equal(reply.headers["cache-control"], "no-store");

        const hub = kit.hunts.hunts.get(reply.json.sessionId)!;
        assert.equal(hub.sessionKind, "REALM_HUB");
        assert.equal(hub.hubKind, "RAMSGATE");
        assert.equal(hub.realmId, REALM_ID);
        assert.equal(hub.hostAccountId, HOST);
        assert.equal(hub.hostSteamId, DeriveIcePeerId(HOST));
        assert.equal(hub.activePartyKey, `realmhub:${REALM_ID}:ramsgate`);
        assert.equal(hub.partyId, `realmhub:${REALM_ID}:ramsgate`);
        assert.equal(hub.partyRevision, 1);
        assert.equal(hub.huntDefinitionId, "ShatteredIsles_ReturnToRamsgate");
        assert.equal(hub.guardCompletionMode, "NO_COMPLETION");
        assert.equal(hub.trustTier, 0);
        assert.equal(hub.coopTransport, "ICE");
        assert.deepEqual(hub.roster, []);
        assert.equal(hub.hostParticipates, true);
        assert.equal(hub.maxPeers, 16);
        assert.equal(hub.hubRoomId, kit.realms.hubRoomId(REALM_ID, "RAMSGATE"));
        assert.equal(hub.matchmakerHuntId, "NO_MM_HUNTID");
        assert.equal(hub.behemothPath, "NO_BEHEMOTH");
        assert.equal(hub.expectedPlayerString, "NO_EXPECTED_PLAYERS");
        assert.equal(hub.mapPath, "/Game/Maps/ramsgate/ramsgate_01_persistent");
        assert.equal(hub.build, 647472);
        assert.equal(hub.bridgeProtocol, 1);
        assert.equal(hub.virtualPort, 1);
        assert.equal(hub.generation, 1);
        assert.equal(hub.state, "HOST_OFFERED");
        assert.equal(Date.parse(hub.expiresAt) - Date.parse(hub.createdAt), 7 * 24 * 3_600_000);
        assert.ok(Date.parse(hub.offerExpiresAt!) > Date.now());
        assert.equal(hub.sessionKind === "REALM_HUB" && hub.gameMode, "CITY");

        const offer = kit.hunts.hostOffers.get(hub.hostOfferId!)!;
        assert.equal(offer.status, "ACCEPTED");
        assert.equal(offer.rank, 0);
        assert.equal(offer.accountId, HOST);
        assert.equal(offer.steamId, DeriveIcePeerId(HOST));
        assert.equal(offer.sessionId, hub.sessionId);
        assert.equal(kit.hunts.transitions.filter((entry) => entry.sessionId === hub.sessionId).map((entry) => entry.toState).join(), "HOST_OFFERED");

        // The realm directory is told the hub is starting (and how many servers the host runs).
        assert.deepEqual(kit.realms.shown(REALM_ID), { hubState: "STARTING", hubSessionId: hub.sessionId, activeServers: 1 });
    });
});

test("hubs/start takes maxPlayers (1..64), creates a Training hub beside Ramsgate and mirrors its own state", async () => {
    await WithKit(async (kit) => {
        const ramsgate = await Call("POST", START, HOST, { hubKind: "RAMSGATE", maxPlayers: 40 });
        const training = await Call("POST", START, HOST, { hubKind: "TRAINING", maxPlayers: 4 });
        assert.equal(ramsgate.status, 200);
        assert.equal(training.status, 200, JSON.stringify(training.json));
        const trainingHub = kit.hunts.hunts.get(training.json.sessionId)!;
        assert.equal(kit.hunts.hunts.get(ramsgate.json.sessionId)!.maxPeers, 40);
        assert.equal(trainingHub.maxPeers, 4);
        assert.equal(trainingHub.hubKind, "TRAINING");
        assert.equal(trainingHub.huntDefinitionId, "ShatteredIsles_TrainingDojo");
        assert.equal(trainingHub.mapPath, "/Game/Maps/islands/dojo/training_dojo_persistent");
        assert.equal(trainingHub.gameMode, "SHARED");
        assert.equal(trainingHub.activePartyKey, `realmhub:${REALM_ID}:training`);
        assert.notEqual(trainingHub.hubRoomId, kit.hunts.hunts.get(ramsgate.json.sessionId)!.hubRoomId);
        assert.equal(await kit.hunts.countActiveRealmServers(REALM_ID), 2);
        const shown = kit.realms.shown(REALM_ID);
        assert.equal(shown.hubState, "STARTING");
        assert.equal(shown.trainingState, "STARTING");
        assert.equal(shown.hubSessionId, ramsgate.json.sessionId, "the Training hub never takes the hub session id");
        assert.equal(shown.activeServers, 2);
    });
});

test("hubs/start refuses a bad body", async () => {
    await WithKit(async (kit) => {
        for (const body of [{}, { hubKind: "CITY" }, { hubKind: "ramsgate" }, { hubKind: "RAMSGATE", maxPlayers: 0 },
            { hubKind: "RAMSGATE", maxPlayers: 65 }, { hubKind: "RAMSGATE", maxPlayers: 1.5 }, { hubKind: "RAMSGATE", maxPlayers: "16" }, []]) {
            ExpectError(await Call("POST", START, HOST, body), 400, "REALM_VALIDATION_FAILED");
        }
        assert.equal(kit.hunts.hunts.size, 0);
    });
});

test("hubs/start is for a realm's host only", async () => {
    await WithKit(async (kit) => {
        ExpectError(await Call("POST", START, MEMBER, { hubKind: "RAMSGATE" }), 404, "REALM_NOT_FOUND");
        ExpectError(await Call("POST", START, STRANGER, { hubKind: "RAMSGATE" }), 404, "REALM_NOT_FOUND");
        assert.equal(kit.hunts.hunts.size, 0);
    });
});

test("a realm has one live hub per kind: a second start is REALM_HUB_EXISTS, another kind is fine, and a finished hub frees the kind", async () => {
    await WithKit(async (kit) => {
        const first = await Call("POST", START, HOST, { hubKind: "RAMSGATE" });
        assert.equal(first.status, 200);
        const second = await Call("POST", START, HOST, { hubKind: "RAMSGATE" });
        ExpectError(second, 409, "REALM_HUB_EXISTS");
        assert.equal(kit.hunts.hunts.size, 1);
        assert.equal((await Call("POST", START, HOST, { hubKind: "TRAINING" })).status, 200);

        // The unique key also decides a race that passed the early check (what a duplicate key from the database means).
        const original = kit.hunts.findActiveHuntForParty.bind(kit.hunts);
        kit.hunts.findActiveHuntForParty = async () => undefined;
        ExpectError(await Call("POST", START, HOST, { hubKind: "RAMSGATE" }), 409, "REALM_HUB_EXISTS");
        kit.hunts.findActiveHuntForParty = original;

        const stopped = await Call("POST", STOP, HOST, { hubKind: "RAMSGATE" });
        assert.equal(stopped.status, 200);
        assert.equal((await Call("POST", START, HOST, { hubKind: "RAMSGATE" })).status, 200, "the key is free again");
    });
});

test("hubs/start asks the host's PC to be eligible, and says why when it is not", async () => {
    await WithKit(async (kit) => {
        kit.hunts.hostPresences.clear();
        const none = await Call("POST", START, HOST, { hubKind: "RAMSGATE" });
        ExpectError(none, 409, "REALM_HOST_INELIGIBLE");
        assert.equal(none.json.error.reason, "HOST_PRESENCE_MISSING");

        // [2026-10-16] Commit headroom is what can end a server; low free physical memory is only logged (below).
        kit.seedHostPresence(HOST, { commitHeadroomMiB: 2048 });
        const memory = await Call("POST", START, HOST, { hubKind: "RAMSGATE" });
        ExpectError(memory, 409, "REALM_HOST_INELIGIBLE");
        assert.equal(memory.json.error.reason, "HOST_COMMIT_LOW");

        kit.seedHostPresence(HOST, { consentToHost: false });
        assert.equal((await Call("POST", START, HOST, { hubKind: "RAMSGATE" })).json.error.reason, "HOST_CONSENT_REQUIRED");
        kit.seedHostPresence(HOST, { artifactsVerified: false });
        assert.equal((await Call("POST", START, HOST, { hubKind: "RAMSGATE" })).json.error.reason, "HOST_RUNTIME_UNVERIFIED");
        // Guard is not asked at a hub start: the hub's process (what Guard verifies) exists only after it (14 Oct repro).
        kit.seedHostPresence(HOST, { guardVerified: false, launcherVersion: "0.0.9" });
        assert.equal((await Call("POST", START, HOST, { hubKind: "RAMSGATE" })).json.error.reason, "HOST_LAUNCHER_OUTDATED",
            "the other checks still apply with Guard unverified");
        kit.seedHostPresence(HOST, { launcherVersion: "0.0.9" });
        assert.equal((await Call("POST", START, HOST, { hubKind: "RAMSGATE" })).json.error.reason, "HOST_LAUNCHER_OUTDATED");
        assert.equal(kit.hunts.hunts.size, 0);

        // A slow link is not a reason here, and 3 GiB is enough for the realm's per-server floor.
        // A slow link is not a reason here, 3 GiB is enough for the realm's per-server floor, and an unverified Guard (no game
        // running, no hub process yet) does not stop the start.
        kit.seedHostPresence(HOST, { worstPeerRttMs: 1500, jitterMs: 500, packetLossPercent: 40, freePhysicalMemoryMiB: 3100, commitHeadroomMiB: 4200,
            guardVerified: false });
        assert.equal((await Call("POST", START, HOST, { hubKind: "RAMSGATE" })).status, 200);
    });
});

// [2026-10-16] Realm servers start like a dedicated server's: a PC with little free physical memory and plenty of commit headroom
// was refused every Training start with REALM_HOST_INELIGIBLE HOST_MEMORY_LOW. Low free memory now starts, with a warning line.
test("hubs/start on a PC short of free physical memory but with commit headroom starts the hub", async () => {
    await WithKit(async (kit) => {
        kit.seedHostPresence(HOST, { freePhysicalMemoryMiB: 2006, commitHeadroomMiB: 15460 });
        assert.equal((await Call("POST", START, HOST, { hubKind: "TRAINING" })).status, 200);
    });
});

test("hubs/start counts the servers the realm already runs against the host's own limit", async () => {
    await WithKit(async (kit) => {
        kit.realms.realms.get(REALM_ID)!.hosting = { maxServers: 1 };
        assert.equal((await Call("POST", START, HOST, { hubKind: "RAMSGATE" })).status, 200);
        ExpectError(await Call("POST", START, HOST, { hubKind: "TRAINING" }), 409, "REALM_FULL");
        kit.realms.realms.get(REALM_ID)!.hosting = { maxServers: 2 };
        assert.equal((await Call("POST", START, HOST, { hubKind: "TRAINING" })).status, 200);
    });
});

test("hubs/start is gated by realm hosting, the P2P switch, the emergency stop and the ICE transport", async () => {
    await WithKit(async (kit) => {
        const hosting = process.env.MYSTICPARADOX_REALMS_HOSTING;
        process.env.MYSTICPARADOX_REALMS_HOSTING = "off";
        ExpectError(await Call("POST", START, HOST, { hubKind: "RAMSGATE" }), 503, "P2P_DISABLED");
        process.env.MYSTICPARADOX_REALMS_HOSTING = hosting;

        const p2p = process.env.P2P_HUNTS_ENABLED;
        process.env.P2P_HUNTS_ENABLED = "false";
        ExpectError(await Call("POST", START, HOST, { hubKind: "RAMSGATE" }), 503, "P2P_DISABLED");
        process.env.P2P_HUNTS_ENABLED = p2p;

        UseP2POperationsPolicyForTest({ p2pEmergencyStop: true, coopTransport: "ICE" });
        ExpectError(await Call("POST", START, HOST, { hubKind: "RAMSGATE" }), 503, "P2P_EMERGENCY_STOP");
        UseP2POperationsPolicyForTest({ p2pEmergencyStop: false, coopTransport: "STEAM_EXPERIMENTAL" });
        ExpectError(await Call("POST", START, HOST, { hubKind: "RAMSGATE" }), 409, "REALM_TRANSPORT_UNSUPPORTED");
        assert.equal(kit.hunts.hunts.size, 0);
        UseP2POperationsPolicyForTest({ p2pEmergencyStop: false, coopTransport: "ICE" });
        assert.equal((await Call("POST", START, HOST, { hubKind: "RAMSGATE" })).status, 200);
    });
});

test("a failing realm directory never fails the hub request", async () => {
    await WithKit(async (kit) => {
        kit.realms.failSetHosting = true;
        const reply = await Call("POST", START, HOST, { hubKind: "RAMSGATE" });
        assert.equal(reply.status, 200, JSON.stringify(reply.json));
        assert.equal(kit.hunts.hunts.size, 1);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// hubs/stop
// ---------------------------------------------------------------------------------------------------------------

test("hubs/stop ends the running hub cleanly: members told to leave, the host fenced, the realm offline, the key free", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        for (const account of [MEMBER, FRIEND]) {
            kit.linkAccount(account);
            await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: 1, realmId: REALM_ID, accountId: account,
                peerId: DeriveIcePeerId(account), candidateId: `c-${account}`, now: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString() });
        }
        await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: 1, accountId: MEMBER, admissionId: "adm", admittedAt: new Date().toISOString(), now: new Date().toISOString() });
        kit.realms.hostingPatches.length = 0;

        const reply = await Call("POST", STOP, HOST, { hubKind: "RAMSGATE" });
        assert.equal(reply.status, 200, JSON.stringify(reply.json));
        assert.deepEqual(reply.json, { stopped: true, hubKind: "RAMSGATE", sessionId: hub.sessionId, state: "COMPLETED" });
        const record = kit.hunts.hunts.get(hub.sessionId)!;
        assert.equal(record.state, "COMPLETED");
        assert.equal(record.completionReason, "HOST_STOPPED");
        assert.equal(record.failureReason, undefined);
        assert.equal(record.activePartyKey, undefined, "the key is free");
        assert.ok(record.terminalAt);
        assert.equal(kit.hunts.transitions.at(-1)!.toState, "COMPLETED");
        assert.equal(kit.hunts.transitions.at(-1)!.actorType, "HOST");

        // Presence: every live row (host, the member present, the member still waiting) is LOST.
        for (const account of [HOST, MEMBER, FRIEND]) assert.equal((await kit.presence.findPresence(hub.sessionId, account))!.state, "LOST", account);
        const leave = kit.hunts.controlMessages.filter((entry) => entry.messageType === "REALM_SESSION_LEAVE");
        assert.deepEqual(leave.map((entry) => entry.accountId).sort(), [FRIEND, MEMBER].sort());
        assert.deepEqual(leave[0].payload, { sessionId: hub.sessionId, generation: 1, reason: "HOST_STOPPED", hubKind: "RAMSGATE", realmId: REALM_ID });
        const fence = kit.hunts.controlMessages.filter((entry) => entry.messageType === "FENCE_NOW");
        assert.deepEqual(fence.map((entry) => entry.accountId), [HOST]);
        assert.equal(fence[0].payload.recoveryAction, "NONE");
        assert.ok(kit.hunts.capabilities.get(hub.capabilityId)!.revokedAt, "the host capability is revoked");
        assert.equal(kit.hunts.hostReliability.get(HOST)!.cleanCompletions, 1);

        // The directory: stopping, then none, and the realm is offline now.
        assert.deepEqual(kit.realms.hostingPatches.map((entry) => entry.patch.hubState), ["STOPPING", "NONE"]);
        assert.deepEqual(kit.realms.shown(REALM_ID), { hubState: "NONE", hubSessionId: null, activeServers: 0 });
        assert.deepEqual(kit.realms.offline, [REALM_ID]);

        // Stopping again is a no-op, and the kind can be started again.
        assert.deepEqual((await Call("POST", STOP, HOST, { hubKind: "RAMSGATE" })).json, { stopped: false, hubKind: "RAMSGATE" });
        assert.equal((await Call("POST", START, HOST, { hubKind: "RAMSGATE" })).status, 200);
    });
});

test("stopping the Training hub leaves Ramsgate and the realm online", async () => {
    await WithKit(async (kit) => {
        const ramsgate = await StartRunningHub(kit);
        const training = await StartRunningHubKind(kit, "TRAINING");
        kit.realms.hostingPatches.length = 0;
        const reply = await Call("POST", STOP, HOST, { hubKind: "TRAINING" });
        assert.equal(reply.json.stopped, true);
        assert.equal(kit.hunts.hunts.get(training)!.state, "COMPLETED");
        assert.equal(kit.hunts.hunts.get(ramsgate.sessionId)!.state, "RUNNING");
        assert.deepEqual(kit.realms.hostingPatches.map((entry) => entry.patch.trainingState), ["STOPPING", "NONE"]);
        assert.deepEqual(kit.realms.offline, [], "only the end of Ramsgate takes the realm offline");
        assert.equal(kit.realms.shown(REALM_ID).hubState, undefined);
    });
});

async function StartRunningHubKind(kit: HubKit, hubKind: "RAMSGATE" | "TRAINING"): Promise<string> {
    // A second hub of the same host on the same kit: bootstrap and route-ready like the first.
    const { CreateRealmHubSession } = await import("../controllers/realmHubLifecycle");
    const { CreateHostBootstrap, MarkLocalRouteReady } = await import("../controllers/p2pLauncher");
    const { MarkHostReady } = await import("../controllers/p2pAdmission");
    const { HashHostCapabilitySecret } = await import("../security/hostCapabilities");
    const started = await CreateRealmHubSession(HOST, { hubKind });
    const bootstrap = await CreateHostBootstrap(HOST, started.sessionId);
    const capability = (await kit.hunts.findHostCapabilityByDigest(HashHostCapabilitySecret(bootstrap.capability)))!;
    await MarkHostReady({ sessionId: started.sessionId, lobbyId: undefined, transport: "ICE", virtualPort: bootstrap.virtualPort,
        bridgeInstanceId: bootstrap.bridgeInstanceId, capability });
    await MarkLocalRouteReady(HOST, started.sessionId, { generation: 1, bridgeInstanceId: bootstrap.bridgeInstanceId, localHost: "127.0.0.1", localPort: 55200 });
    return started.sessionId;
}

test("hubs/stop is for the realm's host and needs a valid kind; it needs no switch to be on", async () => {
    await WithKit(async (kit) => {
        await StartRunningHub(kit);
        ExpectError(await Call("POST", STOP, MEMBER, { hubKind: "RAMSGATE" }), 404, "REALM_NOT_FOUND");
        ExpectError(await Call("POST", STOP, HOST, {}), 400, "REALM_VALIDATION_FAILED");
        ExpectError(await Call("POST", STOP, HOST, { hubKind: "CITY" }), 400, "REALM_VALIDATION_FAILED");
        assert.equal([...kit.hunts.hunts.values()][0].state, "RUNNING");
        // Cleanup works with realm hosting switched off.
        const hosting = process.env.MYSTICPARADOX_REALMS_HOSTING;
        process.env.MYSTICPARADOX_REALMS_HOSTING = "off";
        const reply = await Call("POST", STOP, HOST, { hubKind: "RAMSGATE" });
        process.env.MYSTICPARADOX_REALMS_HOSTING = hosting;
        assert.equal(reply.json.stopped, true);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// /peers
// ---------------------------------------------------------------------------------------------------------------

async function Enter(kit: HubKit, sessionId: string, accountId: string, requestedAtOffsetMs = 0): Promise<void> {
    kit.linkAccount(accountId);
    const now = Date.now() + requestedAtOffsetMs;
    await kit.presence.requestEntry({ sessionId, generation: 1, realmId: REALM_ID, accountId, peerId: DeriveIcePeerId(accountId),
        candidateId: `c-${accountId}`, now: new Date(now).toISOString(), expiresAt: new Date(now + 90_000).toISOString() });
}

test("peers: the host gets every expected or connected member with its pair key, never itself, never a lost one", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        await Enter(kit, hub.sessionId, MEMBER, -2000);
        await Enter(kit, hub.sessionId, FRIEND, -1000);
        await Enter(kit, hub.sessionId, STRANGER, 0);
        const at = new Date().toISOString();
        await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: 1, accountId: MEMBER, admissionId: "adm-m", admittedAt: at, now: at });
        await kit.presence.markTicketed({ sessionId: hub.sessionId, generation: 1, accountId: FRIEND, now: at, ticketExpiresAt: new Date(Date.now() + 180_000).toISOString() });
        await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: 1, accountId: STRANGER, admissionId: "adm-s", admittedAt: at, now: at });
        await kit.presence.markLost({ sessionId: hub.sessionId, generation: 1, accountId: STRANGER, lostAt: at, purgeAt: at });

        const reply = await Call("POST", peersPath(hub.sessionId), HOST, { generation: 1 });
        assert.equal(reply.status, 200, JSON.stringify(reply.json));
        assert.equal(reply.json.generation, 1);
        assert.deepEqual(reply.json.peers.map((peer: any) => [peer.accountId, peer.state, peer.peerId]), [
            [MEMBER, "ADMITTED", DeriveIcePeerId(MEMBER)],
            [FRIEND, "TICKETED", DeriveIcePeerId(FRIEND)]
        ]);
        const secret = process.env.P2P_TRANSPORT_KEY_SECRET!;
        for (const peer of reply.json.peers) {
            assert.deepEqual(Object.keys(peer).sort(), ["accountId", "peerId", "state", "transportKey"]);
            assert.equal(peer.transportKey, DeriveIcePairKey(secret, hub.sessionId, 1, HOST, peer.accountId));
            assert.equal(Buffer.from(peer.transportKey, "base64url").length, 32);
        }
        assert.notEqual(reply.json.peers[0].transportKey, reply.json.peers[1].transportKey);
        assert.equal(reply.headers["cache-control"], "no-store");
        // Stateless and secret-free: asking again changes nothing and mints no relay credential.
        assert.deepEqual((await Call("POST", peersPath(hub.sessionId), HOST, { generation: 1 })).json, reply.json);
        assert.equal(JSON.stringify(reply.json).includes("credential"), false);
    });
});

test("peers: an empty hub has an empty list; the list is capped at 64", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        assert.deepEqual((await Call("POST", peersPath(hub.sessionId), HOST, { generation: 1 })).json, { generation: 1, peers: [] });
        for (let index = 0; index < 70; index++) await Enter(kit, hub.sessionId, `crowd-account-${String(index).padStart(3, "0")}`, index);
        const crowded = await Call("POST", peersPath(hub.sessionId), HOST, { generation: 1 });
        assert.equal(crowded.json.peers.length, 64);
        assert.equal(crowded.json.peers[0].accountId, "crowd-account-000", "oldest entries first");
    });
});

test("peers: only the hub's host, only its own generation, only a hub that is up", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        ExpectError(await Call("POST", peersPath(hub.sessionId), MEMBER, { generation: 1 }), 403, "P2P_NOT_ROSTERED");
        ExpectError(await Call("POST", peersPath(hub.sessionId), STRANGER, { generation: 1 }), 403, "P2P_NOT_ROSTERED");
        ExpectError(await Call("POST", peersPath(hub.sessionId), HOST, { generation: 2 }), 409, "P2P_GENERATION_FENCED");
        ExpectError(await Call("POST", peersPath(hub.sessionId), HOST, {}), 400, "P2P_TICKET_INVALID");
        ExpectError(await Call("POST", peersPath(hub.sessionId), HOST, { generation: "1" }), 400, "P2P_TICKET_INVALID");
        ExpectError(await Call("POST", peersPath("22222222-2222-4222-8222-222222222222"), HOST, { generation: 1 }), 404, "P2P_SESSION_NOT_FOUND");

        // A hunt session is not a hub: its host has no peer list here.
        const [hubRecord] = [...kit.hunts.hunts.values()];
        kit.hunts.hunts.set("33333333-3333-4333-8333-333333333333", { ...hubRecord, sessionId: "33333333-3333-4333-8333-333333333333",
            sessionKind: undefined, activePartyKey: "party-x", partyId: "party-x" });
        ExpectError(await Call("POST", peersPath("33333333-3333-4333-8333-333333333333"), HOST, { generation: 1 }), 404, "P2P_SESSION_NOT_FOUND");

        // The ended hub answers nothing.
        await Call("POST", STOP, HOST, { hubKind: "RAMSGATE" });
        ExpectError(await Call("POST", peersPath(hub.sessionId), HOST, { generation: 1 }), 409, "P2P_SESSION_NOT_READY");
    });
});

test("peers: is refused while realm hosting's other switches are off, and without the transport key", async () => {
    await WithKit(async (kit) => {
        const hub = await StartRunningHub(kit);
        UseP2POperationsPolicyForTest({ p2pEmergencyStop: true, coopTransport: "ICE" });
        ExpectError(await Call("POST", peersPath(hub.sessionId), HOST, { generation: 1 }), 503, "P2P_EMERGENCY_STOP");
        UseP2POperationsPolicyForTest({ p2pEmergencyStop: false, coopTransport: "ICE" });
        const secret = process.env.P2P_TRANSPORT_KEY_SECRET;
        delete process.env.P2P_TRANSPORT_KEY_SECRET;
        ExpectError(await Call("POST", peersPath(hub.sessionId), HOST, { generation: 1 }), 503, "P2P_ICE_UNAVAILABLE");
        process.env.P2P_TRANSPORT_KEY_SECRET = secret;
        assert.equal((await Call("POST", peersPath(hub.sessionId), HOST, { generation: 1 })).status, 200);
    });
});
