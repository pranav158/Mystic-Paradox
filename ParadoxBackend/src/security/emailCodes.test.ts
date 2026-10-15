/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The code helpers: 6 digits from crypto.randomInt, the HMAC that binds a code to its account and purpose, a constant-time
// comparison, the address mask for messages, and the one TTL and try limit.
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { HashEmailCode } from "./apiKeyHash";
import {
    EMAIL_CODE_MAX_TRIES,
    EMAIL_CODE_TTL_MINUTES,
    EMAIL_CODE_TTL_MS,
    EmailCodeHash,
    EmailCodeMatches,
    GenerateEmailCode,
    IsEmailCodeFormat,
    MaskEmail
} from "./emailCodes";

before(() => {
    process.env.API_KEY_HASH_SECRET = "email-code-test-secret-that-is-long-enough-1234";
});

test("the code is 6 digits, and GenerateEmailCode keeps leading zeros", () => {
    const Seen = new Set<string>();
    for (let Index = 0; Index < 500; Index += 1) {
        const Code = GenerateEmailCode();
        assert.match(Code, /^\d{6}$/);
        Seen.add(Code);
    }
    assert.ok(Seen.size > 400, "the codes are not repeating");
    assert.equal(Array.from(Seen).some((code) => code.startsWith("0")), true, "leading zeros are kept (500 draws)");
});

test("only exactly six ASCII digits are a code", () => {
    for (const value of ["123456", "000000"]) assert.equal(IsEmailCodeFormat(value), true, value);
    for (const value of ["12345", "1234567", "12345a", " 123456", "123 456", "١٢٣٤٥٦", 123456, undefined, null]) {
        assert.equal(IsEmailCodeFormat(value), false, String(value));
    }
});

test("a stored code is an HMAC bound to the account and the purpose, never the code itself", () => {
    const Hash = EmailCodeHash("user-1", "verify", "482913");
    assert.match(Hash, /^[0-9a-f]{64}$/);
    assert.notEqual(Hash, "482913");
    assert.equal(Hash, HashEmailCode("user-1", "verify", "482913"), "deterministic under the secret");
    assert.notEqual(Hash, EmailCodeHash("user-1", "reset", "482913"), "a verify hash is not a reset hash");
    assert.notEqual(Hash, EmailCodeHash("user-2", "verify", "482913"), "a hash cannot be moved to another account");
    assert.notEqual(Hash, EmailCodeHash("user-1", "verify", "482914"));
});

test("the hash needs the server secret (no secret, no hash)", () => {
    const Saved = process.env.API_KEY_HASH_SECRET;
    delete process.env.API_KEY_HASH_SECRET;
    try {
        assert.throws(() => EmailCodeHash("user-1", "verify", "482913"), /API_KEY_HASH_SECRET/);
    } finally {
        process.env.API_KEY_HASH_SECRET = Saved;
    }
});

test("EmailCodeMatches is true only for the same hash, and never for malformed or empty input", () => {
    const Stored = EmailCodeHash("user-1", "verify", "482913");
    assert.equal(EmailCodeMatches(Stored, EmailCodeHash("user-1", "verify", "482913")), true);
    assert.equal(EmailCodeMatches(Stored, EmailCodeHash("user-1", "verify", "482914")), false);
    assert.equal(EmailCodeMatches(Stored, Stored.slice(0, 10)), false, "different lengths");
    assert.equal(EmailCodeMatches("", ""), false);
    assert.equal(EmailCodeMatches("zz", "zz"), false, "not hex");
});

test("MaskEmail keeps the first and last letter of a longer name, the first letter of a short one, and the domain", () => {
    assert.equal(MaskEmail("mystic@gmail.com"), "m***c@gmail.com");
    assert.equal(MaskEmail("ab@x.io"), "a***@x.io");
    assert.equal(MaskEmail("a@x.io"), "a***@x.io");
    assert.equal(MaskEmail("no-at-sign"), "***");
});

test("the code lives 5 minutes, allows 5 wrong tries, and the TTL is one constant", () => {
    assert.equal(EMAIL_CODE_TTL_MINUTES, 5);
    assert.equal(EMAIL_CODE_TTL_MS, 5 * 60 * 1000);
    assert.equal(EMAIL_CODE_MAX_TRIES, 5);
});
