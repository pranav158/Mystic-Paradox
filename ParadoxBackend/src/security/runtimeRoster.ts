/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-11] A runtime authenticated by an optional module (AuthData.IsPlayerHostRuntime, src/extensions/p2p.ts) is
// neither a player nor the central gameserver. It acts for the accounts of one session only, which its authentication
// lists in AuthData.RuntimeRosterAccountIds. Routes that let such a runtime read per-account state (cooldowns, bounty,
// escalation) or fetch a player's UDP key restrict it to that list; a runtime without the list gets nothing.

/** The accounts a module runtime may act for; undefined when the caller is not a module runtime. */
export function RuntimeRosterOf(authData: any): ReadonlySet<string> | undefined {
    if (authData?.IsPlayerHostRuntime !== true) return undefined;
    const Listed = authData.RuntimeRosterAccountIds;
    return new Set(Array.isArray(Listed) ? Listed.filter((Id: unknown): Id is string => typeof Id === "string" && Id.length > 0) : []);
}

/** True when a module runtime may act for `targetUserId` (fails closed without a roster). */
export function IsRuntimeRosterTarget(authData: any, targetUserId: string): boolean {
    return RuntimeRosterOf(authData)?.has(targetUserId) === true;
}
