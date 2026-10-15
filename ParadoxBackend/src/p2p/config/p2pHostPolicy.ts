import {
    P2PArtifactHashes,
    P2PHostPresenceRecord,
    P2PHostReliabilityRecord,
    P2PHostScoreBreakdown
} from "../persistence";
import { VersionAtLeast } from "../../security/launcherVersion";
import { logger } from "../../logger";
import { GuardRequiredByEnvironment } from "../../services/guardMode";

const SHA256 = /^[a-f0-9]{64}$/i;

/*
 * [2026-10-11 P2P on 1.14.7, plan 39_ §13.1 B3] Where the artifact hashes a player host must match come from.
 *
 * They were six required .env pins, and the pins on this server were stale (the 1.12 exe, runtime 0.1.83, an old
 * winmm), so every host reported HOST_RUNTIME_UNVERIFIED and could never be selected. Now, per artifact, the first of:
 *   1. the .env value (kept as an explicit override; a pin that differs from the feed is logged once as stale -
 *      remove it from .env to follow the feed),
 *   2. what the feed serves: the client runtime feed's latest manifest for P2P_RUNTIME_CHANNEL (default stable) gives
 *      the runtime DLL (`sha256`) and the winmm proxy (extra file winmm.dll); the signed Guard manifest of the same
 *      channel gives the co-op roles TRANSPORT_MODULE, TRANSPORT_RUNTIME and ADMISSION_KEY (their file names stay feed
 *      data),
 *   3. for the game executable, the known hash of TARGET_CHANGELIST (KNOWN_GAME_EXE_SHA256).
 * An artifact with none of these is still "Missing or invalid" (the caller fails closed).
 */
export const KNOWN_GAME_EXE_SHA256: Readonly<Record<number, string>> = Object.freeze({
    // Dauntless 1.14.7, CL 647472: Dauntless-Win64-Shipping.exe, 121,407,264 bytes. The GAME artifact of the signed
    // stable Guard manifest seq 61, and the hash of the installed file, both checked on 11 Oct 2026.
    647472: "f3f95fbf22709ef077a11632ed95d675b7209b7e0172d9ecb9ba7d02a1fbb66b"
});

/** What the update feed serves, as read by ReadP2PArtifactSources (injectable for tests). */
export interface P2PArtifactSources {
    /** The client runtime feed's latest.json for the P2P channel. */
    runtimeManifest?: Record<string, unknown>;
    /** Role and SHA-256 of each artifact of the signed Guard manifest of the same channel. */
    guardArtifacts?: ReadonlyArray<{ role: string; sha256: string }>;
}

const ARTIFACT_SOURCE_CACHE_MS = 5_000;
let ArtifactSourceCache: { channel: string; at: number; sources: P2PArtifactSources } | undefined;

function RuntimeChannel(environment: NodeJS.ProcessEnv): string {
    const value = environment.P2P_RUNTIME_CHANNEL?.trim() ?? "";
    return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : "stable";
}

/** The feed's current runtime manifest and Guard artifacts for P2P_RUNTIME_CHANNEL, cached for a few seconds. */
export function ReadP2PArtifactSources(environment: NodeJS.ProcessEnv = process.env, now = Date.now()): P2PArtifactSources {
    const channel = RuntimeChannel(environment);
    if (ArtifactSourceCache != undefined && ArtifactSourceCache.channel === channel && now - ArtifactSourceCache.at < ARTIFACT_SOURCE_CACHE_MS) {
        return ArtifactSourceCache.sources;
    }
    // Loaded on first use: the feed layout belongs to the launcher update routes.
    const feed = require("../../routes/launcherUpdates") as typeof import("../../routes/launcherUpdates");
    const sources: P2PArtifactSources = {
        runtimeManifest: feed.ReadPublishedRuntimeManifest("client", channel),
        guardArtifacts: feed.ReadPublishedGuardArtifacts(channel)
    };
    ArtifactSourceCache = { channel, at: now, sources };
    return sources;
}

function FeedChangelistMatches(manifest: Record<string, unknown>, environment: NodeJS.ProcessEnv): boolean {
    const expected = Number(environment.TARGET_CHANGELIST);
    return !Number.isSafeInteger(expected) || manifest.targetChangelist === undefined || manifest.targetChangelist === expected;
}

function FeedRuntimeHash(sources: P2PArtifactSources, environment: NodeJS.ProcessEnv): string | undefined {
    const manifest = sources.runtimeManifest;
    if (manifest == undefined || !FeedChangelistMatches(manifest, environment)) return undefined;
    return typeof manifest.sha256 === "string" && SHA256.test(manifest.sha256) ? manifest.sha256.toLowerCase() : undefined;
}

function FeedExtraFileHash(sources: P2PArtifactSources, environment: NodeJS.ProcessEnv, fileName: string): string | undefined {
    const manifest = sources.runtimeManifest;
    if (manifest == undefined || !FeedChangelistMatches(manifest, environment) || !Array.isArray(manifest.extraFiles)) return undefined;
    const entry = (manifest.extraFiles as any[]).find((file) =>
        typeof file?.name === "string" && file.name.toLowerCase() === fileName.toLowerCase());
    return typeof entry?.sha256 === "string" && SHA256.test(entry.sha256) ? entry.sha256.toLowerCase() : undefined;
}

function GuardRoleHash(sources: P2PArtifactSources, role: string): string | undefined {
    const entry = sources.guardArtifacts?.find((artifact) => artifact.role === role);
    return typeof entry?.sha256 === "string" && SHA256.test(entry.sha256) ? entry.sha256.toLowerCase() : undefined;
}

function KnownGameExeHash(environment: NodeJS.ProcessEnv): string | undefined {
    const changelist = Number(environment.TARGET_CHANGELIST);
    return Number.isSafeInteger(changelist) ? KNOWN_GAME_EXE_SHA256[changelist] : undefined;
}

const ReportedStalePins = new Set<string>();

/**
 * The first set name wins; later names are older spellings of the same setting. Without one (an empty value, as the
 * blank KEY= lines of .env.p2p.example give, counts as unset) the derived value is used; with neither the artifact is
 * missing.
 */
function RequiredHash(environment: NodeJS.ProcessEnv, derived: string | undefined, name: string, ...legacyNames: string[]): string {
    const set = [name, ...legacyNames].find((key) => (environment[key] ?? "").trim().length > 0);
    if (set === undefined) {
        if (derived !== undefined) return derived;
        throw new Error(`Missing or invalid ${name}.`);
    }
    const value = (environment[set] ?? "").trim();
    if (!SHA256.test(value)) throw new Error(`Missing or invalid ${name}.`);
    const pinned = value.toLowerCase();
    if (derived !== undefined && derived !== pinned) {
        const report = `${set}:${pinned}:${derived}`;
        if (!ReportedStalePins.has(report)) {
            ReportedStalePins.add(report);
            logger.warn(`[P2PArtifacts] ${set} pins ${pinned.slice(0, 12)}... but the feed serves ${derived.slice(0, 12)}...; ` +
                "the pin wins, so hosts on the feed's file are refused (HOST_RUNTIME_UNVERIFIED). Remove the pin to follow the feed.");
        }
    }
    return pinned;
}

function BoundedNumber(environment: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
    const value = Number(environment[name]);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function LauncherVersion(environment: NodeJS.ProcessEnv): string {
    const value = environment.P2P_HOST_MIN_LAUNCHER_VERSION?.trim() ?? "";
    return /^\d+\.\d+\.\d+$/.test(value) ? value : "0.1.35";
}

export function ReadP2PArtifactPolicy(
    environment: NodeJS.ProcessEnv = process.env,
    sources: P2PArtifactSources = ReadP2PArtifactSources(environment)
): P2PArtifactHashes {
    return {
        gameExe: RequiredHash(environment, KnownGameExeHash(environment), "P2P_GAME_EXE_SHA256"),
        internalServer: RequiredHash(environment, FeedRuntimeHash(sources, environment), "P2P_INTERNAL_SERVER_SHA256"),
        winmmProxy: RequiredHash(environment, FeedExtraFileHash(sources, environment, "winmm.dll"), "P2P_WINMM_SHA256"),
        steamBridge: RequiredHash(environment, GuardRoleHash(sources, "TRANSPORT_MODULE"),
            "P2P_TRANSPORT_MODULE_SHA256", "P2P_STEAM_BRIDGE_SHA256"),
        // [2026-10-13] The ICE transport module has no separate runtime: a manifest without a TRANSPORT_RUNTIME role
        // expects the module's own hash here, and launchers report the module for both.
        steamRuntime: RequiredHash(environment,
            GuardRoleHash(sources, "TRANSPORT_RUNTIME") ?? GuardRoleHash(sources, "TRANSPORT_MODULE"),
            "P2P_TRANSPORT_RUNTIME_SHA256", "P2P_STEAM_RUNTIME_SHA256"),
        admissionPublicKey: RequiredHash(environment, GuardRoleHash(sources, "ADMISSION_KEY"), "P2P_ADMISSION_PUBLIC_XY_SHA256")
    };
}

export function ArtifactHashesMatch(actual: P2PArtifactHashes, expected: P2PArtifactHashes): boolean {
    return Object.keys(expected).every((key) => {
        const field = key as keyof P2PArtifactHashes;
        return SHA256.test(actual[field]) && actual[field].toLowerCase() === expected[field].toLowerCase();
    });
}

export interface P2PHostEligibilityPolicy {
    minimumLauncherVersion: string;
    minimumFreeMemoryMiB: number;
    minimumCommitHeadroomMiB: number;
    minimumLogicalCpuCount: number;
    maximumCpuLoadPercent: number;
    maximumWorstPeerRttMs: number;
    maximumJitterMs: number;
    maximumPacketLossPercent: number;
    presenceMaximumAgeMs: number;
    offerLifetimeMs: number;
    startupLifetimeMs: number;
    leaseLifetimeMs: number;
    suspectLifetimeMs: number;
    rejoinLifetimeMs: number;
    maximumReconnects: number;
}

export function ReadP2PHostEligibilityPolicy(environment: NodeJS.ProcessEnv = process.env): P2PHostEligibilityPolicy {
    return {
        minimumLauncherVersion: LauncherVersion(environment),
        minimumFreeMemoryMiB: BoundedNumber(environment, "P2P_HOST_MIN_FREE_MEMORY_MIB", 4096, 1024, 262144),
        minimumCommitHeadroomMiB: BoundedNumber(environment, "P2P_HOST_MIN_COMMIT_HEADROOM_MIB", 6144, 1024, 262144),
        minimumLogicalCpuCount: BoundedNumber(environment, "P2P_HOST_MIN_LOGICAL_CPUS", 4, 2, 256),
        maximumCpuLoadPercent: BoundedNumber(environment, "P2P_HOST_MAX_CPU_PERCENT", 85, 10, 100),
        maximumWorstPeerRttMs: BoundedNumber(environment, "P2P_HOST_MAX_WORST_RTT_MS", 250, 20, 2000),
        maximumJitterMs: BoundedNumber(environment, "P2P_HOST_MAX_JITTER_MS", 80, 1, 1000),
        maximumPacketLossPercent: BoundedNumber(environment, "P2P_HOST_MAX_PACKET_LOSS_PERCENT", 10, 0, 100),
        presenceMaximumAgeMs: BoundedNumber(environment, "P2P_HOST_PRESENCE_MAX_AGE_MS", 30_000, 5_000, 300_000),
        offerLifetimeMs: BoundedNumber(environment, "P2P_HOST_OFFER_LIFETIME_MS", 15_000, 5_000, 120_000),
        startupLifetimeMs: BoundedNumber(environment, "P2P_HOST_STARTUP_LIFETIME_MS", 120_000, 30_000, 600_000),
        leaseLifetimeMs: BoundedNumber(environment, "P2P_HOST_LEASE_LIFETIME_MS", 10_000, 4_000, 60_000),
        suspectLifetimeMs: BoundedNumber(environment, "P2P_HOST_SUSPECT_LIFETIME_MS", 15_000, 5_000, 120_000),
        rejoinLifetimeMs: BoundedNumber(environment, "P2P_REJOIN_LIFETIME_MS", 60_000, 10_000, 300_000),
        maximumReconnects: Math.floor(BoundedNumber(environment, "P2P_MAX_RECONNECTS", 3, 1, 10))
    };
}

/**
 * [2026-10-15] The cap on how long a superseded Tier 0 hunt keeps its server for the players still in it (BeginDrainPartySession), in
 * ms, or undefined for no cap. The default is no cap: a drained server runs while a player is in it and ends when it empties (the game
 * server exits 50 s after its last client leaves). 0 is no cap too, said explicitly. 30000 to 600000 sets the cap; any other value (blank,
 * garbage, out of range) is the default, no cap.
 */
export function ReadP2PHuntDrainCapMs(environment: NodeJS.ProcessEnv = process.env): number | undefined {
    const raw = (environment.P2P_HUNT_DRAIN_GRACE_MS ?? "").trim();
    if (raw.length === 0) return undefined;
    const value = Number(raw);
    if (value === 0 || !Number.isFinite(value) || value < 30_000 || value > 600_000) return undefined;
    return Math.floor(value);
}

export function HostIneligibilityReason(
    presence: P2PHostPresenceRecord,
    reliability: P2PHostReliabilityRecord | undefined,
    activeHostSessions: number,
    policy: P2PHostEligibilityPolicy,
    // [2026-10-14] Default: enforce mode and P2P_LAUNCHER_GUARD_REQUIRED (observe mode never requires a verified Guard).
    guardRequired = GuardRequiredByEnvironment(),
    now = Date.now()
): string | undefined {
    if (!presence.consentToHost) return "HOST_CONSENT_REQUIRED";
    if (!VersionAtLeast(presence.launcherVersion, policy.minimumLauncherVersion)) return "HOST_LAUNCHER_OUTDATED";
    if (!presence.artifactsVerified || !presence.runtimeSupported || !presence.steamRuntimeReady) return "HOST_RUNTIME_UNVERIFIED";
    if (guardRequired && !presence.guardVerified) return "HOST_GUARD_UNVERIFIED";
    if (Date.parse(presence.expiresAt) <= now || now - Date.parse(presence.observedAt) > policy.presenceMaximumAgeMs) return "HOST_PRESENCE_STALE";
    if (presence.freePhysicalMemoryMiB < policy.minimumFreeMemoryMiB || presence.commitHeadroomMiB < policy.minimumCommitHeadroomMiB) return "HOST_MEMORY_LOW";
    if (presence.logicalCpuCount < policy.minimumLogicalCpuCount || presence.cpuLoadPercent > policy.maximumCpuLoadPercent || presence.powerSaver) return "HOST_CPU_UNSUITABLE";
    if (presence.worstPeerRttMs > policy.maximumWorstPeerRttMs || presence.jitterMs > policy.maximumJitterMs || presence.packetLossPercent > policy.maximumPacketLossPercent) return "HOST_NETWORK_UNSUITABLE";
    if (activeHostSessions > 0) return "HOST_ALREADY_ACTIVE";
    if (reliability?.cooldownUntil != undefined && Date.parse(reliability.cooldownUntil) > now) return "HOST_COOLDOWN";
    return undefined;
}

function ClampRisk(value: number): number {
    return Math.max(0, Math.min(100, value));
}

export function ScoreHost(
    presence: P2PHostPresenceRecord,
    reliability: P2PHostReliabilityRecord | undefined,
    policy: P2PHostEligibilityPolicy,
    activeHostSessions: number
): { score: number; breakdown: P2PHostScoreBreakdown } {
    const attempts = (reliability?.startsSucceeded ?? 0) + (reliability?.startsFailed ?? 0) + (reliability?.unexpectedFailures ?? 0);
    const historicalFailureRate = attempts === 0
        ? 25
        : 100 * ((reliability?.startsFailed ?? 0) + (reliability?.unexpectedFailures ?? 0)) / attempts;
    const breakdown: P2PHostScoreBreakdown = {
        latencyRisk: ClampRisk(100 * presence.worstPeerRttMs / policy.maximumWorstPeerRttMs),
        networkRisk: ClampRisk(
            50 * presence.packetLossPercent / Math.max(1, policy.maximumPacketLossPercent) +
            50 * presence.jitterMs / policy.maximumJitterMs
        ),
        memoryRisk: ClampRisk(100 * policy.minimumCommitHeadroomMiB / Math.max(1, presence.commitHeadroomMiB)),
        cpuRisk: ClampRisk(presence.cpuLoadPercent),
        stabilityRisk: ClampRisk(historicalFailureRate),
        hostLoadRisk: activeHostSessions > 0 ? 100 : 0,
        integrityRisk: !presence.artifactsVerified ? 100 : presence.guardVerified ? (presence.guardRiskScore ?? 0) : 25
    };
    const score =
        0.35 * breakdown.latencyRisk +
        0.20 * breakdown.networkRisk +
        0.15 * breakdown.memoryRisk +
        0.10 * breakdown.cpuRisk +
        0.10 * breakdown.stabilityRisk +
        0.05 * breakdown.hostLoadRisk +
        0.05 * breakdown.integrityRisk;
    return { score: Math.round(score * 1000) / 1000, breakdown };
}
