import crypto from "node:crypto";
import { GetRepositories, LauncherGuardRole, LauncherGuardSignals } from "../persistence";
import { GetPublishedGuardManifest } from "../routes/launcherUpdates";
import { LauncherApiError } from "../security/launcherErrors";
import { VersionAtLeast } from "../security/launcherVersion";

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const HEX64 = /^[0-9a-f]{64}$/i;
const SESSION_LIFETIME_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;

function opaque(bytes: number): string { return crypto.randomBytes(bytes).toString("base64url"); }

export function ParseLauncherGuardRole(value: unknown, fallback?: LauncherGuardRole): LauncherGuardRole | undefined {
    if (value === "client" || value === "host") return value;
    return value == undefined && fallback != undefined ? fallback : undefined;
}

export function IsGuardManifestCurrent(
    manifest: { manifestId: string; sequence: number; expiresAt: string } | undefined,
    expectedManifestId: string,
    expectedSequence: number,
    now = Date.now()
): boolean {
    if (manifest == undefined || manifest.manifestId !== expectedManifestId || manifest.sequence !== expectedSequence) return false;
    const expiry = Date.parse(manifest.expiresAt);
    return Number.isFinite(expiry) && expiry > now;
}

function requireSignals(value: unknown): LauncherGuardSignals {
    if (value == undefined || typeof value !== "object" || Array.isArray(value)) {
        throw new LauncherApiError("GUARD_REPORT_INVALID", "The Launcher Guard report is invalid.");
    }
    const input = value as Partial<LauncherGuardSignals>;
    const integers = [input.gameProcessId, input.moduleCount, input.privateExecutableBytes,
        input.writableExecutableBytes, input.unexpectedModuleCount, input.protectedPageMismatchCount];
    if (!input || integers.some((number) => !Number.isSafeInteger(number) || Number(number) < 0) ||
        typeof input.gameStartedAt !== "string" || !Number.isFinite(Date.parse(input.gameStartedAt)) ||
        typeof input.moduleSetDigest !== "string" || !HEX64.test(input.moduleSetDigest) ||
        typeof input.debuggerPresent !== "boolean") {
        throw new LauncherApiError("GUARD_REPORT_INVALID", "The Launcher Guard report is invalid.");
    }
    return input as LauncherGuardSignals;
}

export function LauncherGuardSignatureMaterial(input: {
    role: LauncherGuardRole; guardSessionId: string; sequence: number; challenge: string; manifestId: string;
    manifestSequence: number; observedAt: string; signals: LauncherGuardSignals;
}): string {
    const s = input.signals;
    return ["MYSTIC-GUARD-2", input.role, input.guardSessionId, input.sequence, input.challenge,
        input.manifestId, input.manifestSequence, input.observedAt, s.gameProcessId, s.gameStartedAt,
        s.moduleCount, s.moduleSetDigest.toLowerCase(), s.privateExecutableBytes,
        s.writableExecutableBytes, s.unexpectedModuleCount, s.protectedPageMismatchCount,
        s.debuggerPresent ? 1 : 0].join("\n");
}

function scoreSignals(signals: LauncherGuardSignals, privateExecutableLimit: number,
    writableExecutableLimit = 0): number {
    let score = 0;
    if (signals.debuggerPresent) score += 50;
    score += Math.min(50, signals.unexpectedModuleCount * 15);
    score += Math.min(60, signals.protectedPageMismatchCount * 30);
    if (signals.writableExecutableBytes > writableExecutableLimit) score += 60;
    if (signals.privateExecutableBytes > privateExecutableLimit) score += 40;
    return Math.min(100, score);
}

function hasHardIntegrityViolation(signals: LauncherGuardSignals, privateExecutableLimit: number,
    writableExecutableLimit = 0): boolean {
    return signals.debuggerPresent ||
        signals.unexpectedModuleCount > 0 ||
        signals.protectedPageMismatchCount > 0 ||
        signals.privateExecutableBytes > privateExecutableLimit ||
        signals.writableExecutableBytes > writableExecutableLimit;
}

function guardStatus(signals: LauncherGuardSignals, privateExecutableLimit: number,
    writableExecutableLimit: number, riskScore: number): "HEALTHY" | "DEGRADED" {
    return !hasHardIntegrityViolation(signals, privateExecutableLimit, writableExecutableLimit) && riskScore < 50
        ? "HEALTHY" : "DEGRADED";
}

function continuityRisk(previous: LauncherGuardSignals | undefined, current: LauncherGuardSignals,
    previousSequence: number): number {
    if (previous == undefined) return 0;
    if (previous.gameProcessId !== current.gameProcessId || previous.gameStartedAt !== current.gameStartedAt) return 100;
    // Allow the first two reports for normal UE/Steam lazy module loading. Once warm, a changed
    // module set is a central risk finding even when a modified client reports zero unexpected DLLs.
    if (previousSequence >= 2 && previous.moduleSetDigest !== current.moduleSetDigest) return 50;
    return 0;
}

export async function StartLauncherGuard(accountId: string, body: any): Promise<Record<string, unknown>> {
    const role = ParseLauncherGuardRole(body?.role, "client");
    if (role == undefined) throw new LauncherApiError("GUARD_REPORT_INVALID", "The Launcher Guard role is invalid.");
    const channel = typeof body?.channel === "string" ? body.channel : "stable";
    const launcherVersion = typeof body?.launcherVersion === "string" ? body.launcherVersion : "";
    const manifest = GetPublishedGuardManifest(channel);
    if (!manifest || Date.parse(manifest.expiresAt) <= Date.now()) {
        throw new LauncherApiError("GUARD_MANIFEST_UNAVAILABLE", "No current signed Guard manifest is available.");
    }
    if (body?.manifestId !== manifest.manifestId || body?.manifestSequence !== manifest.sequence ||
        manifest.channel !== channel || !VERSION.test(launcherVersion) ||
        !VersionAtLeast(launcherVersion, manifest.minimumLauncherVersion)) {
        throw new LauncherApiError("GUARD_MANIFEST_MISMATCH", "The launcher runtime manifest is not current.");
    }
    const publicKeyBase64 = typeof body?.publicKey === "string" ? body.publicKey : "";
    let publicKey: Buffer;
    try { publicKey = Buffer.from(publicKeyBase64, "base64"); } catch { publicKey = Buffer.alloc(0); }
    if (publicKey.length !== 32) throw new LauncherApiError("GUARD_REPORT_INVALID", "The ephemeral Guard public key is invalid.");
    const guardSessionId = crypto.randomUUID();
    const challenge = opaque(24);
    const now = new Date();
    await GetRepositories().launcherGuard.revokeForAccount(accountId, role, now.toISOString());
    await GetRepositories().launcherGuard.create({
        guardSessionId, accountId, role, publicKeyBase64, manifestId: manifest.manifestId,
        manifestSequence: manifest.sequence, channel, launcherVersion, challenge, lastSequence: 0,
        status: "CHALLENGED", riskScore: 0, createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString()
    });
    return { schema: 1, role, guardSessionId, challenge, manifestId: manifest.manifestId,
        manifestSequence: manifest.sequence, expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString(),
        heartbeatIntervalMs: 15_000 };
}

export async function SubmitLauncherGuardHeartbeat(accountId: string, body: any): Promise<Record<string, unknown>> {
    const guardSessionId = typeof body?.guardSessionId === "string" ? body.guardSessionId : "";
    const sequence = Number(body?.sequence);
    const observedAt = typeof body?.observedAt === "string" ? body.observedAt : "";
    const signatureText = typeof body?.signature === "string" ? body.signature : "";
    if (!/^[0-9a-f-]{36}$/i.test(guardSessionId) || !Number.isSafeInteger(sequence) || sequence < 1 ||
        !Number.isFinite(Date.parse(observedAt)) || Math.abs(Date.now() - Date.parse(observedAt)) > MAX_CLOCK_SKEW_MS ||
        signatureText.length < 80 || signatureText.length > 100) {
        throw new LauncherApiError("GUARD_REPORT_INVALID", "The Launcher Guard heartbeat is invalid.");
    }
    const signals = requireSignals(body?.signals);
    const current = await GetRepositories().launcherGuard.find(guardSessionId);
    if (!current || current.accountId !== accountId || current.lastSequence >= sequence ||
        current.status === "REVOKED" || current.status === "EXPIRED" || Date.parse(current.expiresAt) <= Date.now()) {
        throw new LauncherApiError("GUARD_SESSION_INVALID", "The Launcher Guard session is invalid or expired.");
    }
    const requestedRole = ParseLauncherGuardRole(body?.role);
    if (requestedRole != undefined && requestedRole !== current.role) {
        throw new LauncherApiError("GUARD_SESSION_INVALID", "The Launcher Guard role does not match the session.");
    }
    const material = LauncherGuardSignatureMaterial({ role: current.role, guardSessionId, sequence, challenge: current.challenge,
        manifestId: current.manifestId, manifestSequence: current.manifestSequence, observedAt, signals });
    let signature: Buffer;
    try { signature = Buffer.from(signatureText, "base64"); } catch { signature = Buffer.alloc(0); }
    const rawPublic = Buffer.from(current.publicKeyBase64, "base64");
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPublic]);
    let signatureValid = false;
    try { signatureValid = signature.length === 64 && crypto.verify(null, Buffer.from(material),
        crypto.createPublicKey({ key: spki, format: "der", type: "spki" }), signature); } catch { signatureValid = false; }
    if (!signatureValid) {
        throw new LauncherApiError("GUARD_SIGNATURE_INVALID", "The Launcher Guard heartbeat could not be authenticated.");
    }
    const manifest = GetPublishedGuardManifest(current.channel);
    if (manifest == undefined || !IsGuardManifestCurrent(manifest, current.manifestId, current.manifestSequence)) {
        throw new LauncherApiError("GUARD_MANIFEST_MISMATCH", "The Launcher Guard manifest changed; restart the game.");
    }
    const riskScore = Math.min(100, scoreSignals(signals, manifest.maximumPrivateExecutableBytes,
        manifest.maximumWritableExecutableBytes) +
        continuityRisk(current.lastSignals, signals, current.lastSequence));
    const status = guardStatus(signals, manifest.maximumPrivateExecutableBytes,
        manifest.maximumWritableExecutableBytes, riskScore);
    const heartbeatAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
    const nextChallenge = opaque(24);
    const updated = await GetRepositories().launcherGuard.advance({ guardSessionId, accountId,
        expectedChallenge: current.challenge, sequence, nextChallenge, status, riskScore,
        heartbeatAt, expiresAt, signals });
    if (!updated) throw new LauncherApiError("GUARD_SEQUENCE_CONFLICT", "The Launcher Guard heartbeat was superseded.");
    return { schema: 1, accepted: true, role: current.role, status, riskScore, nextChallenge, expiresAt };
}

export async function GetLauncherGuardStatus(accountId: string, guardSessionId: string): Promise<Record<string, unknown>> {
    const session = await GetRepositories().launcherGuard.find(guardSessionId);
    if (!session || session.accountId !== accountId) throw new LauncherApiError("GUARD_SESSION_INVALID", "Launcher Guard session not found.");
    return { schema: 1, role: session.role, guardSessionId, status: session.status, riskScore: session.riskScore,
        manifestId: session.manifestId, manifestSequence: session.manifestSequence,
        lastHeartbeatAt: session.lastHeartbeatAt, expiresAt: session.expiresAt };
}

export const LauncherGuardInternals = { scoreSignals, hasHardIntegrityViolation, guardStatus, continuityRisk, IsGuardManifestCurrent };
