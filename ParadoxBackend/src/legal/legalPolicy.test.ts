import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CurrentLegalRequirements, MINIMUM_AGE, PRIVACY_VERSION, TERMS_VERSION } from "./legalPolicy";
import { DELETION_HOLD_DAYS, GUARD_SESSION_RETENTION_DAYS, RetentionDateAfter, UPLOADED_LAUNCHER_LOG_RETENTION_DAYS } from "./retentionPolicy";

// [2026-10-14] The backend's legal constants must equal the launcher's (ParadoxLauncher/src/legal/legalMeta.ts). The launcher is another
// part of this checkout; when it is absent (a public checkout) the parity check is skipped.

// src/legal -> ParadoxBackend -> Dauntless
const LAUNCHER_META = path.resolve(__dirname, "..", "..", "..", "ParadoxLauncher", "src", "legal", "legalMeta.ts");

test("the backend's legal versions and minimum age are the launcher's", (t) => {
    if (!fs.existsSync(LAUNCHER_META)) {
        t.skip("ParadoxLauncher is not in this checkout");
        return;
    }
    const Source = fs.readFileSync(LAUNCHER_META, "utf8");
    const ReadString = (key: string): string => {
        const Match = Source.match(new RegExp(`${key}:\\s*"([^"]*)"`));
        assert.ok(Match, `launcher ${key}`);
        return Match[1];
    };
    const ReadNumber = (key: string): number => {
        const Match = Source.match(new RegExp(`${key}:\\s*(\\d+)`));
        assert.ok(Match, `launcher ${key}`);
        return Number(Match[1]);
    };
    assert.equal(TERMS_VERSION, ReadString("termsVersion"));
    assert.equal(PRIVACY_VERSION, ReadString("privacyVersion"));
    assert.equal(MINIMUM_AGE, ReadNumber("minimumAge"));
});

test("the current requirements carry the same values", () => {
    assert.deepEqual(CurrentLegalRequirements(), { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, minimumAge: MINIMUM_AGE });
    assert.equal(MINIMUM_AGE, 16);
});

test("the retention periods are the ones the Privacy Policy states", () => {
    assert.equal(DELETION_HOLD_DAYS, 30);
    assert.equal(GUARD_SESSION_RETENTION_DAYS, 90);
    assert.equal(UPLOADED_LAUNCHER_LOG_RETENTION_DAYS, 90);
    assert.equal(RetentionDateAfter("2026-10-14T00:00:00.000Z", 2).toISOString(), "2026-10-16T00:00:00.000Z");
});

// [2026-10-15] The previous privacy version stays accepted during its transition (0.1.66 launchers carry 2026-10-14.2).
// [2026-10-16] So does 2026-10-15 (launchers up to 0.1.73).
// [2026-10-17] And 2026-10-16 (launchers before the wider log upload).
test("the previous privacy versions still count as accepted, other versions do not", async () => {
    const { IsAcceptedPrivacyVersion, PRIVACY_VERSION } = await import("./legalPolicy");
    assert.equal(PRIVACY_VERSION, "2026-10-17");
    assert.equal(IsAcceptedPrivacyVersion(PRIVACY_VERSION), true);
    assert.equal(IsAcceptedPrivacyVersion("2026-10-16"), true);
    assert.equal(IsAcceptedPrivacyVersion("2026-10-15"), true);
    assert.equal(IsAcceptedPrivacyVersion("2026-10-14.2"), true);
    assert.equal(IsAcceptedPrivacyVersion("2026-10-14"), false);
    assert.equal(IsAcceptedPrivacyVersion(undefined), false);
});
