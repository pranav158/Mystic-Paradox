/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The names a launcher upload may use (services/launcherLogNames.ts), which the upload route, the admin reads and the retention pass
// share. Pinned here: the upload route accepts exactly these names, and the admin view can read exactly what the upload could write.
import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedLauncherLogFileName, isSafeSegment, LAUNCHER_LOG_SESSION_ID_PATTERN } from "./launcherLogNames";

test("the launcher's own file names are allowed, and the upload marker and other names are not", () => {
    for (const name of ["metadata.json", "launcher.log", "runtime-mysticparadox_dll_port0.log", "runtime-mysticparadox_dll_port8790.log"]) {
        assert.equal(isAllowedLauncherLogFileName(name), true, name);
    }
    for (const name of [".uploaded-at.json", "metadata.json.bak", "runtime-mysticparadox_dll_port.log", "runtime-other_dll_port1.log", "../launcher.log", "launcher.log/x"]) {
        assert.equal(isAllowedLauncherLogFileName(name), false, name);
    }
});

test("a path segment is letters, digits, dots, underscores and dashes, and is never a dot segment", () => {
    for (const value of ["4f6a2d1e-0000-4000-8000-000000000001", "launcher.log", "a_b-c.d"]) {
        assert.equal(isSafeSegment(value), true, value);
    }
    for (const value of ["", ".", "..", "a/b", "a\\b", "a b", "a%2Fb", "x;y"]) {
        assert.equal(isSafeSegment(value), false, JSON.stringify(value));
    }
});

test("a launcher session id is 8 to 64 hex characters and dashes", () => {
    assert.equal(LAUNCHER_LOG_SESSION_ID_PATTERN.test("7c1e4a90-2b3d-4f5e-8a6b-1c2d3e4f5a6b"), true);
    assert.equal(LAUNCHER_LOG_SESSION_ID_PATTERN.test("abcdef12"), true);
    assert.equal(LAUNCHER_LOG_SESSION_ID_PATTERN.test("abcdef1"), false, "seven characters are too few");
    assert.equal(LAUNCHER_LOG_SESSION_ID_PATTERN.test("not-a-session!"), false);
    assert.equal(LAUNCHER_LOG_SESSION_ID_PATTERN.test(`${"a".repeat(65)}`), false);
});
