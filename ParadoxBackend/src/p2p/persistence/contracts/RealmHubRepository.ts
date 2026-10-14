/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession } from "mongodb";

// [2026-10-13 realms S1] Who is in a realm's Ramsgate or Training hub (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md
// sections 2 and 4.3). A hub cannot use the frozen roster of a hunt session: every roster write bumps the session's
// stateVersion (which every lifecycle step compare-and-sets on) and a reconnect counter would lock a member out after a few
// entries. Presence therefore lives in its own collection, one row per (hub session, account), written without touching the
// session document.
//
// The transitions between states are rules (realm/realmHubRules.ts PRESENCE_TRANSITIONS); every method below applies exactly
// those, in one atomic operation, in the MongoDB implementation and in the in-memory double alike. Timestamps are
// ISO-8601 UTC strings of one format (as everywhere in the backend), so they compare correctly as text.

export type RealmHubKind = "RAMSGATE" | "TRAINING";

/**
 * PENDING    routed to the hub, no ticket yet (expires)
 * TICKETED   admission ticket issued (expires with the ticket)
 * ADMITTED   connected: present in the hub (the host's own row is created ADMITTED)
 * LOST       link closed; a fresh entry is needed
 * LEFT       went to a hunt (TRAVEL) or left on its own
 * REMOVED    kicked, banned or the realm was released
 * EXPIRED    never admitted in time
 */
export type RealmHubPresenceState = "PENDING" | "TICKETED" | "ADMITTED" | "LOST" | "LEFT" | "REMOVED" | "EXPIRED";

export interface RealmHubPresenceRecord {
    sessionId: string;
    generation: number;
    realmId: string;
    accountId: string;
    /** The account's transport peer id (DeriveIcePeerId); what the admission ticket and the transport link carry. */
    peerId: string;
    state: RealmHubPresenceState;
    /** The matchmaking candidate of the current entry (a new one per entry). */
    candidateId: string;
    /** Counts entries into this hub: 1 for the first, +1 for every re-entry. */
    entryEpoch: number;
    /** The member's own loopback port into its game (set by its launcher's route-ready; the host's by its route-ready). */
    localBridgePort?: number;
    localBridgeReadyAt?: string;
    /** The transport admission (hash of the consumed ticket's jti) of the current connection. */
    admissionId?: string;
    route?: "relay" | "direct";
    requestedAt: string;
    ticketedAt?: string;
    admittedAt?: string;
    lostAt?: string;
    leftAt?: string;
    leftReason?: string;
    /** PENDING and TICKETED rows expire at this time; later states ignore it. */
    expiresAt: string;
    /** When the row may be deleted (a week after it stopped being live); set when it leaves the live states. */
    purgeAt?: string;
}

export type EntryRequestOutcome = "CREATED" | "REUSED" | "REENTERED";

/** One member asking for a seat in a hub (see requestEntries). */
export interface HubEntryRequest {
    accountId: string;
    peerId: string;
    candidateId: string;
}

/**
 * The answer of requestEntries. FULL writes nothing: `live` is the hub's live count (ADMITTED, or PENDING/TICKETED not expired)
 * that the batch did not fit next to.
 */
export type HubEntryBatchResult =
    | { placed: true; entries: Array<{ accountId: string; record: RealmHubPresenceRecord; outcome: EntryRequestOutcome }> }
    | { placed: false; reason: "FULL"; live: number; maxPeers: number };

interface SessionKey {
    sessionId: string;
    generation: number;
    accountId: string;
}

export interface RealmHubRepository {
    /**
     * The account asks to enter the hub, with no capacity check: production entries go through requestEntries, which checks the
     * hub's seats in the same step. No row: created PENDING (entryEpoch 1). A PENDING or TICKETED row that has not
     * expired is reused (its expiry is only ever extended, its candidate and ticket stay valid). Any other row - ADMITTED,
     * LOST, LEFT, EXPIRED, REMOVED or one that expired - starts a new entry: PENDING, a new candidate, entryEpoch + 1, the
     * connection fields cleared. Membership and bans are the caller's check.
     */
    requestEntry(input: {
        sessionId: string;
        generation: number;
        realmId: string;
        accountId: string;
        peerId: string;
        candidateId: string;
        now: string;
        expiresAt: string;
    }, session?: ClientSession): Promise<{ record: RealmHubPresenceRecord; outcome: EntryRequestOutcome }>;
    /**
     * [realms wave 2, capacity] Entry for several members of one hub as ONE atomic step: no capacity can be overshot by concurrent
     * calls, and a batch that does not fit places nobody. The hub's live rows are counted (ADMITTED, or PENDING/TICKETED and not
     * expired); a member whose own row is already live takes no new seat and is never refused. When the newcomers do not fit
     * within `maxPeers`, nothing is written and the answer is FULL. Otherwise each member's entry is made as requestEntry makes it.
     * Without a `session` the implementation runs the step in its own transaction (MongoDB); the in-memory double is atomic by
     * construction (no await inside). Callers invalidate the hub's presence cache afterwards.
     */
    requestEntries(input: {
        sessionId: string;
        generation: number;
        realmId: string;
        maxPeers: number;
        entries: HubEntryRequest[];
        now: string;
        expiresAt: string;
    }, session?: ClientSession): Promise<HubEntryBatchResult>;
    /** The host's own row at hub start: created or replaced as ADMITTED with its loopback port. */
    admitHost(input: {
        sessionId: string;
        generation: number;
        realmId: string;
        accountId: string;
        peerId: string;
        localBridgePort: number;
        now: string;
    }, session?: ClientSession): Promise<RealmHubPresenceRecord>;
    findPresence(sessionId: string, accountId: string, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined>;
    /** The newest row (by request time) of the account in one of `states` (default: PENDING, TICKETED, ADMITTED), any hub. */
    findForAccount(accountId: string, states?: readonly RealmHubPresenceState[], session?: ClientSession): Promise<RealmHubPresenceRecord | undefined>;
    /** Rows of the hub generation in one of `states`, oldest request first. */
    listByState(sessionId: string, generation: number, states: readonly RealmHubPresenceState[], limit: number,
        session?: ClientSession): Promise<RealmHubPresenceRecord[]>;
    countByState(sessionId: string, generation: number, states: readonly RealmHubPresenceState[], session?: ClientSession): Promise<number>;

    /** PENDING or TICKETED and not expired -> TICKETED; the row then lives until `ticketExpiresAt` (if later). */
    markTicketed(input: SessionKey & { now: string; ticketExpiresAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined>;
    /** The member's launcher published its loopback port (PENDING, TICKETED or ADMITTED; PENDING and TICKETED not expired). */
    markRouteReady(input: SessionKey & { localBridgePort: number; readyAt: string; now: string }, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined>;
    /** The host consumed the member's ticket: PENDING, TICKETED (not expired) or ADMITTED (idempotent) -> ADMITTED. */
    markAdmitted(input: SessionKey & { admissionId: string; admittedAt: string; now: string; route?: "relay" | "direct" },
        session?: ClientSession): Promise<RealmHubPresenceRecord | undefined>;
    /**
     * ADMITTED -> LOST. When `admissionId` is given it must be the row's current one, so a late report of an older
     * connection cannot end a newer one.
     */
    markLost(input: SessionKey & { admissionId?: string; lostAt: string; purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined>;
    /** ADMITTED -> LEFT (`reason` TRAVEL when the member went into a realm hunt). */
    markLeft(input: SessionKey & { reason: string; leftAt: string; purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord | undefined>;
    /** Kick or ban: every live row of the account in the realm -> REMOVED. Returns the rows that were live. */
    removeAccountFromRealm(input: { realmId: string; accountId: string; at: string; purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord[]>;
    /** The realm was released: every live row of the realm -> REMOVED. Returns the rows that were live. */
    removeRealm(input: { realmId: string; at: string; purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord[]>;
    /** PENDING and TICKETED rows past their expiry -> EXPIRED (one hub, or all). Returns the rows that expired. */
    expireStale(input: { sessionId?: string; now: string; purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord[]>;
    /** The hub ended: every live row of the generation -> LOST. Returns the rows that were live. */
    endSession(input: { sessionId: string; generation: number; at: string; purgeAt: string }, session?: ClientSession): Promise<RealmHubPresenceRecord[]>;
}
