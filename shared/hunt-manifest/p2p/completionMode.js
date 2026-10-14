/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

"use strict";

// [2026-10-14 M1] The Hunt Guard completion mode of a player-hosted hunt, moved from the Director's src/p2p/huntLaunchManifest.ts
// so the Metagame's local manifest freezes the same mode. This folder is P2P code: the public export leaves every p2p/ folder
// out, so nothing here reaches the public build. Both components call these functions on the shared resolver (../index.js).

/** The dojo row names a fixed Behemoth, so without this check it would be FIRST_DEFEAT. */
function IsTrainingRow(MatchmakerHuntId, GameModeOverride) {
    return /trainingdojo/i.test(MatchmakerHuntId) || /trainingground/i.test(GameModeOverride);
}

/** The Hunt Guard completion mode of a matchmaker row (resolver: a CreateHuntResolver result). */
function CompletionModeFor(resolver, MatchmakerHuntId, BehemothPath) {
    const MatchmakerHuntObject = resolver.FindMatchmakerRow(MatchmakerHuntId);
    if (MatchmakerHuntObject == undefined) {
        throw new Error(`matchmaker_hunts_table has no row for MatchmakerHuntId '${MatchmakerHuntId}'`);
    }
    const GameModeOverride = String(MatchmakerHuntObject.GameModeOverride ?? "");
    if (IsTrainingRow(MatchmakerHuntId, GameModeOverride)) return "NO_COMPLETION";
    // Hunting Grounds have no fixed Behemoth. Escalation, Gauntlet, event and story-mission controllers can
    // advance through several encounters. In both cases a kill is encounter evidence, not hunt finality; only the
    // mode's EndOfHuntStarted signal may close Guard.
    // [2026-10-11] Story missions named explicitly: the 10 BPGM_ArchonStoryMissions rows (11A story missions, Linnea,
    // Dark Harvest, Ramsgiving, Anniversary, the snowball test) are multi-objective missions. They resolved to
    // END_OF_HUNT only because none names a SpecificBehemoth today; a row that did would have become FIRST_DEFEAT.
    const ModeMaterial = `${MatchmakerHuntId}\n${GameModeOverride}\n${JSON.stringify(MatchmakerHuntObject.GameModeSpecificData ?? {})}`;
    return BehemothPath == undefined || /escalation|gauntlet|archonevent|eventgamemode|storymission/i.test(ModeMaterial)
        ? "END_OF_HUNT"
        : "FIRST_DEFEAT";
}

/** The manifest of a player-hosted hunt: the resolver's manifest plus the completion mode frozen into it. */
function ResolvePlayerHostedManifest(resolver, HuntId, ExpectedPlayers) {
    const Manifest = resolver.ResolveManifest(HuntId, ExpectedPlayers);
    const GuardCompletionMode = CompletionModeFor(resolver, Manifest.matchmakerHuntId,
        Manifest.behemothPath === "NO_BEHEMOTH" ? undefined : Manifest.behemothPath);
    // [2026-10-11] A hosted Training Grounds launches like the dedicated Training hub (StartServer passes only the
    // map): the dojo map places its own dummies, so no MonsterClass is forced on it.
    if (GuardCompletionMode === "NO_COMPLETION") return { ...Manifest, behemothPath: "NO_BEHEMOTH", guardCompletionMode: GuardCompletionMode };
    return { ...Manifest, guardCompletionMode: GuardCompletionMode };
}

module.exports = { CompletionModeFor, ResolvePlayerHostedManifest };
