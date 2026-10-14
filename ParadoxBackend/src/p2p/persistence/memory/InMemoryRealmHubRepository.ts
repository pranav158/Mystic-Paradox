/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession } from "mongodb";
import {
    DecideEntryRequest,
    IsPresenceExpired,
    IsPresenceLive,
    NextPresenceState,
    PRESENCE_LIVE_STATES
} from "../../realm/realmHubRules";
import {
    EntryRequestOutcome,
    HubEntryBatchResult,
    HubEntryRequest,
    RealmHubPresenceRecord,
    RealmHubPresenceState,
    RealmHubRepository
} from "../contracts/RealmHubRepository";

// [2026-10-13 realms S1] In-memory RealmHubRepository for tests: the same transitions and guards as the MongoDB
// implementation (both apply realm/realmHubRules.ts), checked against each other by the shared contract
// (persistence/realmHubRepositoryContract.ts). Rows are stored and returned as copies, like a database.

function Copy(record: RealmHubPresenceRecord): RealmHubPresenceRecord {
    return { ...record };
}

const CONNECTION_FIELDS: ReadonlyArray<keyof RealmHubPresenceRecord> = [
    "localBridgePort", "localBridgeReadyAt", "admissionId", "route", "ticketedAt", "admittedAt", "lostAt", "leftAt", "leftReason", "purgeAt"
];

export class InMemoryRealmHubRepository implements RealmHubRepository {
    readonly rows = new Map<string, RealmHubPresenceRecord>();

    private static key(sessionId: string, accountId: string): string {
        return `${sessionId}:${accountId}`;
    }

    private get(sessionId: string, accountId: string): RealmHubPresenceRecord | undefined {
        return this.rows.get(InMemoryRealmHubRepository.key(sessionId, accountId));
    }

    async requestEntry(input: {
        sessionId: string; generation: number; realmId: string; accountId: string; peerId: string;
        candidateId: string; now: string; expiresAt: string;
    }, _session?: ClientSession): Promise<{ record: RealmHubPresenceRecord; outcome: EntryRequestOutcome }> {
        return this.entryRow(input);
    }

    /** No await anywhere in here: the batch below is one step for every caller of this process. */
    async requestEntries(input: {
        sessionId: string; generation: number; realmId: string; maxPeers: number; entries: HubEntryRequest[];
        now: string; expiresAt: string;
    }, _session?: ClientSession): Promise<HubEntryBatchResult> {
        const requests = [...new Map(input.entries.map((entry) => [entry.accountId, entry])).values()];
        const live = [...this.rows.values()].filter((row) => row.sessionId === input.sessionId && row.generation === input.generation
            && IsPresenceLive(row, input.now)).length;
        const newcomers = requests.filter((entry) => {
            const existing = this.get(input.sessionId, entry.accountId);
            return existing == undefined || !IsPresenceLive(existing, input.now);
        }).length;
        if (newcomers > 0 && live + newcomers > input.maxPeers) return { placed: false, reason: "FULL", live, maxPeers: input.maxPeers };
        const entries = requests.map((entry) => ({
            accountId: entry.accountId,
            ...this.entryRow({
                sessionId: input.sessionId, generation: input.generation, realmId: input.realmId, accountId: entry.accountId,
                peerId: entry.peerId, candidateId: entry.candidateId, now: input.now, expiresAt: input.expiresAt
            })
        }));
        return { placed: true, entries };
    }

    private entryRow(input: {
        sessionId: string; generation: number; realmId: string; accountId: string; peerId: string;
        candidateId: string; now: string; expiresAt: string;
    }): { record: RealmHubPresenceRecord; outcome: EntryRequestOutcome } {
        const existing = this.get(input.sessionId, input.accountId);
        const decision = DecideEntryRequest(existing, input.now);
        if (decision === "CREATE") {
            const record: RealmHubPresenceRecord = {
                sessionId: input.sessionId, generation: input.generation, realmId: input.realmId, accountId: input.accountId,
                peerId: input.peerId, state: "PENDING", candidateId: input.candidateId, entryEpoch: 1,
                requestedAt: input.now, expiresAt: input.expiresAt
            };
            this.rows.set(InMemoryRealmHubRepository.key(input.sessionId, input.accountId), record);
            return { record: Copy(record), outcome: "CREATED" };
        }
        if (decision === "REUSE") {
            if (input.expiresAt > existing!.expiresAt) existing!.expiresAt = input.expiresAt;
            return { record: Copy(existing!), outcome: "REUSED" };
        }
        const next: RealmHubPresenceRecord = {
            ...existing!, generation: input.generation, realmId: input.realmId, peerId: input.peerId, state: "PENDING",
            candidateId: input.candidateId, requestedAt: input.now, expiresAt: input.expiresAt, entryEpoch: existing!.entryEpoch + 1
        };
        for (const field of CONNECTION_FIELDS) delete next[field];
        this.rows.set(InMemoryRealmHubRepository.key(input.sessionId, input.accountId), next);
        return { record: Copy(next), outcome: "REENTERED" };
    }

    async admitHost(input: {
        sessionId: string; generation: number; realmId: string; accountId: string; peerId: string;
        localBridgePort: number; now: string;
    }, _session?: ClientSession): Promise<RealmHubPresenceRecord> {
        const existing = this.get(input.sessionId, input.accountId);
        const next: RealmHubPresenceRecord = {
            ...(existing ?? {
                sessionId: input.sessionId, accountId: input.accountId, candidateId: `host:${input.sessionId}`,
                entryEpoch: 0, requestedAt: input.now, expiresAt: input.now
            }),
            generation: input.generation, realmId: input.realmId, peerId: input.peerId, state: "ADMITTED",
            localBridgePort: input.localBridgePort, localBridgeReadyAt: input.now, admittedAt: input.now
        } as RealmHubPresenceRecord;
        next.entryEpoch = (existing?.entryEpoch ?? 0) + 1;
        for (const field of ["ticketedAt", "lostAt", "leftAt", "leftReason", "purgeAt", "admissionId", "route"] as const) delete next[field];
        this.rows.set(InMemoryRealmHubRepository.key(input.sessionId, input.accountId), next);
        return Copy(next);
    }

    async findPresence(sessionId: string, accountId: string, _session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const record = this.get(sessionId, accountId);
        return record == undefined ? undefined : Copy(record);
    }

    async findForAccount(accountId: string, states: readonly RealmHubPresenceState[] = PRESENCE_LIVE_STATES,
        _session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const matching = [...this.rows.values()].filter((row) => row.accountId === accountId && states.includes(row.state))
            .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
        return matching[0] == undefined ? undefined : Copy(matching[0]);
    }

    async listByState(sessionId: string, generation: number, states: readonly RealmHubPresenceState[], limit: number,
        _session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        return [...this.rows.values()]
            .filter((row) => row.sessionId === sessionId && row.generation === generation && states.includes(row.state))
            .sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : 0))
            .slice(0, limit).map(Copy);
    }

    async countByState(sessionId: string, generation: number, states: readonly RealmHubPresenceState[], _session?: ClientSession): Promise<number> {
        return [...this.rows.values()].filter((row) => row.sessionId === sessionId && row.generation === generation && states.includes(row.state)).length;
    }

    async markTicketed(input: { sessionId: string; generation: number; accountId: string; now: string; ticketExpiresAt: string },
        _session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const row = this.get(input.sessionId, input.accountId);
        if (row == undefined || row.generation !== input.generation || NextPresenceState(row.state, "TICKET_ISSUED") == undefined ||
            IsPresenceExpired(row, input.now)) return undefined;
        row.state = "TICKETED";
        row.ticketedAt = input.now;
        if (input.ticketExpiresAt > row.expiresAt) row.expiresAt = input.ticketExpiresAt;
        return Copy(row);
    }

    async markRouteReady(input: { sessionId: string; generation: number; accountId: string; localBridgePort: number;
        readyAt: string; now: string }, _session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const row = this.get(input.sessionId, input.accountId);
        if (row == undefined || row.generation !== input.generation || NextPresenceState(row.state, "ADMITTED") == undefined ||
            IsPresenceExpired(row, input.now)) return undefined;
        row.localBridgePort = input.localBridgePort;
        row.localBridgeReadyAt = input.readyAt;
        return Copy(row);
    }

    async markAdmitted(input: { sessionId: string; generation: number; accountId: string; admissionId: string;
        admittedAt: string; now: string; route?: "relay" | "direct" }, _session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const row = this.get(input.sessionId, input.accountId);
        if (row == undefined || row.generation !== input.generation || NextPresenceState(row.state, "ADMITTED") == undefined ||
            IsPresenceExpired(row, input.now)) return undefined;
        row.state = "ADMITTED";
        row.admissionId = input.admissionId;
        row.admittedAt = input.admittedAt;
        if (input.route !== undefined) row.route = input.route;
        delete row.lostAt; delete row.leftAt; delete row.leftReason; delete row.purgeAt;
        return Copy(row);
    }

    async markLost(input: { sessionId: string; generation: number; accountId: string; admissionId?: string; lostAt: string;
        purgeAt: string }, _session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const row = this.get(input.sessionId, input.accountId);
        if (row == undefined || row.generation !== input.generation || NextPresenceState(row.state, "DISCONNECTED") == undefined) return undefined;
        if (input.admissionId !== undefined && row.admissionId !== input.admissionId) return undefined;
        row.state = "LOST";
        row.lostAt = input.lostAt;
        row.purgeAt = input.purgeAt;
        return Copy(row);
    }

    async markLeft(input: { sessionId: string; generation: number; accountId: string; reason: string; leftAt: string;
        purgeAt: string }, _session?: ClientSession): Promise<RealmHubPresenceRecord | undefined> {
        const row = this.get(input.sessionId, input.accountId);
        if (row == undefined || row.generation !== input.generation || NextPresenceState(row.state, "TRAVELLED") == undefined) return undefined;
        row.state = "LEFT";
        row.leftAt = input.leftAt;
        row.leftReason = input.reason;
        row.purgeAt = input.purgeAt;
        return Copy(row);
    }

    async removeAccountFromRealm(input: { realmId: string; accountId: string; at: string; purgeAt: string },
        _session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        return this.bulk((row) => row.realmId === input.realmId && row.accountId === input.accountId, "REMOVED",
            (row) => { row.leftAt = input.at; row.leftReason = "REMOVED"; row.purgeAt = input.purgeAt; });
    }

    async removeRealm(input: { realmId: string; at: string; purgeAt: string }, _session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        return this.bulk((row) => row.realmId === input.realmId, "REMOVED",
            (row) => { row.leftAt = input.at; row.leftReason = "REALM_RELEASED"; row.purgeAt = input.purgeAt; });
    }

    async expireStale(input: { sessionId?: string; now: string; purgeAt: string }, _session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        return this.bulk((row) => (input.sessionId === undefined || row.sessionId === input.sessionId) && row.expiresAt <= input.now, "EXPIRED",
            (row) => { row.purgeAt = input.purgeAt; });
    }

    async endSession(input: { sessionId: string; generation: number; at: string; purgeAt: string }, _session?: ClientSession): Promise<RealmHubPresenceRecord[]> {
        return this.bulk((row) => row.sessionId === input.sessionId && row.generation === input.generation, "LOST",
            (row) => { row.lostAt = input.at; row.purgeAt = input.purgeAt; });
    }

    private bulk(select: (row: RealmHubPresenceRecord) => boolean, to: RealmHubPresenceState,
        apply: (row: RealmHubPresenceRecord) => void): RealmHubPresenceRecord[] {
        const event = to === "REMOVED" ? "REMOVED" : to === "EXPIRED" ? "EXPIRED" : "SESSION_ENDED";
        const changed: RealmHubPresenceRecord[] = [];
        for (const row of this.rows.values()) {
            if (!select(row) || NextPresenceState(row.state, event) == undefined) continue;
            changed.push(Copy(row));
            row.state = to;
            apply(row);
        }
        return changed;
    }
}
