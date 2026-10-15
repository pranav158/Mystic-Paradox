/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeUrlForLog } from "./logRedaction";

/** A JWT-shaped string built at runtime (a literal one would trip the secret scans of the export and CI). */
const fakeJwt = (header: object, payload: object, signature: string): string =>
    [JSON.stringify(header), JSON.stringify(payload), signature].map((part) => Buffer.from(part).toString("base64url")).join(".");

test("redacts signed store purchase tokens without changing routing text", () => {
    assert.equal(
        sanitizeUrlForLog("/notification/id_currency_s19_coin?token=abc.def&x=1"),
        "/notification/id_currency_s19_coin?token=[REDACTED]&x=1"
    );
});

test("redacts sensitive query keys case-insensitively", () => {
    assert.equal(
        sanitizeUrlForLog("/oauth?CODE=secret&state=ok&access_token=another"),
        "/oauth?CODE=[REDACTED]&state=ok&access_token=[REDACTED]"
    );
});

test("preserves non-sensitive query values", () => {
    assert.equal(
        sanitizeUrlForLog("/balance?currency=id_currency_s19_coin"),
        "/balance?currency=id_currency_s19_coin"
    );
});

// [2026-10-15] The game's logout puts the access token in the path; the VPS log held the full JWT.
test("redacts the token in the path of an OAuth session kill", () => {
    const jwt = fakeJwt({ alg: "HS256" }, { sub: "test-user", exp: 1790 }, "signature-value-here");
    assert.equal(
        sanitizeUrlForLog(`/__origin/xyz.ol.epicgames.com/account/api/oauth/sessions/kill/${jwt}`),
        "/__origin/xyz.ol.epicgames.com/account/api/oauth/sessions/kill/[REDACTED]",
    );
    assert.equal(sanitizeUrlForLog("/account/api/oauth/sessions/kill/opaque-session-token?x=1"), "/account/api/oauth/sessions/kill/[REDACTED]?x=1");
    // The query form names a kill type, not a token: unchanged.
    assert.equal(sanitizeUrlForLog("/account/api/oauth/sessions/kill?killType=OTHERS"), "/account/api/oauth/sessions/kill?killType=OTHERS");
});

test("redacts a JWT anywhere in the path or query", () => {
    const jwt = fakeJwt({ alg: "RS256" }, { account: "x" }, "AbCdEf-123");
    assert.match(jwt, /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/);
    assert.equal(sanitizeUrlForLog(`/some/route/${jwt}/tail`), "/some/route/[REDACTED-JWT]/tail");
    assert.equal(sanitizeUrlForLog(`/route?ticket=${jwt}&b=2`), "/route?ticket=[REDACTED-JWT]&b=2");
    // Ordinary ids stay readable.
    assert.equal(sanitizeUrlForLog("/progression/bounty/2f1c7e3a-9b1d-4c55-8a0e-1234567890ab"), "/progression/bounty/2f1c7e3a-9b1d-4c55-8a0e-1234567890ab");
});
