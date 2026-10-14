/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M1] The Metagame's hunt manifest source: the switch, the table folder, the startup line, the local manifest
// and the DeployServer request kept for comparison. Runs on synthetic tables (no game data).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ResolveHuntLaunchManifest } from "../controllers/p2pMatchmaking";
import {
    HuntDataDir,
    HUNT_DATA_DIR_ENV,
    HUNT_MANIFEST_SOURCE_ENV,
    LogHuntManifestSource,
    ReadHuntManifestSource,
    ResolveLocalHuntLaunchManifest
} from "./localHuntManifest";
import { SYNTHETIC_HUNT_ID, WithEnvironment, WriteSyntheticHuntTables } from "./huntTablesTestKit";

test("the manifest source is local by default, director on request, and any other value is refused", () => {
    assert.equal(ReadHuntManifestSource({}), "local");
    assert.equal(ReadHuntManifestSource({ [HUNT_MANIFEST_SOURCE_ENV]: "" }), "local");
    assert.equal(ReadHuntManifestSource({ [HUNT_MANIFEST_SOURCE_ENV]: " LOCAL " }), "local");
    assert.equal(ReadHuntManifestSource({ [HUNT_MANIFEST_SOURCE_ENV]: "Director" }), "director");
    assert.throws(() => ReadHuntManifestSource({ [HUNT_MANIFEST_SOURCE_ENV]: "remote" }),
        { message: "MYSTICPARADOX_HUNT_MANIFEST_SOURCE must be 'local' or 'director' (got 'remote')" });
});

test("the hunt tables are in ParadoxDirector/game-data unless PARADOX_HUNT_DATA_DIR names another folder", () => {
    const Default = HuntDataDir({});
    assert.ok(path.isAbsolute(Default));
    assert.equal(Default, path.resolve(Default), "already absolute and normalized");
    assert.ok(Default.endsWith(path.join("ParadoxDirector", "game-data")), Default);
    assert.equal(HuntDataDir({ [HUNT_DATA_DIR_ENV]: "  /srv/paradox/hunt-tables " }), path.resolve("/srv/paradox/hunt-tables"));
    assert.equal(HuntDataDir({ [HUNT_DATA_DIR_ENV]: "   " }), Default, "a blank override is no override");
});

test("the local manifest of a player-hosted hunt comes from the tables, with the completion mode frozen in", () => {
    const Dir = WriteSyntheticHuntTables();
    try {
        const Manifest = ResolveLocalHuntLaunchManifest(SYNTHETIC_HUNT_ID, ["acc-1", "acc-2"], { [HUNT_DATA_DIR_ENV]: Dir });
        assert.deepEqual(Manifest, {
            huntId: SYNTHETIC_HUNT_ID,
            matchmakerHuntId: "Adventure_IslandA_Synthetic",
            mapPath: "/Game/Maps/synthetic/island_a",
            behemothPath: "NO_BEHEMOTH",
            expectedPlayerString: `acc-1:${SYNTHETIC_HUNT_ID},acc-2:${SYNTHETIC_HUNT_ID}`,
            guardCompletionMode: "END_OF_HUNT"
        });
        assert.throws(() => ResolveLocalHuntLaunchManifest("No_Such_Hunt", ["acc-1"], { [HUNT_DATA_DIR_ENV]: Dir }),
            { message: "player_hunts_table has no usable row for HuntId 'No_Such_Hunt' (missing row or empty MatchmakerHuntIDs)" });
        assert.throws(() => ResolveLocalHuntLaunchManifest(SYNTHETIC_HUNT_ID, [], { [HUNT_DATA_DIR_ENV]: Dir }),
            { message: "ExpectedPlayers must contain between one and four account IDs" });
    } finally {
        fs.rmSync(Dir, { recursive: true, force: true });
    }
});

test("the startup line names the source; the local source counts the hunts it resolves; a missing table is reported, not thrown", () => {
    const Dir = WriteSyntheticHuntTables();
    try {
        assert.deepEqual(LogHuntManifestSource({ [HUNT_DATA_DIR_ENV]: Dir }),
            { source: "local", dataDir: path.resolve(Dir), playerHuntRows: 1, resolvableHunts: 1 });
        assert.deepEqual(LogHuntManifestSource({ [HUNT_MANIFEST_SOURCE_ENV]: "director", [HUNT_DATA_DIR_ENV]: Dir }), { source: "director" });
        assert.throws(() => LogHuntManifestSource({ [HUNT_MANIFEST_SOURCE_ENV]: "maybe" }), /must be 'local' or 'director'/);
    } finally {
        fs.rmSync(Dir, { recursive: true, force: true });
    }
    const Empty = fs.mkdtempSync(path.join(os.tmpdir(), "paradox-hunt-tables-empty-"));
    try {
        assert.deepEqual(LogHuntManifestSource({ [HUNT_DATA_DIR_ENV]: Empty }),
            { source: "local", dataDir: path.resolve(Empty), playerHuntRows: 0, resolvableHunts: 0 });
    } finally {
        fs.rmSync(Empty, { recursive: true, force: true });
    }
});

test("the manifest request resolves locally with no DeployServer call, and goes to DeployServer only for the director source", async () => {
    const Dir = WriteSyntheticHuntTables();
    const RealFetch = globalThis.fetch;
    const Calls: string[] = [];
    const Reply = { huntId: SYNTHETIC_HUNT_ID, matchmakerHuntId: "from-director", mapPath: "/Game/Maps/x", behemothPath: "NO_BEHEMOTH", expectedPlayerString: "", guardCompletionMode: "END_OF_HUNT" };
    globalThis.fetch = (async (url: string | URL | Request) => {
        Calls.push(String(url));
        return new Response(JSON.stringify(Reply), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
        // DEPLOYSERVER_URL points at a port nothing listens on: the local source must not touch it.
        const Local = await WithEnvironment({ [HUNT_DATA_DIR_ENV]: Dir, DEPLOYSERVER_URL: "127.0.0.1:9", [HUNT_MANIFEST_SOURCE_ENV]: undefined },
            () => ResolveHuntLaunchManifest(SYNTHETIC_HUNT_ID, ["acc-1"]));
        assert.equal(Local?.matchmakerHuntId, "Adventure_IslandA_Synthetic");
        assert.deepEqual(Calls, [], "no request reached DeployServer");

        const Remote = await WithEnvironment({ [HUNT_DATA_DIR_ENV]: Dir, DEPLOYSERVER_URL: "127.0.0.1:9", [HUNT_MANIFEST_SOURCE_ENV]: "director" },
            () => ResolveHuntLaunchManifest(SYNTHETIC_HUNT_ID, ["acc-1"]));
        assert.equal(Remote?.matchmakerHuntId, "from-director");
        assert.deepEqual(Calls, ["http://127.0.0.1:9/api/matchmaker/resolve-hunt-launch-manifest"]);
    } finally {
        globalThis.fetch = RealFetch;
        fs.rmSync(Dir, { recursive: true, force: true });
    }
});
