/*
 * Copyright (C) 2026 MysticFox / Pranav Karande
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */



import fs from "node:fs";
import path from "node:path";

const GAME_DATA_DIR = process.env.PARADOX_GAME_DATA_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_DIR)
    : path.resolve(__dirname, "..", "..", "game-data");

export function gameDataDir(): string {
    return GAME_DATA_DIR;
}

export function gameDataPath(fileName: string): string {
    return path.join(GAME_DATA_DIR, fileName);
}


export function loadGameData<T = any>(fileName: string): T {
    const filePath = gameDataPath(fileName);
    if (!fs.existsSync(filePath)) {
        throw new Error(
            `[game-data] Required game data file is missing: ${filePath}\n` +
            `This project does not ship game data. Generate it from your own installation ` +
            `(see docs/GENERATING_GAME_DATA.md), or copy the matching *.example.json for a smoke test.`,
        );
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;
}


export function tryLoadGameData<T = any>(fileName: string): T | undefined {
    const filePath = gameDataPath(fileName);
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;
}
