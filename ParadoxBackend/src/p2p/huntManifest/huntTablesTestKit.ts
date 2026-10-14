/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] Test support: the seven hunt tables with one synthetic hunt, in a new temporary folder. No game data.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HUNT_TABLE_FILES } from "../../../../shared/hunt-manifest";

/** The synthetic player hunt the tables resolve (a plain hunt with no fixed Behemoth). */
export const SYNTHETIC_HUNT_ID = "ShatteredIsles_IslandA";

/** Writes the seven tables into a new temporary folder; the caller removes it with fs.rmSync. */
export function WriteSyntheticHuntTables(): string {
    const Dir = fs.mkdtempSync(path.join(os.tmpdir(), "paradox-hunt-tables-"));
    const Table = (Rows: Record<string, unknown>) => JSON.stringify([{ Type: "DataTable", Rows }]);
    const MainRows = {
        Adventure_IslandA_Synthetic: {
            MapList: [{ MapAssetName: "/Game/Maps/synthetic/island_a.island_a" }],
            SpecificBehemoth: { BehemothAsset: { AssetPathName: "None" } },
            GameModeOverride: "",
            HuntTags: []
        }
    };
    const PlayerRows = { [SYNTHETIC_HUNT_ID]: { MatchmakerHuntIDs: [{ RowName: "Adventure_IslandA_Synthetic" }] } };
    fs.writeFileSync(path.join(Dir, HUNT_TABLE_FILES.player), Table(PlayerRows), "utf8");
    for (const { name, file } of HUNT_TABLE_FILES.matchmakerSources) {
        fs.writeFileSync(path.join(Dir, file), Table(name === "matchmaker_hunts_table" ? MainRows : {}), "utf8");
    }
    return Dir;
}

/** Sets environment variables for fn and restores the previous values afterwards (undefined removes a variable). */
export async function WithEnvironment<T>(variables: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const Saved = new Map(Object.keys(variables).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(variables)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [name, value] of Saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}
