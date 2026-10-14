/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] Types for manifestDigest.js (the pinned manifest digest used by the parity tests).

export const PINNED_NOW_MS: number;

/** Runs fn with Date.now and crypto.randomInt pinned, then restores them. */
export function WithPinnedClockAndRandom<T>(choice: "first" | "last", fn: () => T): T;

export function BuildManifestDump(
    playerHuntIds: string[],
    resolvePlain: (huntId: string, expectedPlayers: unknown) => unknown,
    resolveHosted: (huntId: string, expectedPlayers: unknown) => unknown
): string[];

export function DigestOf(lines: string[]): string;

export interface GoldenDigest {
    algorithm: string;
    digest: string;
    playerRows: number;
    lines: number;
}

export function ReadGoldenDigest(): GoldenDigest;
