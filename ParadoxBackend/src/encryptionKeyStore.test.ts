/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EncryptionKeyStore, EncryptionKeyTokenFingerprint, NormalizeEncryptionKeyToken } from "./encryptionKeyStore";

const LeaderToken = "BEARER eyJleader.payload.sig";
const MemberToken = "BEARER eyJmember.payload.sig";

test("each joining player gets the key issued to their own token (two-player party, 10 Oct 19:41)", () => {
    const Store = new EncryptionKeyStore();
    // Leader and member generate keys 170 ms apart, each with their own candidate id.
    Store.issue("leader-candidate", { key: "leader-key", nonce: "n1", token: LeaderToken, at: 1000 });
    Store.issue("member-candidate", { key: "member-key", nonce: "n2", token: MemberToken, at: 1170 });

    // The game server consumes with { token, gameId } only - no candidate id.
    const Leader = Store.lookup("", LeaderToken, 9000);
    assert.equal(Leader.matchedBy, "token");
    assert.equal(Leader.issued?.key, "leader-key");
    const Member = Store.lookup("", MemberToken, 21000);
    assert.equal(Member.matchedBy, "token");
    assert.equal(Member.issued?.key, "member-key");
});

test("token matching ignores the BEARER prefix, its case and whitespace", () => {
    const Store = new EncryptionKeyStore();
    Store.issue("", { key: "k", nonce: "n", token: LeaderToken, at: 0 });
    assert.equal(Store.lookup("", "eyJleader.payload.sig", 1).issued?.key, "k");
    assert.equal(Store.lookup("", "  bearer eyJleader.payload.sig ", 1).issued?.key, "k");
    assert.equal(NormalizeEncryptionKeyToken("Bearer  abc "), "abc");
});

test("a candidate id still wins, and a re-issue for the same player replaces their key", () => {
    const Store = new EncryptionKeyStore();
    Store.issue("c1", { key: "first", nonce: "n", token: LeaderToken, at: 0 });
    Store.issue("c2", { key: "second", nonce: "n", token: LeaderToken, at: 10 });
    assert.equal(Store.lookup("c1", LeaderToken, 20).issued?.key, "first");
    assert.equal(Store.lookup("", LeaderToken, 20).issued?.key, "second");
});

test("an unknown token falls back to the most recent key and says so; expired keys are dropped", () => {
    const Store = new EncryptionKeyStore(1000);
    Store.issue("", { key: "recent", nonce: "n", token: MemberToken, at: 0 });
    const Unknown = Store.lookup("", "BEARER somebody-else", 500);
    assert.equal(Unknown.matchedBy, "most-recent");
    assert.equal(Unknown.unknownToken, true);
    assert.equal(Unknown.issued?.key, "recent");

    const Expired = Store.lookup("", MemberToken, 5000);
    assert.equal(Expired.issued, null);
    assert.equal(Expired.matchedBy, "none");
});

test("the log fingerprint never contains the token", () => {
    const Fp = EncryptionKeyTokenFingerprint(LeaderToken);
    assert.equal(Fp.length, 12);
    assert.ok(!LeaderToken.includes(Fp));
    assert.equal(EncryptionKeyTokenFingerprint(""), "none");
});
