import assert from "node:assert/strict";
import test from "node:test";
import { P2PHuntParticipantRecord, P2PHuntSessionRecord } from "../persistence";
import {
    ClassifyExistingPartySession,
    CleanEndTerminalState,
    HostGuardStillStarting,
    HostLossIsCleanEnd,
    HOST_END_STATES,
    HOST_GUARD_START_GRACE_MS,
    MarkParticipantReturnedToHub,
    ParseGuardPresenceSessions,
    ParseGuardRequiredRoles,
    ParticipantsStillInHunt,
    P2P_LIFECYCLE_STATES,
    IsPreActiveOperatorStopState,
    RecoveryDestinationRequest,
    RecoveryGameSessionId,
    SelectRecoveryParticipants,
    ShouldUseDedicatedPreActiveFallback,
    SUPERSEDE_STATES
} from "./p2pHostLifecycle";
import { GetHubGameSessionId } from "../../controllers/matchmaking";
import { DedicatedFallbackAction, PlayerHostedSetupFailureReason } from "./p2pMatchmaking";

test("lifecycle scan includes persisted host selection sessions for restart recovery", () => {
    assert.ok(P2P_LIFECYCLE_STATES.includes("HOST_SELECTING"));
});

test("operator stop routes offered and starting hunts through pre-active recovery", () => {
    for (const state of ["HOST_SELECTING", "HOST_OFFERED", "STARTING", "HOST_READY"] as const) {
        assert.equal(IsPreActiveOperatorStopState(state), true, state);
    }
    for (const state of ["ADMITTING", "RUNNING", "SUSPECT", "ABORTING", "RECOVERING"] as const) {
        assert.equal(IsPreActiveOperatorStopState(state), false, state);
    }
});

function participant(
    accountId: string,
    admissionState: P2PHuntParticipantRecord["admissionState"],
    routeReady: boolean
): P2PHuntParticipantRecord {
    return {
        accountId,
        steamId: accountId === "host" ? "76561198000000101" : "76561198000000102",
        candidateId: `${accountId}-candidate`,
        reconnectEpoch: 0,
        admissionState,
        ...(routeReady
            ? { localBridgeInstanceId: `${accountId}-bridge`, localBridgePort: 55000, localBridgeReadyAt: "2026-08-24T16:00:08.000Z" }
            : {})
    };
}

test("active recovery excludes a joiner that never completed the Steam route", () => {
    const host = participant("host", "ADMITTED", true);
    const strandedJoiner = participant("joiner", "ISSUED", false);

    assert.deepEqual(
        SelectRecoveryParticipants([host, strandedJoiner], false).map((entry) => entry.accountId),
        ["host"]
    );
});

test("active recovery includes every admitted participant with a published loopback route", () => {
    const host = participant("host", "ADMITTED", true);
    const joiner = participant("joiner", "ADMITTED", true);

    assert.deepEqual(
        SelectRecoveryParticipants([host, joiner], false).map((entry) => entry.accountId),
        ["host", "joiner"]
    );
});

test("pre-active dedicated fallback still includes the complete roster", () => {
    const host = participant("host", "PENDING", false);
    const joiner = participant("joiner", "PENDING", false);

    assert.deepEqual(
        SelectRecoveryParticipants([host, joiner], true).map((entry) => entry.accountId),
        ["host", "joiner"]
    );
});

test("dedicated-hunt disable rail cancels pre-active failure but preserves active hub recovery", () => {
    const deployServer = { DEPLOYSERVER_URL: "deployserver.invalid:8080" };
    const p2pOnly = { ...deployServer, P2P_DISABLE_DEDICATED_HUNTS: "true" };
    assert.equal(ShouldUseDedicatedPreActiveFallback(true, p2pOnly), false);
    assert.equal(ShouldUseDedicatedPreActiveFallback(false, p2pOnly), false);
    assert.equal(ShouldUseDedicatedPreActiveFallback(true, deployServer), true);
    // [2026-10-15] No DeployServer: the pre-active failure is cancelled, not sent to a dedicated server that does not exist.
    assert.equal(ShouldUseDedicatedPreActiveFallback(true, {}), false);
});

test("Launcher Guard presence keeps client and host sessions independently bound", () => {
    const sessions = ParseGuardPresenceSessions({
        guardSessions: [
            { role: "client", guardSessionId: "11111111-1111-4111-8111-111111111111" },
            { role: "host", guardSessionId: "22222222-2222-4222-8222-222222222222" }
        ],
        guardRequiredRoles: ["client", "host"]
    });
    assert.deepEqual(sessions.map((entry) => entry.role), ["client", "host"]);
    assert.deepEqual(ParseGuardRequiredRoles({ guardRequiredRoles: ["client", "host"] }, sessions), ["client", "host"]);
    assert.throws(() => ParseGuardRequiredRoles({ guardRequiredRoles: ["host"] }, sessions));
    assert.throws(() => ParseGuardPresenceSessions({
        guardSessions: [
            { role: "client", guardSessionId: "11111111-1111-4111-8111-111111111111" },
            { role: "client", guardSessionId: "22222222-2222-4222-8222-222222222222" }
        ]
    }));
});

function session(overrides: Partial<P2PHuntSessionRecord> = {}): P2PHuntSessionRecord {
    return {
        sessionId: "session-1", generation: 2, state: "RUNNING", stateVersion: 9, partyId: "party-1", partyRevision: 4,
        huntDefinitionId: "ShatteredIsles_IslandA", build: 647472, bridgeProtocol: 1, virtualPort: 1,
        hostAccountId: "host", hostSteamId: "76561198000000101", bridgeInstanceId: "bridge", trustTier: 0,
        roster: [participant("host", "ADMITTED", true), participant("joiner", "ADMITTED", true)],
        createdAt: "2026-10-11T10:00:00.000Z", expiresAt: "2026-10-11T12:00:00.000Z",
        leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(), guardEncounterState: "ENCOUNTER_ACTIVE",
        ...overrides
    };
}

test("a Tier 0 session that ran ends COMPLETED; one that never started, or Tier 1, ends ABORTED (B1)", () => {
    assert.equal(CleanEndTerminalState(session()), "COMPLETED");
    assert.equal(CleanEndTerminalState(session({ state: "SUSPECT", preSuspectState: "RUNNING" })), "COMPLETED");
    assert.equal(CleanEndTerminalState(session({ state: "ADMITTING" })), "ABORTED");
    assert.equal(CleanEndTerminalState(session({ state: "HOST_SELECTING" })), "ABORTED");
    assert.equal(CleanEndTerminalState(session({ trustTier: 1 })), "ABORTED");
});

test("losing the host after a Guard completion, or after everyone left, is a clean end (B1)", () => {
    assert.equal(HostLossIsCleanEnd(session()), undefined, "players still in the hunt: failure path");
    assert.equal(HostLossIsCleanEnd(session({ guardEncounterState: "COMPLETION_REQUESTED" })), "TIER0_HUNT_COMPLETED");
    assert.equal(HostLossIsCleanEnd(session({ state: "SUSPECT", preSuspectState: "RUNNING",
        guardEncounterState: "COMPLETION_REQUESTED" })), "TIER0_HUNT_COMPLETED");
    const left = session({ roster: [participant("host", "LOST", true),
        { ...participant("joiner", "ADMITTED", true), returnedToHubAt: "2026-10-11T10:30:00.000Z" }] });
    assert.equal(HostLossIsCleanEnd(left), "TIER0_PARTY_LEFT");
    // Nobody was ever admitted: a host start failure, not a clean end.
    assert.equal(HostLossIsCleanEnd(session({ state: "ADMITTING", roster: [participant("host", "PENDING", false)] })), undefined);
    assert.equal(HostLossIsCleanEnd(session({ trustTier: 1, guardEncounterState: "COMPLETION_REQUESTED" })), undefined);
    assert.equal(HostLossIsCleanEnd(session({ state: "RECOVERING", guardEncounterState: "COMPLETION_REQUESTED" })), undefined);
});

test("hub returns are recorded per admitted participant; the last one out empties the hunt (B1)", () => {
    const roster = [participant("host", "ADMITTED", true), participant("joiner", "ADMITTED", true), participant("never", "ISSUED", false)];
    assert.deepEqual(ParticipantsStillInHunt(roster), ["host", "joiner"]);
    const first = MarkParticipantReturnedToHub(roster, "joiner", "2026-10-11T10:30:00.000Z")!;
    assert.equal(first.changed, true);
    assert.deepEqual(first.stillInHunt, ["host"]);
    assert.equal(first.roster.find((entry) => entry.accountId === "joiner")?.returnedToHubAt, "2026-10-11T10:30:00.000Z");
    const repeat = MarkParticipantReturnedToHub(first.roster, "joiner", "2026-10-11T10:31:00.000Z")!;
    assert.equal(repeat.changed, false);
    const last = MarkParticipantReturnedToHub(first.roster, "host", "2026-10-11T10:32:00.000Z")!;
    assert.deepEqual(last.stillInHunt, []);
    // A participant that never joined, or an outsider, records nothing.
    assert.equal(MarkParticipantReturnedToHub(roster, "never", "2026-10-11T10:30:00.000Z"), undefined);
    assert.equal(MarkParticipantReturnedToHub(roster, "outsider", "2026-10-11T10:30:00.000Z"), undefined);
});

test("the host stays in its own hunt until it leaves, whatever its admission row says (B1)", () => {
    const roster = [participant("host", "PENDING", false), participant("joiner", "ADMITTED", true)];
    assert.deepEqual(ParticipantsStillInHunt(roster, "host"), ["host", "joiner"]);
    const joinerLeft = MarkParticipantReturnedToHub(roster, "joiner", "2026-10-11T10:30:00.000Z", "host")!;
    assert.deepEqual(joinerLeft.stillInHunt, ["host"], "the joiner leaving must not end the host's hunt");
    const hostLeft = MarkParticipantReturnedToHub(joinerLeft.roster, "host", "2026-10-11T10:31:00.000Z", "host")!;
    assert.deepEqual(hostLeft.stillInHunt, []);
    assert.equal(HostLossIsCleanEnd(session({ roster: joinerLeft.roster })), undefined);
    assert.equal(HostLossIsCleanEnd(session({ roster: hostLeft.roster })), "TIER0_PARTY_LEFT");
    assert.deepEqual(ParticipantsStillInHunt([participant("host", "LOST", true)], "host"), []);
});

test("a party's new request reuses only a forming session and supersedes finished or ending ones (B1)", () => {
    const forming = session({ state: "HOST_OFFERED", leaseExpiresAt: undefined,
        roster: [participant("host", "PENDING", false), participant("joiner", "PENDING", false)] });
    assert.deepEqual(ClassifyExistingPartySession(forming, "ShatteredIsles_IslandA", "joiner"), { action: "REUSE", reason: "PARTY_FAN_OUT" });
    assert.deepEqual(ClassifyExistingPartySession(forming, "ShatteredIsles_IslandB", "joiner"), { action: "SUPERSEDE", reason: "PARTY_CHANGED_HUNT" });
    assert.deepEqual(ClassifyExistingPartySession(forming, "ShatteredIsles_IslandA", "newcomer"), { action: "SUPERSEDE", reason: "ROSTER_CHANGED" });
    // The stale-session bug: same hunt after it ended -> the dead loopback port.
    assert.equal(ClassifyExistingPartySession(session({ guardEncounterState: "COMPLETION_REQUESTED" }), "ShatteredIsles_IslandA", "host").reason,
        "HUNT_FINISHED");
    assert.equal(ClassifyExistingPartySession(session({ state: "SUSPECT", preSuspectState: "RUNNING" }), "ShatteredIsles_IslandA", "host").reason,
        "SESSION_ENDING");
    assert.equal(ClassifyExistingPartySession(session({ state: "ABORTING" }), "ShatteredIsles_IslandB", "host").reason, "SESSION_ENDING");
    assert.equal(ClassifyExistingPartySession(session({ leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }),
        "ShatteredIsles_IslandA", "host").reason, "HOST_LEASE_EXPIRED");
    // A running Tier 0 hunt the requester left is drained, not fenced (2026-10-15).
    assert.deepEqual(ClassifyExistingPartySession(session(), "ShatteredIsles_IslandA", "joiner"), { action: "DRAIN", reason: "REQUESTER_LEFT_HUNT" });
    // A member who joined the party after the roster froze cannot end the others' running hunt.
    assert.deepEqual(ClassifyExistingPartySession(session(), "ShatteredIsles_IslandA", "newcomer"), { action: "CONFLICT", reason: "ROSTER_FROZEN" });
});

test("a running Tier 0 hunt the requester left is drained; every other superseded session is ended as before (2026-10-15)", () => {
    // The host of a running hunt asking for one again has left its own server too.
    assert.deepEqual(ClassifyExistingPartySession(session(), "ShatteredIsles_IslandA", "host"), { action: "DRAIN", reason: "REQUESTER_LEFT_HUNT" });
    // A Tier 1 hunt is never drained: its completion belongs to the Guard.
    assert.deepEqual(ClassifyExistingPartySession(session({ trustTier: 1 }), "ShatteredIsles_IslandA", "joiner"),
        { action: "SUPERSEDE", reason: "REQUESTER_LEFT_HUNT" });
    // A hunt still starting is superseded (its server has not run the hunt).
    for (const state of ["ADMITTING", "HOST_READY"] as const) {
        assert.deepEqual(ClassifyExistingPartySession(session({ state }), "ShatteredIsles_IslandA", "joiner"),
            { action: "SUPERSEDE", reason: "REQUESTER_LEFT_HUNT" }, state);
    }
    // A realm hub is never drained (it has its own lifecycle).
    assert.deepEqual(ClassifyExistingPartySession(session({ sessionKind: "REALM_HUB" }), "ShatteredIsles_IslandA", "joiner"),
        { action: "SUPERSEDE", reason: "REQUESTER_LEFT_HUNT" });
    // [2026-10-15] A finished running Tier 0 hunt drains too (its players are still on the results screen); a finished hunt that
    // is no longer running is superseded. The suspect and expired-lease states keep their own reasons.
    assert.deepEqual(ClassifyExistingPartySession(session({ guardEncounterState: "COMPLETION_REQUESTED" }), "ShatteredIsles_IslandA", "joiner"),
        { action: "DRAIN", reason: "HUNT_FINISHED" });
    assert.deepEqual(ClassifyExistingPartySession(session({ guardEncounterState: "COMPLETION_REQUESTED", trustTier: 1 }), "ShatteredIsles_IslandA", "joiner"),
        { action: "SUPERSEDE", reason: "HUNT_FINISHED" });
    // A party that changed hunt while its running hunt still has players drains it as well.
    assert.deepEqual(ClassifyExistingPartySession(session(), "ShatteredIsles_IslandB", "joiner2"),
        { action: "DRAIN", reason: "PARTY_CHANGED_HUNT" });
    assert.deepEqual(ClassifyExistingPartySession(session({ state: "SUSPECT", preSuspectState: "RUNNING" }), "ShatteredIsles_IslandA", "joiner"),
        { action: "SUPERSEDE", reason: "SESSION_ENDING" });
    assert.deepEqual(ClassifyExistingPartySession(session({ leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }), "ShatteredIsles_IslandA", "joiner"),
        { action: "SUPERSEDE", reason: "HOST_LEASE_EXPIRED" });
});

test("a draining hunt is scanned by the lifecycle monitor, ends COMPLETED, and is no supersede or host-end state (2026-10-15)", () => {
    assert.ok(P2P_LIFECYCLE_STATES.includes("DRAINING"));
    assert.equal(CleanEndTerminalState({ state: "DRAINING" }), "COMPLETED");
    assert.equal(CleanEndTerminalState({ state: "DRAINING", trustTier: 1 }), "ABORTED");
    assert.equal(SUPERSEDE_STATES.includes("DRAINING"), false, "a new request never supersedes a drain again");
    assert.equal(HOST_END_STATES.includes("DRAINING"), false, "the host's end is handled by its own drain branch");
});

test("recovery to a persistent hub carries the hub's own game session id (B6)", () => {
    assert.deepEqual(RecoveryDestinationRequest({ recoveryBeforeActive: false, huntDefinitionId: "ShatteredIsles_IslandA" }),
        { gameMode: "CITY", huntId: "ShatteredIsles_ReturnToRamsgate", persistentHub: true });
    assert.deepEqual(RecoveryDestinationRequest({ recoveryBeforeActive: true, huntDefinitionId: "ShatteredIsles_IslandA" }),
        { gameMode: "ISLAND", huntId: "ShatteredIsles_IslandA", persistentHub: false });
    // Hosted Training that never started falls back to the Training hub, not a fresh dojo hunt server (B7).
    assert.deepEqual(RecoveryDestinationRequest({ recoveryBeforeActive: true, huntDefinitionId: "ShatteredIsles_TrainingDojo" }),
        { gameMode: "SHARED", huntId: "ShatteredIsles_TrainingDojo", persistentHub: true });
    const hubId = RecoveryGameSessionId(true, "203.0.113.9", 8790);
    assert.equal(hubId, GetHubGameSessionId("203.0.113.9", 8790), "the same City room as players already in Ramsgate");
    assert.equal(RecoveryGameSessionId(true, "203.0.113.9", 8790), hubId);
    assert.notEqual(RecoveryGameSessionId(false, "203.0.113.9", 8790), hubId);
    assert.notEqual(RecoveryGameSessionId(false, "203.0.113.9", 8790), RecoveryGameSessionId(false, "203.0.113.9", 8790));
});

test("a failed player-hosted setup falls back to a dedicated server instead of failing the request (B2)", () => {
    assert.equal(PlayerHostedSetupFailureReason(new Error("P2P_STEAM_LINK_REQUIRED")), "P2P_STEAM_LINK_REQUIRED");
    assert.equal(PlayerHostedSetupFailureReason(new Error("PARTY_REVISION_CONFLICT")), "PARTY_REVISION_CONFLICT");
    assert.equal(PlayerHostedSetupFailureReason(new Error("mongo exploded")), undefined, "unknown errors still surface");
    assert.equal(DedicatedFallbackAction(false, false), "DEDICATED");
    assert.equal(DedicatedFallbackAction(false, true), "CANCEL");
    assert.equal(DedicatedFallbackAction(true, true), "DEDICATED", "Training keeps its hub as the fallback");
});

test("a just-started host whose first Guard verdict is still pending is not recovered", () => {
    const createdAt = "2026-10-13T13:15:38.762Z";
    const at = (ms: number) => Date.parse(createdAt) + ms;
    const client = new Set(["client"] as const);
    // The second live ICE hunt: presence named the host role 15 s after creation, before its first verdict.
    assert.equal(HostGuardStillStarting({ createdAt }, ["client", "host"], client, at(15_000)), true);
    // After the window the missing host verdict counts as unhealthy again.
    assert.equal(HostGuardStillStarting({ createdAt }, ["client", "host"], client, at(HOST_GUARD_START_GRACE_MS)), false);
    // An unverified client is never excused, nor is a host role reported with no client verdict.
    assert.equal(HostGuardStillStarting({ createdAt }, ["client", "host"], new Set(), at(15_000)), false);
    assert.equal(HostGuardStillStarting({ createdAt }, ["client"], new Set(), at(15_000)), false);
    // Nothing is missing, or the creation time is unusable: no grace.
    assert.equal(HostGuardStillStarting({ createdAt }, ["client", "host"], new Set(["client", "host"] as const), at(15_000)), false);
    assert.equal(HostGuardStillStarting({ createdAt: "not a date" }, ["client", "host"], client, at(15_000)), false);
    assert.equal(HostGuardStillStarting({ createdAt }, ["client", "host"], client, at(-1_000)), false);
});
