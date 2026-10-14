/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { HuntResolver } from "../controllers/gameservers";
import { CompletionModeFor, ResolvePlayerHostedManifest } from "../../../shared/hunt-manifest/p2p/completionMode";

/**
 * When Hunt Guard may close a player-hosted session:
 *   FIRST_DEFEAT   the first Behemoth defeat ends the hunt (single-Behemoth pursuits, Trials).
 *   END_OF_HUNT    only the mode's EndOfHuntStarted signal ends it (Hunting Grounds, Escalations, Gauntlet,
 *                  events, story missions).
 *   NO_COMPLETION  the session never completes and never produces rewards (the Training Grounds). It ends only
 *                  by a clean end (the party leaves, the host shuts down) or an abort.
 */
export type GuardCompletionMode = "FIRST_DEFEAT" | "END_OF_HUNT" | "NO_COMPLETION";

// [2026-10-14 M1] The completion rule lives in shared/hunt-manifest/p2p (the Metagame freezes the same mode), with the dated
// notes that justify each rule. This file keeps the Director's route names.

/** The Hunt Guard completion mode of a matchmaker row. */
export function GetGuardCompletionMode(MatchmakerHuntId: string, BehemothPath: string | undefined): GuardCompletionMode {
    return CompletionModeFor(HuntResolver, MatchmakerHuntId, BehemothPath);
}

/** The shared launch manifest plus the Hunt Guard finality rule frozen into a player-hosted hunt. */
export function ResolvePlayerHostedLaunchManifest(HuntId: string, ExpectedPlayers: string[]) {
    return ResolvePlayerHostedManifest(HuntResolver, HuntId, ExpectedPlayers);
}
