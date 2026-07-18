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

import { escapeXml, redacted, sanitizeName } from "./xml";

test("escapeXml escapes all five XML metacharacters", () => {
    assert.equal(escapeXml(`<a href="x" id='y'>&</a>`), "&lt;a href=&quot;x&quot; id=&apos;y&apos;&gt;&amp;&lt;/a&gt;");
    assert.equal(escapeXml("plain text"), "plain text");
});

test("escapeXml is idempotent-safe for already-safe text", () => {
    assert.equal(escapeXml(""), "");
    assert.equal(escapeXml("no-specials-123"), "no-specials-123");
});

test("redacted reveals only length, never content", () => {
    assert.equal(redacted("secret-token"), "<redacted:12>");
    assert.equal(redacted(""), "<redacted:0>");
    assert.equal(redacted(undefined), "<redacted:0>");
    assert.equal(redacted(null), "<redacted:0>");
});

test("sanitizeName strips control chars and caps length", () => {
    assert.equal(sanitizeName("clean_name"), "clean_name");
    
    assert.equal(sanitizeName("bad\u0000name\u0007"), "bad?name?");
    
    const long = "x".repeat(200);
    const out = sanitizeName(long, 16);
    assert.ok(out.length <= 16 + 3);
    assert.ok(out.endsWith("..."));
});
