/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { LauncherGuardInternals, RecordGuardModuleFindings } from "../controllers/launcherGuard";
import { LauncherGuardSignals, LauncherGuardUnexpectedModule, UsePersistenceForTest } from "../persistence";
import { LauncherApiError } from "./launcherErrors";
import { OpenTestRealm } from "../persistence/sqlite/testSupport";

// [2026-10-14] The launcher's Guard report: the reason codes behind a score, the bounded unexpectedModules list (basenames only), and
// the module findings recorded from an accepted heartbeat.

const { explainSignals, explainContinuity, ParseUnexpectedModules } = LauncherGuardInternals;

const Cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const Cleanup of Cleanups) await Cleanup(); });

const Clean: LauncherGuardSignals = {
    gameProcessId: 4242, gameStartedAt: "2026-10-14T10:00:00.000Z", moduleCount: 188, moduleSetDigest: "d".repeat(64),
    privateExecutableBytes: 0, writableExecutableBytes: 0, unexpectedModuleCount: 0, protectedPageMismatchCount: 0, debuggerPresent: false
};

function Invalid(action: () => unknown): void {
    assert.throws(action, (error: unknown) => error instanceof LauncherApiError && error.code === "GUARD_REPORT_INVALID");
}

const Good = { fileName: "Overlay (x64).dll", signer: "unsigned", sha256: "A".repeat(64), size: 10 };

// ---- Reason codes ----

test("reason codes: a clean report scores 0 with no reasons", () => {
    assert.deepEqual(explainSignals(Clean, 1000), { score: 0, reasons: [] });
});

test("reason codes: each cause names itself, with the same arithmetic as before", () => {
    assert.deepEqual(explainSignals({ ...Clean, debuggerPresent: true }, 1000), { score: 50, reasons: ["DEBUGGER"] });
    assert.deepEqual(explainSignals({ ...Clean, unexpectedModuleCount: 2 }, 1000), { score: 30, reasons: ["UNEXPECTED_UNSIGNED:2"] });
    assert.deepEqual(explainSignals({ ...Clean, unexpectedModuleCount: 5 }, 1000), { score: 50, reasons: ["UNEXPECTED_UNSIGNED:5"] }, "capped at 50");
    assert.deepEqual(explainSignals({ ...Clean, protectedPageMismatchCount: 3 }, 1000), { score: 60, reasons: ["PAGE_MISMATCH:3"] }, "capped at 60");
    assert.deepEqual(explainSignals({ ...Clean, writableExecutableBytes: 1 }, 1000), { score: 60, reasons: ["WRITABLE_EXEC_OVER"] });
    assert.deepEqual(explainSignals({ ...Clean, privateExecutableBytes: 2000 }, 1000), { score: 40, reasons: ["PRIVATE_EXEC_OVER"] });
    const Everything = explainSignals({ ...Clean, debuggerPresent: true, unexpectedModuleCount: 5, protectedPageMismatchCount: 3,
        writableExecutableBytes: 1, privateExecutableBytes: 2000 }, 1000);
    assert.equal(Everything.score, 100, "capped at 100");
    assert.deepEqual(Everything.reasons, ["DEBUGGER", "UNEXPECTED_UNSIGNED:5", "PAGE_MISMATCH:3", "WRITABLE_EXEC_OVER", "PRIVATE_EXEC_OVER"]);
});

test("reason codes: continuity names a changed process (100) and a changed module set once warm (50), never on the first reports", () => {
    assert.deepEqual(explainContinuity(undefined, Clean, 0), { score: 0, reasons: [] });
    assert.deepEqual(explainContinuity(Clean, { ...Clean, gameProcessId: 4243 }, 5), { score: 100, reasons: ["PROCESS_CHANGED"] });
    assert.deepEqual(explainContinuity(Clean, { ...Clean, moduleSetDigest: "e".repeat(64) }, 2), { score: 50, reasons: ["MODULE_SET_CHANGED"] });
    assert.deepEqual(explainContinuity(Clean, { ...Clean, moduleSetDigest: "e".repeat(64) }, 1), { score: 0, reasons: [] }, "the first two reports may load modules");
});

// ---- Signers: a signed module is a low-weight finding; unsigned and invalid ones keep the full weight ----

const { hasHardIntegrityViolation, guardStatus } = LauncherGuardInternals;

function Listed(signer: string): LauncherGuardUnexpectedModule {
    return { fileName: `m-${signer.length}.dll`, signer, sha256: "3".repeat(64), size: 1 };
}

test("signers: a signed module (Discord, an overlay) is a low-weight finding, not a hard violation; the status stays HEALTHY", () => {
    const Signals = { ...Clean, unexpectedModuleCount: 2, unexpectedModules: [Listed("Discord Inc."), Listed("NVIDIA Corporation")] };
    assert.deepEqual(explainSignals(Signals, 1000), { score: 4, reasons: ["UNEXPECTED_SIGNED:2"] });
    assert.equal(hasHardIntegrityViolation(Signals, 1000), false);
    assert.equal(guardStatus(Signals, 1000, 0, 4), "HEALTHY");
});

test("signers: the signed weight is capped at 10", () => {
    const Signals = { ...Clean, unexpectedModuleCount: 8, unexpectedModules: Array.from({ length: 8 }, (_, Index) => Listed(`Publisher ${Index}`)) };
    assert.deepEqual(explainSignals(Signals, 1000), { score: 10, reasons: ["UNEXPECTED_SIGNED:8"] });
});

test("signers: unsigned and invalid modules keep the full weight and are hard violations, whatever their case", () => {
    const Signals = { ...Clean, unexpectedModuleCount: 2, unexpectedModules: [Listed("unsigned"), Listed("INVALID")] };
    assert.deepEqual(explainSignals(Signals, 1000), { score: 30, reasons: ["UNEXPECTED_UNSIGNED:2"] });
    assert.equal(hasHardIntegrityViolation(Signals, 1000), true);
    assert.equal(guardStatus(Signals, 1000, 0, 30), "DEGRADED");
});

test("signers: a mixed report splits the count, and the list can never add to the signed count", () => {
    const Mixed = { ...Clean, unexpectedModuleCount: 3, unexpectedModules: [Listed("Discord Inc."), Listed("Discord Inc."), Listed("unsigned")] };
    assert.deepEqual(explainSignals(Mixed, 1000), { score: 19, reasons: ["UNEXPECTED_UNSIGNED:1", "UNEXPECTED_SIGNED:2"] });
    // The list claims five signed modules, but the Guard's own count is 3: the signed part stops at 3.
    const Overclaim = { ...Clean, unexpectedModuleCount: 3, unexpectedModules: Array.from({ length: 5 }, () => Listed("Microsoft")) };
    assert.deepEqual(explainSignals(Overclaim, 1000), { score: 6, reasons: ["UNEXPECTED_SIGNED:3"] });
});

test("signers: a list shorter than the count leaves the rest untrusted; no list (an older launcher) is all untrusted", () => {
    const Partial = { ...Clean, unexpectedModuleCount: 4, unexpectedModules: [Listed("Discord Inc.")] };
    assert.deepEqual(explainSignals(Partial, 1000), { score: 47, reasons: ["UNEXPECTED_UNSIGNED:3", "UNEXPECTED_SIGNED:1"] });
    assert.deepEqual(explainSignals({ ...Clean, unexpectedModuleCount: 2 }, 1000), { score: 30, reasons: ["UNEXPECTED_UNSIGNED:2"] });
});

// ---- unexpectedModules validation ----

test("unexpectedModules: absent or null is no list; a valid list is kept with its hash in lower case", () => {
    assert.equal(ParseUnexpectedModules(undefined), undefined);
    assert.equal(ParseUnexpectedModules(null), undefined);
    assert.deepEqual(ParseUnexpectedModules([]), []);
    assert.deepEqual(ParseUnexpectedModules([Good]), [{ fileName: "Overlay (x64).dll", signer: "unsigned", sha256: "a".repeat(64), size: 10 }]);
    const Accepted: LauncherGuardUnexpectedModule[] = ParseUnexpectedModules([{ ...Good, fileName: "a.b.c-d_e f.dll", size: 2 ** 40, signer: "Discord Inc." }])!;
    assert.equal(Accepted[0]!.size, 2 ** 40, "the size bound is inclusive");
});

test("unexpectedModules: a path, a drive, a dot name or a forbidden character is refused (basenames only)", () => {
    for (const fileName of ["..\\evil.dll", "dir/evil.dll", "dir\\evil.dll", "C:evil.dll", "C:\\Windows\\evil.dll", "..", ".", "",
        "bad*.dll", "bad?.dll", "bad<.dll", "bad>.dll", "bad\".dll", "bad|.dll", "bad\u0001.dll", "bad\n.dll", "a".repeat(261)]) {
        Invalid(() => ParseUnexpectedModules([{ ...Good, fileName }]));
    }
    assert.ok(ParseUnexpectedModules([{ ...Good, fileName: "a".repeat(260) }]), "260 characters is the limit");
    Invalid(() => ParseUnexpectedModules([{ ...Good, fileName: 7 }]));
});

test("unexpectedModules: the signer is a bounded text (the subject or unsigned); control characters are refused", () => {
    Invalid(() => ParseUnexpectedModules([{ ...Good, signer: "" }]));
    Invalid(() => ParseUnexpectedModules([{ ...Good, signer: "a".repeat(257) }]));
    Invalid(() => ParseUnexpectedModules([{ ...Good, signer: "Acme\n" }]));
    assert.ok(ParseUnexpectedModules([{ ...Good, signer: "a".repeat(256) }]), "256 characters is the limit");
});

test("unexpectedModules: the hash is 64 hex digits and the size a whole number of bytes from 0 to 2^40", () => {
    Invalid(() => ParseUnexpectedModules([{ ...Good, sha256: "abc" }]));
    Invalid(() => ParseUnexpectedModules([{ ...Good, sha256: "g".repeat(64) }]));
    for (const size of [-1, 1.5, 2 ** 40 + 1, "10", Number.NaN]) {
        Invalid(() => ParseUnexpectedModules([{ ...Good, size }]));
    }
});

test("unexpectedModules: at most 32 entries; an entry that is not an object refuses the whole list", () => {
    const Thirty = Array.from({ length: 32 }, (_, Index) => ({ ...Good, fileName: `m${Index}.dll` }));
    assert.equal(ParseUnexpectedModules(Thirty)!.length, 32);
    Invalid(() => ParseUnexpectedModules([...Thirty, { ...Good, fileName: "m32.dll" }]));
    Invalid(() => ParseUnexpectedModules("m.dll"));
    Invalid(() => ParseUnexpectedModules([null]));
    Invalid(() => ParseUnexpectedModules([["m.dll"]]));
    Invalid(() => ParseUnexpectedModules({ 0: Good }));
});

test("unexpectedModules: extra fields are dropped; only the four fields are kept", () => {
    const [Kept] = ParseUnexpectedModules([{ ...Good, path: "C:\\games\\x.dll", extra: true }])!;
    assert.deepEqual(Object.keys(Kept!).sort(), ["fileName", "sha256", "signer", "size"]);
});

// ---- Findings recorded from an accepted heartbeat ----

test("findings: an accepted heartbeat records each module once; sessionCount counts only what is new to the session", async () => {
    const Opened = OpenTestRealm("guard-report-findings");
    Cleanups.push(Opened.cleanup);
    UsePersistenceForTest({ repos: Opened.repos, uow: Opened.uow });
    const A = { ...Good, fileName: "A.dll", sha256: "1".repeat(64) };
    const B = { ...Good, fileName: "B.dll", sha256: "2".repeat(64) };

    assert.equal(await RecordGuardModuleFindings({ accountId: "acc-1", modules: [A, A], seenAt: "2026-10-14T10:00:00.000Z" }), 1, "a repeated entry counts once");
    assert.equal(await RecordGuardModuleFindings({ accountId: "acc-1", modules: [A, B], previousModules: [A], seenAt: "2026-10-14T10:00:20.000Z" }), 2);
    assert.equal(await RecordGuardModuleFindings({ accountId: "acc-2", modules: undefined, seenAt: "2026-10-14T10:00:40.000Z" }), 0);

    const Listed = (await Opened.repos.launcherGuard.listFindings({}, 0, 10)).records;
    const ByName = new Map(Listed.map((finding) => [finding.fileName, finding]));
    assert.equal(ByName.get("A.dll")?.sessionCount, 1, "new in the first heartbeat, not again in the second");
    assert.equal(ByName.get("B.dll")?.sessionCount, 1, "new in the second heartbeat");
    assert.equal(ByName.get("A.dll")?.accountCount, 1);
    assert.equal(ByName.get("A.dll")?.lastSeenAt, "2026-10-14T10:00:20.000Z");
});

test("findings: a storage failure is logged and does not refuse the heartbeat", async () => {
    const Opened = OpenTestRealm("guard-report-failure");
    Cleanups.push(Opened.cleanup);
    const Failing = {
        ...Opened.repos,
        launcherGuard: {
            ...Opened.repos.launcherGuard,
            recordFindingSighting: async () => { throw new Error("disk full"); }
        }
    };
    UsePersistenceForTest({ repos: Failing as unknown as typeof Opened.repos, uow: Opened.uow });
    const Recorded = await RecordGuardModuleFindings({ accountId: "acc-1", modules: [Good], seenAt: "2026-10-14T10:00:00.000Z" });
    assert.equal(Recorded, 0, "nothing recorded, and no error thrown");
});
