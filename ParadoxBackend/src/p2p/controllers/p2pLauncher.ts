import crypto from "crypto";
import { GetAntiCheatExtension } from "../antiCheat";
import { ReadP2PPolicy } from "../config/p2pPolicy";
import { HuntEvidenceEnabled } from "../config/huntEvidence";
import { GetP2PRepositories, WithP2PTransaction, P2PArtifactHashes, P2PHuntSessionRecord, P2PHuntState } from "../persistence";
import { GenerateHostCapabilitySecret, InvalidateHubPresence } from "../security/hostCapabilities";
import { LauncherApiError } from "../security/p2pErrors";
import { IssueSelfAdmissionTicket } from "./p2pAdmission";
import { HubJoinerRouteReady } from "./realmHubAdmission";
import { FinishHubRouteReady, HubHostRouteReady, HubRouteReadyOutcome } from "./realmHubLifecycle";
import { HUB_CAPABILITY_SCOPES } from "../realm/hubManifests";
import { IsRealmHub } from "../realm/realmHubRules";
import { IsRealmHostingEnabled, ReadRealmHubPolicy } from "../realm/realmHubPolicy";
import { IssueAdmissionTicket } from "../security/admissionTickets";
import { ReadP2PArtifactPolicy } from "../config/p2pHostPolicy";
import { ReadP2PHostEligibilityPolicy } from "../config/p2pHostPolicy";
import { logger } from "../../logger";
import { CoopTransport, FenceP2PEmergencyStop } from "../services/p2pOperationsPolicy";

const INSTANCE = /^[a-f0-9]{32}$/;

function BackendUrl(): string {
    const value = process.env.P2P_BACKEND_URL ?? "";
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(value) &&
        !(process.env.NODE_ENV !== "production" && /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(value))) {
        throw new Error("P2P_BACKEND_URL is missing or unsafe.");
    }
    return value;
}

function HostServerUdpPort(): number {
    const value = Number(process.env.P2P_HOST_SERVER_UDP_PORT);
    return Number.isSafeInteger(value) && value >= 1024 && value <= 65535 ? value : 8791;
}

/** How many consecutive ports, from P2P_HOST_SERVER_UDP_PORT (8791), a host's game servers may use. */
export const HOST_SERVER_PORT_SPAN = 32;
// [2026-10-15] DRAINING: a drained server still holds its port (the new server must pick another).
const LIVE_HOST_STATES: P2PHuntState[] = ["STARTING", "HOST_READY", "ADMITTING", "RUNNING", "DRAINING", "SUSPECT"];

/**
 * [2026-10-14 repro] The UDP port for a host's new game server: the first port from `base` that none of the host's other live
 * sessions uses. One port for every session made two servers listen on 8791 at once (the realm's Ramsgate and a realm hunt):
 * Windows let both bind, packets went to either, the hunt never received its client and the next one ended in a fatal error.
 * A live session from before this rule has no stored port and counts as holding `base` (the old fixed port). Pure.
 */
export function PickHostServerUdpPort(base: number, otherLiveSessions: Array<Pick<P2PHuntSessionRecord, "serverUdpPort">>): number {
    const used = new Set(otherLiveSessions.map((session) => session.serverUdpPort ?? base));
    for (let port = base; port < base + HOST_SERVER_PORT_SPAN && port <= 65535; port++) {
        if (!used.has(port)) return port;
    }
    throw new LauncherApiError("P2P_HOST_PORTS_EXHAUSTED", "This PC already runs as many game servers as it has ports for.");
}

/** The hunt's frozen co-op transport; hunts created before 13 October 2026 were all Steam. */
export function HuntCoopTransport(hunt: P2PHuntSessionRecord): CoopTransport {
    return hunt.coopTransport ?? "STEAM_EXPERIMENTAL";
}

function Common(hunt: P2PHuntSessionRecord, bridgeInstanceId: string) {
    if (hunt.metadataNonce == undefined) throw new LauncherApiError("P2P_SESSION_NOT_READY", "The hunt rendezvous is incomplete.");
    return {
        // [2026-10-13] The co-op transport frozen with the hunt (ICE or STEAM_EXPERIMENTAL); launchers that predate
        // the ICE transport ignore it. With ICE the launcher fetches .../transport-config (controllers/p2pIce.ts).
        coopTransport: HuntCoopTransport(hunt),
        keyId: process.env.P2P_ADMISSION_KEY_ID,
        sessionId: hunt.sessionId,
        partyId: hunt.partyId,
        partyRevision: hunt.partyRevision,
        huntDefinitionId: hunt.huntDefinitionId,
        guardCompletionMode: hunt.guardCompletionMode,
        generation: hunt.generation,
        build: hunt.build,
        bridgeProtocol: hunt.bridgeProtocol,
        virtualPort: hunt.virtualPort,
        hostPeerId: hunt.hostSteamId,
        bridgeInstanceId,
        metadataNonce: hunt.metadataNonce,
        forceRelay: ReadP2PPolicy().forceSdr,
        artifacts: WireArtifacts(ReadP2PArtifactPolicy()),
        // False without the anti-cheat module: the launcher then opts no process into hunt evidence.
        // [2026-10-17] And false while MYSTICPARADOX_HUNT_EVIDENCE is off (the tier 0 default; config/huntEvidence.ts): the host's
        // transport posted each event on its packet thread and every hosted hunt lagged.
        evidenceCollection: GetAntiCheatExtension().loaded && HuntEvidenceEnabled(),
        // Older names, read by launchers before plan step 4.2.
        hostSteamId: hunt.hostSteamId,
        forceSdr: ReadP2PPolicy().forceSdr
    };
}

/** Artifact hashes on the wire: the neutral co-op names, plus the older names launchers before step 4.2 read. */
export function WireArtifacts(artifacts: P2PArtifactHashes) {
    return { ...artifacts, transportModule: artifacts.steamBridge, transportRuntime: artifacts.steamRuntime };
}

export async function CreateHostBootstrap(accountId: string, sessionId: string) {
    if (!ReadP2PPolicy().enabled) throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are disabled.");
    return WithP2PTransaction(async (repos, mongoSession) => {
        if (!await FenceP2PEmergencyStop(mongoSession)) {
            throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are currently stopped by operations policy.");
        }
        const current = await repos.p2pHunts.findHunt(sessionId, mongoSession);
        if (current == undefined) throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Hunt session not found.");
        // [2026-10-13 realms S1] A realm hub is bootstrapped like a hunt (same offer, capability and host ticket) with its own
        // scopes, a longer capability and a peer limit of its own; it needs realm hosting to be on.
        const isHub = IsRealmHub(current);
        if (isHub && !IsRealmHostingEnabled()) throw new LauncherApiError("P2P_DISABLED", "Realm hosting is switched off on this server.");
        // [2026-10-11 B7/B10] NO_COMPLETION is the Training Grounds' no-reward session. Launchers older than the one
        // that accepts it refuse the bootstrap ("bindings are invalid"); the hunt then falls back as for any failed
        // host start - P2P_TRAINING_ENABLED stays off until launchers accept the mode.
        if (current.guardCompletionMode !== "FIRST_DEFEAT" && current.guardCompletionMode !== "END_OF_HUNT" &&
            current.guardCompletionMode !== "NO_COMPLETION") {
            throw new LauncherApiError("P2P_SESSION_NOT_READY", "The frozen Guard completion rule is missing.");
        }
        if (current.hostAccountId !== accountId) throw new LauncherApiError("P2P_CAPABILITY_INVALID", "This account is not the selected host.");
        const offer = current.hostOfferId == undefined
            ? undefined
            : await repos.p2pHunts.findHostOffer(current.hostOfferId, mongoSession);
        if (offer == undefined || offer.status !== "ACCEPTED" || offer.accountId !== accountId) {
            throw new LauncherApiError("P2P_GENERATION_FENCED", "The host offer was not accepted or is stale.");
        }
        const steamLink = await repos.p2pHunts.findSteamLink(accountId, mongoSession);
        if (steamLink == undefined || steamLink.status !== "VERIFIED" || steamLink.steamId !== current.hostSteamId) {
            throw new LauncherApiError("P2P_STEAM_LINK_REQUIRED", "The current Steam co-op transport no longer matches this hunt.");
        }
        const bridgeInstanceId = crypto.randomBytes(16).toString("hex");
        const metadataNonce = crypto.randomBytes(24).toString("base64url");
        const startupDeadline = new Date(Date.now() + ReadP2PHostEligibilityPolicy().startupLifetimeMs).toISOString();
        const otherLive = (await repos.p2pHunts.listLifecycleHunts(LIVE_HOST_STATES, 500, mongoSession))
            .filter((session) => session.hostAccountId === accountId && session.sessionId !== sessionId);
        const serverUdpPort = PickHostServerUdpPort(HostServerUdpPort(), otherLive);
        const hunt = await repos.p2pHunts.beginHostStartup({
            sessionId,
            hostAccountId: accountId,
            bridgeInstanceId,
            metadataNonce,
            startupDeadline,
            serverUdpPort
        }, mongoSession);
        if (hunt == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "The host offer is stale or no longer startable.");
        await repos.p2pHunts.appendHuntTransition({
            sessionId,
            generation: hunt.generation,
            fromState: "HOST_OFFERED",
            toState: "STARTING",
            stateVersion: hunt.stateVersion,
            reason: "HOST_OFFER_ACCEPTED",
            actorType: "HOST",
            actorAccountId: accountId,
            at: new Date().toISOString()
        }, mongoSession);
        if (hunt.matchmakerHuntId == undefined || hunt.mapPath == undefined || hunt.behemothPath == undefined || hunt.expectedPlayerString == undefined) {
            throw new LauncherApiError("P2P_SESSION_NOT_READY", "The frozen hunt launch manifest is incomplete.");
        }
        const generated = GenerateHostCapabilitySecret();
        const now = new Date();
        const capabilityExpiry = new Date(Math.min(Date.parse(hunt.expiresAt),
            now.getTime() + (isHub ? ReadRealmHubPolicy().capabilityTtlMs : 2 * 60 * 60 * 1000)));
        await repos.p2pHunts.createHostCapability({
            capabilityId: crypto.randomUUID(),
            secretDigest: generated.digest,
            sessionId,
            generation: hunt.generation,
            hostAccountId: accountId,
            hostSteamId: hunt.hostSteamId,
            bridgeInstanceId,
            // A hub produces no hunt evidence and has no completion: no EVENTS_WRITE, no COMPLETE_REQUEST.
            scopes: isHub ? [...HUB_CAPABILITY_SCOPES]
                : ["HOST_READY", "LEASE_HEARTBEAT", "PEER_ADMITTED", "GAME_SERVER_RUNTIME", "EVENTS_WRITE", "COMPLETE_REQUEST", "ABORT"],
            issuedAt: now.toISOString(),
            expiresAt: capabilityExpiry.toISOString(),
            lastSequence: 0
        }, mongoSession);
        // [2026-10-14 realms S3] A realm host that does not play its realm hunt is no roster member: it has no admission ticket
        // (the host's own client never joins, so there is nothing to admit).
        const hostParticipates = hunt.hostParticipates !== false;
        const hostTicket = hostParticipates ? IssueAdmissionTicket({
            accountId,
            joinerSteamId: hunt.hostSteamId,
            hostSteamId: hunt.hostSteamId,
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            partyId: hunt.partyId,
            partyRevision: hunt.partyRevision,
            huntDefinitionId: hunt.huntDefinitionId,
            build: hunt.build,
            bridgeProtocol: hunt.bridgeProtocol,
            virtualPort: hunt.virtualPort,
            lifetimeSeconds: 180
        }) : undefined;
        if (hostTicket != undefined) await repos.p2pHunts.createAdmissionTicket({
            jtiDigest: hostTicket.jtiDigest,
            keyId: hostTicket.claims.keyId,
            sessionId: hunt.sessionId,
            generation: hunt.generation,
            accountId,
            joinerSteamId: hunt.hostSteamId,
            hostSteamId: hunt.hostSteamId,
            bridgeProtocol: hunt.bridgeProtocol,
            virtualPort: hunt.virtualPort,
            issuedAt: new Date(hostTicket.claims.issuedAt * 1000).toISOString(),
            expiresAt: new Date(hostTicket.claims.expiresAt * 1000).toISOString(),
            status: "ISSUED"
        }, mongoSession);
        return {
            ...Common(hunt, bridgeInstanceId),
            capability: generated.secret,
            ...(hostTicket != undefined ? { hostTicket: hostTicket.token } : {}),
            // [2026-10-14 realms S3] The realm a realm session serves, and whether the host's own client plays it (a hub's client
            // always does; the launcher counts realm sessions and skips the host's ticket and route-ready when it does not).
            ...(hunt.realmId != undefined ? { realmId: hunt.realmId } : {}),
            ...(hunt.realmId != undefined && !isHub ? { hostParticipates, hostLocalClient: hostParticipates } : {}),
            backendUrl: BackendUrl(),
            serverUdpPort: hunt.serverUdpPort ?? serverUdpPort,
            maximumPeers: isHub ? hunt.maxPeers ?? 1 : Math.min(4, hunt.roster.length),
            // Dedicated launches use this resolved row as the server's HuntId argument.
            // Keep huntDefinitionId for player attribution and client matchmaking only.
            matchmakerHuntId: hunt.matchmakerHuntId,
            mapPath: hunt.mapPath,
            behemothPath: hunt.behemothPath,
            expectedPlayers: hunt.expectedPlayerString,
            ...(isHub ? {
                sessionKind: hunt.sessionKind,
                hubKind: hunt.hubKind,
                hubRoomId: hunt.hubRoomId,
                maxPlayers: hunt.maxPeers,
                hostParticipates: hunt.hostParticipates ?? true,
                hostLocalClient: true
            } : {})
        };
    });
}

export async function CreateJoinBootstrap(accountId: string, sessionId: string) {
    if (!ReadP2PPolicy().enabled) throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are disabled.");
    // IssueSelfAdmissionTicket owns the transactionally fenced state change.
    const issued = await IssueSelfAdmissionTicket(accountId, sessionId);
    const hunt = await GetP2PRepositories().p2pHunts.findHunt(sessionId);
    if (hunt == undefined || hunt.lobbyId == undefined || hunt.metadataNonce == undefined) {
        throw new LauncherApiError("P2P_SESSION_NOT_READY", "The host lobby is not ready.");
    }
    return {
        ...Common(hunt, crypto.randomBytes(16).toString("hex")),
        ticket: issued.ticket,
        lobbyId: hunt.lobbyId
    };
}

export async function MarkLocalRouteReady(accountId: string, sessionId: string, body: any) {
    if (typeof body?.generation !== "number" || !Number.isInteger(body.generation) ||
        typeof body?.bridgeInstanceId !== "string" || !INSTANCE.test(body.bridgeInstanceId) ||
        body?.localHost !== "127.0.0.1" || typeof body?.localPort !== "number" ||
        !Number.isInteger(body.localPort) || body.localPort < 1 || body.localPort > 65535) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The local bridge route is malformed.");
    }
    const now = new Date();
    let hubOutcome = undefined as HubRouteReadyOutcome | undefined;
    let hubSessionId = undefined as string | undefined;
    const hunt = await WithP2PTransaction(async (repos, mongoSession) => {
        hubOutcome = undefined;
        hubSessionId = undefined;
        if (!await FenceP2PEmergencyStop(mongoSession)) {
            throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are currently stopped by operations policy.");
        }
        const steamLink = await repos.p2pHunts.findSteamLink(accountId, mongoSession);
        if (steamLink == undefined || steamLink.status !== "VERIFIED") {
            throw new LauncherApiError("P2P_STEAM_LINK_REQUIRED", "A verified Steam account is required.");
        }
        // [2026-10-13 realms S1] A realm hub: the host's own route admits the host locally and runs the hub to RUNNING; a
        // member's route lands on its presence row. Hunts take the roster path below, exactly as before.
        const hub = await repos.p2pHunts.findHunt(sessionId, mongoSession);
        if (IsRealmHub(hub)) {
            hubSessionId = sessionId;
            if (hub!.hostAccountId === accountId) {
                hubOutcome = await HubHostRouteReady(repos, mongoSession, hub!, accountId, body.generation, body.localPort, now);
                return hubOutcome?.hub;
            }
            const routedMember = await HubJoinerRouteReady(repos, mongoSession, hub!, {
                accountId, generation: body.generation, localBridgePort: body.localPort, readyAt: now.toISOString()
            });
            return routedMember == undefined ? undefined : hub;
        }
        const routed = await repos.p2pHunts.markParticipantRouteReady({
            sessionId,
            generation: body.generation,
            accountId,
            steamId: steamLink.steamId,
            bridgeInstanceId: body.bridgeInstanceId,
            localBridgePort: body.localPort,
            readyAt: now.toISOString()
        }, mongoSession);
        if (routed == undefined) return undefined;
        if (routed.hostAccountId === accountId && routed.state === "HOST_READY") {
            const admitting = await repos.p2pHunts.compareAndSetHunt({
                sessionId,
                generation: routed.generation,
                expectedStates: ["HOST_READY"],
                expectedStateVersion: routed.stateVersion,
                set: { state: "ADMITTING" }
            }, mongoSession);
            if (admitting != undefined) {
                await repos.p2pHunts.appendHuntTransition({
                    sessionId,
                    generation: admitting.generation,
                    fromState: "HOST_READY",
                    toState: "ADMITTING",
                    stateVersion: admitting.stateVersion,
                    reason: "HOST_LOCAL_ROUTE_READY",
                    actorType: "HOST",
                    actorAccountId: accountId,
                    at: now.toISOString()
                }, mongoSession);
                await repos.p2pHunts.incrementHostReliability(accountId, { startsSucceeded: 1 }, now.toISOString(), undefined, mongoSession);
                for (const participant of admitting.roster) {
                    if (participant.accountId === accountId) continue;
                    await repos.p2pHunts.enqueueControlMessage({
                        accountId: participant.accountId,
                        messageType: "JOIN_RENDEZVOUS",
                        sessionId,
                        generation: admitting.generation,
                        payload: { sessionId, generation: admitting.generation, role: "JOIN" },
                        createdAt: now.toISOString(),
                        expiresAt: new Date(Math.min(Date.parse(admitting.expiresAt), now.getTime() + 10 * 60_000)).toISOString()
                    }, mongoSession);
                }
                // [2026-10-13 realms plan step 5] The host's own client is admitted by its own transport (source=local:
                // no ticket, nothing to consume centrally), so only a joiner's consume ever moved a hunt to RUNNING. A solo
                // hunt therefore stayed ADMITTING with the host not ADMITTED, and every loot transaction of the host was
                // refused (HUNT_NOT_RUNNING / PARTICIPANT_NOT_ADMITTED) - the first live ICE hunt saved nothing. The host
                // is admitted here, with its local route, and the hunt runs from now on; joiners still need their consume.
                const hostAdmitted = await repos.p2pHunts.markParticipantAdmitted({
                    sessionId,
                    generation: admitting.generation,
                    accountId,
                    admittedAt: now.toISOString()
                }, mongoSession);
                if (hostAdmitted?.state === "ADMITTING") {
                    const running = await repos.p2pHunts.compareAndSetHunt({
                        sessionId,
                        generation: hostAdmitted.generation,
                        expectedStates: ["ADMITTING"],
                        expectedStateVersion: hostAdmitted.stateVersion,
                        set: { state: "RUNNING" }
                    }, mongoSession);
                    if (running != undefined) {
                        await repos.p2pHunts.appendHuntTransition({
                            sessionId,
                            generation: running.generation,
                            fromState: "ADMITTING",
                            toState: "RUNNING",
                            stateVersion: running.stateVersion,
                            reason: "HOST_ADMITTED_LOCALLY",
                            actorType: "HOST",
                            actorAccountId: accountId,
                            at: now.toISOString()
                        }, mongoSession);
                        return running;
                    }
                }
                return hostAdmitted ?? admitting;
            }
        }
        return routed;
    });
    if (hubSessionId !== undefined) {
        if (hubOutcome != undefined) await FinishHubRouteReady(hubOutcome);
        else InvalidateHubPresence(hubSessionId);
    }
    if (hunt == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "This local route belongs to a stale hunt generation.");
    logger.info({
        event: "p2p_local_route_ready",
        sessionId,
        generation: hunt.generation,
        accountId,
        localHost: "127.0.0.1",
        localPort: body.localPort
    }, `P2P loopback route ready session=${sessionId} generation=${hunt.generation}`);
    return { ready: true, sessionId, generation: hunt.generation, localHost: "127.0.0.1", localPort: body.localPort };
}
