import crypto from "crypto";
import { ReadP2PPolicy } from "../config/p2pPolicy";
import { GetP2PRepositories, WithP2PTransaction, P2PHostCapabilityRecord } from "../persistence";
import { LauncherApiError } from "../security/p2pErrors";
import {
    HashAdmissionJti,
    IssueAdmissionTicket,
    VerifyAdmissionTicket
} from "../security/admissionTickets";
import { ReadP2PHostEligibilityPolicy } from "../config/p2pHostPolicy";
import { FenceP2PEmergencyStop } from "../services/p2pOperationsPolicy";
import { IsRealmHub, PresencePurgeAt } from "../realm/realmHubRules";
import { InvalidateHubPresence } from "../security/hostCapabilities";
import { AdmitHubPeer, HubPeerDisconnected, IssueHubAdmissionTicket } from "./realmHubAdmission";
import { RealmHubTravel } from "./realmHubTravel";
import { logger } from "../../logger";

const TICKETABLE_STATES = new Set(["HOST_READY", "ADMITTING", "RUNNING"]);

function AssertP2PAdmissionNotStopped(fenced: boolean): void {
    if (!fenced) {
        throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are currently unavailable.");
    }
}

export async function IssueSelfAdmissionTicket(accountId: string, sessionId: string) {
    if (!ReadP2PPolicy().enabled) {
        throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are currently disabled.");
    }
    let hubSessionId = undefined as string | undefined;
    const result = await WithP2PTransaction(async (repos, mongoSession) => {
        hubSessionId = undefined;
        AssertP2PAdmissionNotStopped(await FenceP2PEmergencyStop(mongoSession));
        const hunt = await repos.p2pHunts.findHunt(sessionId, mongoSession);
        if (hunt == undefined) throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Hunt session not found.");
        // [2026-10-13 realms S1] A realm hub issues a fresh ticket per entry from the member's presence row (no roster, no
        // reconnect counter, nothing written on the session).
        if (IsRealmHub(hunt)) {
            hubSessionId = hunt.sessionId;
            return IssueHubAdmissionTicket(repos, mongoSession, hunt, accountId);
        }
        if (!TICKETABLE_STATES.has(hunt.state) || Date.parse(hunt.expiresAt) <= Date.now()) {
            throw new LauncherApiError("P2P_SESSION_NOT_READY", "The hunt is not accepting participants.");
        }
        let participant = hunt.roster.find((entry) => entry.accountId === accountId);
        if (participant == undefined) {
            throw new LauncherApiError("P2P_NOT_ROSTERED", "This account is not in the frozen hunt roster.");
        }
        const steamLink = await repos.p2pHunts.findSteamLink(accountId, mongoSession);
        if (steamLink == undefined || steamLink.status !== "VERIFIED" || steamLink.steamId !== participant.steamId) {
            throw new LauncherApiError("P2P_STEAM_LINK_REQUIRED", "The current Steam co-op transport no longer matches this hunt.");
        }
        const now = new Date();
        const rejoinDeadline = new Date(now.getTime() + ReadP2PHostEligibilityPolicy().rejoinLifetimeMs).toISOString();
        const reserved = await repos.p2pHunts.reserveParticipantTicket({
            sessionId,
            generation: hunt.generation,
            accountId,
            now: now.toISOString(),
            rejoinDeadline,
            maxReconnects: ReadP2PHostEligibilityPolicy().maximumReconnects
        }, mongoSession);
        if (reserved == undefined) throw new LauncherApiError("P2P_SESSION_NOT_READY", "The rejoin window or attempt limit has been reached.");
        participant = reserved.roster.find((entry) => entry.accountId === accountId)!;
        const issued = IssueAdmissionTicket({
            accountId,
            joinerSteamId: participant.steamId,
            hostSteamId: reserved.hostSteamId,
            sessionId: reserved.sessionId,
            generation: reserved.generation,
            partyId: reserved.partyId,
            partyRevision: reserved.partyRevision,
            huntDefinitionId: reserved.huntDefinitionId,
            build: reserved.build,
            bridgeProtocol: reserved.bridgeProtocol,
            virtualPort: reserved.virtualPort,
            // The launcher may need to join the exact Steam lobby, validate its
            // metadata, and establish a cold SDR route before the host consumes
            // this one-use ticket.  Use the protocol's bounded maximum so the
            // ticket cannot expire inside the supported 45-second transport
            // window.  Generation fencing and one-use JTI consumption remain
            // authoritative.
            lifetimeSeconds: 180
        });
        await repos.p2pHunts.createAdmissionTicket({
            jtiDigest: issued.jtiDigest,
            keyId: issued.claims.keyId,
            sessionId: reserved.sessionId,
            generation: reserved.generation,
            accountId,
            joinerSteamId: participant.steamId,
            hostSteamId: reserved.hostSteamId,
            bridgeProtocol: reserved.bridgeProtocol,
            virtualPort: reserved.virtualPort,
            issuedAt: new Date(issued.claims.issuedAt * 1000).toISOString(),
            expiresAt: new Date(issued.claims.expiresAt * 1000).toISOString(),
            status: "ISSUED"
        }, mongoSession);
        return {
            ticket: issued.token,
            expiresAt: new Date(issued.claims.expiresAt * 1000).toISOString(),
            rendezvous: {
                sessionId: reserved.sessionId,
                generation: reserved.generation,
                lobbyId: reserved.lobbyId,
                hostSteamId: reserved.hostSteamId,
                virtualPort: reserved.virtualPort,
                bridgeProtocol: reserved.bridgeProtocol,
                build: reserved.build
            }
        };
    });
    if (hubSessionId !== undefined) InvalidateHubPresence(hubSessionId);
    return result;
}

export async function MarkHostReady(input: {
    sessionId: string;
    lobbyId: unknown;
    /** [2026-10-13] "ICE" from the ICE transport, which has no lobby. */
    transport?: unknown;
    virtualPort: unknown;
    bridgeInstanceId: unknown;
    capability: P2PHostCapabilityRecord;
}) {
    if (!ReadP2PPolicy().enabled) throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are currently disabled.");
    const ice = input.transport === "ICE" && input.lobbyId === undefined;
    if ((!ice && (typeof input.lobbyId !== "string" || !/^[1-9][0-9]{0,19}$/.test(input.lobbyId))) ||
        typeof input.virtualPort !== "number" || !Number.isInteger(input.virtualPort) ||
        input.virtualPort < 1 || input.virtualPort > 999 ||
        typeof input.bridgeInstanceId !== "string" || input.bridgeInstanceId !== input.capability.bridgeInstanceId) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The host-ready request is malformed.");
    }
    const leaseExpiresAt = new Date(Date.now() + ReadP2PHostEligibilityPolicy().leaseLifetimeMs).toISOString();
    const hunt = await WithP2PTransaction(async (repos, mongoSession) => {
        AssertP2PAdmissionNotStopped(await FenceP2PEmergencyStop(mongoSession));
        // The transport that reports ready must be the one the hunt was created with.
        const frozen = (await repos.p2pHunts.findHunt(input.sessionId, mongoSession))?.coopTransport ?? "STEAM_EXPERIMENTAL";
        if ((frozen === "ICE") !== ice) {
            throw new LauncherApiError("P2P_TICKET_INVALID", "The host-ready request does not match this hunt's co-op transport.");
        }
        const ready = await repos.p2pHunts.markHostReady({
            sessionId: input.sessionId,
            generation: input.capability.generation,
            hostSteamId: input.capability.hostSteamId,
            bridgeInstanceId: input.capability.bridgeInstanceId,
            lobbyId: ice ? "ICE" : input.lobbyId as string,
            virtualPort: input.virtualPort as number,
            leaseExpiresAt
        }, mongoSession);
        if (ready != undefined) {
            await repos.p2pHunts.appendHuntTransition({
                sessionId: ready.sessionId,
                generation: ready.generation,
                fromState: "STARTING",
                toState: "HOST_READY",
                stateVersion: ready.stateVersion,
                reason: ice ? "ICE_HOST_BRIDGE_READY" : "STEAM_LOBBY_AND_HOST_BRIDGE_READY",
                actorType: "HOST",
                actorAccountId: input.capability.hostAccountId,
                at: new Date().toISOString()
            }, mongoSession);
        }
        // [2026-10-14 realms S3, design section 4.8] A realm host that does not play its realm hunt has no route to publish: its
        // server is ready for the members at once, so the hunt goes to ADMITTING here and the members are asked to join now.
        if (ready != undefined && ready.realmId != undefined && ready.hostParticipates === false) {
            const at = new Date().toISOString();
            const admitting = await repos.p2pHunts.compareAndSetHunt({
                sessionId: ready.sessionId,
                generation: ready.generation,
                expectedStates: ["HOST_READY"],
                expectedStateVersion: ready.stateVersion,
                set: { state: "ADMITTING" }
            }, mongoSession);
            if (admitting != undefined) {
                await repos.p2pHunts.appendHuntTransition({
                    sessionId: ready.sessionId,
                    generation: admitting.generation,
                    fromState: "HOST_READY",
                    toState: "ADMITTING",
                    stateVersion: admitting.stateVersion,
                    reason: "HOST_NOT_PLAYING_READY",
                    actorType: "HOST",
                    actorAccountId: input.capability.hostAccountId,
                    at
                }, mongoSession);
                await repos.p2pHunts.incrementHostReliability(input.capability.hostAccountId, { startsSucceeded: 1 }, at, undefined, mongoSession);
                for (const participant of admitting.roster) {
                    await repos.p2pHunts.enqueueControlMessage({
                        accountId: participant.accountId,
                        messageType: "JOIN_RENDEZVOUS",
                        sessionId: admitting.sessionId,
                        generation: admitting.generation,
                        payload: { sessionId: admitting.sessionId, generation: admitting.generation, role: "JOIN" },
                        createdAt: at,
                        expiresAt: new Date(Math.min(Date.parse(admitting.expiresAt), Date.now() + 10 * 60_000)).toISOString()
                    }, mongoSession);
                }
                return admitting;
            }
        }
        return ready;
    });
    if (hunt == undefined) {
        throw new LauncherApiError("P2P_GENERATION_FENCED", "The host generation is stale or no longer starting.");
    }
    return {
        ready: true,
        sessionId: hunt.sessionId,
        generation: hunt.generation,
        leaseExpiresAt
    };
}

function AssertCapabilityMatchesTicket(capability: P2PHostCapabilityRecord, claims: ReturnType<typeof VerifyAdmissionTicket>, bridgeInstanceId: string): void {
    if (capability.sessionId !== claims.sessionId || capability.generation !== claims.generation ||
        capability.hostSteamId !== claims.hostSteamId || capability.bridgeInstanceId !== bridgeInstanceId) {
        throw new LauncherApiError("P2P_GENERATION_FENCED", "The admission ticket does not match the active host generation.");
    }
}

export async function ConsumeAdmissionTicket(input: {
    sessionId: string;
    ticket: unknown;
    authenticatedSteamId: unknown;
    bridgeInstanceId: unknown;
    connectionHandle: unknown;
    requestId: string;
    capability: P2PHostCapabilityRecord;
}) {
    if (!ReadP2PPolicy().enabled) throw new LauncherApiError("P2P_DISABLED", "Player-hosted hunts are currently disabled.");
    if (typeof input.ticket !== "string" || typeof input.authenticatedSteamId !== "string" ||
        typeof input.bridgeInstanceId !== "string" || input.bridgeInstanceId.length < 16 || input.bridgeInstanceId.length > 96 ||
        typeof input.connectionHandle !== "string" || input.connectionHandle.length < 1 || input.connectionHandle.length > 32) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The admission request is malformed.");
    }
    const ticket = input.ticket;
    const authenticatedSteamId = input.authenticatedSteamId;
    const bridgeInstanceId = input.bridgeInstanceId;
    const connectionHandle = input.connectionHandle;
    let claims: ReturnType<typeof VerifyAdmissionTicket>;
    try {
        claims = VerifyAdmissionTicket(ticket);
    } catch (error) {
        const message = error instanceof Error ? error.message : "invalid admission ticket";
        throw new LauncherApiError(message.includes("expired") ? "P2P_TICKET_EXPIRED" : "P2P_TICKET_INVALID", "The admission ticket is invalid or expired.");
    }
    if (claims.sessionId !== input.sessionId || claims.joinerSteamId !== authenticatedSteamId) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "The ticket does not match the authenticated Steam connection.");
    }
    AssertCapabilityMatchesTicket(input.capability, claims, bridgeInstanceId);

    let hubSessionId = undefined as string | undefined;
    // [2026-10-14 realms S3] The realm of a realm hunt the member was admitted to: its hub presence ends after the transaction.
    let travelRealmId = undefined as string | undefined;
    const consumed = await WithP2PTransaction(async (repos, mongoSession) => {
        hubSessionId = undefined;
        travelRealmId = undefined;
        AssertP2PAdmissionNotStopped(await FenceP2PEmergencyStop(mongoSession));
        const hunt = await repos.p2pHunts.findHunt(input.sessionId, mongoSession);
        if (hunt == undefined) throw new LauncherApiError("P2P_SESSION_NOT_FOUND", "Hunt session not found.");
        const hub = IsRealmHub(hunt);
        if (hunt.generation !== claims.generation || hunt.hostSteamId !== claims.hostSteamId ||
            hunt.bridgeInstanceId !== bridgeInstanceId || !TICKETABLE_STATES.has(hunt.state)) {
            throw new LauncherApiError("P2P_GENERATION_FENCED", "This hunt generation no longer accepts admission.");
        }
        const result = await repos.p2pHunts.consumeAdmissionTicket({
            jtiDigest: HashAdmissionJti(claims.jti),
            sessionId: claims.sessionId,
            generation: claims.generation,
            accountId: claims.accountId,
            joinerSteamId: claims.joinerSteamId,
            hostSteamId: claims.hostSteamId,
            bridgeInstanceId,
            requestId: input.requestId,
            now: new Date().toISOString()
        }, mongoSession);
        if (result.outcome === "EXPIRED") throw new LauncherApiError("P2P_TICKET_EXPIRED", "The admission ticket expired.");
        if (result.outcome === "REPLAY") throw new LauncherApiError("P2P_TICKET_REPLAYED", "The admission ticket was already consumed.");
        if (result.outcome === "INVALID") throw new LauncherApiError("P2P_TICKET_INVALID", "The admission ticket is not valid for this hunt.");

        // The JTI digest gives each reconnect a distinct admission record while the separate
        // active key below preserves the one-live-connection invariant for this peer/session.
        const admissionId = HashAdmissionJti(claims.jti);
        if (result.outcome === "CONSUMED") {
            // A hub member that comes back before the host reported its old link closed (a lost link, a quick re-entry)
            // would hit the one-live-connection key; its old admission is closed first. A hunt keeps its reconnect rules.
            if (hub) {
                await repos.p2pHunts.supersedeActivePeerAdmission(
                    `${claims.sessionId}:${claims.generation}:${claims.joinerSteamId}`, new Date().toISOString(), mongoSession);
            }
            await repos.p2pHunts.recordPeerAdmission({
                admissionId,
                activeAdmissionKey: `${claims.sessionId}:${claims.generation}:${claims.joinerSteamId}`,
                sessionId: claims.sessionId,
                generation: claims.generation,
                accountId: claims.accountId,
                steamId: claims.joinerSteamId,
                bridgeInstanceId,
                connectionHandle,
                admittedAt: new Date().toISOString()
            }, mongoSession);
        }
        const admittedAt = new Date().toISOString();
        if (hub) {
            hubSessionId = hunt.sessionId;
            await AdmitHubPeer(repos, mongoSession, hunt, { accountId: claims.accountId, admissionId, admittedAt });
            return {
                admitted: true,
                idempotent: result.outcome === "IDEMPOTENT",
                admissionId,
                accountId: claims.accountId,
                steamId: claims.joinerSteamId,
                sessionId: claims.sessionId,
                generation: claims.generation
            };
        }
        const admitted = await repos.p2pHunts.markParticipantAdmitted({
            sessionId: claims.sessionId,
            generation: claims.generation,
            accountId: claims.accountId,
            admittedAt
        }, mongoSession);
        if (admitted == undefined) throw new LauncherApiError("P2P_GENERATION_FENCED", "The participant admission raced a fenced generation.");
        if (hunt.realmId != undefined) travelRealmId = hunt.realmId;
        if (admitted.state === "ADMITTING") {
            const running = await repos.p2pHunts.compareAndSetHunt({
                sessionId: admitted.sessionId,
                generation: admitted.generation,
                expectedStates: ["ADMITTING"],
                expectedStateVersion: admitted.stateVersion,
                set: { state: "RUNNING" }
            }, mongoSession);
            if (running != undefined) {
                await repos.p2pHunts.appendHuntTransition({
                    sessionId: running.sessionId,
                    generation: running.generation,
                    fromState: "ADMITTING",
                    toState: "RUNNING",
                    stateVersion: running.stateVersion,
                    reason: "PARTICIPANT_ADMITTED",
                    actorType: "PARTICIPANT",
                    actorAccountId: claims.accountId,
                    at: admittedAt
                }, mongoSession);
            }
        }
        return {
            admitted: true,
            idempotent: result.outcome === "IDEMPOTENT",
            admissionId,
            accountId: claims.accountId,
            steamId: claims.joinerSteamId,
            sessionId: claims.sessionId,
            generation: claims.generation
        };
    });
    if (hubSessionId !== undefined) InvalidateHubPresence(hubSessionId);
    if (travelRealmId !== undefined) {
        // Best effort after the commit: the admission stands even if the member's hub presence could not be moved.
        try {
            await RealmHubTravel.onHuntAdmitted(claims.accountId, travelRealmId);
        } catch (error) {
            logger.warn(`[RealmHub] could not move ${claims.accountId} out of its hub for realm ${travelRealmId}: ${error}`);
        }
    }
    return consumed;
}

export async function RecordPeerDisconnected(input: {
    admissionId: string;
    disconnectedAt?: string;
    capability: P2PHostCapabilityRecord;
}): Promise<{ disconnected: boolean }> {
    if (!/^[a-f0-9]{64}$/.test(input.admissionId)) {
        throw new LauncherApiError("P2P_TICKET_INVALID", "Invalid peer admission identifier.");
    }
    const now = input.disconnectedAt ?? new Date().toISOString();
    let hubSessionId = undefined as string | undefined;
    const disconnected = await WithP2PTransaction(async (repos, mongoSession) => {
        hubSessionId = undefined;
        AssertP2PAdmissionNotStopped(await FenceP2PEmergencyStop(mongoSession));
        const admission = await repos.p2pHunts.findPeerAdmission(input.admissionId, mongoSession);
        if (admission == undefined || admission.sessionId !== input.capability.sessionId || admission.generation !== input.capability.generation) return false;
        const changed = await repos.p2pHunts.disconnectPeer({
            admissionId: input.admissionId,
            sessionId: input.capability.sessionId,
            generation: input.capability.generation,
            bridgeInstanceId: input.capability.bridgeInstanceId,
            disconnectedAt: now
        }, mongoSession);
        if (changed) {
            const marked = await repos.p2pHunts.markParticipantDisconnected({
                sessionId: admission.sessionId,
                generation: admission.generation,
                accountId: admission.accountId,
                disconnectedAt: now,
                rejoinDeadline: new Date(Date.parse(now) + ReadP2PHostEligibilityPolicy().rejoinLifetimeMs).toISOString()
            }, mongoSession);
            // [2026-10-13 realms S1] A realm hub has no roster: the member's presence row becomes LOST (only if this
            // admission is still the row's current one, so a late report cannot end a newer connection).
            if (marked == undefined) {
                const hub = await repos.p2pHunts.findHunt(admission.sessionId, mongoSession);
                if (IsRealmHub(hub)) {
                    hubSessionId = admission.sessionId;
                    await HubPeerDisconnected(repos, mongoSession, hub!, {
                        accountId: admission.accountId, admissionId: input.admissionId, disconnectedAt: now,
                        purgeAt: PresencePurgeAt(Date.parse(now))
                    });
                }
            }
        }
        return changed;
    });
    if (hubSessionId !== undefined) InvalidateHubPresence(hubSessionId);
    return { disconnected };
}
