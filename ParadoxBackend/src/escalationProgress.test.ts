/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    DefaultEscalationProgress,
    IsAuthorizedEscalationReader,
    IsAuthorizedEscalationWriter,
    MergeEscalationProgress,
    RecordToEscalationPayload
} from "./escalationProgress";

const USER = "player-1";
const SEASON = "ESC_SEASON_6";
const NOW = "2026-07-29T00:00:00.000Z";

test("escalation writes are gameserver-authoritative and same-account for ordinary players", () => {
    assert.equal(IsAuthorizedEscalationWriter({ IsGameserver: true }, "player-2"), true);
    assert.equal(IsAuthorizedEscalationWriter({ userId: "player-1" }, "player-1"), true);
    assert.equal(IsAuthorizedEscalationWriter({ userId: "player-1" }, "player-2"), false);
    assert.equal(IsAuthorizedEscalationWriter({ IsPlayerHostRuntime: true, userId: "player-1" }, "player-1"), false);
    assert.equal(IsAuthorizedEscalationWriter({}, "player-1"), false);
});

test("escalation reads are gameserver-authoritative or same-account", () => {
    assert.equal(IsAuthorizedEscalationReader({ IsGameserver: true }, "player-2"), true);
    assert.equal(IsAuthorizedEscalationReader({ userId: "player-1" }, "player-1"), true);
    assert.equal(IsAuthorizedEscalationReader({ userId: "player-1" }, "player-2"), false);
    assert.equal(IsAuthorizedEscalationReader({ IsPlayerHostRuntime: true, userId: "player-1" }, "player-2"), false);
});

test("new escalation state starts at the wire-compatible zero baseline", () => {
    assert.deepEqual(DefaultEscalationProgress(), {
        escalation_level: 0,
        next_level_xp: 0,
        talents_progress: [],
        unlock_progress: [],
        update_version: 0
    });
});

test("level, XP, talents, and unlocks round-trip into a durable record", () => {
    const Saved = MergeEscalationProgress(USER, SEASON, undefined, {
        escalation_level: 7,
        next_level_xp: 545,
        talents_progress: [{ talent_id: "Talent_MoveSpeed", talent_rank: 1 }],
        unlock_progress: [{ unlock_id: "EscalationReward05", is_unlocked: true, is_collected: false }],
        update_version: 99
    }, NOW);

    assert.deepEqual(RecordToEscalationPayload(Saved), {
        escalation_level: 7,
        next_level_xp: 545,
        talents_progress: [{ talent_id: "Talent_MoveSpeed", talent_rank: 1 }],
        unlock_progress: [{ unlock_id: "EscalationReward05", is_unlocked: true, is_collected: false }],
        update_version: 1
    });
    assert.equal(Saved.createdAt, NOW);
    assert.equal(Saved.updatedAt, NOW);
});

test("partial writes retain fields the game server omitted", () => {
    const First = MergeEscalationProgress(USER, SEASON, undefined, {
        escalation_level: 2,
        next_level_xp: 400,
        talents_progress: [{ talent_id: "Talent_A", talent_rank: 1 }],
        unlock_progress: [{ unlock_id: "Reward_A", is_unlocked: true }]
    }, NOW);
    const Second = MergeEscalationProgress(USER, SEASON, First, {
        next_level_xp: 545
    }, "2026-07-29T00:01:00.000Z");

    assert.equal(Second.escalationLevel, 2);
    assert.equal(Second.nextLevelXp, 545);
    assert.deepEqual(Second.talentsProgress, First.talentsProgress);
    assert.deepEqual(Second.unlockProgress, First.unlockProgress);
    assert.equal(Second.updateVersion, 2);
    assert.equal(Second.createdAt, NOW);
});

test("a stale hunt cannot lower a level already persisted by another server", () => {
    const LevelEight = MergeEscalationProgress(USER, SEASON, undefined, {
        escalation_level: 8,
        next_level_xp: 120
    }, NOW);
    const Stale = MergeEscalationProgress(USER, SEASON, LevelEight, {
        escalation_level: 1,
        next_level_xp: 20
    }, "2026-07-29T00:01:00.000Z");

    assert.equal(Stale.escalationLevel, 8);
});

test("an explicit empty talent array supports the in-game talent reset", () => {
    const WithTalent = MergeEscalationProgress(USER, SEASON, undefined, {
        escalation_level: 5,
        talents_progress: [{ talent_id: "Talent_A", talent_rank: 3 }]
    }, NOW);
    const Reset = MergeEscalationProgress(USER, SEASON, WithTalent, {
        talents_progress: []
    }, "2026-07-29T00:01:00.000Z");

    assert.deepEqual(Reset.talentsProgress, []);
    assert.equal(Reset.escalationLevel, 5);
});
