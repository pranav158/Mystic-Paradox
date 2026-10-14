/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] Every manifest the real hunt tables produce (plain and player-hosted, every player hunt id, the unknown
// ids and the malformed expected-player lists), with the clock and the random choice pinned, must reproduce the digest the
// Director's resolver produced before the move into shared/hunt-manifest (shared/hunt-manifest/golden-digest.json). The
// Metagame's parity test (ParadoxBackend src/p2p/huntManifest) checks the same digest, so both components agree. This file is
// P2P code because the player-hosted half needs the completion rule (shared/hunt-manifest/p2p).

import assert from "node:assert/strict";
import test from "node:test";

import { logger } from "../logger";
import { HuntResolver, ResolveHuntLaunchManifest } from "../controllers/gameservers";
import { ResolvePlayerHostedLaunchManifest } from "./huntLaunchManifest";
import { BuildManifestDump, DigestOf, ReadGoldenDigest } from "../../../shared/hunt-manifest/manifestDigest";

test("the Director's manifests reproduce the pinned digest of the real hunt tables", () => {
    const Golden = ReadGoldenDigest();
    const HuntIds = Object.keys(HuntResolver.tables.playerRows);
    // The run resolves about 1,400 manifests; the per-hunt tag-routing and trials lines are not wanted in the debug log.
    const SavedLevel = logger.level;
    logger.level = "silent";
    try {
        const Lines = BuildManifestDump(HuntIds,
            (huntId, expectedPlayers) => ResolveHuntLaunchManifest(huntId, expectedPlayers as string[]),
            (huntId, expectedPlayers) => ResolvePlayerHostedLaunchManifest(huntId, expectedPlayers as string[]));
        assert.equal(HuntIds.length, Golden.playerRows, "player hunt rows");
        assert.equal(Lines.length, Golden.lines, "manifest lines");
        assert.equal(DigestOf(Lines), Golden.digest);
    } finally {
        logger.level = SavedLevel;
    }
});
