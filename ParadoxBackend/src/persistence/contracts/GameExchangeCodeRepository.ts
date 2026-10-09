/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Single-use launcher-to-game handoff codes (spec section "Game session
// handoff"). `/launcher/v1/game-sessions` (controllers/launcherAuth.ts) creates
// rows here after validating buildChangelist/executableSha256; routes/eos.ts's
// `AUTH_MODE=LAUNCHER` branch consumes them via consumeByCodeHash.
export interface GameExchangeCodeRecord {
    codeHash: string;
    userId: string;
    launcherSessionId: string;
    buildChangelist: number;
    /** The client executable hash validated at issuance time — recorded here so
     *  a consumed code carries proof of what was actually checked, not just trust
     *  in the moment it was issued. */
    executableSha256: string;
    /** Runtime channel and exact signed-manifest DLL hash validated at issuance. */
    runtimeChannel: "stable" | "beta" | "dev";
    runtimeSha256: string;
    /** Exact signed release and canonical digest of all five installed runtime artifacts. */
    runtimeManifestVersion: string;
    runtimeArtifactSetSha256: string;
    createdAt: string;
    expiresAt: string;
    consumedAt?: string;
}

export interface GameExchangeCodeRepository {
    create(code: GameExchangeCodeRecord): Promise<void>;

    /** Atomic find-and-consume: succeeds at most once per code, and only before
     *  expiry. Returns undefined if the code is unknown, already consumed, or expired. */
    consumeByCodeHash(codeHash: string): Promise<GameExchangeCodeRecord | undefined>;
    revokeUnusedForUser(userId: string): Promise<void>;
}
