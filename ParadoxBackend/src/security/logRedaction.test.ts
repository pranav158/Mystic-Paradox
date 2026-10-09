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
