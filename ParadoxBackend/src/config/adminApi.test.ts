/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DescribeAdminApiPolicy, ReadAdminApiPolicy } from "./adminApi";

describe("admin API switch", () => {
    test("off by default: a self-hosted backend starts with no admin surface", () => {
        assert.deepEqual(ReadAdminApiPolicy({}), { enabled: false, source: "default" });
        assert.deepEqual(ReadAdminApiPolicy({ MYSTICPARADOX_ADMIN_API: "  " }), { enabled: false, source: "default" });
        assert.match(DescribeAdminApiPolicy(ReadAdminApiPolicy({})), /admin API off .*unset, manager bridge off/);
    });

    test("a blank switch follows the manager bridge (the official VPS needs no new setting)", () => {
        assert.deepEqual(ReadAdminApiPolicy({ MYSTICPARADOX_MANAGER_ADMIN: "on" }), { enabled: true, source: "manager" });
        assert.deepEqual(ReadAdminApiPolicy({ MYSTICPARADOX_MANAGER_ADMIN: "off" }), { enabled: false, source: "default" });
    });

    test("the switch decides when set, either way", () => {
        assert.deepEqual(ReadAdminApiPolicy({ MYSTICPARADOX_ADMIN_API: "on" }), { enabled: true, source: "switch" });
        assert.deepEqual(ReadAdminApiPolicy({ MYSTICPARADOX_ADMIN_API: "ON" }), { enabled: true, source: "switch" });
        assert.deepEqual(ReadAdminApiPolicy({ MYSTICPARADOX_ADMIN_API: "off", MYSTICPARADOX_MANAGER_ADMIN: "on" }), { enabled: false, source: "switch" });
        assert.match(DescribeAdminApiPolicy(ReadAdminApiPolicy({ MYSTICPARADOX_ADMIN_API: "on" })), /admin API on \(MYSTICPARADOX_ADMIN_API=on\)/);
    });

    test("any other value stops startup", () => {
        assert.throws(() => ReadAdminApiPolicy({ MYSTICPARADOX_ADMIN_API: "yes" }), /must be on or off/);
        assert.throws(() => ReadAdminApiPolicy({ MYSTICPARADOX_ADMIN_API: "true" }), /must be on or off/);
    });
});
