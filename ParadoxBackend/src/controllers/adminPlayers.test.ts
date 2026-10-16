/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ParsePlayerIds } from "./admin";

// [2026-10-15] The dashboard looks up the names of players who are not online (/admin/v1/players?ids=...).
test("player ids from ?ids= are trimmed, de-duplicated, checked and capped at 100", () => {
    assert.equal(ParsePlayerIds(undefined), undefined);
    assert.equal(ParsePlayerIds(""), undefined);
    assert.equal(ParsePlayerIds(["a"]), undefined);
    assert.deepEqual(ParsePlayerIds(" 0b7c3a52-1f4e-4d2a-9c61-5e8f2d7a4b10 , c0ffee01,0b7c3a52-1f4e-4d2a-9c61-5e8f2d7a4b10"),
        ["0b7c3a52-1f4e-4d2a-9c61-5e8f2d7a4b10", "c0ffee01"]);
    assert.deepEqual(ParsePlayerIds("ok,../x,a b,$where,ok_2"), ["ok", "ok_2"]);
    const Many = Array.from({ length: 150 }, (_, index) => `id-${index}`).join(",");
    assert.equal(ParsePlayerIds(Many)?.length, 100);
});
