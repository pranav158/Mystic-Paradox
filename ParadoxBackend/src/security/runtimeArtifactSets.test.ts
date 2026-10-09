/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// A launcher reports the core runtime files, or the core plus every other file the published manifest lists (an
// optional module's files, such as a co-op transport). The optional names come from the manifest, not from code.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LauncherApiError } from "./launcherErrors";
import { AssertRuntimeArtifactSetApproved, RuntimeManifestPath } from "./runtimeAuthorization";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

const COMPLETE_ARTIFACTS = [
    { name: "MysticParadox.dll", sha256: HASH_A },
    { name: "winmm.dll", sha256: HASH_B },
    { name: "coop-transport.dll", sha256: HASH_C },
    { name: "coop-runtime.dll", sha256: HASH_D },
    { name: "coop-admission.key", sha256: HASH_E }
];

function expectLauncherError(action: () => unknown, code: string): void {
    assert.throws(action, (error: unknown) => error instanceof LauncherApiError && error.code === code);
}

function withManifest(action: (root: string) => void): void {
    const Root = fs.mkdtempSync(path.join(os.tmpdir(), "mysticparadox-runtime-auth-optional-"));
    const PreviousTarget = process.env.TARGET_CHANGELIST;
    process.env.TARGET_CHANGELIST = "392819";
    try {
        const ManifestPath = RuntimeManifestPath("stable", Root);
        fs.mkdirSync(path.dirname(ManifestPath), { recursive: true });
        fs.writeFileSync(ManifestPath, JSON.stringify({
            version: "0.1.78", targetChangelist: 392819, sha256: HASH_A,
            extraFiles: COMPLETE_ARTIFACTS.slice(1)
        }));
        action(Root);
    } finally {
        if (PreviousTarget === undefined) delete process.env.TARGET_CHANGELIST;
        else process.env.TARGET_CHANGELIST = PreviousTarget;
        fs.rmSync(Root, { recursive: true, force: true });
    }
}

test("the complete optional set is accepted with its own digest", () => {
    withManifest((Root) => {
        const full = AssertRuntimeArtifactSetApproved("stable", "0.1.78",
            COMPLETE_ARTIFACTS.map((entry) => ({ ...entry, sha256: entry.sha256.toUpperCase() })), Root);
        assert.equal(full.runtimeSha256, HASH_A);
        const core = AssertRuntimeArtifactSetApproved("stable", "0.1.78", COMPLETE_ARTIFACTS.slice(0, 2), Root);
        assert.notEqual(core.artifactSetSha256, full.artifactSetSha256);
    });
});

test("every optional file mutation or partial optional set is rejected", () => {
    withManifest((Root) => {
        for (let index = 1; index < COMPLETE_ARTIFACTS.length; index++) {
            const mutated = COMPLETE_ARTIFACTS.map((entry) => ({ ...entry }));
            mutated[index].sha256 = "f".repeat(64);
            expectLauncherError(() => AssertRuntimeArtifactSetApproved("stable", "0.1.78", mutated, Root),
                "RUNTIME_BUILD_UNSUPPORTED");
        }
        expectLauncherError(() => AssertRuntimeArtifactSetApproved("stable", "0.1.78",
            COMPLETE_ARTIFACTS.slice(0, -1), Root), "AUTH_VALIDATION_FAILED");
    });
});

test("a core-only published manifest serves core launchers and refuses unpublished files", () => {
    withManifest((Root) => {
        const manifestPath = RuntimeManifestPath("stable", Root);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.extraFiles = COMPLETE_ARTIFACTS.slice(1, 2);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        assert.doesNotThrow(() => AssertRuntimeArtifactSetApproved("stable", "0.1.78",
            COMPLETE_ARTIFACTS.slice(0, 2), Root));
        expectLauncherError(() => AssertRuntimeArtifactSetApproved("stable", "0.1.78",
            COMPLETE_ARTIFACTS, Root), "AUTH_VALIDATION_FAILED");
    });
});
