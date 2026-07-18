/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSaslPlain } from "./saslPlain";

function plain(authzid: string, authcid: string, password: string): string {
    return Buffer.from(`${authzid}\u0000${authcid}\u0000${password}`, "utf8").toString("base64");
}

test("parseSaslPlain: valid PLAIN (no authzid) extracts authcid + password", () => {
    const r = parseSaslPlain("PLAIN", plain("", "mysticparadox", "the-jwt"));
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.equal(r.authcid, "mysticparadox");
        assert.equal(r.password, "the-jwt");
    }
});

test("parseSaslPlain: authzid present is still 3 fields; authcid is the middle field", () => {
    const r = parseSaslPlain("PLAIN", plain("authz", "mysticparadox", "pw"));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.authcid, "mysticparadox");
});

test("parseSaslPlain: non-PLAIN mechanism rejected", () => {
    const r = parseSaslPlain("SCRAM-SHA-1", plain("", "u", "p"));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "unsupported mechanism");
});

test("parseSaslPlain: wrong NUL field count rejected", () => {
    
    const twoFields = Buffer.from("mysticparadox\u0000pw", "utf8").toString("base64");
    const r = parseSaslPlain("PLAIN", twoFields);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "malformed PLAIN layout");

    
    const fourFields = Buffer.from("a\u0000b\u0000c\u0000d", "utf8").toString("base64");
    assert.equal(parseSaslPlain("PLAIN", fourFields).ok, false);
});

test("parseSaslPlain: empty authcid or password rejected", () => {
    assert.equal(parseSaslPlain("PLAIN", plain("", "", "pw")).ok, false);
    assert.equal(parseSaslPlain("PLAIN", plain("", "user", "")).ok, false);
});

test("parseSaslPlain: empty / oversized input rejected", () => {
    assert.equal(parseSaslPlain("PLAIN", "").ok, false);
    const huge = "A".repeat(9 * 1024); 
    const r = parseSaslPlain("PLAIN", huge);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "sasl length");
});
