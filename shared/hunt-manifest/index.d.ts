/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] Types for index.js (the hunt manifest lookup). Keep in step with index.js; the Director and Metagame
// tests exercise every export. The player-hosted completion types live with their P2P module (p2p/completionMode.d.ts).

export interface HuntLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export interface MatchmakerSource {
    name: string;
    rows: Record<string, any>;
}

/** The hunt tables as LoadHuntTables reads them. matchmakerRows is the main table (also matchmakerSources[0].rows). */
export interface HuntTables {
    dataDir?: string;
    playerRows: Record<string, any>;
    matchmakerRows: Record<string, any>;
    matchmakerSources: MatchmakerSource[];
}

export interface ExpectedPlayer {
    playerUid: string;
    playerHuntId: string;
}

/** The exact server arguments of a player hunt (what the dedicated route passes to StartServer). */
export interface HuntManifest {
    huntId: string;
    matchmakerHuntId: string;
    mapPath: string;
    behemothPath: string;
    expectedPlayerString: string;
}

export interface HuntResolverOptions {
    tables: HuntTables;
    log?: HuntLogger;
    trialsRotationMinutes?: number;
    now?: () => number;
    randomInt?: (min: number, max: number) => number;
    onMissingHunt?: (playerHuntId: string) => void;
}

export interface HuntResolver {
    readonly tables: HuntTables;
    readonly trialsRotationMinutes: number;
    FindMatchmakerRow(matchmakerHuntId: string): Record<string, any> | undefined;
    ResolveTagRoutedMatchmakerHuntIds(playerHuntId: string, row: Record<string, any> | undefined): string[];
    MatchmakerHuntIdFor(playerHuntId: string): string;
    BehemothPathFor(matchmakerHuntId: string): string | undefined;
    MapPathFor(matchmakerHuntId: string): string;
    ResolveManifest(huntId: string, expectedPlayers: string[]): HuntManifest;
    CountResolvablePlayerHunts(): number;
}

export const HUNT_TABLE_FILES: {
    readonly player: string;
    readonly matchmakerSources: ReadonlyArray<{ readonly name: string; readonly file: string }>;
};
export const DEFAULT_TRIALS_ROTATION_MINUTES: number;
export const TRIALS_ROTATION_ROW_COUNT: number;

/** Reads every hunt table from dataDir; throws when one is missing or is not a DataTable export. */
export function LoadHuntTables(dataDir: string): HuntTables;
export function CreateHuntResolver(options: HuntResolverOptions): HuntResolver;
export function ParseTrialsRotationMinutes(value: string | undefined, log?: HuntLogger): number;
export function GetCurrentTrialsWeek(nowMs: number, rotationMinutes?: number): string;
export function TransformExpectedPlayerArgs(expectedPlayers: ExpectedPlayer[]): string;
export function EvaluateTagQuery(query: any, rowTags: string[]): boolean;
