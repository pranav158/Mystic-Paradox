/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LauncherApiError } from "./launcherErrors";
import { TESTER_ROLE } from "./testerFeatures";
import { GetP2PExtension } from "../extensions/p2p";

export const RUNTIME_CHANNELS = ["stable", "beta", "dev"] as const;
export type RuntimeChannel = typeof RUNTIME_CHANNELS[number];

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const RUNTIME_TARGET = "client";
const RUNTIME_PLATFORM = "windows-x86_64";

interface RuntimeManifestRecord {
    version?: unknown;
    targetChangelist?: unknown;
    sha256?: unknown;
    extraFiles?: unknown;
}

export interface RuntimeArtifactHash {
    name: string;
    sha256: string;
}

export interface ApprovedRuntimeAttestation {
    version: string;
    runtimeSha256: string;
    artifactSetSha256: string;
    artifacts: RuntimeArtifactHash[];
}

/** Every launcher installs and reports these: the runtime and the winmm proxy that loads it. */
const CORE_INSTALLED_ARTIFACTS = ["MysticParadox.dll", "winmm.dll"];

/**
 * Files a launcher built with an optional module installs and reports, all or none (src/extensions).
 * The game client never loads them; a launcher without the module reports the core files alone.
 */
function ModuleInstalledArtifacts(): readonly string[] {
    return GetP2PExtension().launcher.runtimeArtifacts;
}

const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,96}$/;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function ParseRuntimeChannel(value: unknown): RuntimeChannel {
    if (typeof value === "string" && (RUNTIME_CHANNELS as readonly string[]).includes(value)) {
        return value as RuntimeChannel;
    }
    throw new LauncherApiError("AUTH_VALIDATION_FAILED", "runtimeChannel must be stable, beta, or dev.");
}

export function NormalizeRuntimeSha256(value: unknown): string {
    const Normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!SHA256_HEX_PATTERN.test(Normalized)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "runtimeSha256 must be a SHA-256 hash.");
    }
    return Normalized;
}

function NormalizePublishedRuntimeSha256(value: unknown): string {
    try {
        return NormalizeRuntimeSha256(value);
    } catch {
        throw new LauncherApiError(
            "RUNTIME_BUILD_UNSUPPORTED",
            "The published runtime manifest has an invalid SHA-256 hash."
        );
    }
}

function HasAll(seen: Set<string>, names: readonly string[]): boolean {
    return names.every((name) => seen.has(name.toLowerCase()));
}

/** A launcher reports either the core set or the core plus all of the module's files. */
function NormalizeRuntimeArtifactSet(value: unknown): RuntimeArtifactHash[] {
    const moduleArtifacts = ModuleInstalledArtifacts();
    const knownArtifacts = new Set([...CORE_INSTALLED_ARTIFACTS, ...moduleArtifacts].map((name) => name.toLowerCase()));
    if (!Array.isArray(value) || value.length > knownArtifacts.size) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "The complete runtime artifact set is required.");
    }
    const seen = new Set<string>();
    const normalized = value.map((raw) => {
        const input = raw as Partial<RuntimeArtifactHash>;
        const name = typeof input?.name === "string" ? input.name : "";
        if (!SAFE_ARTIFACT_NAME.test(name) || seen.has(name.toLowerCase()) ||
            !knownArtifacts.has(name.toLowerCase())) {
            throw new LauncherApiError("AUTH_VALIDATION_FAILED", "The runtime artifact set is malformed.");
        }
        seen.add(name.toLowerCase());
        return { name, sha256: NormalizeRuntimeSha256(input.sha256) };
    });
    const reportsModule = moduleArtifacts.some((name) => seen.has(name.toLowerCase()));
    if (!HasAll(seen, CORE_INSTALLED_ARTIFACTS) || (reportsModule && !HasAll(seen, moduleArtifacts))) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "The complete runtime artifact set is required.");
    }
    return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function ArtifactSetDigest(artifacts: RuntimeArtifactHash[]): string {
    return crypto.createHash("sha256")
        .update(artifacts.map((entry) => `${entry.name.toLowerCase()}:${entry.sha256}`).join("\n"))
        .digest("hex");
}

/** The channel returned by the current launcher policy for this account. */
export function ExpectedRuntimeChannel(roles: readonly string[]): RuntimeChannel {
    return roles.includes(TESTER_ROLE) ? "beta" : "stable";
}

/**
 * Enforces the server-derived policy channel rather than trusting the channel declared by a
 * launcher. This deliberately rejects a non-tester claiming stable while actually retaining a
 * cached beta DLL once the runtime hash check below is also applied.
 */
export function AssertRuntimeChannelMatchesAccount(requested: RuntimeChannel, roles: readonly string[]): void {
    const Expected = ExpectedRuntimeChannel(roles);
    if (requested === Expected) return;

    if (requested !== "stable" && !roles.includes(TESTER_ROLE)) {
        throw new LauncherApiError("AUTH_TESTER_REQUIRED", "Tester access is required for this channel.");
    }

    throw new LauncherApiError(
        "AUTH_CHANNEL_MISMATCH",
        `Your account currently requires the ${Expected} runtime channel.`
    );
}

export function RuntimeUpdateRoot(): string {
    return path.resolve(process.env.LAUNCHER_UPDATE_ROOT ?? path.join(process.cwd(), "updates"));
}

export function RuntimeManifestPath(channel: RuntimeChannel, updateRoot = RuntimeUpdateRoot()): string {
    return path.join(updateRoot, "runtime", RUNTIME_TARGET, channel, RUNTIME_PLATFORM, "latest.json");
}

export function GetApprovedRuntimeSha256(channel: RuntimeChannel, updateRoot = RuntimeUpdateRoot()): string {
    let Manifest: RuntimeManifestRecord;
    try {
        Manifest = JSON.parse(fs.readFileSync(RuntimeManifestPath(channel, updateRoot), "utf8")) as RuntimeManifestRecord;
    } catch {
        throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", `No approved ${channel} runtime is currently published.`);
    }

    const TargetChangelist = Number(process.env.TARGET_CHANGELIST ?? NaN);
    if (!Number.isFinite(TargetChangelist) || Number(Manifest.targetChangelist) !== TargetChangelist) {
        throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", "The published runtime does not match the supported game build.");
    }

    const Hash = typeof Manifest.sha256 === "string" ? Manifest.sha256.trim().toLowerCase() : "";
    if (!SHA256_HEX_PATTERN.test(Hash)) {
        throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", "The published runtime manifest has an invalid SHA-256 hash.");
    }
    return Hash;
}

export function GetApprovedRuntimeAttestation(channel: RuntimeChannel,
    updateRoot = RuntimeUpdateRoot()): ApprovedRuntimeAttestation {
    let manifest: RuntimeManifestRecord;
    try {
        manifest = JSON.parse(fs.readFileSync(RuntimeManifestPath(channel, updateRoot), "utf8")) as RuntimeManifestRecord;
    } catch {
        throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", `No approved ${channel} runtime is currently published.`);
    }
    const targetChangelist = Number(process.env.TARGET_CHANGELIST ?? NaN);
    const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
    if (!Number.isFinite(targetChangelist) || Number(manifest.targetChangelist) !== targetChangelist ||
        !SAFE_VERSION.test(version)) {
        throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", "The published runtime manifest is invalid or targets another game build.");
    }
    const mainHash = NormalizePublishedRuntimeSha256(manifest.sha256);
    if (!Array.isArray(manifest.extraFiles)) {
        throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", "The published runtime manifest is incomplete.");
    }
    const artifacts: RuntimeArtifactHash[] = [{ name: "MysticParadox.dll", sha256: mainHash }];
    const seen = new Set(["mysticparadox.dll"]);
    for (const raw of manifest.extraFiles) {
        const extra = raw as { name?: unknown; sha256?: unknown };
        const name = typeof extra?.name === "string" ? extra.name : "";
        if (!SAFE_ARTIFACT_NAME.test(name) || seen.has(name.toLowerCase())) {
            throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", "The published runtime manifest has a duplicate or unsafe artifact.");
        }
        seen.add(name.toLowerCase());
        artifacts.push({ name, sha256: NormalizePublishedRuntimeSha256(extra.sha256) });
    }
    const normalized = artifacts.sort((left, right) => left.name.localeCompare(right.name));
    if (!HasAll(seen, CORE_INSTALLED_ARTIFACTS)) {
        throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", "The published runtime manifest does not contain the complete required artifact set.");
    }
    return { version, runtimeSha256: mainHash, artifactSetSha256: ArtifactSetDigest(normalized), artifacts: normalized };
}

/**
 * Every reported file must match the signed manifest's hash for that name. A launcher reports the
 * core set, or the core plus all of an optional module's files, so module files the manifest also
 * lists are not required of a core client. The returned digest covers the set actually verified.
 */
export function AssertRuntimeArtifactSetApproved(channel: RuntimeChannel, requestedVersion: unknown,
    requestedArtifacts: unknown, updateRoot = RuntimeUpdateRoot()): ApprovedRuntimeAttestation {
    const version = typeof requestedVersion === "string" ? requestedVersion.trim() : "";
    if (!SAFE_VERSION.test(version)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "runtimeManifestVersion is invalid.");
    }
    const actual = NormalizeRuntimeArtifactSet(requestedArtifacts);
    const approved = GetApprovedRuntimeAttestation(channel, updateRoot);
    const approvedByName = new Map(approved.artifacts.map((entry) => [entry.name.toLowerCase(), entry.sha256]));
    if (version !== approved.version ||
        actual.some((entry) => approvedByName.get(entry.name.toLowerCase()) !== entry.sha256)) {
        throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", `The installed ${channel} runtime set is not the approved release.`);
    }
    return { ...approved, artifactSetSha256: ArtifactSetDigest(actual), artifacts: actual };
}

export function AssertRuntimeHashApproved(
    channel: RuntimeChannel,
    runtimeSha256: unknown,
    updateRoot = RuntimeUpdateRoot()
): string {
    const Actual = NormalizeRuntimeSha256(runtimeSha256);
    const Approved = GetApprovedRuntimeSha256(channel, updateRoot);
    if (Actual !== Approved) {
        throw new LauncherApiError("RUNTIME_BUILD_UNSUPPORTED", `The installed ${channel} runtime is not the approved release.`);
    }
    return Actual;
}
