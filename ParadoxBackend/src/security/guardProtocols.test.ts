import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { LauncherGuardInternals, LauncherGuardSignatureMaterial, ParseLauncherGuardRole } from "../controllers/launcherGuard";
import { IsAuthorizedProgressionReader, IsAuthorizedProgressionReporter } from "../controllers/progression";

test("Launcher Guard signature material is ordered, versioned, and deterministic", () => {
    const material = LauncherGuardSignatureMaterial({
        role: "client",
        guardSessionId: "11111111-1111-4111-8111-111111111111",
        sequence: 7,
        challenge: "challenge",
        manifestId: "22222222-2222-4222-8222-222222222222",
        manifestSequence: 3,
        observedAt: "2026-08-12T00:00:00.000Z",
        signals: {
            gameProcessId: 42, gameStartedAt: "2026-08-12T00:00:01.000Z", moduleCount: 5,
            moduleSetDigest: "A".repeat(64), privateExecutableBytes: 0, writableExecutableBytes: 0,
            unexpectedModuleCount: 0, protectedPageMismatchCount: 0, debuggerPresent: false
        }
    });
    assert.equal(material.split("\n").length, 17);
    assert.equal(material.split("\n")[0], "MYSTIC-GUARD-2");
    assert.equal(material.split("\n")[1], "client");
    assert.equal(material.split("\n")[11], "a".repeat(64));
    const hostMaterial = LauncherGuardSignatureMaterial({
        role: "host",
        guardSessionId: "11111111-1111-4111-8111-111111111111",
        sequence: 7,
        challenge: "challenge",
        manifestId: "22222222-2222-4222-8222-222222222222",
        manifestSequence: 3,
        observedAt: "2026-08-12T00:00:00.000Z",
        signals: {
            gameProcessId: 42, gameStartedAt: "2026-08-12T00:00:01.000Z", moduleCount: 5,
            moduleSetDigest: "A".repeat(64), privateExecutableBytes: 0, writableExecutableBytes: 0,
            unexpectedModuleCount: 0, protectedPageMismatchCount: 0, debuggerPresent: false
        }
    });
    assert.notEqual(material, hostMaterial);
    assert.equal(crypto.createHash("sha256").update(material).digest("hex").length, 64);
});

test("Launcher Guard role parser defaults only legacy sessions to client", () => {
    assert.equal(ParseLauncherGuardRole(undefined, "client"), "client");
    assert.equal(ParseLauncherGuardRole("host"), "host");
    assert.equal(ParseLauncherGuardRole("worker"), undefined);
});

test("Launcher Guard detects post-warmup module-set and process identity changes", () => {
    const base = {
        gameProcessId: 42, gameStartedAt: "2026-08-12T00:00:01.000Z", moduleCount: 5,
        moduleSetDigest: "a".repeat(64), privateExecutableBytes: 0, writableExecutableBytes: 0,
        unexpectedModuleCount: 0, protectedPageMismatchCount: 0, debuggerPresent: false
    };
    assert.equal(LauncherGuardInternals.continuityRisk(base, { ...base, moduleSetDigest: "b".repeat(64) }, 1), 0);
    assert.equal(LauncherGuardInternals.continuityRisk(base, { ...base, moduleSetDigest: "b".repeat(64) }, 2), 50);
    assert.equal(LauncherGuardInternals.continuityRisk(base, { ...base, gameProcessId: 43 }, 2), 100);
});

test("Launcher Guard rejects a manifest after its signed expiry during heartbeat renewal", () => {
    const manifest = { manifestId: "manifest-a", sequence: 4, expiresAt: "2026-09-06T00:00:10.000Z" };
    const now = Date.parse("2026-09-06T00:00:09.000Z");
    assert.equal(LauncherGuardInternals.IsGuardManifestCurrent(manifest, "manifest-a", 4, now), true);
    assert.equal(LauncherGuardInternals.IsGuardManifestCurrent(manifest, "manifest-a", 4, now + 1_000), false);
    assert.equal(LauncherGuardInternals.IsGuardManifestCurrent(manifest, "manifest-b", 4, now), false);
});

test("Launcher Guard executable-memory thresholds tolerate bounded trampolines and flag excess", () => {
    const base = {
        gameProcessId: 42, gameStartedAt: "2026-08-12T00:00:01.000Z", moduleCount: 5,
        moduleSetDigest: "a".repeat(64), privateExecutableBytes: 512 * 1024,
        writableExecutableBytes: 32 * 1024, unexpectedModuleCount: 0,
        protectedPageMismatchCount: 0, debuggerPresent: false
    };
    assert.equal(LauncherGuardInternals.scoreSignals(base, 1024 * 1024, 64 * 1024), 0);
    assert.equal(LauncherGuardInternals.guardStatus(base, 1024 * 1024, 64 * 1024, 0), "HEALTHY");

    const writableExcess = { ...base, writableExecutableBytes: 64 * 1024 + 1 };
    assert.equal(LauncherGuardInternals.scoreSignals(writableExcess, 1024 * 1024, 64 * 1024), 60);
    assert.equal(LauncherGuardInternals.guardStatus(writableExcess, 1024 * 1024, 64 * 1024, 60), "DEGRADED");

    const privateExcess = { ...base, privateExecutableBytes: 1024 * 1024 + 1 };
    assert.equal(LauncherGuardInternals.scoreSignals(privateExcess, 1024 * 1024, 64 * 1024), 40);
    assert.equal(LauncherGuardInternals.guardStatus(privateExcess, 1024 * 1024, 64 * 1024, 40), "DEGRADED");

    const protectedMismatch = { ...base, protectedPageMismatchCount: 1 };
    assert.equal(LauncherGuardInternals.scoreSignals(protectedMismatch, 1024 * 1024, 64 * 1024), 30);
    assert.equal(LauncherGuardInternals.guardStatus(protectedMismatch, 1024 * 1024, 64 * 1024, 30), "DEGRADED");

    const unexpectedModule = { ...base, unexpectedModuleCount: 1 };
    assert.equal(LauncherGuardInternals.scoreSignals(unexpectedModule, 1024 * 1024, 64 * 1024), 15);
    assert.equal(LauncherGuardInternals.guardStatus(unexpectedModule, 1024 * 1024, 64 * 1024, 15), "DEGRADED");
});

test("player-host runtime cannot turn route-derived roster identity into progression authority", () => {
    assert.equal(IsAuthorizedProgressionReporter({ IsGameserver: true }, "player-2"), true);
    assert.equal(IsAuthorizedProgressionReporter({ userId: "player-2" }, "player-2"), true);
    assert.equal(IsAuthorizedProgressionReporter({ userId: "player-1" }, "player-2"), false);
    assert.equal(IsAuthorizedProgressionReporter({ IsPlayerHostRuntime: true, userId: "player-2" }, "player-2"), false);
});

test("progression reads are same-account unless performed by a dedicated gameserver", () => {
    assert.equal(IsAuthorizedProgressionReader({ IsGameserver: true }, "player-2"), true);
    assert.equal(IsAuthorizedProgressionReader({ userId: "player-2" }, "player-2"), true);
    assert.equal(IsAuthorizedProgressionReader({ userId: "player-1" }, "player-2"), false);
    assert.equal(IsAuthorizedProgressionReader({ IsPlayerHostRuntime: true, userId: "player-2" }, "player-2"), true);
});
