/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ReadTesterChannel } from "./launcherPolicy";

// [2026-10-15] The VPS publishes only stable: a tester moved to beta found no runtime or Guard manifest and could not play.
test("testers stay on stable unless MYSTICPARADOX_TESTER_CHANNEL names another channel", () => {
    assert.equal(ReadTesterChannel({}), "stable");
    assert.equal(ReadTesterChannel({ MYSTICPARADOX_TESTER_CHANNEL: "" }), "stable");
    assert.equal(ReadTesterChannel({ MYSTICPARADOX_TESTER_CHANNEL: "beta" }), "beta");
    assert.equal(ReadTesterChannel({ MYSTICPARADOX_TESTER_CHANNEL: " DEV " }), "dev");
    assert.equal(ReadTesterChannel({ MYSTICPARADOX_TESTER_CHANNEL: "nightly" }), "stable", "an unknown channel falls back to stable");
});
