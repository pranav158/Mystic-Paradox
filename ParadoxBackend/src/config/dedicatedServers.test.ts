/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DedicatedServersConfigured } from "./dedicatedServers";

test("a DeployServer is configured only when DEPLOYSERVER_URL holds an address (2026-10-15)", () => {
    assert.equal(DedicatedServersConfigured({}), false, "unset");
    assert.equal(DedicatedServersConfigured({ DEPLOYSERVER_URL: "" }), false, "empty");
    assert.equal(DedicatedServersConfigured({ DEPLOYSERVER_URL: " \t " }), false, "whitespace only");
    assert.equal(DedicatedServersConfigured({ DEPLOYSERVER_URL: "deployserver.invalid:8080" }), true);
    assert.equal(DedicatedServersConfigured({ DEPLOYSERVER_URL: " 127.0.0.1:9 " }), true, "padded address");
});

test("the default reads the process environment", () => {
    const saved = process.env.DEPLOYSERVER_URL;
    try {
        delete process.env.DEPLOYSERVER_URL;
        assert.equal(DedicatedServersConfigured(), false);
        process.env.DEPLOYSERVER_URL = "deployserver.invalid:8080";
        assert.equal(DedicatedServersConfigured(), true);
    } finally {
        if (saved === undefined) delete process.env.DEPLOYSERVER_URL;
        else process.env.DEPLOYSERVER_URL = saved;
    }
});
