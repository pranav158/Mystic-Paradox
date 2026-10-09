import assert from "node:assert/strict";
import test from "node:test";

import { segment } from "./routes/launcherUpdates";

test("accepts flat update path segments", () => {
    assert.equal(segment("stable", "channel"), "stable");
    assert.equal(segment("windows-x86_64", "platform"), "windows-x86_64");
    assert.equal(segment("runtime.dll", "filename"), "runtime.dll");
});

test("rejects traversal, nested paths, and non-scalar parameters", () => {
    for (const value of [
        "../stable",
        "nested/stable",
        "stable\\channel",
        ".",
        "..",
        "",
        "stable channel",
        ["stable"],
        { value: "stable" },
    ]) {
        assert.throws(() => segment(value, "test segment"));
    }
});
