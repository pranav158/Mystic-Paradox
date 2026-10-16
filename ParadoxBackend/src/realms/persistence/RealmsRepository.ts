/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import {
    RealmBan,
    RealmHostingPatch,
    RealmInviteRecord,
    RealmJoinPolicy,
    RealmJoinRequest,
    RealmMember,
    RealmPlayerInvite,
    RealmPresenceRecord,
    RealmRecord
} from "../realmTypes";
import { HeartbeatUpdate } from "../realmRules";

// [2026-10-13 realms S2] Persistence contract of the realms module. Every method that changes a realm or an invite is
// one atomic operation with its precondition inside it (so two requests racing for the same name, the last invite use
// or the last member slot cannot both win); the service composes them and compensates where one request needs two.

export type InsertRealmResult = "INSERTED" | "NAME_TAKEN" | "HOST_HAS_REALM";
export type AddMemberResult = "ADDED" | "ALREADY_MEMBER" | "BANNED" | "FULL" | "NOT_FOUND";
export type AddBanResult = "BANNED" | "ALREADY_BANNED" | "FULL" | "NOT_FOUND";
/** [2026-10-15] A join request: ADDED now; the other answers say why it was not (checked in the order listed). */
export type AddJoinRequestResult = "ADDED" | "ALREADY_REQUESTED" | "BANNED" | "ALREADY_MEMBER" | "FULL" | "NOT_FOUND";
/** [2026-10-16] A player invite: ADDED now; the other answers say why it was not (checked in the order listed). */
export type AddPlayerInviteResult = "ADDED" | "ALREADY_INVITED" | "BANNED" | "ALREADY_MEMBER" | "FULL" | "NOT_FOUND";

export interface RealmsRepository {
    findById(realmId: string): Promise<RealmRecord | undefined>;
    findByName(name: string): Promise<RealmRecord | undefined>;
    findByHost(hostAccountId: string): Promise<RealmRecord | undefined>;
    /** Realms the account is in (the host's own realm included); newest membership order is not promised. */
    findByMember(accountId: string, limit: number): Promise<RealmRecord[]>;
    /** Listed realms, online ones first. */
    listListed(limit: number, offset: number): Promise<RealmRecord[]>;

    /** Inserts a new realm; the name and the host account are each unique. */
    insertRealm(realm: RealmRecord): Promise<InsertRealmResult>;
    /**
     * Deletes the realm only if it has not been online since `expectedLastOnlineAt` was read (name release: a heartbeat
     * between the check and the delete keeps the realm). Its invites go with it.
     */
    deleteRealmIfLastOnline(realmId: string, expectedLastOnlineAt: string | undefined): Promise<boolean>;
    /** The host closes its own realm; its invites go with it. */
    deleteRealmOfHost(realmId: string, hostAccountId: string): Promise<boolean>;

    setSettings(realmId: string, hostAccountId: string, settings: { joinPolicy?: RealmJoinPolicy; listed?: boolean }): Promise<boolean>;
    recordHeartbeat(realmId: string, hostAccountId: string, update: HeartbeatUpdate): Promise<boolean>;

    /**
     * [hub design section 2.3] Merges `patch` into the realm's hosting record, creating it with the defaults when absent. Fields the
     * patch does not name keep their value (so the host's heartbeat and the p2p module, who write disjoint fields, never undo each
     * other); null removes an optional field; `updatedAtIso` is stamped. False when the realm does not exist.
     */
    patchHosting(realmId: string, patch: RealmHostingPatch, updatedAtIso: string): Promise<boolean>;
    /**
     * Ends the realm's online state at `atIso` without the sweeper noticing it (the caller already knows): only when it would last
     * beyond `atIso`. False when the realm does not exist or was not online.
     */
    markOffline(realmId: string, atIso: string): Promise<boolean>;
    /**
     * Realms whose `onlineUntil` lapsed within (sinceIso, nowIso] and for which no notice was taken yet. Each realm is claimed
     * atomically (so one lapse is returned once, even to two processes) and at most `limit` are returned.
     */
    claimLapsedHosts(nowIso: string, sinceIso: string, limit: number): Promise<RealmRecord[]>;
    /** The realm one of whose hub room ids this is (RealmRecord.hubRoomIds). */
    findByHubRoomId(hubRoomId: string): Promise<RealmRecord | undefined>;

    /**
     * Adds a member unless already in, banned, or the realm holds `maxMembers`. [2026-10-16] The same update removes the account's
     * player invite, so no invite outlives the membership it offered.
     */
    addMember(realmId: string, member: RealmMember, maxMembers: number): Promise<AddMemberResult>;
    /** Removes a plain member (never the host). False when the account is not a member. */
    removeMember(realmId: string, accountId: string): Promise<boolean>;
    /** Bans an account (member or not) and removes it from the members, its join request and [2026-10-16] its player invite. */
    addBan(realmId: string, ban: RealmBan, maxBans: number): Promise<AddBanResult>;
    /** Lifts a ban. False when the account was not banned. A ban also removes the account's join request (addBan). */
    removeBan(realmId: string, accountId: string): Promise<boolean>;

    /**
     * [2026-10-15] Records a join request unless the account already has one, is banned or is a member, or the realm already holds
     * `maxRequests` requests. The checks and the insert are one update, so two racing requests cannot exceed the bound.
     */
    addJoinRequest(realmId: string, request: RealmJoinRequest, maxRequests: number): Promise<AddJoinRequestResult>;
    /** Removes the account's join request. False when it had none. */
    removeJoinRequest(realmId: string, accountId: string): Promise<boolean>;

    /**
     * [2026-10-16] Records a player invite unless the account already has one, is banned or is a member, or the realm already holds
     * `maxInvites` invites. The checks and the insert are one update, like addJoinRequest.
     */
    addPlayerInvite(realmId: string, invite: RealmPlayerInvite, maxInvites: number): Promise<AddPlayerInviteResult>;
    /** Removes the account's player invite. False when it had none. */
    removePlayerInvite(realmId: string, accountId: string): Promise<boolean>;
    /** Realms holding a player invite for the account, by name. */
    findByPlayerInvite(accountId: string, limit: number): Promise<RealmRecord[]>;

    insertInvite(invite: RealmInviteRecord): Promise<"INSERTED" | "DUPLICATE">;
    findInvite(code: string): Promise<RealmInviteRecord | undefined>;
    /** The realm's invites, newest first. */
    listInvites(realmId: string, limit: number): Promise<RealmInviteRecord[]>;
    /** Invites of the realm that can still be used now. */
    countActiveInvites(realmId: string, nowIso: string): Promise<number>;
    /** Adds one use if the invite is still usable at `nowIso`; undefined when it no longer is. */
    consumeInvite(code: string, nowIso: string): Promise<RealmInviteRecord | undefined>;
    /** Gives one use back (a join that consumed it failed afterwards). */
    refundInvite(code: string): Promise<void>;
    /** Marks the invite revoked (kept if already revoked); undefined when it is not an invite of this realm. */
    revokeInvite(realmId: string, code: string, atIso: string): Promise<RealmInviteRecord | undefined>;
}

/**
 * [hub design section 2.2] Realm presence: which realm an account's current game login belongs to, one row per account. A row is
 * active while expiresAt > now; every read enforces that (the database's TTL index only cleans up, minutes late).
 */
export interface RealmPresenceRepository {
    /** Replaces the account's row with this one (one row per account). */
    bind(row: RealmPresenceRecord): Promise<void>;
    /** The account's row if it is still active at `nowIso`. */
    findActive(accountId: string, nowIso: string): Promise<RealmPresenceRecord | undefined>;
    /** Extends a row that is still active at `nowIso` (lastSeenAt = nowIso, expiresAt = expiresAtIso) and returns it; undefined when none is. */
    touch(accountId: string, nowIso: string, expiresAtIso: string): Promise<RealmPresenceRecord | undefined>;
    /** Deletes the account's row; with `realmId` only when it is bound to that realm. False when nothing was deleted. */
    remove(accountId: string, realmId?: string): Promise<boolean>;
    /** Deletes every row of the realm; returns how many. */
    removeForRealm(realmId: string): Promise<number>;
    /** Active rows per realm (realms with none are absent from the map). */
    countActiveByRealm(realmIds: string[], nowIso: string): Promise<Map<string, number>>;
}

/** Display names of accounts, for host and member labels (best effort: an unknown account has no entry). */
export type DisplayNameResolver = (accountIds: string[]) => Promise<Map<string, string>>;
