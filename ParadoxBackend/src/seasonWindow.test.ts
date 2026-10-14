/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_SEASON_ANCHOR_MS, ACTIVE_SEASON_LENGTH_MS, ActiveSeasonWindow, ActiveSeasonWindowMs, IsoUtc } from "./seasonWindow";

// [2026-10-13 realms S3 limits] The pass-window arithmetic moved out of routes/system.ts unchanged; these pin its values
// (they are what the served progression config, the weekly schedule stamps and the host cooldown limits all hang on).

test("the cycle is anchored on season27's real start (Thursday 2024-09-26 17:00 UTC) and is 84 days long", () => {
    assert.equal(new Date(ACTIVE_SEASON_ANCHOR_MS).toISOString(), "2024-09-26T17:00:00.000Z");
    assert.equal(ACTIVE_SEASON_LENGTH_MS, 84 * 24 * 60 * 60 * 1000);
    assert.equal(new Date(ACTIVE_SEASON_ANCHOR_MS).getUTCDay(), 4, "a Thursday");
});

test("the window containing now is [start, end): the roll belongs to the new window", () => {
    const Roll = Date.parse("2026-10-22T17:00:00.000Z");
    assert.deepEqual(ActiveSeasonWindowMs(Roll - 1), { startMs: Date.parse("2026-07-30T17:00:00.000Z"), endMs: Roll });
    assert.deepEqual(ActiveSeasonWindowMs(Roll), { startMs: Roll, endMs: Roll + ACTIVE_SEASON_LENGTH_MS });
    assert.deepEqual(ActiveSeasonWindowMs(Date.parse("2026-10-13T18:00:00.000Z")), { startMs: Date.parse("2026-07-30T17:00:00.000Z"), endMs: Roll });
    assert.deepEqual(ActiveSeasonWindowMs(ACTIVE_SEASON_ANCHOR_MS), { startMs: ACTIVE_SEASON_ANCHOR_MS, endMs: ACTIVE_SEASON_ANCHOR_MS + ACTIVE_SEASON_LENGTH_MS });
});

test("before the anchor the cycles continue backwards", () => {
    const Window = ActiveSeasonWindowMs(ACTIVE_SEASON_ANCHOR_MS - 1);
    assert.equal(Window.endMs, ACTIVE_SEASON_ANCHOR_MS);
    assert.equal(Window.startMs, ACTIVE_SEASON_ANCHOR_MS - ACTIVE_SEASON_LENGTH_MS);
});

test("ActiveSeasonWindow keeps the +00:00 notation the served progression config uses", () => {
    assert.deepEqual(ActiveSeasonWindow(Date.parse("2026-10-13T18:00:00.000Z")), { start: "2026-07-30T17:00:00+00:00", end: "2026-10-22T17:00:00+00:00" });
    assert.equal(IsoUtc(Date.parse("2026-10-22T17:00:00.000Z")), "2026-10-22T17:00:00+00:00");
    // The string window is the instant window, written down.
    for (const Now of ["2025-01-01T00:00:00.000Z", "2026-10-22T16:59:59.999Z", "2026-10-22T17:00:00.000Z", "2030-06-30T12:34:56.789Z"]) {
        const Ms = ActiveSeasonWindowMs(Date.parse(Now));
        const Text = ActiveSeasonWindow(Date.parse(Now));
        assert.equal(Date.parse(Text.start), Ms.startMs, Now);
        assert.equal(Date.parse(Text.end), Ms.endMs, Now);
    }
});
