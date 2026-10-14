/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14] Gauntlet is not enabled or tested yet (owner decision). A request for a Gauntlet hunt is cancelled with
// GAUNTLET_DISABLED before any route sees it: a realm's hunt, a player-hosted hunt or a dedicated server. MYSTICPARADOX_GAUNTLET=on
// lifts the refusal; the switch is read on every request. Gauntlet leaderboard and information GET routes are not refused.
// Core code: it must not import the P2P module (the public build has none), so the shared matchmaker and the P2P routes both use it.

export const GAUNTLET_DISABLED_REASON = "GAUNTLET_DISABLED";

/** MYSTICPARADOX_GAUNTLET=on enables Gauntlet matchmaking. Any other value, including unset, keeps it refused. */
export function GauntletMatchmakingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    return (environment.MYSTICPARADOX_GAUNTLET ?? "").trim().toLowerCase() === "on";
}

/**
 * A Gauntlet hunt. Every Gauntlet hunt id in the 1.14.7 hunt tables (ParadoxDirector/game-data: CR19_PlayerHunt_Gauntlet and
 * CR19_MatchmakerHunt_Gauntlet) contains "Gauntlet", and no other hunt id does.
 */
export function IsGauntletHuntId(huntId: string | undefined): boolean {
    return typeof huntId === "string" && /gauntlet/i.test(huntId);
}

/** True when a request for this hunt is cancelled with GAUNTLET_DISABLED. */
export function RefusesGauntletRequest(huntId: string | undefined, environment: NodeJS.ProcessEnv = process.env): boolean {
    return IsGauntletHuntId(huntId) && !GauntletMatchmakingEnabled(environment);
}
