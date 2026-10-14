/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] The Metagame's local manifests over the real hunt tables reproduce the digest the Director's resolver
// produced before the move (shared/hunt-manifest/golden-digest.json); the Director's huntManifestParity.gamedata.test.ts
// checks the same digest. Skipped when the tables are not generated (a public checkout).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { logger } from "../../logger";
import { HUNT_TABLE_FILES } from "../../../../shared/hunt-manifest";
import { BuildManifestDump, DigestOf, ReadGoldenDigest } from "../../../../shared/hunt-manifest/manifestDigest";
import { HuntDataDir, LocalHuntResolver, ResolveLocalHuntLaunchManifest } from "./localHuntManifest";

const DataDir = HuntDataDir();
const Required = [HUNT_TABLE_FILES.player, ...HUNT_TABLE_FILES.matchmakerSources.map((source) => source.file)];
const MissingTables = Required.filter((file) => !fs.existsSync(path.join(DataDir, file)));

test("the Metagame's local manifests reproduce the pinned digest of the real hunt tables", {
    skip: MissingTables.length > 0 ? `hunt tables missing in ${DataDir}: ${MissingTables.join(", ")}` : false
}, () => {
    const Golden = ReadGoldenDigest();
    const Resolver = LocalHuntResolver();
    const HuntIds = Object.keys(Resolver.tables.playerRows);
    // The run resolves about 1,400 manifests; the per-hunt tag-routing and trials lines are not wanted in the debug log.
    const SavedLevel = logger.level;
    logger.level = "silent";
    try {
        const Lines = BuildManifestDump(HuntIds,
            (huntId, expectedPlayers) => Resolver.ResolveManifest(huntId, expectedPlayers as string[]),
            (huntId, expectedPlayers) => ResolveLocalHuntLaunchManifest(huntId, expectedPlayers as string[]));
        assert.equal(HuntIds.length, Golden.playerRows, "player hunt rows");
        assert.equal(Lines.length, Golden.lines, "manifest lines");
        assert.equal(DigestOf(Lines), Golden.digest);
    } finally {
        logger.level = SavedLevel;
    }
});
