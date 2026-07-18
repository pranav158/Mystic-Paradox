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

import { bareJid, fullJid, parseJid, sameBareJid } from "./jid";

test("parseJid: full JID with Epic-style resource containing ':' and '/'", () => {
    const jid = parseJid("mysticparadox@prod.ol.epicgames.com/V2:Jackal:WIN::abc/def");
    assert.ok(jid);
    assert.equal(jid.local, "mysticparadox");
    assert.equal(jid.domain, "prod.ol.epicgames.com");
    
    assert.equal(jid.resource, "V2:Jackal:WIN::abc/def");
});

test("parseJid: bare JID (no resource)", () => {
    const jid = parseJid("user@example.com");
    assert.ok(jid);
    assert.equal(jid.local, "user");
    assert.equal(jid.domain, "example.com");
    assert.equal(jid.resource, "");
});

test("parseJid: domain-only JID", () => {
    const jid = parseJid("prod.ol.epicgames.com");
    assert.ok(jid);
    assert.equal(jid.local, "");
    assert.equal(jid.domain, "prod.ol.epicgames.com");
    assert.equal(jid.resource, "");
});

test("parseJid: local + domain lowercased, resource case preserved", () => {
    const jid = parseJid("ExampleSlayer@Prod.OL.EpicGames.com/ReSource");
    assert.ok(jid);
    assert.equal(jid.local, "exampleslayer");
    assert.equal(jid.domain, "prod.ol.epicgames.com");
    assert.equal(jid.resource, "ReSource");
});

test("parseJid: empty / invalid input returns undefined", () => {
    assert.equal(parseJid(""), undefined);
    assert.equal(parseJid("   "), undefined);
    
    assert.equal(parseJid("user@"), undefined);
    
    assert.equal(parseJid("/res"), undefined);
});

test("bareJid / fullJid formatting", () => {
    const withResource = parseJid("a@b.com/r");
    assert.ok(withResource);
    assert.equal(bareJid(withResource), "a@b.com");
    assert.equal(fullJid(withResource), "a@b.com/r");

    const domainOnly = parseJid("b.com");
    assert.ok(domainOnly);
    assert.equal(bareJid(domainOnly), "b.com");
    assert.equal(fullJid(domainOnly), "b.com");
});

test("sameBareJid ignores resource", () => {
    const a = parseJid("u@d.com/one");
    const b = parseJid("u@d.com/two");
    const c = parseJid("v@d.com/one");
    assert.ok(a && b && c);
    assert.equal(sameBareJid(a, b), true);
    assert.equal(sameBareJid(a, c), false);
});
