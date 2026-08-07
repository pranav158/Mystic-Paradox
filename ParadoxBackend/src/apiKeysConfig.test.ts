import assert from "node:assert/strict";
import test from "node:test";

import { ParseConfiguredGameserverAPIKeys, SynchronizeConfiguredGameserverAPIKeys } from "./controllers/apikeys";

test("gameserver keys are trimmed, deduplicated, and empty values are ignored", () => {
    assert.deepEqual(
        ParseConfiguredGameserverAPIKeys(" first,second, first, ,third "),
        ["first", "second", "third"]
    );
});

test("an unset gameserver key list is empty", () => {
    assert.deepEqual(ParseConfiguredGameserverAPIKeys(undefined), []);
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
