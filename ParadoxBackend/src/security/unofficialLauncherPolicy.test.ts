import assert from "node:assert/strict";
import test from "node:test";
import { ReadUnofficialLauncherPolicy, UnofficialLauncherRefuses } from "./unofficialLauncherPolicy";
import { ClassifyReportedLauncherBuild } from "../activity/activityMonitor";

const OFFICIAL = "a".repeat(64);
const SELF_BUILT = "b".repeat(64);
const TEST_BUILD = "c".repeat(64);
const report = (sha256: string, version = "0.1.68") => ({ version, sha256 });
const sources = { pinnedLauncherSha256: () => OFFICIAL, servedLauncherVersion: () => "0.1.68" };

test("[2026-10-16] the unofficial-launcher policy is observe unless set to refuse; a typo never refuses", () => {
    assert.equal(ReadUnofficialLauncherPolicy({}).mode, "observe");
    assert.equal(ReadUnofficialLauncherPolicy({ MYSTICPARADOX_UNOFFICIAL_LAUNCHER: " Refuse " }).mode, "refuse");
    const typo = ReadUnofficialLauncherPolicy({ MYSTICPARADOX_UNOFFICIAL_LAUNCHER: "refuze" });
    assert.equal(typo.mode, "observe");
    assert.equal(typo.warnings.length, 1);
    assert.equal(ReadUnofficialLauncherPolicy({}).testersExempt, true);
    assert.equal(ReadUnofficialLauncherPolicy({ MYSTICPARADOX_UNOFFICIAL_LAUNCHER_TESTERS_EXEMPT: "off" }).testersExempt, false);
});

test("[2026-10-16] allowed test-build hashes are read case-insensitively; malformed entries are ignored with a warning", () => {
    const policy = ReadUnofficialLauncherPolicy({
        MYSTICPARADOX_LAUNCHER_ALLOWED_HASHES: `${TEST_BUILD.toUpperCase()}, not-a-hash  ${"d".repeat(64)}`
    });
    assert.deepEqual([...policy.allowedHashes].sort(), [TEST_BUILD, "d".repeat(64)]);
    assert.equal(policy.warnings.length, 1);
});

test("[2026-10-16] with refuse, only an unofficial build is refused; outdated, unknown, allowed hashes and admins play on", () => {
    const refuse = ReadUnofficialLauncherPolicy({ MYSTICPARADOX_UNOFFICIAL_LAUNCHER: "refuse",
        MYSTICPARADOX_LAUNCHER_ALLOWED_HASHES: TEST_BUILD });
    const player: string[] = ["player"];
    assert.equal(UnofficialLauncherRefuses("unofficial", report(SELF_BUILT), player, refuse), true);
    assert.equal(UnofficialLauncherRefuses("official", report(OFFICIAL), player, refuse), false);
    assert.equal(UnofficialLauncherRefuses("outdated", report(SELF_BUILT, "0.1.60"), player, refuse), false);
    assert.equal(UnofficialLauncherRefuses("unknown", undefined, player, refuse), false);
    assert.equal(UnofficialLauncherRefuses("unofficial", report(TEST_BUILD, "0.1.69"), player, refuse), false);
    // [2026-10-16, owner] The tester role is no exemption any more (it unlocks the log upload only).
    assert.equal(UnofficialLauncherRefuses("unofficial", report(SELF_BUILT), ["admin"], refuse), false);
    const strict = { ...refuse, testersExempt: false };
    assert.equal(UnofficialLauncherRefuses("unofficial", report(SELF_BUILT), ["admin"], strict), true);
    // observe never refuses.
    assert.equal(UnofficialLauncherRefuses("unofficial", report(SELF_BUILT), player, ReadUnofficialLauncherPolicy({})), false);
});

test("[2026-10-16] the Play verdict: the pinned hash is official, an older version outdated, the served version or newer unofficial", () => {
    assert.equal(ClassifyReportedLauncherBuild("stable", report(OFFICIAL), sources), "official");
    assert.equal(ClassifyReportedLauncherBuild("stable", report(SELF_BUILT, "0.1.67"), sources), "outdated");
    assert.equal(ClassifyReportedLauncherBuild("stable", report(SELF_BUILT, "0.1.68"), sources), "unofficial");
    assert.equal(ClassifyReportedLauncherBuild("stable", report(SELF_BUILT, "0.1.69"), sources), "unofficial");
    assert.equal(ClassifyReportedLauncherBuild("stable", undefined, sources), "unknown");
    // No Guard pin (a server without a manifest), or a feed that cannot be read: unknown, never a refusal.
    assert.equal(ClassifyReportedLauncherBuild("stable", report(SELF_BUILT), { ...sources, pinnedLauncherSha256: () => undefined }), "unknown");
    assert.equal(ClassifyReportedLauncherBuild("stable", report(SELF_BUILT), {
        pinnedLauncherSha256: () => { throw new Error("feed unreadable"); }, servedLauncherVersion: () => "0.1.68"
    }), "unknown");
});
