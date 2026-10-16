/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-13 realms S2] The realms module is off unless MYSTICPARADOX_REALMS_MODULE is on, true or 1, so nothing
// about it (routes, collections, indexes) exists on a server that has not asked for it.

export function IsRealmsModuleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return /^(on|true|1)$/i.test((env.MYSTICPARADOX_REALMS_MODULE ?? "").trim());
}

export interface RealmLimits {
    /**
     * Technical backstops, not policy: the plan sets no realm-size cap ("the host knows what their PC can carry"), but a
     * realm is one MongoDB document with its members and bans embedded, so both lists are bounded well above any
     * real friend group. MYSTICPARADOX_REALMS_MAX_MEMBERS / _MAX_BANS change them.
     */
    maxMembers: number;
    maxBans: number;
    /** Invites a host may have open (unexpired, unrevoked, unused up) at once. */
    maxActiveInvites: number;
    /**
     * [2026-10-15] Join requests a realm holds at once. A player who asks when the list is full is refused (REALM_REQUESTS_FULL)
     * instead of pushing out someone who asked earlier; the host clears the list by approving or denying. Not configurable: a
     * realm's request list is a small, visible queue, not a backstop like the two above.
     */
    maxJoinRequests: number;
    /** [2026-10-16] Unanswered player invites a realm holds at once (REALM_PLAYER_INVITES_FULL beyond it). Not configurable. */
    maxPlayerInvites: number;
}

export const DEFAULT_REALM_LIMITS: RealmLimits = Object.freeze({
    maxMembers: 1000,
    maxBans: 1000,
    maxActiveInvites: 25,
    maxJoinRequests: 50,
    maxPlayerInvites: 50
});

function ReadBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || !/^\d{1,6}$/.test(raw.trim())) return fallback;
    const value = Number(raw.trim());
    return value >= min && value <= max ? value : fallback;
}

export function ReadRealmLimits(env: NodeJS.ProcessEnv = process.env): RealmLimits {
    return {
        maxMembers: ReadBoundedInt(env.MYSTICPARADOX_REALMS_MAX_MEMBERS, DEFAULT_REALM_LIMITS.maxMembers, 2, 5000),
        maxBans: ReadBoundedInt(env.MYSTICPARADOX_REALMS_MAX_BANS, DEFAULT_REALM_LIMITS.maxBans, 1, 5000),
        maxActiveInvites: DEFAULT_REALM_LIMITS.maxActiveInvites,
        maxJoinRequests: DEFAULT_REALM_LIMITS.maxJoinRequests,
        maxPlayerInvites: DEFAULT_REALM_LIMITS.maxPlayerInvites
    };
}
