/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LauncherApiError } from "./launcherErrors";
import {
    AssertRuntimeArtifactSetApproved,
    AssertRuntimeChannelMatchesAccount,
    AssertRuntimeHashApproved,
    ExpectedRuntimeChannel,
    ParseRuntimeChannel,
    RuntimeManifestPath
} from "./runtimeAuthorization";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const CORE_ARTIFACTS = [
    { name: "MysticParadox.dll", sha256: HASH_A },
    { name: "winmm.dll", sha256: HASH_B }
];

function expectLauncherError(action: () => unknown, code: string): void {
    assert.throws(action, (error: unknown) => error instanceof LauncherApiError && error.code === code);
}

function withManifest(channel: "stable" | "beta" | "dev", hash: string, action: (root: string) => void): void {
    const Root = fs.mkdtempSync(path.join(os.tmpdir(), "mysticparadox-runtime-auth-"));
    const PreviousTarget = process.env.TARGET_CHANGELIST;
    process.env.TARGET_CHANGELIST = "392819";
    try {
        const ManifestPath = RuntimeManifestPath(channel, Root);
        fs.mkdirSync(path.dirname(ManifestPath), { recursive: true });
        fs.writeFileSync(ManifestPath, JSON.stringify({
            version: "0.1.78", targetChangelist: 392819, sha256: hash,
            extraFiles: CORE_ARTIFACTS.slice(1)
        }));
        action(Root);
    } finally {
        if (PreviousTarget === undefined) delete process.env.TARGET_CHANGELIST;
        else process.env.TARGET_CHANGELIST = PreviousTarget;
        fs.rmSync(Root, { recursive: true, force: true });
    }
}

test("runtime channel parser accepts only the three named channels", () => {
    assert.equal(ParseRuntimeChannel("stable"), "stable");
    assert.equal(ParseRuntimeChannel("beta"), "beta");
    assert.equal(ParseRuntimeChannel("dev"), "dev");
    expectLauncherError(() => ParseRuntimeChannel("preview"), "AUTH_VALIDATION_FAILED");
    expectLauncherError(() => ParseRuntimeChannel(undefined), "AUTH_VALIDATION_FAILED");
});

test("non-tester policy is stable and stable is authorized", () => {
    assert.equal(ExpectedRuntimeChannel(["player"]), "stable");
    assert.doesNotThrow(() => AssertRuntimeChannelMatchesAccount("stable", ["player"]));
});

test("non-tester beta and dev requests are denied", () => {
    expectLauncherError(() => AssertRuntimeChannelMatchesAccount("beta", ["player"]), "AUTH_TESTER_REQUIRED");
    expectLauncherError(() => AssertRuntimeChannelMatchesAccount("dev", ["player"]), "AUTH_TESTER_REQUIRED");
});

test("tester policy is beta and beta is authorized", () => {
    assert.equal(ExpectedRuntimeChannel(["player", "tester"]), "beta");
    assert.doesNotThrow(() => AssertRuntimeChannelMatchesAccount("beta", ["player", "tester"]));
});

test("tester cannot claim stable or dev when policy currently requires beta", () => {
    expectLauncherError(() => AssertRuntimeChannelMatchesAccount("stable", ["player", "tester"]), "AUTH_CHANNEL_MISMATCH");
    expectLauncherError(() => AssertRuntimeChannelMatchesAccount("dev", ["player", "tester"]), "AUTH_CHANNEL_MISMATCH");
});

test("approved runtime hash is accepted from the channel manifest", () => {
    withManifest("beta", HASH_A, (Root) => {
        assert.equal(AssertRuntimeHashApproved("beta", HASH_A.toUpperCase(), Root), HASH_A);
    });
});

test("runtime hash that does not match the channel manifest is denied", () => {
    withManifest("stable", HASH_A, (Root) => {
        expectLauncherError(() => AssertRuntimeHashApproved("stable", HASH_B, Root), "RUNTIME_BUILD_UNSUPPORTED");
    });
});

test("complete signed-manifest runtime set is accepted", () => {
    withManifest("stable", HASH_A, (Root) => {
        const approved = AssertRuntimeArtifactSetApproved("stable", "0.1.78",
            CORE_ARTIFACTS.map((entry) => ({ ...entry, sha256: entry.sha256.toUpperCase() })), Root);
        assert.equal(approved.version, "0.1.78");
        assert.equal(approved.runtimeSha256, HASH_A);
        assert.match(approved.artifactSetSha256, /^[a-f0-9]{64}$/);
        assert.deepEqual(approved.artifacts.map((entry) => entry.name).sort(), ["MysticParadox.dll", "winmm.dll"]);
    });
});

test("every runtime mutation, omission or unknown file is rejected", () => {
    withManifest("stable", HASH_A, (Root) => {
        const badProxy = CORE_ARTIFACTS.map((entry) => ({ ...entry }));
        badProxy[1].sha256 = "f".repeat(64);
        expectLauncherError(() => AssertRuntimeArtifactSetApproved("stable", "0.1.78", badProxy, Root),
            "RUNTIME_BUILD_UNSUPPORTED");
        expectLauncherError(() => AssertRuntimeArtifactSetApproved("stable", "0.1.78", CORE_ARTIFACTS.slice(0, 1), Root),
            "AUTH_VALIDATION_FAILED");
        expectLauncherError(() => AssertRuntimeArtifactSetApproved("stable", "0.1.78",
            [...CORE_ARTIFACTS, { name: "inject.dll", sha256: HASH_C }], Root), "AUTH_VALIDATION_FAILED");
    });
});

test("files the published manifest lists beyond the core set are not required of a launcher", () => {
    withManifest("stable", HASH_A, (Root) => {
        const manifestPath = RuntimeManifestPath("stable", Root);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.extraFiles = [...manifest.extraFiles, { name: "optional-module.bin", sha256: HASH_C }];
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        assert.doesNotThrow(() => AssertRuntimeArtifactSetApproved("stable", "0.1.78", CORE_ARTIFACTS, Root));
    });
});

test("stale runtime version and incomplete published manifest fail closed", () => {
    withManifest("stable", HASH_A, (Root) => {
        expectLauncherError(() => AssertRuntimeArtifactSetApproved("stable", "0.1.77",
            CORE_ARTIFACTS, Root), "RUNTIME_BUILD_UNSUPPORTED");
        const manifestPath = RuntimeManifestPath("stable", Root);
        const incomplete = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        incomplete.extraFiles = [];
        fs.writeFileSync(manifestPath, JSON.stringify(incomplete));
        expectLauncherError(() => AssertRuntimeArtifactSetApproved("stable", "0.1.78",
            CORE_ARTIFACTS, Root), "RUNTIME_BUILD_UNSUPPORTED");
    });
});
test("missing or wrong-build runtime manifest fails closed", () => {
    const Root = fs.mkdtempSync(path.join(os.tmpdir(), "mysticparadox-runtime-auth-missing-"));
    const PreviousTarget = process.env.TARGET_CHANGELIST;
    process.env.TARGET_CHANGELIST = "392819";
    try {
        expectLauncherError(() => AssertRuntimeHashApproved("stable", HASH_A, Root), "RUNTIME_BUILD_UNSUPPORTED");

        const ManifestPath = RuntimeManifestPath("stable", Root);
        fs.mkdirSync(path.dirname(ManifestPath), { recursive: true });
        fs.writeFileSync(ManifestPath, JSON.stringify({
            version: "0.1.78", targetChangelist: 1, sha256: HASH_A,
            extraFiles: CORE_ARTIFACTS.slice(1)
        }));
        expectLauncherError(() => AssertRuntimeHashApproved("stable", HASH_A, Root), "RUNTIME_BUILD_UNSUPPORTED");
    } finally {
        if (PreviousTarget === undefined) delete process.env.TARGET_CHANGELIST;
        else process.env.TARGET_CHANGELIST = PreviousTarget;
        fs.rmSync(Root, { recursive: true, force: true });
    }
});
