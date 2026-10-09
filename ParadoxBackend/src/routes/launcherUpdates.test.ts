import assert from "node:assert/strict";
import test from "node:test";
import { validateGuardManifestWindow } from "./launcherUpdates";

const NOW = Date.parse("2026-09-09T00:00:00.000Z");

test("Guard manifest window accepts a current, future-expiring manifest", () => {
    assert.doesNotThrow(() => validateGuardManifestWindow(
        "2026-09-08T23:59:00.000Z",
        "2026-09-09T01:00:00.000Z",
        NOW,
    ));
});

test("Guard manifest window rejects an issue time beyond the clock-skew bound", () => {
    assert.throws(() => validateGuardManifestWindow(
        "2026-09-09T00:05:01.000Z",
        "2026-09-09T01:00:00.000Z",
        NOW,
    ), /too far in the future/);
});

test("Guard manifest window rejects expired manifests", () => {
    assert.throws(() => validateGuardManifestWindow(
        "2026-09-08T23:00:00.000Z",
        "2026-09-08T23:59:59.000Z",
        NOW,
    ), /expired/);
});

test("Guard manifest window rejects reversed timestamps", () => {
    assert.throws(() => validateGuardManifestWindow(
        "2026-09-09T00:30:00.000Z",
        "2026-09-09T00:20:00.000Z",
        NOW,
    ), /not after/);
});

test("Guard manifest window rejects a lifetime beyond the publisher bound", () => {
    assert.throws(() => validateGuardManifestWindow(
        "2026-01-01T00:00:00.000Z",
        "2027-01-01T00:00:00.001Z",
        NOW,
    ), /maximum allowed window/);
});

test("Guard manifest window rejects malformed timestamps", () => {
    assert.throws(() => validateGuardManifestWindow("not-a-time", "2026-09-09T01:00:00.000Z", NOW), /invalid/);
});
