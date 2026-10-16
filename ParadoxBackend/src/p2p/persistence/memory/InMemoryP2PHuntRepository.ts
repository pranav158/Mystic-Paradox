/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import {
    P2PAdmissionTicketRecord,
    P2PControlMessageRecord,
    P2PHostCapabilityRecord,
    P2PHostOfferRecord,
    P2PHostPresenceRecord,
    P2PHostReliabilityRecord,
    P2PHuntRepository,
    P2PHuntSessionRecord,
    P2PHuntState,
    P2PHuntTransitionRecord,
    P2PParticipantObservationRecord,
    P2PPeerAdmissionRecord,
    P2PSteamLinkRecord,
    P2PTicketConsumeResult
} from "../contracts/P2PHuntRepository";

// [2026-10-13 realms S1] In-memory P2PHuntRepository for tests: the same guards, stateVersion increments and uniqueness
// rules as MongoP2PHuntRepository (read side by side), so controller and route tests run the real flows without MongoDB.
// Records go in and come out as copies, like a database. `clock` lets a test control "now" where the Mongo code reads it.

const LIVE_HOST_STATES: P2PHuntState[] = ["HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"];

function Copy<T>(value: T): T {
    return value === undefined ? value : structuredClone(value);
}

function DuplicateKey(index: string): Error {
    const error = new Error(`E11000 duplicate key error (${index})`);
    (error as any).code = 11000;
    return error;
}

export class InMemoryP2PHuntRepository implements P2PHuntRepository {
    readonly hunts = new Map<string, P2PHuntSessionRecord>();
    readonly transitions: P2PHuntTransitionRecord[] = [];
    readonly steamLinks = new Map<string, P2PSteamLinkRecord>();
    readonly capabilities = new Map<string, P2PHostCapabilityRecord>();
    readonly tickets = new Map<string, P2PAdmissionTicketRecord>();
    readonly peerAdmissions = new Map<string, P2PPeerAdmissionRecord>();
    readonly controlMessages: P2PControlMessageRecord[] = [];
    readonly hostPresences = new Map<string, P2PHostPresenceRecord>();
    readonly hostOffers = new Map<string, P2PHostOfferRecord>();
    readonly hostReliability = new Map<string, P2PHostReliabilityRecord>();
    readonly observations: P2PParticipantObservationRecord[] = [];
    private readonly controlSequences = new Map<string, number>();

    constructor(private readonly clock: () => number = () => Date.now()) {}

    private nowIso(): string {
        return new Date(this.clock()).toISOString();
    }

    async findHunt(sessionId: string, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        return Copy(this.hunts.get(sessionId));
    }

    async findActiveHuntForParty(partyId: string, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        return Copy([...this.hunts.values()].find((hunt) => hunt.activePartyKey === partyId));
    }

    async findActiveHuntForAccount(accountId: string, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const matching = [...this.hunts.values()].filter((hunt) => typeof hunt.activePartyKey === "string" &&
            hunt.sessionKind !== "REALM_HUB" && hunt.roster.some((entry) => entry.accountId === accountId))
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
        return Copy(matching[0]);
    }

    async createHunt(record: P2PHuntSessionRecord, _session?: ClientSession): Promise<void> {
        if (this.hunts.has(record.sessionId)) throw DuplicateKey("_id");
        if (typeof record.activePartyKey === "string" &&
            [...this.hunts.values()].some((hunt) => hunt.activePartyKey === record.activePartyKey)) throw DuplicateKey("activePartyKey");
        this.hunts.set(record.sessionId, Copy(record));
    }

    async findRecoverableHuntForAccount(accountId: string, now: string, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const matching = [...this.hunts.values()].filter((hunt) => hunt.state === "RECOVERING" && hunt.expiresAt > now &&
            hunt.roster.some((entry) => entry.accountId === accountId))
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
        return Copy(matching[0]);
    }

    async listLifecycleHunts(states: P2PHuntState[], limit: number, _session?: ClientSession): Promise<P2PHuntSessionRecord[]> {
        return [...this.hunts.values()].filter((hunt) => states.includes(hunt.state))
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)).slice(0, limit).map(Copy);
    }

    async compareAndSetHunt(input: {
        sessionId: string; generation: number; expectedStates: P2PHuntState[]; expectedStateVersion: number;
        set: Partial<P2PHuntSessionRecord>; unset?: Array<keyof P2PHuntSessionRecord>;
    }, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const hunt = this.hunts.get(input.sessionId);
        if (hunt == undefined || hunt.generation !== input.generation || !input.expectedStates.includes(hunt.state) ||
            hunt.stateVersion !== input.expectedStateVersion) return undefined;
        Object.assign(hunt, Copy(input.set));
        for (const field of input.unset ?? []) delete (hunt as any)[field];
        hunt.stateVersion += 1;
        return Copy(hunt);
    }

    async appendHuntTransition(record: Omit<P2PHuntTransitionRecord, "transitionId">, _session?: ClientSession): Promise<void> {
        this.transitions.push({ transitionId: crypto.randomUUID(), ...record });
    }

    async beginHostStartup(input: {
        sessionId: string; hostAccountId: string; bridgeInstanceId: string; metadataNonce: string; startupDeadline: string;
        serverUdpPort?: number;
    }, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const hunt = this.hunts.get(input.sessionId);
        if (hunt == undefined || hunt.hostAccountId !== input.hostAccountId || hunt.state !== "HOST_OFFERED" || hunt.expiresAt <= this.nowIso()) return undefined;
        hunt.state = "STARTING";
        hunt.bridgeInstanceId = input.bridgeInstanceId;
        hunt.metadataNonce = input.metadataNonce;
        hunt.startupDeadline = input.startupDeadline;
        if (input.serverUdpPort !== undefined) hunt.serverUdpPort = input.serverUdpPort;
        for (const field of ["lobbyId", "leaseExpiresAt", "suspectSince", "suspectDeadline", "preSuspectState"] as const) delete hunt[field];
        hunt.stateVersion += 1;
        return Copy(hunt);
    }

    async renewHostLease(input: {
        sessionId: string; generation: number; hostSteamId: string; bridgeInstanceId: string; leaseSequence: number;
        heartbeatAt: string; leaseExpiresAt: string;
    }, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const hunt = this.hunts.get(input.sessionId);
        if (hunt == undefined || hunt.generation !== input.generation || hunt.hostSteamId !== input.hostSteamId ||
            hunt.bridgeInstanceId !== input.bridgeInstanceId || !["HOST_READY", "ADMITTING", "RUNNING", "DRAINING", "SUSPECT"].includes(hunt.state) ||
            !(hunt.lastLeaseSequence === undefined || hunt.lastLeaseSequence < input.leaseSequence)) return undefined;
        hunt.lastLeaseSequence = input.leaseSequence;
        hunt.lastHeartbeatAt = input.heartbeatAt;
        hunt.leaseExpiresAt = input.leaseExpiresAt;
        hunt.stateVersion += 1;
        return Copy(hunt);
    }

    async markHostReady(input: {
        sessionId: string; generation: number; hostSteamId: string; bridgeInstanceId: string; lobbyId: string;
        virtualPort: number; leaseExpiresAt: string;
    }, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const hunt = this.hunts.get(input.sessionId);
        if (hunt == undefined || hunt.generation !== input.generation || hunt.hostSteamId !== input.hostSteamId ||
            hunt.bridgeInstanceId !== input.bridgeInstanceId || hunt.virtualPort !== input.virtualPort ||
            !["STARTING", "HOST_READY"].includes(hunt.state)) return undefined;
        hunt.state = "HOST_READY";
        hunt.lobbyId = input.lobbyId;
        hunt.leaseExpiresAt = input.leaseExpiresAt;
        hunt.lastHeartbeatAt = this.nowIso();
        hunt.lastLeaseSequence = 0;
        hunt.stateVersion += 1;
        return Copy(hunt);
    }

    async findSteamLink(accountId: string, _session?: ClientSession): Promise<P2PSteamLinkRecord | undefined> {
        return Copy(this.steamLinks.get(accountId));
    }

    async findSteamLinkBySteamId(steamId: string, _session?: ClientSession): Promise<P2PSteamLinkRecord | undefined> {
        return Copy([...this.steamLinks.values()].find((link) => link.steamId === steamId));
    }

    async upsertSteamLink(record: P2PSteamLinkRecord, _session?: ClientSession): Promise<void> {
        const owner = [...this.steamLinks.values()].find((link) => link.steamId === record.steamId && link.accountId !== record.accountId);
        if (owner != undefined) throw DuplicateKey("steamId");
        this.steamLinks.set(record.accountId, Copy(record));
    }

    async deleteSteamLink(accountId: string, _session?: ClientSession): Promise<void> {
        this.steamLinks.delete(accountId);
    }

    async createHostCapability(record: P2PHostCapabilityRecord, _session?: ClientSession): Promise<void> {
        if ([...this.capabilities.values()].some((entry) => entry.secretDigest === record.secretDigest)) throw DuplicateKey("secretDigest");
        this.capabilities.set(record.capabilityId, Copy(record));
    }

    async findHostCapabilityByDigest(secretDigest: string, _session?: ClientSession): Promise<P2PHostCapabilityRecord | undefined> {
        return Copy([...this.capabilities.values()].find((entry) => entry.secretDigest === secretDigest));
    }

    async advanceHostCapabilitySequence(capabilityId: string, sequence: number, _session?: ClientSession): Promise<boolean> {
        const capability = this.capabilities.get(capabilityId);
        if (capability == undefined || capability.revokedAt != undefined || !(capability.lastSequence < sequence)) return false;
        capability.lastSequence = sequence;
        return true;
    }

    async revokeGeneration(sessionId: string, generation: number, revokedAt: string, _session?: ClientSession): Promise<void> {
        for (const capability of this.capabilities.values()) {
            if (capability.sessionId === sessionId && capability.generation === generation && capability.revokedAt === undefined) capability.revokedAt = revokedAt;
        }
    }

    async markParticipantRouteReady(input: {
        sessionId: string; generation: number; accountId: string; steamId: string; bridgeInstanceId: string;
        localBridgePort: number; readyAt: string;
    }, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const hunt = this.hunts.get(input.sessionId);
        const participant = hunt?.roster.find((entry) => entry.accountId === input.accountId && entry.steamId === input.steamId);
        if (hunt == undefined || participant == undefined || hunt.generation !== input.generation ||
            !["HOST_READY", "ADMITTING", "RUNNING"].includes(hunt.state)) return undefined;
        participant.localBridgeInstanceId = input.bridgeInstanceId;
        participant.localBridgePort = input.localBridgePort;
        participant.localBridgeReadyAt = input.readyAt;
        return Copy(hunt);
    }

    async markParticipantAdmitted(input: { sessionId: string; generation: number; accountId: string; admittedAt: string },
        _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const hunt = this.hunts.get(input.sessionId);
        const participant = hunt?.roster.find((entry) => entry.accountId === input.accountId);
        if (hunt == undefined || participant == undefined || hunt.generation !== input.generation ||
            !["HOST_READY", "ADMITTING", "RUNNING"].includes(hunt.state)) return undefined;
        participant.admissionState = "ADMITTED";
        (participant as any).admittedAt = input.admittedAt;
        delete participant.disconnectedAt;
        delete participant.rejoinDeadline;
        hunt.stateVersion += 1;
        return Copy(hunt);
    }

    async createAdmissionTicket(record: P2PAdmissionTicketRecord, _session?: ClientSession): Promise<void> {
        if (this.tickets.has(record.jtiDigest)) throw DuplicateKey("_id");
        this.tickets.set(record.jtiDigest, Copy(record));
    }

    async revokeAdmissionTickets(sessionId: string, generation: number, _session?: ClientSession): Promise<void> {
        for (const ticket of this.tickets.values()) {
            if (ticket.sessionId === sessionId && ticket.generation === generation && ticket.status === "ISSUED") ticket.status = "REVOKED";
        }
    }

    async revokeAdmissionTicketsForAccount(sessionId: string, accountId: string, _session?: ClientSession): Promise<number> {
        let revoked = 0;
        for (const ticket of this.tickets.values()) {
            if (ticket.sessionId === sessionId && ticket.accountId === accountId && ticket.status === "ISSUED") {
                ticket.status = "REVOKED";
                revoked++;
            }
        }
        return revoked;
    }

    async reserveParticipantTicket(input: {
        sessionId: string; generation: number; accountId: string; now: string; rejoinDeadline: string; maxReconnects: number;
    }, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const hunt = this.hunts.get(input.sessionId);
        const participant = hunt?.roster.find((entry) => entry.accountId === input.accountId);
        if (hunt == undefined || participant == undefined || hunt.generation !== input.generation ||
            !["HOST_READY", "ADMITTING", "RUNNING"].includes(hunt.state) || !(participant.reconnectEpoch < input.maxReconnects) ||
            !(participant.disconnectedAt === undefined || (participant.rejoinDeadline ?? "") > input.now)) return undefined;
        participant.reconnectEpoch += 1;
        participant.admissionState = "ISSUED";
        participant.rejoinDeadline = input.rejoinDeadline;
        return Copy(hunt);
    }

    async markParticipantDisconnected(input: {
        sessionId: string; generation: number; accountId: string; disconnectedAt: string; rejoinDeadline: string;
    }, _session?: ClientSession): Promise<P2PHuntSessionRecord | undefined> {
        const hunt = this.hunts.get(input.sessionId);
        const participant = hunt?.roster.find((entry) => entry.accountId === input.accountId);
        if (hunt == undefined || participant == undefined || hunt.generation !== input.generation ||
            !["HOST_READY", "ADMITTING", "RUNNING", "DRAINING", "SUSPECT"].includes(hunt.state)) return undefined;
        participant.admissionState = "LOST";
        participant.disconnectedAt = input.disconnectedAt;
        participant.rejoinDeadline = input.rejoinDeadline;
        return Copy(hunt);
    }

    async consumeAdmissionTicket(input: {
        jtiDigest: string; sessionId: string; generation: number; accountId: string; joinerSteamId: string;
        hostSteamId: string; bridgeInstanceId: string; requestId: string; now: string;
    }, _session?: ClientSession): Promise<P2PTicketConsumeResult> {
        const ticket = this.tickets.get(input.jtiDigest);
        if (ticket == undefined) return { outcome: "INVALID" };
        if (ticket.status === "ISSUED" && ticket.sessionId === input.sessionId && ticket.generation === input.generation &&
            ticket.accountId === input.accountId && ticket.joinerSteamId === input.joinerSteamId &&
            ticket.hostSteamId === input.hostSteamId && ticket.expiresAt > input.now) {
            ticket.status = "CONSUMED";
            ticket.consumedAt = input.now;
            ticket.consumerBridgeInstanceId = input.bridgeInstanceId;
            ticket.consumerRequestId = input.requestId;
            return { outcome: "CONSUMED", record: Copy(ticket) };
        }
        if (ticket.status === "CONSUMED") {
            if (ticket.consumerBridgeInstanceId === input.bridgeInstanceId && ticket.consumerRequestId === input.requestId &&
                ticket.sessionId === input.sessionId && ticket.generation === input.generation && ticket.joinerSteamId === input.joinerSteamId) {
                return { outcome: "IDEMPOTENT", record: Copy(ticket) };
            }
            return { outcome: "REPLAY" };
        }
        if (Date.parse(ticket.expiresAt) <= Date.parse(input.now)) return { outcome: "EXPIRED" };
        return { outcome: "INVALID" };
    }

    async recordPeerAdmission(record: P2PPeerAdmissionRecord, _session?: ClientSession): Promise<void> {
        if (this.peerAdmissions.has(record.admissionId)) throw DuplicateKey("_id");
        if (typeof record.activeAdmissionKey === "string" &&
            [...this.peerAdmissions.values()].some((entry) => entry.activeAdmissionKey === record.activeAdmissionKey)) throw DuplicateKey("activeAdmissionKey");
        this.peerAdmissions.set(record.admissionId, Copy(record));
    }

    async findPeerAdmission(admissionId: string, _session?: ClientSession): Promise<P2PPeerAdmissionRecord | undefined> {
        return Copy(this.peerAdmissions.get(admissionId));
    }

    async disconnectPeer(input: {
        admissionId: string; sessionId: string; generation: number; bridgeInstanceId: string; disconnectedAt: string;
    }, _session?: ClientSession): Promise<boolean> {
        const admission = this.peerAdmissions.get(input.admissionId);
        if (admission == undefined || admission.sessionId !== input.sessionId || admission.generation !== input.generation ||
            admission.bridgeInstanceId !== input.bridgeInstanceId || admission.disconnectedAt !== undefined) return false;
        admission.disconnectedAt = input.disconnectedAt;
        delete (admission as any).activeAdmissionKey;
        return true;
    }

    async enqueueControlMessage(input: Omit<P2PControlMessageRecord, "messageId" | "sequence">, _session?: ClientSession): Promise<P2PControlMessageRecord> {
        const sequence = (this.controlSequences.get(input.accountId) ?? 0) + 1;
        this.controlSequences.set(input.accountId, sequence);
        const record: P2PControlMessageRecord = { ...Copy(input), messageId: crypto.randomUUID(), sequence };
        this.controlMessages.push(record);
        return Copy(record);
    }

    async listControlMessages(accountId: string, afterSequence: number, now: string, limit: number,
        options: { unacknowledgedOnly?: boolean } = {}): Promise<P2PControlMessageRecord[]> {
        return this.controlMessages.filter((message) => message.accountId === accountId && message.sequence > afterSequence && message.expiresAt > now
                && (!options.unacknowledgedOnly || message.acknowledgedAt === undefined))
            .sort((a, b) => a.sequence - b.sequence).slice(0, limit).map(Copy);
    }

    async latestControlSequence(accountId: string): Promise<number> {
        return this.controlSequences.get(accountId) ?? 0;
    }

    async acknowledgeControlMessage(accountId: string, messageId: string, acknowledgedAt: string): Promise<boolean> {
        const message = this.controlMessages.find((entry) => entry.messageId === messageId && entry.accountId === accountId);
        if (message == undefined) return false;
        message.acknowledgedAt = acknowledgedAt;
        return true;
    }

    async upsertHostPresence(record: P2PHostPresenceRecord, _session?: ClientSession): Promise<void> {
        this.hostPresences.set(record.accountId, Copy(record));
    }

    async listHostPresences(accountIds: string[], observedAfter: string, _session?: ClientSession): Promise<P2PHostPresenceRecord[]> {
        return accountIds.map((id) => this.hostPresences.get(id)).filter((presence): presence is P2PHostPresenceRecord =>
            presence != undefined && presence.observedAt >= observedAfter && presence.expiresAt > this.nowIso()).map(Copy);
    }

    // [2026-10-15] A drained hunt has no activePartyKey, so these filters leave it out: it is inactive for its host's one-hunt rule
    // and for its realm's server limit, and it is not listed as a realm hunt. ConfirmsRealmHost uses countRunningRealmServers.
    async countActiveHostSessions(accountId: string, _session?: ClientSession): Promise<number> {
        return [...this.hunts.values()].filter((hunt) => hunt.hostAccountId === accountId && typeof hunt.activePartyKey === "string" &&
            LIVE_HOST_STATES.includes(hunt.state)).length;
    }

    async countActiveRealmServers(realmId: string, _session?: ClientSession): Promise<number> {
        return [...this.hunts.values()].filter((hunt) => hunt.realmId === realmId && typeof hunt.activePartyKey === "string" &&
            ["HOST_SELECTING", ...LIVE_HOST_STATES].includes(hunt.state)).length;
    }

    // [2026-10-15] Every realm session whose server still runs on the host's PC, a draining one included (Mongo: $or).
    async countRunningRealmServers(realmId: string, _session?: ClientSession): Promise<number> {
        return [...this.hunts.values()].filter((hunt) => hunt.realmId === realmId &&
            ((typeof hunt.activePartyKey === "string" && ["HOST_SELECTING", ...LIVE_HOST_STATES].includes(hunt.state)) ||
                hunt.state === "DRAINING")).length;
    }

    async listLiveRealmHunts(realmId: string, hostAccountId: string, _session?: ClientSession): Promise<P2PHuntSessionRecord[]> {
        return [...this.hunts.values()].filter((hunt) => hunt.realmId === realmId && hunt.hostAccountId === hostAccountId &&
            hunt.sessionKind !== "REALM_HUB" && typeof hunt.activePartyKey === "string" &&
            ["HOST_SELECTING", ...LIVE_HOST_STATES].includes(hunt.state)).slice(0, 64).map(Copy);
    }

    async supersedeActivePeerAdmission(activeAdmissionKey: string, at: string, _session?: ClientSession): Promise<boolean> {
        const admission = [...this.peerAdmissions.values()].find((entry) => entry.activeAdmissionKey === activeAdmissionKey);
        if (admission == undefined) return false;
        admission.disconnectedAt = at;
        (admission as any).supersededAt = at;
        delete (admission as any).activeAdmissionKey;
        return true;
    }

    async findHostReliability(accountId: string, _session?: ClientSession): Promise<P2PHostReliabilityRecord | undefined> {
        return Copy(this.hostReliability.get(accountId));
    }

    async incrementHostReliability(accountId: string, increments: Partial<Record<keyof P2PHostReliabilityRecord, number>>, now: string,
        cooldownUntil?: string, _session?: ClientSession): Promise<void> {
        const current = this.hostReliability.get(accountId) ?? {
            accountId, offersAccepted: 0, offersDeclined: 0, offersExpired: 0, startsSucceeded: 0, startsFailed: 0,
            cleanCompletions: 0, unexpectedFailures: 0, updatedAt: now
        };
        for (const [key, value] of Object.entries(increments)) {
            if (typeof value === "number") (current as any)[key] = ((current as any)[key] ?? 0) + value;
        }
        current.updatedAt = now;
        if (cooldownUntil != undefined) current.cooldownUntil = cooldownUntil;
        this.hostReliability.set(accountId, current);
    }

    async createHostOffer(record: P2PHostOfferRecord, _session?: ClientSession): Promise<void> {
        if (record.status === "ACCEPTED" && [...this.hostOffers.values()].some((offer) => offer.sessionId === record.sessionId &&
            offer.generation === record.generation && offer.status === "ACCEPTED")) throw DuplicateKey("ACCEPTED offer");
        this.hostOffers.set(record.offerId, Copy(record));
    }

    async findHostOffer(offerId: string, _session?: ClientSession): Promise<P2PHostOfferRecord | undefined> {
        return Copy(this.hostOffers.get(offerId));
    }

    async listHostOffers(sessionId: string, generation: number, _session?: ClientSession): Promise<P2PHostOfferRecord[]> {
        return [...this.hostOffers.values()].filter((offer) => offer.sessionId === sessionId && offer.generation === generation)
            .sort((a, b) => a.rank - b.rank).map(Copy);
    }

    async updateHostOffer(input: {
        offerId: string; accountId: string; expectedStatus: P2PHostOfferRecord["status"]; status: P2PHostOfferRecord["status"];
        respondedAt: string; responseReason?: string;
    }, _session?: ClientSession): Promise<P2PHostOfferRecord | undefined> {
        const offer = this.hostOffers.get(input.offerId);
        if (offer == undefined || offer.accountId !== input.accountId || offer.status !== input.expectedStatus) return undefined;
        offer.status = input.status;
        offer.respondedAt = input.respondedAt;
        offer.responseReason = input.responseReason;
        return Copy(offer);
    }

    async recordParticipantObservation(record: P2PParticipantObservationRecord, _session?: ClientSession): Promise<void> {
        this.observations.push(Copy(record));
    }

    async listRecentParticipantObservations(sessionId: string, generation: number, observedAfter: string,
        _session?: ClientSession): Promise<P2PParticipantObservationRecord[]> {
        return this.observations.filter((entry) => entry.sessionId === sessionId && entry.generation === generation && entry.observedAt >= observedAfter)
            .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0)).map(Copy);
    }
}
