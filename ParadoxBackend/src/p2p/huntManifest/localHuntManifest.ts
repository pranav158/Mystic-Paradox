/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] The Metagame's own hunt manifest lookup. A player-hosted (P2P or realm) hunt used to ask DeployServer for
// its launch manifest; now the Metagame resolves it from the hunt tables with the resolver DeployServer uses
// (shared/hunt-manifest), so a VPS needs no DeployServer for those hunts. MYSTICPARADOX_HUNT_MANIFEST_SOURCE=director keeps
// the old request for comparison. Only P2P code imports this folder (src/p2p), so the public build does not carry it.

import path from "node:path";

import { CreateHuntResolver, LoadHuntTables, ParseTrialsRotationMinutes } from "../../../../shared/hunt-manifest";
import type { HuntResolver } from "../../../../shared/hunt-manifest";
import { ResolvePlayerHostedManifest } from "../../../../shared/hunt-manifest/p2p/completionMode";
import { logger } from "../../logger";

export const HUNT_MANIFEST_SOURCE_ENV = "MYSTICPARADOX_HUNT_MANIFEST_SOURCE";
export const HUNT_DATA_DIR_ENV = "PARADOX_HUNT_DATA_DIR";

export type HuntManifestSource = "local" | "director";

/** local (the default) or director. Any other value is refused: a typo must not quietly pick a source. */
export function ReadHuntManifestSource(environment: NodeJS.ProcessEnv = process.env): HuntManifestSource {
    const Raw = (environment[HUNT_MANIFEST_SOURCE_ENV] ?? "").trim().toLowerCase();
    if (Raw === "" || Raw === "local") return "local";
    if (Raw === "director") return "director";
    throw new Error(`${HUNT_MANIFEST_SOURCE_ENV} must be 'local' or 'director' (got '${Raw}')`);
}

/**
 * The folder of the hunt tables: PARADOX_HUNT_DATA_DIR when set, else ParadoxDirector/game-data in this checkout (the
 * tables stay with DeployServer's generator; see ParadoxDirector/game-data/README.md).
 */
export function HuntDataDir(environment: NodeJS.ProcessEnv = process.env): string {
    const Override = environment[HUNT_DATA_DIR_ENV]?.trim();
    if (Override) return path.resolve(Override);
    // From build/p2p/huntManifest (or src/p2p/huntManifest) up to ParadoxBackend's parent: the checkout root.
    return path.resolve(__dirname, "..", "..", "..", "..", "ParadoxDirector", "game-data");
}

let CachedResolver: { key: string; resolver: HuntResolver } | undefined;
// Requests name hunt ids the client chose, so the set of ids seen is bounded: past this many, no further ids are recorded or logged.
const MAX_RECORDED_MISSING_HUNTS = 200;
const SeenMissingHunts = new Set<string>();

/**
 * The resolver over the tables in HuntDataDir, built on first use and rebuilt only when the folder or the rotation setting
 * changes. Throws when a table is missing (the startup line reports that).
 */
export function LocalHuntResolver(environment: NodeJS.ProcessEnv = process.env): HuntResolver {
    const DataDir = HuntDataDir(environment);
    const RawRotation = environment.TRIALS_ROTATION_MINUTES ?? "";
    const Key = `${DataDir}|${RawRotation}`;
    if (CachedResolver?.key !== Key) {
        CachedResolver = {
            key: Key,
            resolver: CreateHuntResolver({
                tables: LoadHuntTables(DataDir),
                log: logger,
                trialsRotationMinutes: ParseTrialsRotationMinutes(environment.TRIALS_ROTATION_MINUTES, logger),
                onMissingHunt: (PlayerHuntId) => {
                    // The client retries a hunt it cannot start, so the first sighting is the line that matters.
                    if (SeenMissingHunts.has(PlayerHuntId) || SeenMissingHunts.size >= MAX_RECORDED_MISSING_HUNTS) return;
                    SeenMissingHunts.add(PlayerHuntId);
                    logger.error(`[HuntManifest] '${PlayerHuntId}' is not in player_hunts_table; that hunt cannot start (re-export the tables, see ParadoxDirector/game-data/README.md)`);
                }
            })
        };
    }
    return CachedResolver.resolver;
}

/** A player-hosted hunt's launch manifest from the local tables: the shape DeployServer's route returns. */
export function ResolveLocalHuntLaunchManifest(HuntId: string, ExpectedPlayers: string[], environment: NodeJS.ProcessEnv = process.env) {
    return ResolvePlayerHostedManifest(LocalHuntResolver(environment), HuntId, ExpectedPlayers);
}

export interface HuntManifestStartupSummary {
    source: HuntManifestSource;
    dataDir?: string;
    playerHuntRows?: number;
    resolvableHunts?: number;
}

/**
 * One startup line: which source resolves player-hosted hunt manifests and, for the local source, how many player hunt rows
 * resolve. An invalid source setting throws (startup stops); unreadable tables are logged as an error and the process goes on.
 */
export function LogHuntManifestSource(environment: NodeJS.ProcessEnv = process.env): HuntManifestStartupSummary {
    const Source = ReadHuntManifestSource(environment);
    if (Source === "director") {
        logger.info(`[HuntManifest] source=director: player-hosted hunt manifests come from DeployServer (${HUNT_MANIFEST_SOURCE_ENV}=director)`);
        return { source: "director" };
    }
    const DataDir = HuntDataDir(environment);
    try {
        const Resolver = LocalHuntResolver(environment);
        const PlayerHuntRows = Object.keys(Resolver.tables.playerRows).length;
        const ResolvableHunts = Resolver.CountResolvablePlayerHunts();
        logger.info(`[HuntManifest] source=local tables=${DataDir} resolvableHunts=${ResolvableHunts}/${PlayerHuntRows} (no DeployServer request)`);
        return { source: "local", dataDir: DataDir, playerHuntRows: PlayerHuntRows, resolvableHunts: ResolvableHunts };
    } catch (error) {
        logger.error(`[HuntManifest] source=local but the hunt tables did not load from ${DataDir}: ${error instanceof Error ? error.message : String(error)}`);
        return { source: "local", dataDir: DataDir, playerHuntRows: 0, resolvableHunts: 0 };
    }
}
