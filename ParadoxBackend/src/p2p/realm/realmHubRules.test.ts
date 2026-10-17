import assert from "node:assert/strict";
import test from "node:test";
import type { P2PHostPresenceRecord, P2PHuntState } from "../persistence/contracts/P2PHuntRepository";
import type { RealmHubPresenceState } from "../persistence/contracts/RealmHubRepository";
import { ReadP2PHostEligibilityPolicy } from "../config/p2pHostPolicy";
import { REALM_HUB_MANIFESTS } from "./hubManifests";
import {
    ClassifyRealmRequest,
    DecideEntryRequest,
    DecideHubTick,
    DecideRealmCapacity,
    ENTRY_LIFETIME_MS,
    HUB_LIVE_STATES,
    HubEndCountsAsHostFailure,
    HubIsFull,
    HubPartyKey,
    HubTicketCheck,
    HubTicketDenialError,
    HubTicketDenialReason,
    IsHubTransitionAllowed,
    IsPresenceExpired,
    IsRealmHub,
    NextHubState,
    NextPresenceState,
    ParseHubStartBody,
    ParseHubStopBody,
    PRESENCE_ALL_STATES,
    PRESENCE_LIVE_STATES
} from "./realmHubRules";
import { IsRealmHostingEnabled, ReadRealmHubPolicy, RealmHostIneligibilityReason } from "./realmHubPolicy";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("ClassifyRealmRequest: CITY and ReturnToRamsgate are Ramsgate, the dojo is Training, everything else a hunt", () => {
    assert.equal(ClassifyRealmRequest("CITY", undefined), "RAMSGATE");
    assert.equal(ClassifyRealmRequest("CITY", ""), "RAMSGATE");
    assert.equal(ClassifyRealmRequest("CITY", "ShatteredIsles_ReturnToRamsgate"), "RAMSGATE");
    assert.equal(ClassifyRealmRequest("SHARED", "ShatteredIsles_ReturnToRamsgate"), "RAMSGATE");
    assert.equal(ClassifyRealmRequest("ISLAND", "ShatteredIsles_ReturnToRamsgate"), "RAMSGATE");
    assert.equal(ClassifyRealmRequest("SHARED", "ShatteredIsles_TrainingDojo"), "TRAINING");
    assert.equal(ClassifyRealmRequest("SHARED", REALM_HUB_MANIFESTS.TRAINING.huntDefinitionId), "TRAINING");
    assert.equal(ClassifyRealmRequest("ISLAND", "ShatteredIsles_IslandA"), "HUNT");
    assert.equal(ClassifyRealmRequest("SHARED", "ShatteredIsles_Embermane"), "HUNT");
    assert.equal(ClassifyRealmRequest("ISLAND", undefined), "HUNT");
    assert.equal(ClassifyRealmRequest(undefined, undefined), "HUNT");
    assert.equal(ClassifyRealmRequest("SHARED", "shatteredisles_trainingdojo"), "HUNT", "ids are matched as the shared matchmaker matches them: exactly");
});

test("the hub manifests are the Director's persistent hub layout, as constants", () => {
    assert.equal(REALM_HUB_MANIFESTS.RAMSGATE.mapPath, "/Game/Maps/ramsgate/ramsgate_01_persistent");
    assert.equal(REALM_HUB_MANIFESTS.RAMSGATE.huntDefinitionId, "ShatteredIsles_ReturnToRamsgate");
    assert.equal(REALM_HUB_MANIFESTS.TRAINING.mapPath, "/Game/Maps/islands/dojo/training_dojo_persistent");
    assert.equal(REALM_HUB_MANIFESTS.TRAINING.huntDefinitionId, "ShatteredIsles_TrainingDojo");
    for (const manifest of Object.values(REALM_HUB_MANIFESTS)) {
        assert.equal(manifest.behemothPath, "NO_BEHEMOTH");
        assert.equal(manifest.matchmakerHuntId, "NO_MM_HUNTID");
        assert.equal(manifest.expectedPlayerString, "NO_EXPECTED_PLAYERS");
        assert.equal(manifest.guardCompletionMode, "NO_COMPLETION");
    }
});

test("a hub is the session kind REALM_HUB; its party key is unique per realm and kind", () => {
    assert.equal(IsRealmHub({ sessionKind: "REALM_HUB" }), true);
    assert.equal(IsRealmHub({}), false);
    assert.equal(IsRealmHub(undefined), false);
    assert.equal(HubPartyKey("r1", "RAMSGATE"), "realmhub:r1:ramsgate");
    assert.equal(HubPartyKey("r1", "TRAINING"), "realmhub:r1:training");
    assert.notEqual(HubPartyKey("r1", "RAMSGATE"), HubPartyKey("r2", "RAMSGATE"));
});

test("hubs/start body: a kind, and 1..64 players (default 16)", () => {
    assert.deepEqual(ParseHubStartBody({ hubKind: "RAMSGATE" }), { ok: true, hubKind: "RAMSGATE", maxPlayers: 16 });
    assert.deepEqual(ParseHubStartBody({ hubKind: "TRAINING", maxPlayers: 64 }), { ok: true, hubKind: "TRAINING", maxPlayers: 64 });
    assert.deepEqual(ParseHubStartBody({ hubKind: "RAMSGATE", maxPlayers: 1 }), { ok: true, hubKind: "RAMSGATE", maxPlayers: 1 });
    for (const bad of [undefined, null, [], "RAMSGATE", {}, { hubKind: "ramsgate" }, { hubKind: "CITY" },
        { hubKind: "RAMSGATE", maxPlayers: 0 }, { hubKind: "RAMSGATE", maxPlayers: 65 }, { hubKind: "RAMSGATE", maxPlayers: 2.5 },
        { hubKind: "RAMSGATE", maxPlayers: "8" }]) {
        assert.equal(ParseHubStartBody(bad).ok, false, JSON.stringify(bad));
    }
    assert.deepEqual(ParseHubStopBody({ hubKind: "TRAINING" }), { ok: true, hubKind: "TRAINING" });
    assert.equal(ParseHubStopBody({}).ok, false);
    assert.equal(ParseHubStopBody(null).ok, false);
});

test("hub state machine: the §4.2 transitions and no others", () => {
    assert.equal(NextHubState("HOST_OFFERED", "HOST_BOOTSTRAP"), "STARTING");
    assert.equal(NextHubState("STARTING", "HOST_READY"), "HOST_READY");
    assert.equal(NextHubState("HOST_READY", "HOST_ROUTE_READY"), "ADMITTING");
    assert.equal(NextHubState("ADMITTING", "HOST_ADMITTED"), "RUNNING");
    assert.equal(NextHubState("RUNNING", "LEASE_LAPSED"), "SUSPECT");
    assert.equal(NextHubState("SUSPECT", "LEASE_BACK", "RUNNING"), "RUNNING");
    assert.equal(NextHubState("SUSPECT", "LEASE_BACK", "HOST_READY"), "HOST_READY");
    assert.equal(NextHubState("SUSPECT", "LEASE_BACK"), undefined, "no way back without the pre-suspect state");
    assert.equal(NextHubState("SUSPECT", "LEASE_BACK", "STARTING"), undefined);
    assert.equal(NextHubState("SUSPECT", "SUSPECT_TIMEOUT"), "ABORTED");
    assert.equal(NextHubState("RUNNING", "STOP"), "COMPLETED");
    assert.equal(NextHubState("HOST_OFFERED", "ABORT"), "ABORTED");
    // Not allowed from here.
    assert.equal(NextHubState("RUNNING", "HOST_BOOTSTRAP"), undefined);
    assert.equal(NextHubState("STARTING", "HOST_ROUTE_READY"), undefined);
    assert.equal(NextHubState("ABORTED", "STOP"), undefined);
    assert.equal(NextHubState("COMPLETED", "ABORT"), undefined);
    assert.equal(NextHubState("RUNNING", "SUSPECT_TIMEOUT"), undefined);
    assert.equal(NextHubState("STARTING", "LEASE_LAPSED"), undefined);

    const states: P2PHuntState[] = ["REQUESTED", "HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING",
        "SUSPECT", "FENCED", "ABORTING", "RECOVERING", "COMPLETED", "ABORTED"];
    const allowed = new Set([
        "HOST_OFFERED>STARTING", "STARTING>HOST_READY", "HOST_READY>HOST_READY", "HOST_READY>ADMITTING", "ADMITTING>RUNNING",
        "HOST_READY>SUSPECT", "ADMITTING>SUSPECT", "RUNNING>SUSPECT",
        "SUSPECT>HOST_READY", "SUSPECT>ADMITTING", "SUSPECT>RUNNING", "SUSPECT>ABORTED",
        ...HUB_LIVE_STATES.flatMap((from) => [`${from}>COMPLETED`, `${from}>ABORTED`])
    ]);
    for (const from of states) for (const to of states) {
        assert.equal(IsHubTransitionAllowed(from, to), allowed.has(`${from}>${to}`), `${from} -> ${to}`);
    }
});

const lease = (state: P2PHuntState, overrides: Record<string, unknown> = {}) => ({
    state,
    expiresAt: iso(7 * 86_400_000),
    offerExpiresAt: iso(60_000),
    startupDeadline: iso(60_000),
    leaseExpiresAt: iso(8_000),
    suspectDeadline: undefined as string | undefined,
    preSuspectState: undefined as P2PHuntState | undefined,
    ...overrides
});
const tick = { nowMs: NOW, emergencyStop: false, hostingEnabled: true };

test("monitor: a healthy hub does nothing; a lapsed lease makes a hub SUSPECT, never a recovery", () => {
    for (const state of ["HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING"] as const) {
        assert.deepEqual(DecideHubTick(lease(state), tick), { action: "NONE" }, state);
    }
    for (const state of ["HOST_READY", "ADMITTING", "RUNNING"] as const) {
        assert.deepEqual(DecideHubTick(lease(state, { leaseExpiresAt: iso(-1) }), tick), { action: "SUSPECT", reason: "HOST_LEASE_MISSED" }, state);
    }
    // A lapsed lease before the host was ready is the startup deadline's business, not the lease's.
    assert.deepEqual(DecideHubTick(lease("STARTING", { leaseExpiresAt: iso(-1) }), tick), { action: "NONE" });
    assert.deepEqual(DecideHubTick(lease("RUNNING", { leaseExpiresAt: undefined }), tick), { action: "NONE" });
});

test("monitor: suspect hub comes back with the lease and is aborted (HOST_LEASE_LOST) when the suspect window ends", () => {
    const suspect = lease("SUSPECT", { preSuspectState: "RUNNING", suspectDeadline: iso(10_000), leaseExpiresAt: iso(-5_000) });
    assert.deepEqual(DecideHubTick(suspect, tick), { action: "NONE" });
    assert.deepEqual(DecideHubTick({ ...suspect, leaseExpiresAt: iso(5_000) }, tick), { action: "RECOVER" });
    assert.deepEqual(DecideHubTick({ ...suspect, suspectDeadline: iso(-1) }, tick),
        { action: "END", terminal: "ABORTED", reason: "HOST_LEASE_LOST" });
    // A lease that is back wins over a deadline that has also passed.
    assert.deepEqual(DecideHubTick({ ...suspect, leaseExpiresAt: iso(5_000), suspectDeadline: iso(-1) }, tick), { action: "RECOVER" });
    // Nothing to return to: wait for the deadline.
    assert.deepEqual(DecideHubTick({ ...suspect, leaseExpiresAt: iso(5_000), preSuspectState: undefined }, tick), { action: "NONE" });
});

test("monitor: startup and offer deadlines, the session's own expiry, the operator stop and the hosting switch end a hub", () => {
    assert.deepEqual(DecideHubTick(lease("HOST_OFFERED", { offerExpiresAt: iso(-1) }), tick), { action: "END", terminal: "ABORTED", reason: "HUB_OFFER_EXPIRED" });
    assert.deepEqual(DecideHubTick(lease("STARTING", { startupDeadline: iso(-1) }), tick), { action: "END", terminal: "ABORTED", reason: "HUB_STARTUP_TIMEOUT" });
    assert.deepEqual(DecideHubTick(lease("HOST_READY", { startupDeadline: iso(-1) }), tick), { action: "END", terminal: "ABORTED", reason: "HUB_STARTUP_TIMEOUT" });
    assert.deepEqual(DecideHubTick(lease("ADMITTING", { startupDeadline: iso(-1) }), tick), { action: "END", terminal: "ABORTED", reason: "HUB_STARTUP_TIMEOUT" });
    // A running hub has no startup deadline any more (it is cleared on the way to RUNNING; a stale one is ignored).
    assert.deepEqual(DecideHubTick(lease("RUNNING", { startupDeadline: iso(-1) }), tick), { action: "NONE" });
    assert.deepEqual(DecideHubTick(lease("RUNNING", { expiresAt: iso(-1) }), tick), { action: "END", terminal: "ABORTED", reason: "HUB_SESSION_EXPIRED" });
    assert.deepEqual(DecideHubTick(lease("RUNNING"), { ...tick, emergencyStop: true }), { action: "END", terminal: "ABORTED", reason: "OPERATOR_P2P_STOP" });
    assert.deepEqual(DecideHubTick(lease("HOST_OFFERED"), { ...tick, emergencyStop: true }), { action: "END", terminal: "ABORTED", reason: "OPERATOR_P2P_STOP" });
    assert.deepEqual(DecideHubTick(lease("RUNNING"), { ...tick, hostingEnabled: false }), { action: "END", terminal: "ABORTED", reason: "REALM_HOSTING_DISABLED" });
    // A hub that is not live is never touched.
    assert.deepEqual(DecideHubTick(lease("COMPLETED"), { ...tick, emergencyStop: true }), { action: "NONE" });
    assert.deepEqual(DecideHubTick(lease("ABORTED"), tick), { action: "NONE" });
});

test("only a lost host is a failure of the host", () => {
    for (const reason of ["HOST_LEASE_LOST", "HOST_PROCESS_UNHEALTHY", "HUB_STARTUP_TIMEOUT"]) assert.equal(HubEndCountsAsHostFailure(reason), true, reason);
    for (const reason of ["HOST_STOPPED", "OPERATOR_P2P_STOP", "REALM_RELEASED", "HUB_OFFER_EXPIRED", "REALM_HOSTING_DISABLED"]) {
        assert.equal(HubEndCountsAsHostFailure(reason), false, reason);
    }
});

test("presence transitions: the §4.3 table", () => {
    const next = (from: RealmHubPresenceState, event: Parameters<typeof NextPresenceState>[1]) => NextPresenceState(from, event);
    assert.equal(next("PENDING", "TICKET_ISSUED"), "TICKETED");
    assert.equal(next("TICKETED", "TICKET_ISSUED"), "TICKETED");
    assert.equal(next("TICKETED", "ADMITTED"), "ADMITTED");
    assert.equal(next("PENDING", "ADMITTED"), "ADMITTED");
    assert.equal(next("ADMITTED", "ADMITTED"), "ADMITTED");
    assert.equal(next("ADMITTED", "DISCONNECTED"), "LOST");
    assert.equal(next("ADMITTED", "TRAVELLED"), "LEFT");
    assert.equal(next("PENDING", "EXPIRED"), "EXPIRED");
    assert.equal(next("TICKETED", "EXPIRED"), "EXPIRED");
    for (const from of PRESENCE_LIVE_STATES) {
        assert.equal(next(from, "REMOVED"), "REMOVED", from);
        assert.equal(next(from, "SESSION_ENDED"), "LOST", from);
    }
    for (const from of PRESENCE_ALL_STATES) assert.equal(next(from, "ENTRY_STARTED"), "PENDING", from);
    // Not allowed.
    assert.equal(next("LOST", "ADMITTED"), undefined, "a lost link needs a fresh entry");
    assert.equal(next("LOST", "TICKET_ISSUED"), undefined);
    assert.equal(next("LEFT", "ADMITTED"), undefined);
    assert.equal(next("REMOVED", "ADMITTED"), undefined);
    assert.equal(next("EXPIRED", "TICKET_ISSUED"), undefined);
    assert.equal(next("PENDING", "DISCONNECTED"), undefined);
    assert.equal(next("TICKETED", "TRAVELLED"), undefined);
    assert.equal(next("ADMITTED", "EXPIRED"), undefined, "a connected member never expires");
    assert.equal(next("LOST", "REMOVED"), undefined);
});

test("an entry expires only while it waits", () => {
    assert.equal(IsPresenceExpired({ state: "PENDING", expiresAt: iso(-1) }, iso(0)), true);
    assert.equal(IsPresenceExpired({ state: "PENDING", expiresAt: iso(0) }, iso(0)), true);
    assert.equal(IsPresenceExpired({ state: "TICKETED", expiresAt: iso(1) }, iso(0)), false);
    assert.equal(IsPresenceExpired({ state: "ADMITTED", expiresAt: iso(-86_400_000) }, iso(0)), false);
    assert.equal(IsPresenceExpired({ state: "LOST", expiresAt: iso(-86_400_000) }, iso(0)), false);
    assert.equal(ENTRY_LIFETIME_MS, 90_000);
});

test("an entry request creates a row, reuses a waiting one and starts over from every other state", () => {
    assert.equal(DecideEntryRequest(undefined, iso(0)), "CREATE");
    assert.equal(DecideEntryRequest({ state: "PENDING", expiresAt: iso(30_000) }, iso(0)), "REUSE");
    assert.equal(DecideEntryRequest({ state: "TICKETED", expiresAt: iso(30_000) }, iso(0)), "REUSE");
    assert.equal(DecideEntryRequest({ state: "PENDING", expiresAt: iso(-1) }, iso(0)), "REENTER");
    for (const state of ["ADMITTED", "LOST", "LEFT", "REMOVED", "EXPIRED"] as const) {
        assert.equal(DecideEntryRequest({ state, expiresAt: iso(30_000) }, iso(0)), "REENTER", state);
    }
});

function ticketCheck(overrides: Partial<HubTicketCheck> = {}): HubTicketCheck {
    return {
        hub: { state: "RUNNING", generation: 1, expiresAt: iso(86_400_000), hostAccountId: "host-account" },
        accountId: "member-account",
        presence: { state: "PENDING", expiresAt: iso(60_000), peerId: "4242" },
        isMember: true,
        isBanned: false,
        link: { status: "VERIFIED", steamId: "4242" },
        nowMs: NOW,
        ...overrides
    };
}

test("ticket eligibility: a running hub, an open unexpired entry, a member who is not banned, the verified peer link", () => {
    assert.equal(HubTicketDenialReason(ticketCheck()), undefined);
    assert.equal(HubTicketDenialReason(ticketCheck({ presence: { state: "TICKETED", expiresAt: iso(60_000), peerId: "4242" } })), undefined);
    assert.equal(HubTicketDenialReason(ticketCheck({ generation: 1 })), undefined);
    for (const state of ["HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "SUSPECT", "COMPLETED", "ABORTED"] as const) {
        assert.equal(HubTicketDenialReason(ticketCheck({ hub: { ...ticketCheck().hub, state } })), "HUB_NOT_RUNNING", state);
    }
    assert.equal(HubTicketDenialReason(ticketCheck({ hub: { ...ticketCheck().hub, expiresAt: iso(-1) } })), "HUB_EXPIRED");
    assert.equal(HubTicketDenialReason(ticketCheck({ generation: 2 })), "GENERATION_MISMATCH");
    assert.equal(HubTicketDenialReason(ticketCheck({ accountId: "host-account" })), "IS_HOST");
    assert.equal(HubTicketDenialReason(ticketCheck({ presence: undefined })), "NOT_EXPECTED");
    for (const state of ["ADMITTED", "LOST", "LEFT", "REMOVED", "EXPIRED"] as const) {
        assert.equal(HubTicketDenialReason(ticketCheck({ presence: { state, expiresAt: iso(60_000), peerId: "4242" } })), "NOT_EXPECTED", state);
    }
    assert.equal(HubTicketDenialReason(ticketCheck({ presence: { state: "PENDING", expiresAt: iso(-1), peerId: "4242" } })), "ENTRY_EXPIRED");
    assert.equal(HubTicketDenialReason(ticketCheck({ isBanned: true })), "BANNED");
    assert.equal(HubTicketDenialReason(ticketCheck({ isBanned: true, isMember: false })), "BANNED", "a ban is reported before a missing membership");
    assert.equal(HubTicketDenialReason(ticketCheck({ isMember: false })), "NOT_MEMBER");
    assert.equal(HubTicketDenialReason(ticketCheck({ link: undefined })), "PEER_LINK_MISSING");
    assert.equal(HubTicketDenialReason(ticketCheck({ link: { status: "REVOKED", steamId: "4242" } })), "PEER_LINK_MISSING");
    assert.equal(HubTicketDenialReason(ticketCheck({ link: { status: "VERIFIED", steamId: "9999" } })), "PEER_ID_MISMATCH");
});

test("every ticket denial maps to a launcher error", () => {
    const expected: Record<string, string> = {
        HUB_NOT_RUNNING: "P2P_SESSION_NOT_READY", HUB_EXPIRED: "P2P_SESSION_NOT_READY", GENERATION_MISMATCH: "P2P_GENERATION_FENCED",
        IS_HOST: "P2P_NOT_ROSTERED", NOT_EXPECTED: "P2P_NOT_ROSTERED", ENTRY_EXPIRED: "P2P_NOT_ROSTERED", BANNED: "REALM_BANNED",
        NOT_MEMBER: "REALM_NOT_MEMBER", PEER_LINK_MISSING: "P2P_STEAM_LINK_REQUIRED", PEER_ID_MISMATCH: "P2P_STEAM_LINK_REQUIRED"
    };
    for (const [reason, code] of Object.entries(expected)) {
        const error = HubTicketDenialError(reason as Parameters<typeof HubTicketDenialError>[0]);
        assert.equal(error.code, code, reason);
        assert.ok(error.message.length > 0);
    }
});

// [2026-10-16] Low free physical memory is reported (lowFreeMemory) and no longer refuses; commit headroom and the server limit do.
test("capacity: under the server limit with the commit headroom the policy asks for; low free memory is only reported", () => {
    const base = { activeServers: 1, maxServers: 3, freePhysicalMemoryMiB: 8192, commitHeadroomMiB: 8192, minimumFreeMemoryMiB: 3072, minimumCommitHeadroomMiB: 4096 };
    assert.deepEqual(DecideRealmCapacity(base), { ok: true });
    assert.deepEqual(DecideRealmCapacity({ ...base, activeServers: 2 }), { ok: true });
    assert.deepEqual(DecideRealmCapacity({ ...base, activeServers: 3 }), { ok: false, reason: "REALM_SERVER_LIMIT" });
    assert.deepEqual(DecideRealmCapacity({ ...base, freePhysicalMemoryMiB: 3071 }), { ok: true, lowFreeMemory: true });
    assert.deepEqual(DecideRealmCapacity({ ...base, freePhysicalMemoryMiB: 2006, commitHeadroomMiB: 15460 }), { ok: true, lowFreeMemory: true },
        "little free memory, plenty of commit headroom");
    assert.deepEqual(DecideRealmCapacity({ ...base, freePhysicalMemoryMiB: 3072 }), { ok: true });
    assert.deepEqual(DecideRealmCapacity({ ...base, commitHeadroomMiB: 4095 }), { ok: false, reason: "HOST_COMMIT_LOW" });
    assert.deepEqual(DecideRealmCapacity({ ...base, freePhysicalMemoryMiB: 0, commitHeadroomMiB: 4095 }), { ok: false, reason: "HOST_COMMIT_LOW" });
    assert.deepEqual(DecideRealmCapacity({ ...base, activeServers: 3, freePhysicalMemoryMiB: 0 }), { ok: false, reason: "REALM_SERVER_LIMIT" });
});

test("a hub is full at maxPeers, but never for a member already in it", () => {
    assert.equal(HubIsFull(15, 16), false);
    assert.equal(HubIsFull(16, 16), true);
    assert.equal(HubIsFull(17, 16), true);
    assert.equal(HubIsFull(16, 16, true), false);
    assert.equal(HubIsFull(0, 1), false);
    assert.equal(HubIsFull(1, 1), true);
});

test("MYSTICPARADOX_REALMS_HOSTING and the realm hub thresholds", () => {
    for (const on of ["on", "ON", "true", "1", " on "]) assert.equal(IsRealmHostingEnabled({ MYSTICPARADOX_REALMS_HOSTING: on }), true, on);
    for (const off of [undefined, "", "off", "false", "0", "yes", "enabled"]) assert.equal(IsRealmHostingEnabled({ MYSTICPARADOX_REALMS_HOSTING: off }), false, String(off));
    const defaults = ReadRealmHubPolicy({});
    assert.equal(defaults.capabilityTtlMs, 24 * 3_600_000);
    assert.equal(defaults.minimumFreeMemoryMiB, 3072);
    assert.equal(defaults.minimumCommitHeadroomMiB, 4096);
    const tuned = ReadRealmHubPolicy({ P2P_REALM_HUB_CAPABILITY_TTL_HOURS: "12", P2P_REALM_MIN_FREE_MEMORY_MIB_PER_SERVER: "2048" });
    assert.equal(tuned.capabilityTtlMs, 12 * 3_600_000);
    assert.equal(tuned.minimumFreeMemoryMiB, 2048);
    const bad = ReadRealmHubPolicy({ P2P_REALM_HUB_CAPABILITY_TTL_HOURS: "0", P2P_REALM_MIN_FREE_MEMORY_MIB_PER_SERVER: "lots" });
    assert.equal(bad.capabilityTtlMs, 24 * 3_600_000);
    assert.equal(bad.minimumFreeMemoryMiB, 3072);
    assert.equal(ReadRealmHubPolicy({ P2P_REALM_HUB_CAPABILITY_TTL_HOURS: "1000" }).capabilityTtlMs, 24 * 3_600_000, "the session record lives 7 days at most");
});

function hostPresence(overrides: Partial<P2PHostPresenceRecord> = {}): P2PHostPresenceRecord {
    const hash = "a".repeat(64);
    return {
        accountId: "host-account", revision: 1, consentToHost: true, observedAt: iso(-1_000), expiresAt: iso(29_000),
        freePhysicalMemoryMiB: 8192, commitHeadroomMiB: 8192, logicalCpuCount: 8, cpuLoadPercent: 20, powerSaver: false,
        runtimeSupported: true, steamRuntimeReady: true, steamId: "4242", backendRttMs: 40, worstPeerRttMs: 40, jitterMs: 5,
        packetLossPercent: 0,
        artifacts: { gameExe: hash, internalServer: hash, winmmProxy: hash, steamBridge: hash, steamRuntime: hash, admissionPublicKey: hash },
        artifactsVerified: true, launcherVersion: "0.1.55", guardVerified: true,
        ...overrides
    };
}

test("realm host eligibility keeps consent, version, artifacts, transport and Guard, and drops RTT, jitter, loss and other sessions", () => {
    const hostPolicy = ReadP2PHostEligibilityPolicy({});
    const realmPolicy = { minimumFreeMemoryMiB: 3072, minimumCommitHeadroomMiB: 4096 };
    const reason = (presence: P2PHostPresenceRecord, guardRequired = true) =>
        RealmHostIneligibilityReason(presence, hostPolicy, realmPolicy, guardRequired, NOW);
    assert.equal(reason(hostPresence()), undefined);
    // Dropped for a realm host: a slow, jittery, lossy link, and (for the official rules) an earlier session or a cooldown.
    assert.equal(reason(hostPresence({ worstPeerRttMs: 1900, jitterMs: 900, packetLossPercent: 60 })), undefined);
    // Kept.
    assert.equal(reason(hostPresence({ consentToHost: false })), "HOST_CONSENT_REQUIRED");
    assert.equal(reason(hostPresence({ launcherVersion: "0.1.10" })), "HOST_LAUNCHER_OUTDATED");
    assert.equal(reason(hostPresence({ artifactsVerified: false })), "HOST_RUNTIME_UNVERIFIED");
    assert.equal(reason(hostPresence({ steamRuntimeReady: false })), "HOST_RUNTIME_UNVERIFIED");
    assert.equal(reason(hostPresence({ guardVerified: false })), "HOST_GUARD_UNVERIFIED");
    assert.equal(reason(hostPresence({ guardVerified: false }), false), undefined);
    assert.equal(reason(hostPresence({ expiresAt: iso(-1) })), "HOST_PRESENCE_STALE");
    assert.equal(reason(hostPresence({ powerSaver: true })), "HOST_CPU_UNSUITABLE");
    // The realm's memory floors replace the official ones (4096 / 6144 MiB).
    assert.equal(reason(hostPresence({ freePhysicalMemoryMiB: 3100, commitHeadroomMiB: 4100 })), undefined);
    assert.equal(reason(hostPresence({ freePhysicalMemoryMiB: 3000 })), "HOST_MEMORY_LOW");
    assert.equal(reason(hostPresence({ commitHeadroomMiB: 4000 })), "HOST_MEMORY_LOW");
});
