/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

process.env.API_KEY_HASH_SECRET ??= "test-only-api-key-hash-secret-0123456789abcdef";

import { ParseConfiguredGameserverAPIKeys, SynchronizeConfiguredGameserverAPIKeys } from "./controllers/apikeys";

test("configured gameserver keys are trimmed, non-empty and unique", () => {
    assert.deepEqual(
        ParseConfiguredGameserverAPIKeys(" first, second ,,first,third "),
        ["first", "second", "third"]
    );
});

test("an unset or empty gameserver key list is empty, so stored keys are kept", () => {
    assert.deepEqual(ParseConfiguredGameserverAPIKeys(undefined), []);
    assert.deepEqual(ParseConfiguredGameserverAPIKeys(""), []);
    assert.deepEqual(ParseConfiguredGameserverAPIKeys(" , "), []);
});

test("configured gameserver keys replace the persisted set", async () => {
    let ReplacedHashes: string[] | undefined;
    let ClearedPending = false;
    const Repository = {
        async replaceGameServerKeyHashes(Hashes: string[]) {
            ReplacedHashes = Hashes;
        },
        async clearGameServerKeysToRegister() {
            ClearedPending = true;
        }
    };

    const Count = await SynchronizeConfiguredGameserverAPIKeys(Repository, "new-key");

    assert.equal(Count, 1);
    assert.equal(ReplacedHashes?.length, 1);
    assert.equal(ReplacedHashes?.[0].length, 64);
    assert.equal(ClearedPending, true);
});
