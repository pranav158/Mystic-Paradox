/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    GuardRequiredByEnvironment,
    GuardRuleRequires,
    GuardVerdictRefuses,
    LogGuardModePolicy,
    NoteGuardWouldRefuse,
    ResetGuardWouldRefuseNotesForTest,
    ResolveGuardMode
} from "./guardMode";

// [2026-10-14] MYSTICPARADOX_GUARD_MODE: observe (the default) refuses nothing; enforce is the earlier behaviour.

test("parsing: unset or blank is observe by default; observe and enforce are read case-insensitively; anything else is enforce with a refusal", () => {
    assert.deepEqual(ResolveGuardMode({}), { mode: "observe", isDefault: true });
    assert.deepEqual(ResolveGuardMode({ MYSTICPARADOX_GUARD_MODE: "  " }), { mode: "observe", isDefault: true });
    assert.deepEqual(ResolveGuardMode({ MYSTICPARADOX_GUARD_MODE: "Observe" }), { mode: "observe", isDefault: false });
    assert.deepEqual(ResolveGuardMode({ MYSTICPARADOX_GUARD_MODE: " ENFORCE " }), { mode: "enforce", isDefault: false });
    for (const value of ["off", "on", "1", "observ", "monitor"]) {
        const policy = ResolveGuardMode({ MYSTICPARADOX_GUARD_MODE: value });
        assert.equal(policy.mode, "enforce", value);
        assert.match(policy.refusal ?? "", /must be observe or enforce/, value);
    }
});

test("refusal rule: the earlier rule (operations ENFORCE or P2P_LAUNCHER_GUARD_REQUIRED=true) only in enforce mode", () => {
    const Cases: Array<{ mode: string | undefined; operations: "OBSERVE" | "ENFORCE"; p2pRequired: string | undefined; refuses: boolean; rule: boolean }> = [
        { mode: undefined, operations: "ENFORCE", p2pRequired: undefined, refuses: false, rule: true },
        { mode: "observe", operations: "ENFORCE", p2pRequired: "true", refuses: false, rule: true },
        { mode: "observe", operations: "OBSERVE", p2pRequired: "true", refuses: false, rule: true },
        { mode: "observe", operations: "OBSERVE", p2pRequired: undefined, refuses: false, rule: false },
        { mode: "enforce", operations: "ENFORCE", p2pRequired: undefined, refuses: true, rule: true },
        { mode: "enforce", operations: "OBSERVE", p2pRequired: "true", refuses: true, rule: true },
        { mode: "enforce", operations: "OBSERVE", p2pRequired: "false", refuses: false, rule: false },
        { mode: "enforce", operations: "OBSERVE", p2pRequired: undefined, refuses: false, rule: false },
        { mode: "bogus", operations: "ENFORCE", p2pRequired: undefined, refuses: true, rule: true }
    ];
    for (const Case of Cases) {
        const environment: NodeJS.ProcessEnv = {};
        if (Case.mode !== undefined) environment.MYSTICPARADOX_GUARD_MODE = Case.mode;
        if (Case.p2pRequired !== undefined) environment.P2P_LAUNCHER_GUARD_REQUIRED = Case.p2pRequired;
        assert.equal(GuardRuleRequires(Case.operations, environment), Case.rule, JSON.stringify(Case));
        assert.equal(GuardVerdictRefuses(Case.operations, environment), Case.refuses, JSON.stringify(Case));
    }
});

test("the host eligibility default: enforce mode and the env switch only", () => {
    assert.equal(GuardRequiredByEnvironment({ P2P_LAUNCHER_GUARD_REQUIRED: "true" }), false, "observe is the default");
    assert.equal(GuardRequiredByEnvironment({ MYSTICPARADOX_GUARD_MODE: "observe", P2P_LAUNCHER_GUARD_REQUIRED: "true" }), false);
    assert.equal(GuardRequiredByEnvironment({ MYSTICPARADOX_GUARD_MODE: "enforce", P2P_LAUNCHER_GUARD_REQUIRED: "true" }), true);
    assert.equal(GuardRequiredByEnvironment({ MYSTICPARADOX_GUARD_MODE: "enforce" }), false);
});

test("would-be refusals are logged once per Guard session and kind, in the agreed format", () => {
    ResetGuardWouldRefuseNotesForTest();
    const Lines: string[] = [];
    const sink = { warn: (message: string) => { Lines.push(message); } };
    const Refusal = {
        what: "hosting", accountId: "acc-9", guardSessionId: "11111111-1111-4111-8111-111111111111", status: "DEGRADED", riskScore: 75,
        reasons: ["UNEXPECTED_MODULES:2", "MODULE_SET_CHANGED"]
    };
    assert.equal(NoteGuardWouldRefuse(Refusal, sink), true);
    assert.equal(NoteGuardWouldRefuse({ ...Refusal, riskScore: 80 }, sink), false, "the same session is not logged again");
    assert.equal(NoteGuardWouldRefuse({ ...Refusal, what: "host candidate" }, sink), true, "another kind of refusal is");
    assert.equal(NoteGuardWouldRefuse({ what: "hosting", accountId: "acc-10" }, sink), true, "an account without a session");
    assert.equal(NoteGuardWouldRefuse({ what: "hosting", accountId: "acc-10" }, sink), false);
    assert.equal(Lines.length, 3);
    assert.equal(Lines[0], "[GuardObserve] would refuse hosting account=acc-9 status=DEGRADED risk=75 reasons=[UNEXPECTED_MODULES:2,MODULE_SET_CHANGED]");
    assert.equal(Lines[2], "[GuardObserve] would refuse hosting account=acc-10 status=NONE risk=- reasons=[]");
    ResetGuardWouldRefuseNotesForTest();
});

test("startup: one info line with the mode; a warning for an unrecognised value", () => {
    const Lines: Array<{ level: "info" | "warn"; message: string }> = [];
    const sink = {
        info: (message: string) => { Lines.push({ level: "info", message }); },
        warn: (message: string) => { Lines.push({ level: "warn", message }); }
    };
    LogGuardModePolicy(ResolveGuardMode({}), sink);
    LogGuardModePolicy(ResolveGuardMode({ MYSTICPARADOX_GUARD_MODE: "enforce" }), sink);
    LogGuardModePolicy(ResolveGuardMode({ MYSTICPARADOX_GUARD_MODE: "monitor" }), sink);
    assert.deepEqual(Lines.map((line) => line.level), ["info", "info", "warn", "info"]);
    assert.match(Lines[0]!.message, /not set \(default observe\): Guard verdicts refuse nothing/);
    assert.match(Lines[1]!.message, /MYSTICPARADOX_GUARD_MODE=enforce: Guard verdicts refuse as before/);
    assert.match(Lines[2]!.message, /WARNING: MYSTICPARADOX_GUARD_MODE must be observe or enforce/);
});
