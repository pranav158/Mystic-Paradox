import { ClientSession } from "mongodb";

export type P2PHuntState =
    | "REQUESTED"
    | "HOST_SELECTING"
    | "HOST_OFFERED"
    | "STARTING"
    | "HOST_READY"
    | "ADMITTING"
    | "RUNNING"
    // [2026-10-15] A superseded Tier 0 hunt whose server still serves the players in it until the server ends (BeginDrainPartySession).
    | "DRAINING"
    | "SUSPECT"
    | "FENCED"
    | "ABORTING"
    | "RECOVERING"
    | "COMPLETED"
    | "ABORTED";

export interface P2PHuntParticipantRecord {
    accountId: string;
    steamId: string;
    candidateId: string;
    reconnectEpoch: number;
    admissionState: "PENDING" | "ISSUED" | "ADMITTED" | "LOST";
    localBridgeInstanceId?: string;
    localBridgePort?: number;
    localBridgeReadyAt?: string;
    disconnectedAt?: string;
    rejoinDeadline?: string;
    /** [2026-10-11] Set when this admitted participant asked for a hub (Ramsgate) again: it has left the hunt. */
    returnedToHubAt?: string;
}

export interface P2PHuntSessionRecord {
    sessionId: string;
    generation: number;
    state: P2PHuntState;
    stateVersion: number;
    partyId: string;
    activePartyKey?: string;
    partyRevision: number;
    huntDefinitionId: string;
    gameMode?: string;
    build: number;
    bridgeProtocol: number;
    virtualPort: number;
    hostAccountId: string;
    /** The host's transport peer id: its SteamID64 with the Steam transport, the account-derived id with ICE. */
    hostSteamId: string;
    bridgeInstanceId: string;
    roster: P2PHuntParticipantRecord[];
    /** The Steam lobby; "ICE" for an ICE hunt, which has none. */
    lobbyId?: string;
    /**
     * [2026-10-13] The co-op transport frozen when the hunt was created (operations policy). Absent on older hunts,
     * which were all Steam.
     */
    coopTransport?: "ICE" | "STEAM_EXPERIMENTAL";
    leaseExpiresAt?: string;
    createdAt: string;
    expiresAt: string;
    metadataNonce?: string;
    /**
     * [2026-10-13 realms S1] "REALM_HUB": the realm's Ramsgate or Training server on the host's PC - a long-lived session with
     * an empty roster whose members live in realmHubPresence (contracts/RealmHubRepository.ts, controllers/realmHubLifecycle.ts).
     * Absent on every hunt, including realm hunts. SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 4.
     */
    sessionKind?: "REALM_HUB";
    /** Hub sessions only. */
    hubKind?: "RAMSGATE" | "TRAINING";
    /** The Paradox realm this session serves (a hub, or a realm hunt in a later stage). */
    realmId?: string;
    /** Whether the host's own client plays this session (always true for a hub). */
    hostParticipates?: boolean;
    /** Hub sessions: the host's loopback port into its own hub (set by the host's route-ready). */
    hostLocalBridgePort?: number;
    /** [2026-10-14] The UDP port the host's game server of this session listens on (one per live session of a host). */
    serverUdpPort?: number;
    hostLocalBridgeReadyAt?: string;
    /** Hub sessions: the stable id the game and the chat see (the realms module's HubRoomId). */
    hubRoomId?: string;
    /** Hub sessions: players the hub takes, the host included (1..64). */
    maxPeers?: number;
    /**
     * Frozen dedicated-server matchmaker row. This is deliberately distinct from
     * huntDefinitionId: the latter identifies the player-visible activity while
     * this value selects the server's map, game mode, and Behemoth configuration.
     */
    matchmakerHuntId?: string;
    mapPath?: string;
    behemothPath?: string;
    expectedPlayerString?: string;
    /**
     * Frozen native finality rule supplied by the authoritative hunt resolver. NO_COMPLETION (2026-10-11): a
     * no-reward session (the Training Grounds) that never completes; it ends only by a clean end or an abort.
     */
    guardCompletionMode?: "FIRST_DEFEAT" | "END_OF_HUNT" | "NO_COMPLETION";
    hostOfferId?: string;
    offerExpiresAt?: string;
    startupDeadline?: string;
    lastHeartbeatAt?: string;
    lastLeaseSequence?: number;
    suspectSince?: string;
    suspectDeadline?: string;
    preSuspectState?: P2PHuntState;
    failureReason?: string;
    triedHostAccountIds?: string[];
    fallbackHost?: string;
    fallbackPort?: number;
    fallbackGameSessionId?: string;
    fallbackHuntDefinitionId?: string;
    recoveryCandidateIds?: Record<string, string>;
    recoveryDeadline?: string;
    recoveryBeforeActive?: boolean;
    recoveryRetryAt?: string;
    terminalAt?: string;
    /** [2026-10-11] Why a clean end (EndP2PHuntSession) closed the session; failureReason stays for failures. */
    completionReason?: string;
    /**
     * [2026-10-15] DRAINING only, and only when a drain cap is configured (P2P_HUNT_DRAIN_GRACE_MS): when the drained server is fenced
     * if it has not ended by itself (BeginDrainPartySession). Absent with no cap. Cleared by the clean end.
     */
    drainDeadline?: string;
    /**
     * [2026-10-14 cancel] The roster member whose Cancel ended a forming hunt (failureReason PLAYER_CANCELED). The others of the
     * hunt are told PARTY_MEMBER_CANCELED; the canceller keeps PLAYER_CANCELED.
     */
    cancelledByAccountId?: string;
    contentDigest?: string;
    ruleVersion?: string;
    rewardTableVersion?: string;
    /** Frozen at session creation. Tier 0 can never apply persistent progression. */
    trustTier?: 0 | 1;
    rewardPolicyDigest?: string;
    seedCommitment?: string;
    guardSeed?: string;
    frozenLoadouts?: Array<{
        accountId: string;
        characterId?: string;
        loadoutRevision: number;
        activeIndex: number;
        characterUpdateVersion: number;
        characterDataDigest: string;
        digest: string;
    }>;
    guardLastSequence?: number;
    guardHeadHash?: string;
    guardEncounterState?: "CREATED" | "SESSION_STARTED" | "WORLD_READY" | "ENCOUNTER_ACTIVE" | "BEHEMOTH_DEFEATED" | "COMPLETION_REQUESTED" | "ABORTED";
    guardDisposition?: "OBSERVE_CLEAR" | "OBSERVE_FLAGGED" | "QUARANTINED";
    guardFindingCount?: number;
    /** Bounded evidence accounting maintained with the Guard chain head. */
    guardBatchCount?: number;
    guardEventCount?: number;
    guardEventBytes?: number;
    guardFirstMonotonicMs?: number;
    guardLastMonotonicMs?: number;
    /** Transactionally maintained terminal-validation summary; raw batches remain audit data. */
    guardDamageTotal?: number;
    guardDamageHitCount?: number;
    guardEncounterStartedAt?: number;
    guardCompletionRequestedAt?: number;
    guardCompletionSource?: string;
    /** Native OnHuntFinished success signal; observed evidence only, never authority by itself. */
    guardNativeHuntSuccessful?: boolean;
    /** Exact native producer source retained with the observed outcome; never authority by itself. */
    guardNativeHuntOutcomeSource?: string;
    /** Bounded union of event types seen in the frozen Guard chain. */
    guardEventTypes?: string[];
    guardHasUnattributedDamage?: boolean;
    guardLastReceivedAt?: string;
}

export interface P2PArtifactHashes {
    gameExe: string;
    internalServer: string;
    winmmProxy: string;
    steamBridge: string;
    steamRuntime: string;
    admissionPublicKey: string;
}

export interface P2PHostPresenceRecord {
    accountId: string;
    revision: number;
    consentToHost: boolean;
    observedAt: string;
    expiresAt: string;
    freePhysicalMemoryMiB: number;
    commitHeadroomMiB: number;
    logicalCpuCount: number;
    cpuLoadPercent: number;
    powerSaver: boolean;
    runtimeSupported: boolean;
    steamRuntimeReady: boolean;
    steamId?: string;
    backendRttMs: number;
    worstPeerRttMs: number;
    jitterMs: number;
    packetLossPercent: number;
    artifacts: P2PArtifactHashes;
    artifactsVerified: boolean;
    launcherVersion: string;
    guardSessionId?: string;
    guardManifestSequence?: number;
    guardSequence?: number;
    guardRiskScore?: number;
    guardVerified?: boolean;
    /** Independently verified Launcher Guard sessions for the client and optional host server. */
    guardRoles?: Array<{
        role: "client" | "host";
        guardSessionId: string;
        manifestSequence: number;
        sequence: number;
        riskScore: number;
    }>;
    /**
     * [2026-10-14 realms S2] The realm server sessions this PC reports it runs (advisory: the Guard rule that lets a realm host
     * without a client be checked against the server's own record, controllers/p2pHostLifecycle.ts ParseGuardRequiredRoles).
     */
    realmHostSessions?: number;
}

export interface P2PHostScoreBreakdown {
    latencyRisk: number;
    networkRisk: number;
    memoryRisk: number;
    cpuRisk: number;
    stabilityRisk: number;
    hostLoadRisk: number;
    integrityRisk: number;
}

export interface P2PHostOfferRecord {
    offerId: string;
    sessionId: string;
    generation: number;
    accountId: string;
    steamId: string;
    rank: number;
    score: number;
    scoreBreakdown: P2PHostScoreBreakdown;
    status: "OFFERED" | "ACCEPTED" | "DECLINED" | "EXPIRED" | "CANCELLED";
    offeredAt: string;
    expiresAt: string;
    respondedAt?: string;
    responseReason?: string;
}

export interface P2PParticipantObservationRecord {
    observationId: string;
    sessionId: string;
    generation: number;
    accountId: string;
    steamId: string;
    hostReachable: boolean;
    localBridgeAlive: boolean;
    metricsAvailable: boolean;
    lastPacketAgeMs?: number;
    routeKind: "DIRECT" | "RELAY" | "CONNECTING" | "UNKNOWN";
    pingMs?: number;
    jitterMs?: number;
    packetLossPercent?: number;
    observedAt: string;
}

export interface P2PHostReliabilityRecord {
    accountId: string;
    offersAccepted: number;
    offersDeclined: number;
    offersExpired: number;
    startsSucceeded: number;
    startsFailed: number;
    cleanCompletions: number;
    unexpectedFailures: number;
    cooldownUntil?: string;
    updatedAt: string;
}

export interface P2PHuntTransitionRecord {
    transitionId: string;
    sessionId: string;
    generation: number;
    fromState: P2PHuntState;
    toState: P2PHuntState;
    stateVersion: number;
    reason: string;
    actorType: "SYSTEM" | "HOST" | "PARTICIPANT" | "ADMIN";
    actorAccountId?: string;
    at: string;
}

export type P2PHostCapabilityScope =
    | "HOST_READY"
    | "LEASE_HEARTBEAT"
    | "PEER_ADMITTED"
    // Allows the disposable local game-server process to perform normal per-player
    // requests for admitted members of this hunt. It never conveys global gameserver authority.
    | "GAME_SERVER_RUNTIME"
    | "EVENTS_WRITE"
    | "COMPLETE_REQUEST"
    | "ABORT";

export interface P2PHostCapabilityRecord {
    capabilityId: string;
    secretDigest: string;
    sessionId: string;
    generation: number;
    hostAccountId: string;
    hostSteamId: string;
    bridgeInstanceId: string;
    scopes: P2PHostCapabilityScope[];
    issuedAt: string;
    expiresAt: string;
    revokedAt?: string;
    lastSequence: number;
}

export interface P2PSteamLinkRecord {
    accountId: string;
    steamId: string;
    status: "VERIFIED" | "REVOKED";
    revision: number;
    verifiedAt: string;
    lastUsedAt: string;
    /** Provenance describes transport observation only; this record never proves game ownership. */
    // ICE_ACCOUNT_DERIVED (2026-10-13): the ICE transport's peer id, derived from the account (transportPeerIds.ts).
    verificationMethod?: "OPERATOR_STEAM_DOCTOR" | "STEAM_AUTH" | "STEAM_CLIENT_TRANSPORT" | "ICE_ACCOUNT_DERIVED";
}

export interface P2PAdmissionTicketRecord {
    jtiDigest: string;
    keyId: string;
    sessionId: string;
    generation: number;
    accountId: string;
    joinerSteamId: string;
    hostSteamId: string;
    bridgeProtocol: number;
    virtualPort: number;
    issuedAt: string;
    expiresAt: string;
    status: "ISSUED" | "CONSUMED" | "REVOKED";
    consumedAt?: string;
    consumerBridgeInstanceId?: string;
    consumerRequestId?: string;
}

export interface P2PPeerAdmissionRecord {
    admissionId: string;
    /** Unique only while connected; removed atomically on disconnect. */
    activeAdmissionKey: string;
    sessionId: string;
    generation: number;
    accountId: string;
    steamId: string;
    bridgeInstanceId: string;
    connectionHandle: string;
    admittedAt: string;
    disconnectedAt?: string;
}

export type P2PControlMessageType =
    | "HOST_OFFERED"
    | "HOST_OFFER_CANCELLED"
    | "HUNT_BOOTSTRAP"
    | "JOIN_RENDEZVOUS"
    | "FENCE_NOW"
    | "RETURN_TO_RAMSGATE"
    | "DEDICATED_FALLBACK_READY"
    | "MANIFEST_REVOKED"
    | "LAUNCHER_POLICY_CHANGED"
    // [2026-10-13] An ICE description or candidate from the other side of a host-joiner pair (controllers/p2pIce.ts).
    | "ICE_SIGNAL"
    // [2026-10-13 realms S1] A member's launcher stops that hub's join handle; the host's launcher re-reads its peer list.
    | "REALM_SESSION_LEAVE"
    | "REALM_PEER_EXPECTED";

export interface P2PControlMessageRecord {
    messageId: string;
    accountId: string;
    sequence: number;
    messageType: P2PControlMessageType;
    sessionId?: string;
    generation?: number;
    payload: Record<string, unknown>;
    createdAt: string;
    expiresAt: string;
    acknowledgedAt?: string;
}

export type P2PTicketConsumeResult =
    | { outcome: "CONSUMED" | "IDEMPOTENT"; record: P2PAdmissionTicketRecord }
    | { outcome: "EXPIRED" | "REPLAY" | "INVALID" };

export interface P2PHuntRepository {
    findHunt(sessionId: string, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    findActiveHuntForParty(partyId: string, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    findActiveHuntForAccount(accountId: string, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    createHunt(record: P2PHuntSessionRecord, session?: ClientSession): Promise<void>;
    findRecoverableHuntForAccount(accountId: string, now: string, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    listLifecycleHunts(states: P2PHuntState[], limit: number, session?: ClientSession): Promise<P2PHuntSessionRecord[]>;
    compareAndSetHunt(input: {
        sessionId: string;
        generation: number;
        expectedStates: P2PHuntState[];
        expectedStateVersion: number;
        set: Partial<P2PHuntSessionRecord>;
        unset?: Array<keyof P2PHuntSessionRecord>;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    appendHuntTransition(record: Omit<P2PHuntTransitionRecord, "transitionId">, session?: ClientSession): Promise<void>;
    beginHostStartup(input: {
        sessionId: string;
        hostAccountId: string;
        bridgeInstanceId: string;
        metadataNonce: string;
        startupDeadline: string;
        serverUdpPort?: number;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    renewHostLease(input: {
        sessionId: string;
        generation: number;
        hostSteamId: string;
        bridgeInstanceId: string;
        leaseSequence: number;
        heartbeatAt: string;
        leaseExpiresAt: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    markHostReady(input: {
        sessionId: string;
        generation: number;
        hostSteamId: string;
        bridgeInstanceId: string;
        lobbyId: string;
        virtualPort: number;
        leaseExpiresAt: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    findSteamLink(accountId: string, session?: ClientSession): Promise<P2PSteamLinkRecord | undefined>;
    findSteamLinkBySteamId(steamId: string, session?: ClientSession): Promise<P2PSteamLinkRecord | undefined>;
    upsertSteamLink(record: P2PSteamLinkRecord, session?: ClientSession): Promise<void>;
    deleteSteamLink(accountId: string, session?: ClientSession): Promise<void>;
    createHostCapability(record: P2PHostCapabilityRecord, session?: ClientSession): Promise<void>;
    findHostCapabilityByDigest(secretDigest: string, session?: ClientSession): Promise<P2PHostCapabilityRecord | undefined>;
    advanceHostCapabilitySequence(capabilityId: string, sequence: number, session?: ClientSession): Promise<boolean>;
    revokeGeneration(sessionId: string, generation: number, revokedAt: string, session?: ClientSession): Promise<void>;
    markParticipantRouteReady(input: {
        sessionId: string;
        generation: number;
        accountId: string;
        steamId: string;
        bridgeInstanceId: string;
        localBridgePort: number;
        readyAt: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    markParticipantAdmitted(input: {
        sessionId: string;
        generation: number;
        accountId: string;
        admittedAt: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    createAdmissionTicket(record: P2PAdmissionTicketRecord, session?: ClientSession): Promise<void>;
    revokeAdmissionTickets(sessionId: string, generation: number, session?: ClientSession): Promise<void>;
    /** [2026-10-13 realms S1] Revokes the account's unconsumed tickets of the session (a member kicked or banned from a hub). */
    revokeAdmissionTicketsForAccount(sessionId: string, accountId: string, session?: ClientSession): Promise<number>;
    reserveParticipantTicket(input: {
        sessionId: string;
        generation: number;
        accountId: string;
        now: string;
        rejoinDeadline: string;
        maxReconnects: number;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    markParticipantDisconnected(input: {
        sessionId: string;
        generation: number;
        accountId: string;
        disconnectedAt: string;
        rejoinDeadline: string;
    }, session?: ClientSession): Promise<P2PHuntSessionRecord | undefined>;
    consumeAdmissionTicket(input: {
        jtiDigest: string;
        sessionId: string;
        generation: number;
        accountId: string;
        joinerSteamId: string;
        hostSteamId: string;
        bridgeInstanceId: string;
        requestId: string;
        now: string;
    }, session?: ClientSession): Promise<P2PTicketConsumeResult>;
    recordPeerAdmission(record: P2PPeerAdmissionRecord, session?: ClientSession): Promise<void>;
    findPeerAdmission(admissionId: string, session?: ClientSession): Promise<P2PPeerAdmissionRecord | undefined>;
    disconnectPeer(input: {
        admissionId: string;
        sessionId: string;
        generation: number;
        bridgeInstanceId: string;
        disconnectedAt: string;
    }, session?: ClientSession): Promise<boolean>;
    enqueueControlMessage(input: Omit<P2PControlMessageRecord, "messageId" | "sequence">, session?: ClientSession): Promise<P2PControlMessageRecord>;
    /** [2026-10-16] `unacknowledgedOnly` leaves out the messages a launcher already acknowledged (the stale-cursor answer, p2pControl.ts). */
    listControlMessages(accountId: string, afterSequence: number, now: string, limit: number,
        options?: { unacknowledgedOnly?: boolean }): Promise<P2PControlMessageRecord[]>;
    /** [2026-10-16] The sequence of the account's last control message, 0 when it never had one. */
    latestControlSequence(accountId: string): Promise<number>;
    acknowledgeControlMessage(accountId: string, messageId: string, acknowledgedAt: string): Promise<boolean>;
    upsertHostPresence(record: P2PHostPresenceRecord, session?: ClientSession): Promise<void>;
    listHostPresences(accountIds: string[], observedAfter: string, session?: ClientSession): Promise<P2PHostPresenceRecord[]>;
    countActiveHostSessions(accountId: string, session?: ClientSession): Promise<number>;
    /**
     * [2026-10-13 realms S1] Live sessions (the hub, the Training hub and realm hunts together) the realm's host runs: the
     * number a realm's server limit is checked against. [2026-10-15] A draining session is not counted (it has no activePartyKey).
     */
    countActiveRealmServers(realmId: string, session?: ClientSession): Promise<number>;
    /**
     * [2026-10-15] The realm's sessions whose server still runs on its host's PC, a DRAINING one included. Not a limit: the
     * host's presence is only accepted without a client when such a server runs (ConfirmsRealmHost).
     */
    countRunningRealmServers(realmId: string, session?: ClientSession): Promise<number>;
    /** Live realm hunts (never hubs) of this realm and host: what ending the realm's Ramsgate also ends. */
    listLiveRealmHunts(realmId: string, hostAccountId: string, session?: ClientSession): Promise<P2PHuntSessionRecord[]>;
    /**
     * Closes the still-connected admission with this active key (a hub joiner that re-enters before the host reported its
     * old link closed). Returns whether one was closed.
     */
    supersedeActivePeerAdmission(activeAdmissionKey: string, at: string, session?: ClientSession): Promise<boolean>;
    findHostReliability(accountId: string, session?: ClientSession): Promise<P2PHostReliabilityRecord | undefined>;
    incrementHostReliability(accountId: string, increments: Partial<Record<keyof P2PHostReliabilityRecord, number>>, now: string, cooldownUntil?: string, session?: ClientSession): Promise<void>;
    createHostOffer(record: P2PHostOfferRecord, session?: ClientSession): Promise<void>;
    findHostOffer(offerId: string, session?: ClientSession): Promise<P2PHostOfferRecord | undefined>;
    listHostOffers(sessionId: string, generation: number, session?: ClientSession): Promise<P2PHostOfferRecord[]>;
    updateHostOffer(input: {
        offerId: string;
        accountId: string;
        expectedStatus: P2PHostOfferRecord["status"];
        status: P2PHostOfferRecord["status"];
        respondedAt: string;
        responseReason?: string;
    }, session?: ClientSession): Promise<P2PHostOfferRecord | undefined>;
    recordParticipantObservation(record: P2PParticipantObservationRecord, session?: ClientSession): Promise<void>;
    listRecentParticipantObservations(sessionId: string, generation: number, observedAfter: string, session?: ClientSession): Promise<P2PParticipantObservationRecord[]>;
}
