import assert from "node:assert/strict";
import test from "node:test";
import { HUNT_EVIDENCE_ENV, HuntEvidenceEnabled, LogHuntEvidence, ResolveHuntEvidence } from "./huntEvidence";

// [2026-10-17] Hosted hunts send no Hunt Guard evidence by default at trust tier 0: the host's transport posted every event on its
// packet thread and every hosted hunt lagged (config/huntEvidence.ts).

test("hunt evidence: off by default at trust tier 0, on by default at tier 1", () => {
    assert.deepEqual(ResolveHuntEvidence({}), { enabled: false, isDefault: true });
    assert.deepEqual(ResolveHuntEvidence({ [HUNT_EVIDENCE_ENV]: "  " }), { enabled: false, isDefault: true });
    assert.deepEqual(ResolveHuntEvidence({ P2P_TRUST_TIER: "0" }), { enabled: false, isDefault: true });
    assert.deepEqual(ResolveHuntEvidence({ P2P_TRUST_TIER: "1" }), { enabled: true, isDefault: true });
});

test("hunt evidence: on and off are explicit at either tier (trimmed, any case)", () => {
    assert.equal(HuntEvidenceEnabled({ [HUNT_EVIDENCE_ENV]: "on" }), true);
    assert.equal(HuntEvidenceEnabled({ [HUNT_EVIDENCE_ENV]: " ON " }), true);
    assert.equal(HuntEvidenceEnabled({ [HUNT_EVIDENCE_ENV]: "off", P2P_TRUST_TIER: "1" }), false);
    assert.equal(HuntEvidenceEnabled({ [HUNT_EVIDENCE_ENV]: "Off" }), false);
});

test("hunt evidence: an unrecognised value keeps the tier's default and says so", () => {
    const Tier0 = ResolveHuntEvidence({ [HUNT_EVIDENCE_ENV]: "true" });
    assert.equal(Tier0.enabled, false);
    assert.match(Tier0.warning ?? "", /must be on or off \(got "true"\).*\(off\)/);
    const Tier1 = ResolveHuntEvidence({ [HUNT_EVIDENCE_ENV]: "1", P2P_TRUST_TIER: "1" });
    assert.equal(Tier1.enabled, true);
    assert.match(Tier1.warning ?? "", /\(on\)/);
});

test("hunt evidence: one startup line, plus the warning for an unrecognised value", () => {
    const Lines: string[] = [];
    const Sink = { info: (message: string) => Lines.push(`info ${message}`), warn: (message: string) => Lines.push(`warn ${message}`) };
    LogHuntEvidence(ResolveHuntEvidence({}), Sink);
    LogHuntEvidence(ResolveHuntEvidence({ [HUNT_EVIDENCE_ENV]: "on" }), Sink);
    LogHuntEvidence(ResolveHuntEvidence({ [HUNT_EVIDENCE_ENV]: "maybe" }), Sink);
    assert.equal(Lines.length, 4);
    assert.match(Lines[0], /^info \[Startup\] MYSTICPARADOX_HUNT_EVIDENCE not set .*send no Hunt Guard evidence/);
    assert.match(Lines[1], /^info \[Startup\] MYSTICPARADOX_HUNT_EVIDENCE=on: hosted hunts send Hunt Guard evidence/);
    assert.match(Lines[2], /^warn \[Startup\] WARNING: MYSTICPARADOX_HUNT_EVIDENCE must be on or off/);
    assert.match(Lines[3], /send no Hunt Guard evidence/);
});
