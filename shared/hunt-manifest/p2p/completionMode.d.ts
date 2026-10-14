/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] Types for completionMode.js (P2P code: see the header there).

import type { HuntManifest, HuntResolver } from "../index";

export type GuardCompletionMode = "FIRST_DEFEAT" | "END_OF_HUNT" | "NO_COMPLETION";

/** A player-hosted hunt's manifest: the same arguments plus the completion mode frozen into the hunt. */
export interface PlayerHostedHuntManifest extends HuntManifest {
    guardCompletionMode: GuardCompletionMode;
}

export function CompletionModeFor(resolver: HuntResolver, matchmakerHuntId: string, behemothPath: string | undefined): GuardCompletionMode;

export function ResolvePlayerHostedManifest(resolver: HuntResolver, huntId: string, expectedPlayers: string[]): PlayerHostedHuntManifest;
