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
    ArtifactHashesMatch,
    HostIneligibilityReason,
    KNOWN_GAME_EXE_SHA256,
    P2PArtifactSources,
    ReadP2PArtifactPolicy,
    ReadP2PHostEligibilityPolicy,
    ReadP2PHuntDrainCapMs,
    ScoreHost
} from "./p2pHostPolicy";

// No feed: only the environment (and the built-in exe table) can supply hashes.
const NO_FEED: P2PArtifactSources = {};
import { P2PArtifactHashes, P2PHostPresenceRecord } from "../persistence";

const HASHES: P2PArtifactHashes = {
    gameExe: "11".repeat(32),
    internalServer: "22".repeat(32),
    winmmProxy: "33".repeat(32),
    steamBridge: "44".repeat(32),
    steamRuntime: "55".repeat(32),
    admissionPublicKey: "66".repeat(32)
};

function Presence(overrides: Partial<P2PHostPresenceRecord> = {}): P2PHostPresenceRecord {
    const now = Date.now();
    return {
        accountId: "host-a",
        revision: 1,
        consentToHost: true,
        observedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 30_000).toISOString(),
        freePhysicalMemoryMiB: 16_384,
        commitHeadroomMiB: 24_576,
        logicalCpuCount: 12,
        cpuLoadPercent: 20,
        powerSaver: false,
        runtimeSupported: true,
        steamRuntimeReady: true,
        backendRttMs: 30,
        worstPeerRttMs: 50,
        jitterMs: 4,
        packetLossPercent: 0,
        artifacts: HASHES,
        artifactsVerified: true,
        launcherVersion: "0.1.35",
        ...overrides
    };
}

test("artifact policy requires all six exact release hashes", () => {
    assert.throws(() => ReadP2PArtifactPolicy({}, NO_FEED), /Missing or invalid/);
    const environment = {
        P2P_GAME_EXE_SHA256: HASHES.gameExe,
        P2P_INTERNAL_SERVER_SHA256: HASHES.internalServer,
        P2P_WINMM_SHA256: HASHES.winmmProxy,
        P2P_TRANSPORT_MODULE_SHA256: HASHES.steamBridge,
        P2P_TRANSPORT_RUNTIME_SHA256: HASHES.steamRuntime,
        P2P_ADMISSION_PUBLIC_XY_SHA256: HASHES.admissionPublicKey
    };
    const policy = ReadP2PArtifactPolicy(environment, NO_FEED);
    assert.equal(ArtifactHashesMatch(HASHES, policy), true);
    assert.equal(ArtifactHashesMatch({ ...HASHES, steamBridge: "77".repeat(32) }, policy), false);
});

test("artifact policy still reads the transport hashes under their older key names", () => {
    const legacy = ReadP2PArtifactPolicy({
        P2P_GAME_EXE_SHA256: HASHES.gameExe,
        P2P_INTERNAL_SERVER_SHA256: HASHES.internalServer,
        P2P_WINMM_SHA256: HASHES.winmmProxy,
        P2P_STEAM_BRIDGE_SHA256: HASHES.steamBridge,
        P2P_STEAM_RUNTIME_SHA256: HASHES.steamRuntime,
        P2P_ADMISSION_PUBLIC_XY_SHA256: HASHES.admissionPublicKey
    }, NO_FEED);
    assert.equal(ArtifactHashesMatch(HASHES, legacy), true);
});

test("the drain cap defaults to no cap; 0 says no cap; 30 s to 10 min sets one; anything else is the default (2026-10-15)", () => {
    assert.equal(ReadP2PHuntDrainCapMs({}), undefined, "unset: no cap");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: "" }), undefined, "blank: no cap");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: "0" }), undefined, "0 is explicitly no cap");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: " 60000 " }), 60_000, "a cap in range is read, trimmed");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: "30000" }), 30_000, "the floor is in range");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: "600000" }), 600_000, "the ceiling is in range");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: "5000" }), undefined, "below the floor: no cap");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: "900000" }), undefined, "above the ceiling: no cap");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: "-60000" }), undefined, "negative: no cap");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: "soon" }), undefined, "not a number: no cap");
    assert.equal(ReadP2PHuntDrainCapMs({ P2P_HUNT_DRAIN_GRACE_MS: "Infinity" }), undefined, "not finite: no cap");
});

test("host eligibility fails closed for consent, integrity, resources, and concurrent hosting", () => {
    const policy = ReadP2PHostEligibilityPolicy({});
    assert.equal(HostIneligibilityReason(Presence({ consentToHost: false }), undefined, 0, policy), "HOST_CONSENT_REQUIRED");
    assert.equal(HostIneligibilityReason(Presence({ launcherVersion: "0.1.30" }), undefined, 0, policy), "HOST_LAUNCHER_OUTDATED");
    assert.equal(HostIneligibilityReason(Presence({ launcherVersion: "invalid" }), undefined, 0, policy), "HOST_LAUNCHER_OUTDATED");
    assert.equal(HostIneligibilityReason(Presence({ artifactsVerified: false }), undefined, 0, policy), "HOST_RUNTIME_UNVERIFIED");
    assert.equal(HostIneligibilityReason(Presence({ freePhysicalMemoryMiB: 512 }), undefined, 0, policy), "HOST_MEMORY_LOW");
    assert.equal(HostIneligibilityReason(Presence(), undefined, 1, policy), "HOST_ALREADY_ACTIVE");
    assert.equal(HostIneligibilityReason(Presence({ guardVerified: false }), undefined, 0, policy, true), "HOST_GUARD_UNVERIFIED");
    assert.equal(HostIneligibilityReason(Presence(), undefined, 0, policy), undefined);
});

test("automatic hosting requires launcher 0.1.35 or an explicit newer floor", () => {
    assert.equal(ReadP2PHostEligibilityPolicy({}).minimumLauncherVersion, "0.1.35");
    const newer = ReadP2PHostEligibilityPolicy({ P2P_HOST_MIN_LAUNCHER_VERSION: "0.2.0" });
    assert.equal(HostIneligibilityReason(Presence({ launcherVersion: "0.1.99" }), undefined, 0, newer), "HOST_LAUNCHER_OUTDATED");
    assert.equal(HostIneligibilityReason(Presence({ launcherVersion: "0.2.0" }), undefined, 0, newer), undefined);
});

test("central score prefers the lower-latency and more stable eligible host", () => {
    const policy = ReadP2PHostEligibilityPolicy({});
    const reliable = ScoreHost(Presence(), {
        accountId: "host-a",
        offersAccepted: 20,
        offersDeclined: 0,
        offersExpired: 0,
        startsSucceeded: 20,
        startsFailed: 0,
        cleanCompletions: 20,
        unexpectedFailures: 0,
        updatedAt: new Date().toISOString()
    }, policy, 0);
    const risky = ScoreHost(Presence({ worstPeerRttMs: 220, jitterMs: 60, packetLossPercent: 8 }), {
        accountId: "host-b",
        offersAccepted: 10,
        offersDeclined: 0,
        offersExpired: 0,
        startsSucceeded: 2,
        startsFailed: 4,
        cleanCompletions: 1,
        unexpectedFailures: 4,
        updatedAt: new Date().toISOString()
    }, policy, 0);
    assert.ok(reliable.score < risky.score);
});

// The local feed's shape (MysticUpdates/runtime/client/stable/windows-x86_64/latest.json, 11 Oct 2026).
const FEED: P2PArtifactSources = {
    runtimeManifest: {
        schema: 1, component: "ParadoxRuntime", target: "client", version: "0.2.128", channel: "stable",
        targetChangelist: 647472, sha256: HASHES.internalServer.toUpperCase(),
        extraFiles: [
            { name: "WINMM.dll", sha256: HASHES.winmmProxy },
            { name: "steam_api64.dll", sha256: "99".repeat(32) }
        ]
    },
    guardArtifacts: [
        { role: "GAME", sha256: "aa".repeat(32) },
        { role: "INTERNAL_SERVER", sha256: HASHES.internalServer },
        { role: "TRANSPORT_MODULE", sha256: HASHES.steamBridge },
        { role: "TRANSPORT_RUNTIME", sha256: HASHES.steamRuntime },
        { role: "ADMISSION_KEY", sha256: HASHES.admissionPublicKey }
    ]
};

test("artifact policy derives the runtime, winmm and co-op hashes from the feed and the exe from the changelist (B3)", () => {
    const policy = ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "647472" }, FEED);
    assert.equal(policy.gameExe, KNOWN_GAME_EXE_SHA256[647472]);
    assert.equal(policy.gameExe, "f3f95fbf22709ef077a11632ed95d675b7209b7e0172d9ecb9ba7d02a1fbb66b");
    assert.equal(policy.internalServer, HASHES.internalServer);
    assert.equal(policy.winmmProxy, HASHES.winmmProxy);
    assert.equal(policy.steamBridge, HASHES.steamBridge);
    assert.equal(policy.steamRuntime, HASHES.steamRuntime);
    assert.equal(policy.admissionPublicKey, HASHES.admissionPublicKey);
    assert.equal(ArtifactHashesMatch({ ...HASHES, gameExe: KNOWN_GAME_EXE_SHA256[647472] }, policy), true);
});

test("an ICE manifest without a TRANSPORT_RUNTIME role expects the transport module for both co-op hashes", () => {
    const iceFeed: P2PArtifactSources = {
        ...FEED,
        guardArtifacts: FEED.guardArtifacts!.filter((artifact) => artifact.role !== "TRANSPORT_RUNTIME")
    };
    const policy = ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "647472" }, iceFeed);
    assert.equal(policy.steamBridge, HASHES.steamBridge);
    assert.equal(policy.steamRuntime, HASHES.steamBridge);
});

test("an .env pin still overrides the feed, and an unknown changelist needs its exe pin", () => {
    const pinned = ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "647472", P2P_INTERNAL_SERVER_SHA256: "77".repeat(32),
        P2P_GAME_EXE_SHA256: HASHES.gameExe }, FEED);
    assert.equal(pinned.internalServer, "77".repeat(32));
    assert.equal(pinned.gameExe, HASHES.gameExe);
    assert.equal(pinned.winmmProxy, HASHES.winmmProxy);
    const olderFeed: P2PArtifactSources = { ...FEED, runtimeManifest: { ...FEED.runtimeManifest, targetChangelist: 392819 } };
    assert.throws(() => ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "392819" }, olderFeed), /P2P_GAME_EXE_SHA256/);
    assert.equal(ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "392819", P2P_GAME_EXE_SHA256: HASHES.gameExe }, olderFeed).gameExe,
        HASHES.gameExe);
    // A blank KEY= line (as copied from .env.p2p.example) is no pin: the feed value is used.
    assert.equal(ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "647472", P2P_INTERNAL_SERVER_SHA256: "", P2P_GAME_EXE_SHA256: " " }, FEED)
        .internalServer, HASHES.internalServer);
    // A malformed pin is a configuration error, not a fallback to the feed.
    assert.throws(() => ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "647472", P2P_WINMM_SHA256: "not-a-hash" }, FEED), /P2P_WINMM_SHA256/);
});

test("a feed for another changelist, or a Guard manifest without co-op roles, supplies nothing", () => {
    assert.throws(() => ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "647472" },
        { ...FEED, runtimeManifest: { ...FEED.runtimeManifest, targetChangelist: 392819 } }), /P2P_INTERNAL_SERVER_SHA256/);
    // Today's stable Guard manifest (seq 61) has only GAME/LAUNCHER/INTERNAL_SERVER/UDP_PROXY.
    assert.throws(() => ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "647472" },
        { ...FEED, guardArtifacts: FEED.guardArtifacts!.slice(0, 2) }), /P2P_TRANSPORT_MODULE_SHA256/);
    assert.equal(ReadP2PArtifactPolicy({ TARGET_CHANGELIST: "647472", P2P_TRANSPORT_MODULE_SHA256: HASHES.steamBridge,
        P2P_TRANSPORT_RUNTIME_SHA256: HASHES.steamRuntime, P2P_ADMISSION_PUBLIC_XY_SHA256: HASHES.admissionPublicKey },
        { ...FEED, guardArtifacts: [] }).steamBridge, HASHES.steamBridge);
});
