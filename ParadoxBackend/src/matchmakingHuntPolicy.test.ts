/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
    GAUNTLET_DISABLED_REASON, GauntletMatchmakingEnabled, IsGauntletHuntId, RefusesGauntletRequest
} from "./matchmakingHuntPolicy";

// [2026-10-14] Gauntlet is refused on every route until MYSTICPARADOX_GAUNTLET=on (owner decision). The helper tests are pure; the
// dedicated-route tests run the shared matchmaker with the P2P module off (MYSTICPARADOX_P2P_MODULE=off: the public build's
// dedicated-only defaults), so no database is needed. The matchmaker reads MATCHMAKING_MODE when it loads, hence the dynamic import.

const MANAGED = ["MYSTICPARADOX_GAUNTLET", "MYSTICPARADOX_P2P_MODULE", "MATCHMAKING_MODE"] as const;
const saved = new Map(MANAGED.map((name) => [name, process.env[name]]));

before(() => {
    process.env.MYSTICPARADOX_P2P_MODULE = "off";
    process.env.MATCHMAKING_MODE = "DEPLOYSERVER";
});

after(() => {
    for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

test("MYSTICPARADOX_GAUNTLET enables Gauntlet only for the literal on (case and spaces aside)", () => {
    for (const value of ["on", " ON ", "On"]) {
        assert.equal(GauntletMatchmakingEnabled({ MYSTICPARADOX_GAUNTLET: value }), true, `"${value}" enables it`);
    }
    for (const value of [undefined, "", "off", "true", "1", "yes", "onn"]) {
        assert.equal(GauntletMatchmakingEnabled({ MYSTICPARADOX_GAUNTLET: value }), false, `"${value}" keeps it refused`);
    }
});

test("Gauntlet hunt ids are the ids that contain Gauntlet; no other hunt is a Gauntlet hunt", () => {
    for (const huntId of ["CR19_PlayerHunt_Gauntlet", "CR19_MatchmakerHunt_Gauntlet", "CR19_PlayerHunt_gauntlet_Extra"]) {
        assert.equal(IsGauntletHuntId(huntId), true, huntId);
    }
    for (const huntId of ["ShatteredIsles_IslandA", "CR19_PlayerHunt_Arena_Elite", "Trials_Island_01", "ShatteredIsles_ReturnToRamsgate", undefined]) {
        assert.equal(IsGauntletHuntId(huntId), false, String(huntId));
    }
});

test("RefusesGauntletRequest refuses a Gauntlet hunt while the switch is off and allows it with the switch on", () => {
    assert.equal(GAUNTLET_DISABLED_REASON, "GAUNTLET_DISABLED");
    assert.equal(RefusesGauntletRequest("CR19_PlayerHunt_Gauntlet", {}), true);
    assert.equal(RefusesGauntletRequest("CR19_MatchmakerHunt_Gauntlet", { MYSTICPARADOX_GAUNTLET: "on" }), false);
    assert.equal(RefusesGauntletRequest("ShatteredIsles_IslandA", {}), false);
});

test("the dedicated route cancels a Gauntlet request with GAUNTLET_DISABLED for the requester and the whole party", async () => {
    const { CheckAndUpdateQueueStatus, HandlePlayerMatchmaking } = await import("./controllers/matchmaking");
    delete process.env.MYSTICPARADOX_GAUNTLET;

    assert.equal(await HandlePlayerMatchmaking("ISLAND", "", "CR19_PlayerHunt_Gauntlet", "core-solo-player"), true);
    const solo = await CheckAndUpdateQueueStatus("core-solo-player");
    assert.equal(solo?.Canceled, true);
    assert.equal(solo?.StatusReason, "GAUNTLET_DISABLED");
    assert.equal(solo?.Ready, false);
    assert.equal(solo?.HuntId, "CR19_PlayerHunt_Gauntlet");

    assert.equal(await HandlePlayerMatchmaking("ISLAND", "", "CR19_MatchmakerHunt_Gauntlet", "core-leader", "core-party",
        ["core-leader", "core-member"], 3), true);
    for (const playerId of ["core-leader", "core-member"]) {
        assert.equal((await CheckAndUpdateQueueStatus(playerId))?.StatusReason, "GAUNTLET_DISABLED", playerId);
    }
});

test("the dedicated route queues a Gauntlet request with MYSTICPARADOX_GAUNTLET=on, and other hunts are not refused by name", async () => {
    const { CheckAndUpdateQueueStatus, HandlePlayerMatchmaking } = await import("./controllers/matchmaking");
    process.env.MYSTICPARADOX_GAUNTLET = "on";
    try {
        assert.equal(await HandlePlayerMatchmaking("ISLAND", "", "CR19_PlayerHunt_Gauntlet", "core-gauntlet-on"), true);
        const queued = await CheckAndUpdateQueueStatus("core-gauntlet-on");
        assert.equal(queued?.Canceled, undefined);
        assert.equal(queued?.StatusReason, undefined);

        assert.equal(await HandlePlayerMatchmaking("ISLAND", "", "CR19_PlayerHunt_Arena_Elite", "core-arena"), true);
        assert.equal((await CheckAndUpdateQueueStatus("core-arena"))?.Canceled, undefined);
    } finally {
        delete process.env.MYSTICPARADOX_GAUNTLET;
    }
});
