import assert from "node:assert/strict";
import test from "node:test";
import { VersionAtLeast } from "./launcherVersion";

test("launcher version comparison follows prerelease precedence", () => {
    assert.equal(VersionAtLeast("0.1.35", "0.1.35"), true);
    assert.equal(VersionAtLeast("0.1.35+build.7", "0.1.35"), true);
    assert.equal(VersionAtLeast("0.1.35-rc.1", "0.1.35"), false);
    assert.equal(VersionAtLeast("0.1.35-rc.2", "0.1.35-rc.1"), true);
    assert.equal(VersionAtLeast("0.1.35-alpha", "0.1.35-rc.1"), false);
    assert.equal(VersionAtLeast("999999999999999999.0.0", "2.0.0"), true);
    assert.equal(VersionAtLeast("not-a-version", "0.1.35"), false);
});
