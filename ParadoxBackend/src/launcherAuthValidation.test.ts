import assert from "node:assert/strict";
import test from "node:test";
import { IsValidEmailAddress } from "./controllers/launcherAuth";

test("accepts a bounded ordinary email address", () => {
    assert.equal(IsValidEmailAddress("slayer@example.com"), true);
});

test("rejects malformed, whitespace, and oversized email addresses", () => {
    for (const value of [
        "slayer",
        "@example.com",
        "slayer@localhost",
        "slayer@@example.com",
        "slayer @example.com",
        `slayer@${"a".repeat(250)}.com`,
    ]) {
        assert.equal(IsValidEmailAddress(value), false, value);
    }
});
