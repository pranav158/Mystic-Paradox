import express, { Router, Request, Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HasLauncherAuth } from "../middleware/HasLauncherAuth";
import { GetRepositories } from "../persistence";
import { LauncherApiError, SendLauncherError } from "../security/launcherErrors";
import { TESTER_ROLE } from "../security/testerFeatures";
import { IsRateLimited } from "../security/rateLimit";
import { GetP2PExtension } from "../extensions/p2p";

// Release files are deliberately outside the source tree in production. Set
// LAUNCHER_UPDATE_ROOT to the directory populated by the release scripts.
const UPDATE_ROOT = path.resolve(process.env.LAUNCHER_UPDATE_ROOT ?? path.join(process.cwd(), "updates"));
const RUNTIME_TARGETS = new Set(["client", "server"]);
const UPDATE_PUBLIC_BASE_URL = (process.env.UPDATE_PUBLIC_BASE_URL ?? "https://paradox.mysticfox.dev").replace(/\/$/, "");
// The server process must explicitly select the supported game build. Missing or malformed
// values become NaN and make manifest acceptance/publication fail closed.
const TARGET_CHANGELIST = Number(process.env.TARGET_CHANGELIST ?? Number.NaN);
const RUNTIME_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3ZMtA7qUgs1F+1NQs2kmSG2zbOvXfjsh6+axI6eC/tc=\n-----END PUBLIC KEY-----`;
const GUARD_MANIFEST_KEYS: Readonly<Record<string, string>> = Object.freeze({
    "runtime-2026-01": RUNTIME_PUBLIC_KEY,
});
const MAX_GUARD_MANIFEST_BYTES = 256 * 1024;
const GUARD_MANIFEST_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
// Keep the API boundary aligned with build-guard-manifest-payload.ps1's
// ValidateRange(1,365). A signed payload must not turn a short-lived Guard
// authorization into a year-plus credential by bypassing the publisher script.
const GUARD_MANIFEST_MAX_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

// INTERNAL_SERVER is the runtime DLL and UDP_PROXY the winmm proxy that loads it: every manifest has them.
const CORE_GUARD_ARTIFACT_ROLES = ["GAME", "LAUNCHER", "CONTENT", "INTERNAL_SERVER", "UDP_PROXY"];

/**
 * Runtime feed files the publisher accepts besides the runtime DLL: the winmm proxy, plus the lower-case names in
 * RUNTIME_EXTRA_FILES (comma-separated), for example an optional module's runtime files. Every file must still carry
 * a valid runtime signature.
 */
export function AllowedRuntimeExtraFiles(): Set<string> {
    const configured = (process.env.RUNTIME_EXTRA_FILES ?? "").split(",")
        .map((name) => name.trim().toLowerCase()).filter((name) => /^[a-z0-9._-]{1,96}$/.test(name));
    return new Set(["winmm.dll", ...configured]);
}

interface GuardManifestArtifact {
    name: string;
    /** A core role (CORE_GUARD_ARTIFACT_ROLES) or a role of an optional module (src/extensions). */
    role: string;
    size: number;
    sha256: string;
    required: boolean;
    protectedRegions?: Array<{ rva: number; size: number; sha256: string }>;
}

interface GuardManifestPayload {
    schema: 1;
    manifestId: string;
    sequence: number;
    channel: string;
    platform: "windows-x86_64";
    targetChangelist: number;
    minimumLauncherVersion: string;
    issuedAt: string;
    expiresAt: string;
    artifacts: GuardManifestArtifact[];
    executableMemoryPolicy: {
        maximumPrivateExecutableBytes: number;
        maximumWritableExecutableBytes?: number;
        allowlistedModuleHashes: string[];
    };
}

export interface PublishedGuardManifest {
    manifestId: string;
    sequence: number;
    channel: string;
    platform: string;
    targetChangelist: number;
    minimumLauncherVersion: string;
    expiresAt: string;
    maximumPrivateExecutableBytes: number;
    maximumWritableExecutableBytes: number;
}

interface GuardManifestEnvelope {
    schema: 1;
    keyId: string;
    payloadBase64: string;
    signature: string;
}

/**
 * Enforce the signed manifest's usable time window at the publisher/API boundary.
 * Launcher Guard repeats this check locally; keeping it here prevents the backend
 * from serving or accepting a manifest that clients must immediately reject.
 */
export function validateGuardManifestWindow(issuedAt: string, expiresAt: string, nowMs = Date.now()): void {
    const issued = Date.parse(issuedAt);
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires)) {
        throw new Error("Guard manifest timestamps are invalid.");
    }
    if (expires <= issued) {
        throw new Error("Guard manifest expiry is not after its issue time.");
    }
    if (expires - issued > GUARD_MANIFEST_MAX_LIFETIME_MS) {
        throw new Error("Guard manifest lifetime exceeds the maximum allowed window.");
    }
    if (issued > nowMs + GUARD_MANIFEST_MAX_FUTURE_SKEW_MS) {
        throw new Error("Guard manifest issue time is too far in the future.");
    }
    if (expires <= nowMs) {
        throw new Error("Guard manifest has expired.");
    }
}

// Normalize an address for comparison: trim, drop the IPv4-mapped IPv6 prefix
// (::ffff:1.2.3.4 -> 1.2.3.4) and any IPv6 zone id.
function normalizeIp(value: string | undefined | null): string {
    if (!value) return "";
    let ip = value.trim();
    if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
    const zone = ip.indexOf("%");
    if (zone >= 0) ip = ip.slice(0, zone);
    return ip.toLowerCase();
}

// Only these source IPs may PUSH new runtime updates (the admin upload route):
// a comma-separated UPDATE_PUBLISHER_ALLOWED_IPS. An unset or empty list denies
// every push (fail-closed) so a missing or misconfigured value can never open the endpoint.
const UPDATE_PUBLISHER_ALLOWED_IPS = new Set(
    (process.env.UPDATE_PUBLISHER_ALLOWED_IPS ?? "")
        .split(",")
        .map((value) => normalizeIp(value))
        .filter((value) => value.length > 0),
);

// The app sets `trust proxy = loopback`, so req.ip is the real TCP peer for
// direct TLS connections and the true client only when fronted by a loopback
// proxy. Both are checked; neither can be spoofed from the public internet.
function isPublisherIpAllowed(req: Request): boolean {
    if (UPDATE_PUBLISHER_ALLOWED_IPS.size === 0) return false;
    const candidates = [normalizeIp(req.ip), normalizeIp(req.socket?.remoteAddress)];
    return candidates.some((ip) => ip.length > 0 && UPDATE_PUBLISHER_ALLOWED_IPS.has(ip));
}

// Shared publisher API-key check (timing-safe) for admin endpoints.
function hasValidPublisherKey(req: Request): boolean {
    const expectedKey = process.env.UPDATE_PUBLISHER_API_KEY?.trim();
    const providedKey = req.header("x-update-api-key")?.trim();
    if (!expectedKey || !providedKey || expectedKey.length !== providedKey.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(expectedKey), Buffer.from(providedKey)); } catch { return false; }
}

// Runtime-update serving switch. When disabled, the runtime manifest endpoints
// return 204 — which the launcher treats as "no update available", so clients
// skip the DLL download and just launch the game. Persisted to a file under
// UPDATE_ROOT so the choice survives a Metagame restart. Default: enabled.
const SERVING_FLAG_PATH = path.join(UPDATE_ROOT, "serving.json");
function isRuntimeServingEnabled(): boolean {
    try {
        const parsed = JSON.parse(fs.readFileSync(SERVING_FLAG_PATH, "utf8")) as { runtimeEnabled?: boolean };
        return parsed.runtimeEnabled !== false;
    } catch {
        return true;
    }
}
function setRuntimeServingEnabled(enabled: boolean): void {
    fs.mkdirSync(UPDATE_ROOT, { recursive: true });
    fs.writeFileSync(SERVING_FLAG_PATH, `${JSON.stringify({ runtimeEnabled: enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

export const launcherUpdatesRouter = Router();

// [2026-10-09, ported from the public repo's August security follow-ups] Non-strings (an array query value) and
// anything that is not its own basename are rejected outright, not coerced.
export function segment(value: unknown, label: string): string {
    if (typeof value !== "string") {
        throw new Error(`Invalid ${label}`);
    }
    if (path.basename(value) !== value || !/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
        throw new Error(`Invalid ${label}`);
    }
    return value;
}

// [2026-10-09, ported from the public repo's August CodeQL fixes] Per-IP limits on the routes that read or write
// update files: downloads are unauthenticated on the stable channel (the runtime DLL is ~3 MB, the launcher
// installer ~5 MB), and the publish routes are IP- and key-gated but still worth bounding. Same budgets as the
// public fix (180/min downloads, 30/min publishes), on the module's existing in-memory limiter. Called inside the
// handlers because per-route middleware loosens Express's req.params typing (see isTesterChannelAllowed).
function rejectIfRateLimited(req: Request, res: Response, bucket: "update-download" | "update-publish"): boolean {
    const max = bucket === "update-download" ? 180 : 30;
    if (!IsRateLimited(`${bucket}:${normalizeIp(req.ip) || "unknown"}`, max, 60_000)) return false;
    res.status(429).json({ error: "Too many requests. Please retry later." });
    return true;
}

function readJson(file: string): Record<string, unknown> | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

function runtimeManifestPath(target: string, channel: string, platform: string): string {
    return path.join(UPDATE_ROOT, "runtime", segment(target, "target"), segment(channel, "channel"), segment(platform, "platform"), "latest.json");
}

function guardManifestPath(channel: string, platform: string): string {
    return path.join(UPDATE_ROOT, "guard", segment(channel, "channel"), segment(platform, "platform"), "latest.json");
}

function parseAndVerifyGuardEnvelope(value: unknown): { envelope: GuardManifestEnvelope; payload: GuardManifestPayload } {
    const envelope = value as Partial<GuardManifestEnvelope>;
    if (envelope?.schema !== 1 || typeof envelope.keyId !== "string" ||
        typeof envelope.payloadBase64 !== "string" || typeof envelope.signature !== "string") {
        throw new Error("Invalid Guard manifest envelope.");
    }
    const publicKey = GUARD_MANIFEST_KEYS[envelope.keyId];
    if (!publicKey) throw new Error("Unknown Guard manifest signing key.");
    const payloadBytes = Buffer.from(envelope.payloadBase64, "base64");
    const signature = Buffer.from(envelope.signature, "base64");
    if (payloadBytes.length === 0 || payloadBytes.length > MAX_GUARD_MANIFEST_BYTES || signature.length !== 64 ||
        !crypto.verify(null, payloadBytes, publicKey, signature)) {
        throw new Error("Guard manifest signature verification failed.");
    }
    const payload = JSON.parse(payloadBytes.toString("utf8")) as GuardManifestPayload;
    if (payload.schema !== 1 || !/^[0-9a-f-]{36}$/i.test(payload.manifestId) ||
        !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 ||
        !/^[A-Za-z0-9._-]+$/.test(payload.channel) || payload.platform !== "windows-x86_64" ||
        payload.targetChangelist !== TARGET_CHANGELIST || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(payload.minimumLauncherVersion) ||
        typeof payload.issuedAt !== "string" || typeof payload.expiresAt !== "string" ||
        !Array.isArray(payload.artifacts) ||
        payload.artifacts.length === 0 || payload.artifacts.length > 128) {
        throw new Error("Invalid Guard manifest payload.");
    }
    validateGuardManifestWindow(payload.issuedAt, payload.expiresAt);
    const names = new Set<string>();
    for (const artifact of payload.artifacts) {
        if (!artifact || typeof artifact.name !== "string" || artifact.name !== path.basename(artifact.name) ||
            names.has(artifact.name.toLowerCase()) || !Number.isSafeInteger(artifact.size) || artifact.size < 1 ||
            !/^[0-9a-f]{64}$/i.test(artifact.sha256) || typeof artifact.required !== "boolean" ||
            ![...CORE_GUARD_ARTIFACT_ROLES, ...GetP2PExtension().launcher.guardManifestRoles].includes(artifact.role)) {
            throw new Error("Invalid Guard artifact entry.");
        }
        names.add(artifact.name.toLowerCase());
        if (artifact.protectedRegions != undefined && (!Array.isArray(artifact.protectedRegions) ||
            artifact.protectedRegions.length > 256 || artifact.protectedRegions.some((region) =>
                !Number.isSafeInteger(region.rva) || region.rva < 0 || !Number.isSafeInteger(region.size) ||
                region.size < 1 || region.size > 1024 * 1024 || !/^[0-9a-f]{64}$/i.test(region.sha256)))) {
            throw new Error("Invalid Guard protected-region entry.");
        }
    }
    const maximumWritableExecutableBytes = payload.executableMemoryPolicy?.maximumWritableExecutableBytes ?? 0;
    if (!payload.executableMemoryPolicy ||
        !Number.isSafeInteger(payload.executableMemoryPolicy.maximumPrivateExecutableBytes) ||
        payload.executableMemoryPolicy.maximumPrivateExecutableBytes < 0 ||
        payload.executableMemoryPolicy.maximumPrivateExecutableBytes > 64 * 1024 * 1024 ||
        !Number.isSafeInteger(maximumWritableExecutableBytes) || maximumWritableExecutableBytes < 0 ||
        maximumWritableExecutableBytes > 16 * 1024 * 1024 ||
        !Array.isArray(payload.executableMemoryPolicy.allowlistedModuleHashes) ||
        payload.executableMemoryPolicy.allowlistedModuleHashes.length > 512 ||
        payload.executableMemoryPolicy.allowlistedModuleHashes.some((hash) => !/^[0-9a-f]{64}$/i.test(hash))) {
        throw new Error("Invalid Guard executable-memory policy.");
    }
    return { envelope: envelope as GuardManifestEnvelope, payload };
}

export function GetPublishedGuardManifest(channel: string, platform = "windows-x86_64"): PublishedGuardManifest | undefined {
    try {
        const envelope = readJson(guardManifestPath(channel, platform));
        if (!envelope) return undefined;
        const { payload } = parseAndVerifyGuardEnvelope(envelope);
        if (payload.channel !== channel || payload.platform !== platform) return undefined;
        return {
            manifestId: payload.manifestId,
            sequence: payload.sequence,
            channel: payload.channel,
            platform: payload.platform,
            targetChangelist: payload.targetChangelist,
            minimumLauncherVersion: payload.minimumLauncherVersion,
            expiresAt: payload.expiresAt,
            maximumPrivateExecutableBytes: payload.executableMemoryPolicy.maximumPrivateExecutableBytes,
            maximumWritableExecutableBytes: payload.executableMemoryPolicy.maximumWritableExecutableBytes ?? 0
        };
    } catch { return undefined; }
}

function serveRuntimeManifest(target: string, channel: string, platform: string, res: Response): void {
    try {
        // Global kill-switch: when runtime serving is disabled, report "no update"
        // (204) so launchers skip the DLL download and launch the game normally.
        if (!isRuntimeServingEnabled()) {
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.sendStatus(204);
            return;
        }
        const manifest = readJson(runtimeManifestPath(target, channel, platform));
        if (!manifest) {
            res.sendStatus(404);
            return;
        }
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.json(manifest);
    } catch {
        res.sendStatus(400);
    }
}

function serveRuntimeDownload(target: string, channel: string, platform: string, res: Response): void {
    try {
        const safeTarget = segment(target, "target");
        const safeChannel = segment(channel, "channel");
        const safePlatform = segment(platform, "platform");
        const manifest = readJson(runtimeManifestPath(safeTarget, safeChannel, safePlatform));
        const version = typeof manifest?.version === "string" ? segment(manifest.version, "version") : undefined;
        const file = typeof manifest?.file === "string" ? path.basename(manifest.file) : undefined;
        if (!version || !file || file !== manifest?.file) {
            res.sendStatus(404);
            return;
        }
        const artifact = path.join(UPDATE_ROOT, "runtime", safeTarget, safeChannel, safePlatform, version, file);
        if (!fs.existsSync(artifact)) {
            res.sendStatus(404);
            return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", fs.statSync(artifact).size);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        fs.createReadStream(artifact).pipe(res);
    } catch {
        res.sendStatus(400);
    }
}

// "stable" stays fully public/unauthenticated (unchanged behavior — the launcher checks it
// before a player has necessarily finished signing in). "beta"/"dev" require a signed-in
// account with the tester role, closing the gap where anyone with the URL could previously
// fetch or download a non-stable manifest regardless of account state.
//
// Called from inside each route handler rather than registered as a separate Express
// middleware — passing a generically-typed middleware into router.get(path, middleware,
// handler) makes Express's overloaded .get() typings fall back to a looser req.params type
// (string | string[] instead of the path-inferred shape), which breaks tsc.
async function isTesterChannelAllowed(req: Request, res: Response): Promise<boolean> {
    const channel = String(req.params.channel ?? "");
    if (channel === "stable") return true;

    let authorized = false;
    await HasLauncherAuth(req, res, () => { authorized = true; });
    if (!authorized) return false; // HasLauncherAuth already sent the error response.

    const AuthData = (req as any).LauncherAuthData;
    const Account = await GetRepositories().launcherAccounts.findByUserId(AuthData.userId);
    if (!Account || !Account.roles.includes(TESTER_ROLE)) {
        SendLauncherError(res, new LauncherApiError("AUTH_TESTER_REQUIRED", "Tester access is required for this channel."));
        return false;
    }
    return true;
}

launcherUpdatesRouter.get("/launcher/v1/runtime/:target/:channel/:platform", async (req, res) => {
    if (!RUNTIME_TARGETS.has(req.params.target)) { res.sendStatus(400); return; }
    if (!(await isTesterChannelAllowed(req, res))) return;
    serveRuntimeManifest(req.params.target, req.params.channel, req.params.platform, res);
});

// Backward-compatible client endpoint used by existing launchers.
launcherUpdatesRouter.get("/launcher/v1/runtime/:channel/:platform", async (req, res) => {
    if (!(await isTesterChannelAllowed(req, res))) return;
    serveRuntimeManifest("client", req.params.channel, req.params.platform, res);
});

launcherUpdatesRouter.get("/launcher/v1/runtime/:target/:channel/:platform/download", async (req, res) => {
    if (rejectIfRateLimited(req, res, "update-download")) return;
    if (!RUNTIME_TARGETS.has(req.params.target)) { res.sendStatus(400); return; }
    if (!(await isTesterChannelAllowed(req, res))) return;
    serveRuntimeDownload(req.params.target, req.params.channel, req.params.platform, res);
});

launcherUpdatesRouter.get("/launcher/v1/runtime/:channel/:platform/download", async (req, res) => {
    if (rejectIfRateLimited(req, res, "update-download")) return;
    if (!(await isTesterChannelAllowed(req, res))) return;
    serveRuntimeDownload("client", req.params.channel, req.params.platform, res);
});

// Complete runtime-set attestation manifest. The publisher signs the raw JSON payload offline
// and uploads only this envelope; the Metagame server never has access to a release private key.
// The sequence is strictly increasing per channel/platform and every accepted version is kept
// immutable so clients can retain an anti-rollback floor.
launcherUpdatesRouter.get("/launcher/v1/guard-manifests/:channel/:platform", async (req, res) => {
    if (!(await isTesterChannelAllowed(req, res))) return;
    try {
        const file = guardManifestPath(String(req.params.channel), String(req.params.platform));
        const envelope = readJson(file);
        if (!envelope) { res.sendStatus(404); return; }
        const { payload } = parseAndVerifyGuardEnvelope(envelope);
        if (payload.channel !== String(req.params.channel) || payload.platform !== String(req.params.platform)) {
            res.sendStatus(404);
            return;
        }
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.json(envelope);
    } catch { res.sendStatus(400); }
});

launcherUpdatesRouter.post(
    "/launcher/v1/admin/guard-manifests/:channel/:platform",
    express.json({ limit: `${MAX_GUARD_MANIFEST_BYTES}b`, strict: true }),
    (req: Request, res: Response) => {
        if (rejectIfRateLimited(req, res, "update-publish")) return;
        if (!isPublisherIpAllowed(req)) { res.status(403).json({ error: "Not allowed from this address." }); return; }
        if (!hasValidPublisherKey(req)) { res.status(401).json({ error: "Invalid update publisher credentials." }); return; }
        try {
            const channel = segment(String(req.params.channel), "channel");
            const platform = segment(String(req.params.platform), "platform");
            const { envelope, payload } = parseAndVerifyGuardEnvelope(req.body);
            if (payload.channel !== channel || payload.platform !== platform) {
                res.status(400).json({ error: "Guard manifest route and signed payload do not match." }); return;
            }
            const latestPath = guardManifestPath(channel, platform);
            const previous = readJson(latestPath);
            if (previous) {
                const prior = parseAndVerifyGuardEnvelope(previous).payload;
                if (payload.sequence <= prior.sequence) {
                    res.status(409).json({ error: "Guard manifest sequence must increase monotonically." }); return;
                }
            }
            const versionDir = path.join(UPDATE_ROOT, "guard", channel, platform, String(payload.sequence));
            fs.mkdirSync(versionDir, { recursive: true });
            const immutablePath = path.join(versionDir, `${segment(payload.manifestId, "manifestId")}.json`);
            if (fs.existsSync(immutablePath)) {
                res.status(409).json({ error: "That Guard manifest is already published and immutable." }); return;
            }
            fs.writeFileSync(immutablePath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx" });
            fs.mkdirSync(path.dirname(latestPath), { recursive: true });
            fs.writeFileSync(latestPath, `${JSON.stringify(envelope, null, 2)}\n`);
            res.status(201).json({ manifestId: payload.manifestId, sequence: payload.sequence, keyId: envelope.keyId });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Invalid Guard manifest." });
        }
    }
);

launcherUpdatesRouter.post(
    "/launcher/v1/admin/updates/runtime/:target/:channel/:platform",
    express.raw({ type: "application/octet-stream", limit: "200mb" }),
    (req: Request, res: Response) => {
        if (rejectIfRateLimited(req, res, "update-publish")) return;
        if (!isPublisherIpAllowed(req)) {
            console.warn(`[update] publish denied for ${normalizeIp(req.ip) || "unknown"} (not in UPDATE_PUBLISHER_ALLOWED_IPS)`);
            res.status(403).json({ error: "Update publishing is not allowed from this address." });
            return;
        }
        const expectedKey = process.env.UPDATE_PUBLISHER_API_KEY?.trim();
        const providedKey = req.header("x-update-api-key")?.trim();
        if (!expectedKey || !providedKey || expectedKey.length !== providedKey.length ||
            !crypto.timingSafeEqual(Buffer.from(expectedKey), Buffer.from(providedKey))) {
            res.status(401).json({ error: "Invalid update publisher credentials." });
            return;
        }
        let target: string, channel: string, platform: string;
        try {
            target = segment(req.params.target, "target");
            channel = segment(req.params.channel, "channel");
            platform = segment(req.params.platform, "platform");
        } catch { res.status(400).json({ error: "Invalid runtime update metadata." }); return; }
        const version = req.header("x-update-version") ?? "";
        const changelist = Number(req.header("x-update-changelist"));
        const signatureText = req.header("x-update-signature") ?? "";
        if (!RUNTIME_TARGETS.has(target) || !/^[A-Za-z0-9._-]+$/.test(channel) || platform !== "windows-x86_64" ||
            !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) || changelist !== TARGET_CHANGELIST || !Buffer.isBuffer(req.body)) {
            res.status(400).json({ error: "Invalid runtime update metadata." });
            return;
        }
        const bytes = req.body as Buffer;
        if (bytes.length === 0 || bytes.length > 200 * 1024 * 1024) {
            res.status(413).json({ error: "Runtime update is outside the allowed size." });
            return;
        }
        let signature: Buffer;
        try { signature = Buffer.from(signatureText, "base64"); } catch { signature = Buffer.alloc(0); }
        if (signature.length !== 64 || !crypto.verify(null, bytes, RUNTIME_PUBLIC_KEY, signature)) {
            res.status(400).json({ error: "Runtime update signature verification failed." });
            return;
        }
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        const artifactName = `ParadoxRuntime-${version}-${target}-${changelist}.dll`;
        const artifactDir = path.join(UPDATE_ROOT, "runtime", target, channel, platform, version);
        fs.mkdirSync(artifactDir, { recursive: true });
        const artifactPath = path.join(artifactDir, artifactName);
        if (fs.existsSync(artifactPath)) {
            res.status(409).json({ error: "That target/channel/version is already published and immutable." });
            return;
        }
        fs.writeFileSync(artifactPath, bytes, { flag: "wx" });
        const manifest = {
            schema: 1, component: "ParadoxRuntime", target, version, channel, targetChangelist: changelist,
            platform, size: bytes.length, sha256, signature: signatureText, file: artifactName,
            publishedAt: new Date().toISOString(),
            url: `${UPDATE_PUBLIC_BASE_URL}/launcher/v1/runtime/${encodeURIComponent(target)}/${encodeURIComponent(channel)}/${platform}/download`,
            extraFiles: [] as { name: string; size: number; sha256: string; signature: string; url: string }[],
        };
        const latestDir = path.join(UPDATE_ROOT, "runtime", target, channel, platform);
        fs.mkdirSync(latestDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        fs.writeFileSync(path.join(latestDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        res.status(201).json({ target, channel, version, sha256 });
    },
);

// Attach an allowlisted, separately signed runtime companion to an already-published version. The main
// runtime DLL for that version must be published first. Same IP + key + Ed25519
// guards as the main upload.
launcherUpdatesRouter.post(
    "/launcher/v1/admin/updates/runtime/:target/:channel/:platform/extra",
    express.raw({ type: "application/octet-stream", limit: "200mb" }),
    (req: Request, res: Response) => {
        if (rejectIfRateLimited(req, res, "update-publish")) return;
        if (!isPublisherIpAllowed(req)) {
            console.warn(`[update] extra-file publish denied for ${normalizeIp(req.ip) || "unknown"}`);
            res.status(403).json({ error: "Update publishing is not allowed from this address." });
            return;
        }
        const expectedKey = process.env.UPDATE_PUBLISHER_API_KEY?.trim();
        const providedKey = req.header("x-update-api-key")?.trim();
        if (!expectedKey || !providedKey || expectedKey.length !== providedKey.length ||
            !crypto.timingSafeEqual(Buffer.from(expectedKey), Buffer.from(providedKey))) {
            res.status(401).json({ error: "Invalid update publisher credentials." });
            return;
        }
        let target: string, channel: string, platform: string, version: string, filename: string;
        try {
            target = segment(String(req.params.target), "target");
            channel = segment(String(req.params.channel), "channel");
            platform = segment(String(req.params.platform), "platform");
            version = segment(req.header("x-update-version") ?? "", "version");
            filename = segment(path.basename(req.header("x-update-filename") ?? ""), "filename");
        } catch { res.status(400).json({ error: "Invalid extra-file metadata." }); return; }
        // winmm.dll loads the runtime; RUNTIME_EXTRA_FILES names an optional module's runtime files.
        const allowedExtra = AllowedRuntimeExtraFiles();
        if (!RUNTIME_TARGETS.has(target) || platform !== "windows-x86_64" || !allowedExtra.has(filename.toLowerCase())) {
            res.status(400).json({ error: "Invalid extra-file target/platform/name." }); return;
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > 200 * 1024 * 1024) {
            res.status(413).json({ error: "Extra file is outside the allowed size." }); return;
        }
        const bytes = req.body as Buffer;
        let signature: Buffer;
        try { signature = Buffer.from(req.header("x-update-signature") ?? "", "base64"); } catch { signature = Buffer.alloc(0); }
        if (signature.length !== 64 || !crypto.verify(null, bytes, RUNTIME_PUBLIC_KEY, signature)) {
            res.status(400).json({ error: "Extra file signature verification failed." }); return;
        }
        const versionDir = path.join(UPDATE_ROOT, "runtime", target, channel, platform, version);
        const latestPath = runtimeManifestPath(target, channel, platform);
        const manifest = readJson(latestPath) as any;
        if (!fs.existsSync(versionDir) || !manifest || manifest.version !== version) {
            res.status(409).json({ error: "Publish the main runtime DLL for this version first." }); return;
        }
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        fs.writeFileSync(path.join(versionDir, filename), bytes);
        const extra = {
            name: filename, size: bytes.length, sha256, signature: signature.toString("base64"),
            url: `${UPDATE_PUBLIC_BASE_URL}/launcher/v1/runtime/${encodeURIComponent(target)}/${encodeURIComponent(channel)}/${platform}/extra/${encodeURIComponent(filename)}`,
        };
        const extras = Array.isArray(manifest.extraFiles) ? manifest.extraFiles.filter((e: any) => e && e.name !== filename) : [];
        extras.push(extra);
        manifest.extraFiles = extras;
        fs.writeFileSync(path.join(versionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        fs.writeFileSync(latestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        res.status(201).json({ name: filename, sha256, size: bytes.length });
    },
);

// Download a named allowlisted runtime companion for the current published version of a channel.
launcherUpdatesRouter.get("/launcher/v1/runtime/:target/:channel/:platform/extra/:filename", async (req, res) => {
    if (rejectIfRateLimited(req, res, "update-download")) return;
    if (!RUNTIME_TARGETS.has(req.params.target)) { res.sendStatus(400); return; }
    if (!(await isTesterChannelAllowed(req, res))) return;
    try {
        const target = segment(req.params.target, "target");
        const channel = segment(req.params.channel, "channel");
        const platform = segment(req.params.platform, "platform");
        const filename = segment(path.basename(req.params.filename), "filename");
        const manifest = readJson(runtimeManifestPath(target, channel, platform)) as any;
        const version = typeof manifest?.version === "string" ? segment(manifest.version, "version") : undefined;
        const extras = Array.isArray(manifest?.extraFiles) ? manifest.extraFiles : [];
        const known = extras.find((e: any) => e && e.name === filename);
        if (!version || !known) { res.sendStatus(404); return; }
        const artifact = path.join(UPDATE_ROOT, "runtime", target, channel, platform, version, filename);
        if (!fs.existsSync(artifact)) { res.sendStatus(404); return; }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", fs.statSync(artifact).size);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        fs.createReadStream(artifact).pipe(res);
    } catch { res.sendStatus(400); }
});

// --- admin: runtime-update serving switch (IP allow-list + API key) ---------
// GET returns the current state; POST { runtimeEnabled: boolean } flips it.
// Disabling makes every runtime manifest respond 204 (no update) so launchers
// skip the DLL download — used to pause pushing a new client DLL to players.
launcherUpdatesRouter.get("/launcher/v1/admin/updates/serving", (req: Request, res: Response) => {
    if (!isPublisherIpAllowed(req)) { res.status(403).json({ error: "Not allowed from this address." }); return; }
    if (!hasValidPublisherKey(req)) { res.status(401).json({ error: "Invalid update publisher credentials." }); return; }
    res.json({ runtimeEnabled: isRuntimeServingEnabled() });
});

launcherUpdatesRouter.post("/launcher/v1/admin/updates/serving", express.json({ limit: "4kb" }), (req: Request, res: Response) => {
    if (!isPublisherIpAllowed(req)) {
        console.warn(`[update] serving toggle denied for ${normalizeIp(req.ip) || "unknown"} (not in UPDATE_PUBLISHER_ALLOWED_IPS)`);
        res.status(403).json({ error: "Not allowed from this address." });
        return;
    }
    if (!hasValidPublisherKey(req)) { res.status(401).json({ error: "Invalid update publisher credentials." }); return; }
    const enabled = (req.body as { runtimeEnabled?: unknown })?.runtimeEnabled;
    if (typeof enabled !== "boolean") { res.status(400).json({ error: "runtimeEnabled must be a boolean." }); return; }
    setRuntimeServingEnabled(enabled);
    console.warn(`[update] runtime update serving ${enabled ? "ENABLED" : "DISABLED"} by ${normalizeIp(req.ip)}`);
    res.json({ runtimeEnabled: enabled });
});

// Tauri's signed launcher updater endpoints. The release script writes the
// exact JSON shape expected by tauri-plugin-updater into this directory.
//
// ORDER MATTERS: the literal "/download" route MUST be registered before the
// ":currentVersion" manifest route. Tauri requests the installer at
// ".../download", but "download" is also a valid value for the :currentVersion
// path parameter. If the param route is registered first, Express matches it
// for ".../download" and returns latest.json (the ~700-byte manifest) as if it
// were the installer. The updater then verifies the signature against the JSON
// bytes instead of the .exe and fails with "signature verification failed".
launcherUpdatesRouter.get("/launcher/v1/updates/:target/:arch/download", (req, res) => {
    if (rejectIfRateLimited(req, res, "update-download")) return;
    try {
        const target = segment(req.params.target, "target");
        const arch = segment(req.params.arch, "architecture");
        const manifest = readJson(path.join(UPDATE_ROOT, "launcher", target, arch, "latest.json"));
        const version = typeof manifest?.version === "string" ? segment(manifest.version, "version") : undefined;
        const file = typeof manifest?.file === "string" ? path.basename(manifest.file) : undefined;
        if (!version || !file || file !== manifest?.file) {
            res.sendStatus(404);
            return;
        }
        const artifact = path.join(UPDATE_ROOT, "launcher", target, arch, version, file);
        if (!fs.existsSync(artifact)) {
            res.sendStatus(404);
            return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", fs.statSync(artifact).size);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        fs.createReadStream(artifact).pipe(res);
    } catch {
        res.sendStatus(400);
    }
});

launcherUpdatesRouter.get("/launcher/v1/updates/:target/:arch/:currentVersion", (req, res) => {
    try {
        const file = path.join(
            UPDATE_ROOT,
            "launcher",
            segment(req.params.target, "target"),
            segment(req.params.arch, "architecture"),
            "latest.json",
        );
        const manifest = readJson(file);
        if (!manifest) {
            res.sendStatus(204);
            return;
        }
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.json(manifest);
    } catch {
        res.sendStatus(400);
    }
});
