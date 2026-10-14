/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { P2PHostCapabilityScope } from "../persistence/contracts/P2PHuntRepository";
import type { RealmHubKind } from "../persistence/contracts/RealmHubRepository";

// [2026-10-13 realms S1] The launch manifests of a realm's hubs (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section
// 4.1). A hunt's manifest comes from the local hunt tables (src/p2p/huntManifest; DeployServer only with
// MYSTICPARADOX_HUNT_MANIFEST_SOURCE=director) [2026-10-14 M1]; a hub's never changes, so it is
// constant here and no Director is involved. The values are the ones the dedicated Director passes for its persistent hubs
// (ParadoxDirector controllers/gameservers.ts RAMSGATE_MAP_PATH / TRAINING_DOJO_MAP_PATH, hub layout "-" <port> <map>
// NO_BEHEMOTH NO_MM_HUNTID NO_EXPECTED_PLAYERS ...), and the hunt ids the client asks for.

export interface RealmHubManifest {
    hubKind: RealmHubKind;
    /** The hunt id of the persistent hub as the client knows it; also the admission ticket's huntDefinitionId. */
    huntDefinitionId: string;
    /** The game mode the client's request for this hub carries. */
    gameMode: "CITY" | "SHARED";
    mapPath: string;
    matchmakerHuntId: "NO_MM_HUNTID";
    behemothPath: "NO_BEHEMOTH";
    expectedPlayerString: "NO_EXPECTED_PLAYERS";
    /** A hub produces no hunt evidence and never completes; its writes follow the hub rules (security/hubAuthorization.ts). */
    guardCompletionMode: "NO_COMPLETION";
}

export const REALM_HUB_MANIFESTS: Readonly<Record<RealmHubKind, RealmHubManifest>> = Object.freeze({
    RAMSGATE: Object.freeze({
        hubKind: "RAMSGATE",
        huntDefinitionId: "ShatteredIsles_ReturnToRamsgate",
        gameMode: "CITY",
        mapPath: "/Game/Maps/ramsgate/ramsgate_01_persistent",
        matchmakerHuntId: "NO_MM_HUNTID",
        behemothPath: "NO_BEHEMOTH",
        expectedPlayerString: "NO_EXPECTED_PLAYERS",
        guardCompletionMode: "NO_COMPLETION"
    } as const),
    TRAINING: Object.freeze({
        hubKind: "TRAINING",
        huntDefinitionId: "ShatteredIsles_TrainingDojo",
        gameMode: "SHARED",
        mapPath: "/Game/Maps/islands/dojo/training_dojo_persistent",
        matchmakerHuntId: "NO_MM_HUNTID",
        behemothPath: "NO_BEHEMOTH",
        expectedPlayerString: "NO_EXPECTED_PLAYERS",
        guardCompletionMode: "NO_COMPLETION"
    } as const)
});

/**
 * What a hub host's capability may do: report ready, keep the lease, report admitted peers, run the game server's player
 * requests, and abort. No EVENTS_WRITE and no COMPLETE_REQUEST: a hub produces no hunt evidence and has no completion.
 */
export const HUB_CAPABILITY_SCOPES: readonly P2PHostCapabilityScope[] =
    Object.freeze(["HOST_READY", "LEASE_HEARTBEAT", "PEER_ADMITTED", "GAME_SERVER_RUNTIME", "ABORT"] as const);

/** Players a hub takes when the host does not say (the host included). */
export const DEFAULT_HUB_MAX_PLAYERS = 16;
/** The runtime's HubMaxPlayers ceiling. */
export const MAXIMUM_HUB_MAX_PLAYERS = 64;
/** A hub session record lives at most this long; the host's capability (24 h by default) ends sooner. */
export const HUB_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a created hub waits for its host's launcher to bootstrap it. */
export const HUB_OFFER_LIFETIME_MS = 2 * 60 * 1000;
