/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ClassifyReforgeGrant, ExperienceTrackForPrestige, IsReforgeableTrack, PlanPurchaseRestore } from "./reforge";
import { GetTrackCurve, RequiredXpForRank, TrackCapXp } from "./progression";

// Uses the real game-data/progression_config.json (1.14.7 weapon curve: level 20 = 27,775 XP).
const NOW = Date.parse("2026-10-11T07:00:00.000Z");

function Row(reforge: any) {
    return {
        userId: "user-1", progressionId: "ExperienceTrack_Weapon_Axe", progress: 0, confirmedFremiumRank: 0, confirmedPremiumRank: 0,
        updateVersion: 1, createdAt: "", updatedAt: "", reforge,
    };
}

function Open(extra: any = {}) {
    return { reforgeId: "r1", status: "open", priorProgress: 31275, cap: 27775, banked: 3500, bankedRestored: 0,
        prestigeGranted: false, openedAt: new Date(NOW - 1000).toISOString(), ...extra };
}

test("weapon tracks, their prestige tracks and the level-20 cap", () => {
    assert.equal(IsReforgeableTrack("ExperienceTrack_Weapon_Axe"), true);
    assert.equal(IsReforgeableTrack("ExperienceTrack_PlayerLevel"), false);
    assert.equal(ExperienceTrackForPrestige("PrestigeTrack_Weapon_Spear"), "ExperienceTrack_Weapon_Spear");
    assert.equal(ExperienceTrackForPrestige("season43"), undefined);
    assert.equal(TrackCapXp("ExperienceTrack_Weapon_Axe"), 27775);
});

test("prestige ranks: a PrestigeTrack's rank is its progress; regular tracks stop at their top rank", () => {
    const Prestige = GetTrackCurve("PrestigeTrack_Weapon_Axe")!;
    assert.equal(RequiredXpForRank(Prestige, 0), 0);
    assert.equal(RequiredXpForRank(Prestige, 1), 1);
    assert.equal(RequiredXpForRank(Prestige, 3), 3);
    const Weapon = GetTrackCurve("ExperienceTrack_Weapon_Axe")!;
    assert.equal(RequiredXpForRank(Weapon, Weapon.maxRank), 27775);
    const Player = GetTrackCurve("MasteryTrack_PlayerLevel")!;
    assert.equal(RequiredXpForRank(Player, Player.maxRank + 1), undefined);   // no prestige block
    assert.equal(RequiredXpForRank(Player, -1), undefined);
});

test("one +1 and one banked restore per reforge; replays and duplicates are refused", () => {
    // +1 on the prestige track only with an open reforge that has not had it.
    assert.equal(ClassifyReforgeGrant("PrestigeTrack_Weapon_Axe", 1, Row(Open()) as any, NOW, "on").kind, "prestige");
    assert.equal(ClassifyReforgeGrant("PrestigeTrack_Weapon_Axe", 1, Row(Open({ prestigeGranted: true })) as any, NOW, "on").kind, "refuse");
    assert.equal(ClassifyReforgeGrant("PrestigeTrack_Weapon_Axe", 2, Row(Open()) as any, NOW, "on").kind, "refuse");
    assert.equal(ClassifyReforgeGrant("PrestigeTrack_Weapon_Axe", 1, Row(undefined) as any, NOW, "on").kind, "refuse");

    // The banked re-grant: exactly the remaining banked amount while open.
    assert.equal(ClassifyReforgeGrant("ExperienceTrack_Weapon_Axe", 3500, Row(Open()) as any, NOW, "on").kind, "restore");
    // A kill grant during the open window is an ordinary grant.
    assert.equal(ClassifyReforgeGrant("ExperienceTrack_Weapon_Axe", 98, Row(Open()) as any, NOW, "on").kind, "normal");
    // The same restore again after it was applied (a duplicate reforge RPC) is refused for a while...
    const Restored = Open({ status: "closed", bankedRestored: 3500, prestigeGranted: true });
    assert.equal(ClassifyReforgeGrant("ExperienceTrack_Weapon_Axe", 3500, Row(Restored) as any, NOW, "on").kind, "refuse");
    // ...and long after, a grant of the same size is just a grant.
    assert.equal(ClassifyReforgeGrant("ExperienceTrack_Weapon_Axe", 3500, Row({ ...Restored, openedAt: new Date(NOW - 3600_000).toISOString() }) as any, NOW, "on").kind, "normal");

    // With the feature off nothing is classified.
    assert.equal(ClassifyReforgeGrant("PrestigeTrack_Weapon_Axe", 1, Row(undefined) as any, NOW, "off").kind, "normal");
});

test("the banked restore through the purchase endpoint: only an open reforge's remaining banked amount, with a reforge-derived grant id", () => {
    const Opened = PlanPurchaseRestore("ExperienceTrack_Weapon_Axe", 3500, Row(Open()) as any, NOW);
    assert.equal(Opened.plan.kind, "restore");
    assert.equal(Opened.grantId, "reforge-r1-banked");
    assert.equal(PlanPurchaseRestore("ExperienceTrack_Weapon_Axe", 3499, Row(Open()) as any, NOW).plan.kind, "refuse");
    assert.equal(PlanPurchaseRestore("ExperienceTrack_Weapon_Axe", 3500, Row(undefined) as any, NOW).plan.kind, "refuse");
    assert.equal(PlanPurchaseRestore("ExperienceTrack_PlayerLevel", 3500, Row(Open()) as any, NOW).plan.kind, "refuse");
    // Already restored by this reforge: replay candidate (the route replays it only if the ledger holds the grant).
    const Again = PlanPurchaseRestore("ExperienceTrack_Weapon_Axe", 3500, Row(Open({ status: "closed", bankedRestored: 3500, prestigeGranted: true })) as any, NOW);
    assert.equal(Again.plan.kind, "normal");
    assert.equal(Again.grantId, "reforge-r1-banked");
});
