/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-13 realms S2] Records of the Paradox realms directory (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md §3.3,
// HOSTING_TIERS_AND_REALMS_PLAN §5.6). A realm is a player who hosts game servers on their own PC for friends, using our
// backend and Paradox accounts. The record holds NO network address of any kind: players reach the host through the
// transport (ICE / relay), and the directory never learns or serves an IP.
// All timestamps are ISO-8601 UTC strings (as everywhere in the backend); ISO strings of this shape compare correctly as text.

/** [2026-10-16] SOLO: only the host enters (members, invites and requests wait until the host chooses another policy). */
export type RealmJoinPolicy = "INVITE_ONLY" | "PUBLIC" | "SOLO";
export type RealmMemberRole = "HOST" | "MEMBER";

export interface RealmMember {
    accountId: string;
    role: RealmMemberRole;
    joinedAt: string;
}

export interface RealmBan {
    accountId: string;
    reason?: string;
    at: string;
}

/** [2026-10-15] A player who asked to join an invite-only realm and waits for the host (at most RealmLimits.maxJoinRequests). */
export interface RealmJoinRequest {
    accountId: string;
    at: string;
}

/**
 * [2026-10-16] A player the host invited by launcher username. The player becomes a member only by accepting (or by pressing Play
 * with the invite pending); declining removes it. At most RealmLimits.maxPlayerInvites per realm.
 */
export interface RealmPlayerInvite {
    accountId: string;
    at: string;
}

/** State of one hosted server kind on the host's PC. Mirrored by the p2p module (setHosting), never self-reported. */
export type RealmHubState = "NONE" | "STARTING" | "RUNNING" | "STOPPING";
export type RealmHubKind = "RAMSGATE" | "TRAINING";

/**
 * [2026-10-13 realms hub design section 2.3] What the realm's host runs. maxServers, maxPlayers and afkSeconds are advisory and
 * host-chosen (they arrive with the host heartbeat); the hub fields are written by the p2p module on each hub transition.
 */
export interface RealmHosting {
    /** 1..8: servers (hub, Training and hunts together) the host allows at once. */
    maxServers: number;
    /** 1..64: players the realm's Ramsgate takes. */
    maxPlayers: number;
    /** 0..7200: hub AFK limit in seconds (0 = never); absent = the runtime default. */
    afkSeconds?: number;
    hubSessionId?: string;
    hubState: RealmHubState;
    trainingState: RealmHubState;
    activeServers: number;
    updatedAt: string;
}

/**
 * The fields setHosting may change. A value of null removes an optional field (hubSessionId, afkSeconds). `updatedAt` is accepted
 * so a Partial<RealmHosting> is a valid patch, but it is ignored: the service stamps its own clock.
 */
export type RealmHostingPatch = Partial<Omit<RealmHosting, "hubSessionId" | "afkSeconds">> & {
    hubSessionId?: string | null;
    afkSeconds?: number | null;
};

export interface RealmRecord {
    realmId: string;
    /** Canonical (lower-case) realm name; unique across the directory. */
    name: string;
    hostAccountId: string;
    /** The host launcher's public key. A name that comes back with a different key has a new owner. */
    hostPublicKey: string;
    joinPolicy: RealmJoinPolicy;
    /** Shown in the public directory listing (still subject to joinPolicy). */
    listed: boolean;
    /** Includes the host (role HOST) from creation on. */
    members: RealmMember[];
    bans: RealmBan[];
    createdAt: string;
    /** Last time the host reported in; absent until the first heartbeat (a realm that was never online). */
    lastOnlineAt?: string;
    /** The realm counts as online until this time (each heartbeat sets it to now + 90 s). */
    onlineUntil?: string;
    /** Runtime / game-server version the host reported with its last heartbeat (plan §5.7). */
    version?: string;
    /** Absent until the host reports `hosting` or the p2p module mirrors a hub state (section 2.3). */
    hosting?: RealmHosting;
    /**
     * The chat/session room ids of the realm's two hubs (HubRoomId(realmId, kind)), stored so a room id finds its realm by an
     * indexed lookup (findByHubRoomId). Derived data: written once when the realm is created.
     */
    hubRoomIds?: string[];
    /** The `onlineUntil` value for which the sweeper already emitted HOST_OFFLINE: one notice per lapse. */
    offlineNotifiedFor?: string;
    /**
     * [2026-10-15] Players waiting for the host's approval (an invite-only realm refused them without an invite). One entry per
     * account, bounded by RealmLimits.maxJoinRequests; absent until the first request. A ban removes the account's request.
     */
    joinRequests?: RealmJoinRequest[];
    /**
     * [2026-10-16] Players the host invited by username who have not answered yet (RealmPlayerInvite). One entry per account; absent
     * until the first invite. Becoming a member (any way) and a ban both remove the account's invite in the same update.
     */
    playerInvites?: RealmPlayerInvite[];
}

/** A member's current realm context (section 2.2), as stored. */
export interface RealmPresenceRecord {
    accountId: string;
    realmId: string;
    boundAt: string;
    lastSeenAt: string;
    /** Active means expiresAt > now, enforced on read; the database's TTL index only cleans up. */
    expiresAt: string;
}

/** What presenceOf answers (section 2.4). */
export interface RealmPresence {
    realmId: string;
    boundAt: string;
    lastSeenAt: string;
    expiresAt: string;
}

/** What the realms module tells the p2p module about (section 2.4); it never imports p2p. */
export type RealmEvent =
    | { type: "MEMBER_REMOVED"; realmId: string; accountId: string; reason: "KICK" | "BAN" | "LEAVE" }
    | { type: "REALM_RELEASED"; realmId: string; hostAccountId: string }
    | { type: "HOST_OFFLINE"; realmId: string; hostAccountId: string };

export interface RealmInviteRecord {
    /** Unambiguous crypto-random code (realmRules.GenerateInviteCode). */
    code: string;
    realmId: string;
    createdBy: string;
    createdAt: string;
    expiresAt: string;
    maxUses: number;
    uses: number;
    revokedAt?: string;
}
