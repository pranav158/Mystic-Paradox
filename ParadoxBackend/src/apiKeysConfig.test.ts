import assert from "node:assert/strict";
import test from "node:test";

import { ParseConfiguredGameserverAPIKeys } from "./controllers/apikeys";

test("gameserver keys are trimmed, deduplicated, and empty values are ignored", () => {
    assert.deepEqual(
        ParseConfiguredGameserverAPIKeys(" first,second, first, ,third "),
        ["first", "second", "third"]
    );
});

test("an unset gameserver key list is empty", () => {
    assert.deepEqual(ParseConfiguredGameserverAPIKeys(undefined), []);
});