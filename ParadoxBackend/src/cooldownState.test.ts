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
    CooldownList,
    CooldownSaveValidationError,
    CooldownStatePayload,
    IsAuthorizedCooldownReader,
    IsAuthorizedCooldownWriter,
    MergeCooldownState
} from "./cooldownState";

const USER = "player-1";

test("cooldown writes are dedicated-server only; reads are server or same account", () => {
    assert.equal(IsAuthorizedCooldownWriter({ IsGameserver: true }), true);
    assert.equal(IsAuthorizedCooldownWriter({ userId: USER }), false);
    assert.equal(IsAuthorizedCooldownWriter({ IsPlayerHostRuntime: true }), false);
    assert.equal(IsAuthorizedCooldownReader({ IsGameserver: true }, "player-2"), true);
    assert.equal(IsAuthorizedCooldownReader({ userId: USER }, USER), true);
    assert.equal(IsAuthorizedCooldownReader({ userId: USER }, "player-2"), false);
});

test("an account with no cooldowns is served an empty map", () => {
    assert.deepEqual(CooldownStatePayload(undefined), {});
});

test("a batch (the PUT's list shape) is stored verbatim and served back as an id -> date map", () => {
    // The ids and dates the 1.14.7 server sent on 10 Oct 14:11.
    const Record = MergeCooldownState(USER, undefined, {
        cooldowns: [
            { cooldown_id: "GRANT_PATROL_BOOST_TOKEN", cooldown_started_date: "2026-10-10T00:00:00.000Z" },
            { cooldown_id: "GRANT_DAILY_HEROICPLUS", cooldown_started_date: "2026-10-10T00:00:00.000Z" }
        ]
    }, "2026-10-10T08:41:49.822Z");
    assert.equal(Record.updateVersion, 1);
    assert.deepEqual(CooldownStatePayload(Record), {
        GRANT_PATROL_BOOST_TOKEN: "2026-10-10T00:00:00.000Z",
        GRANT_DAILY_HEROICPLUS: "2026-10-10T00:00:00.000Z"
    });
    assert.deepEqual(CooldownList(Record)[0], { cooldown_id: "GRANT_PATROL_BOOST_TOKEN", cooldown_started_date: "2026-10-10T00:00:00.000Z" });
});

test("a later batch replaces the cooldowns it names and keeps the rest", () => {
    let Record = MergeCooldownState(USER, undefined, {
        cooldowns: [
            { cooldown_id: "season43", cooldown_started_date: "2026-10-22T17:00:00.000Z" },
            { cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-09T17:00:00.000Z" }
        ]
    });
    Record = MergeCooldownState(USER, Record, { cooldowns: [{ cooldown_id: "bounty_daily", cooldown_started_date: "2026-10-10T17:00:00.000Z" }] });
    assert.deepEqual(CooldownStatePayload(Record), { season43: "2026-10-22T17:00:00.000Z", bounty_daily: "2026-10-10T17:00:00.000Z" });
    assert.equal(Record.updateVersion, 2);
});

test("an id that collides with an Object.prototype name is served as plain data", () => {
    const Record = MergeCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "__proto__", cooldown_started_date: "2026-10-10T00:00:00Z" }] });
    const Payload = CooldownStatePayload(Record);
    assert.equal(JSON.stringify(Payload), "{\"__proto__\":\"2026-10-10T00:00:00Z\"}");
});

test("a bare array body is accepted too", () => {
    const Record = MergeCooldownState(USER, undefined, [{ cooldown_id: "X", cooldown_started_date: "2026-10-10T00:00:00Z" }]);
    assert.equal(Record.entries.length, 1);
});

test("malformed cooldown saves are rejected", () => {
    assert.throws(() => MergeCooldownState(USER, undefined, {}), CooldownSaveValidationError);
    assert.throws(() => MergeCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "" , cooldown_started_date: "2026-10-10T00:00:00Z" }] }), CooldownSaveValidationError);
    assert.throws(() => MergeCooldownState(USER, undefined, { cooldowns: [{ cooldown_id: "X", cooldown_started_date: "not a date" }] }), CooldownSaveValidationError);
    assert.throws(() => MergeCooldownState(USER, undefined, { cooldowns: new Array(257).fill({ cooldown_id: "X", cooldown_started_date: "2026-10-10T00:00:00Z" }) }), CooldownSaveValidationError);
});
