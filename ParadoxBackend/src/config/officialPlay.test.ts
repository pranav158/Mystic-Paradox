/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { OFFICIAL_PLAY_UNAVAILABLE_MESSAGE, ReadOfficialPlay } from "./officialPlay";

const WITH_DEPLOYSERVER = { DEPLOYSERVER_URL: "deployserver.invalid:8080" };
const UNAVAILABLE = { available: false, message: "The official server is currently unavailable. Join or host a realm." };

test("the launcher's message when official play is off is exact (2026-10-15)", () => {
    assert.equal(OFFICIAL_PLAY_UNAVAILABLE_MESSAGE, "The official server is currently unavailable. Join or host a realm.");
});

test("the default is on with a DeployServer and off without one (2026-10-15)", () => {
    assert.deepEqual(ReadOfficialPlay({ ...WITH_DEPLOYSERVER }), { available: true });
    assert.deepEqual(ReadOfficialPlay({}), UNAVAILABLE);
    assert.deepEqual(ReadOfficialPlay({ DEPLOYSERVER_URL: "  " }), UNAVAILABLE, "a blank DeployServer is none");
    assert.deepEqual(ReadOfficialPlay({ MYSTICPARADOX_OFFICIAL_PLAY: "" }), UNAVAILABLE, "a blank switch is the default");
    assert.deepEqual(ReadOfficialPlay({ MYSTICPARADOX_OFFICIAL_PLAY: "   ", ...WITH_DEPLOYSERVER }), { available: true });
});

test("on and off are read case-insensitively and trimmed, and override the default", () => {
    assert.deepEqual(ReadOfficialPlay({ MYSTICPARADOX_OFFICIAL_PLAY: "on" }), { available: true }, "on without a DeployServer");
    assert.deepEqual(ReadOfficialPlay({ MYSTICPARADOX_OFFICIAL_PLAY: " ON " }), { available: true });
    assert.deepEqual(ReadOfficialPlay({ ...WITH_DEPLOYSERVER, MYSTICPARADOX_OFFICIAL_PLAY: "off" }), UNAVAILABLE, "off with a DeployServer");
    assert.deepEqual(ReadOfficialPlay({ ...WITH_DEPLOYSERVER, MYSTICPARADOX_OFFICIAL_PLAY: "Off" }), UNAVAILABLE);
});

test("any other value fails closed to off, whatever the DeployServer (2026-10-15)", () => {
    for (const value of ["1", "0", "yes", "true", "disabled", "onn", "of"]) {
        assert.deepEqual(ReadOfficialPlay({ ...WITH_DEPLOYSERVER, MYSTICPARADOX_OFFICIAL_PLAY: value }), UNAVAILABLE, value);
    }
});

test("the reader takes the process environment by default", () => {
    const saved = { switch: process.env.MYSTICPARADOX_OFFICIAL_PLAY, deploy: process.env.DEPLOYSERVER_URL };
    try {
        delete process.env.MYSTICPARADOX_OFFICIAL_PLAY;
        delete process.env.DEPLOYSERVER_URL;
        assert.deepEqual(ReadOfficialPlay(), UNAVAILABLE);
        process.env.MYSTICPARADOX_OFFICIAL_PLAY = "on";
        assert.deepEqual(ReadOfficialPlay(), { available: true });
    } finally {
        if (saved.switch === undefined) delete process.env.MYSTICPARADOX_OFFICIAL_PLAY;
        else process.env.MYSTICPARADOX_OFFICIAL_PLAY = saved.switch;
        if (saved.deploy === undefined) delete process.env.DEPLOYSERVER_URL;
        else process.env.DEPLOYSERVER_URL = saved.deploy;
    }
});
