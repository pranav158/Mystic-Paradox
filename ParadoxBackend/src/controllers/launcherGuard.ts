import crypto from "node:crypto";
import { GetRepositories, LauncherGuardRole, LauncherGuardSignals, LauncherGuardUnexpectedModule } from "../persistence";
import { GetPublishedGuardManifest } from "../routes/launcherUpdates";
import { LauncherApiError } from "../security/launcherErrors";
import { VersionAtLeast } from "../security/launcherVersion";
import { logger } from "../logger";

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const HEX64 = /^[0-9a-f]{64}$/i;
const SESSION_LIFETIME_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 60_000;

// [2026-10-14] Bounds for the launcher's unexpectedModules list (basenames, the Authenticode subject or "unsigned").
const UNEXPECTED_MODULE_LIMIT = 32;
const MODULE_FILE_NAME_LIMIT = 260;
const MODULE_SIGNER_LIMIT = 256;
const MODULE_SIZE_LIMIT = 2 ** 40;
const MODULE_SHA256 = /^[0-9a-f]{64}$/i;
// Separators are refused on their own (see ParseUnexpectedModules); this is the rest of what a Windows file name may not hold.
const MODULE_FILE_NAME_FORBIDDEN = /[\u0000-\u001f<>:"|?*]/;
// Reason codes for the score (stored with the session and in its history).
export interface LauncherGuardExplanation {
    score: number;
    reasons: string[];
}

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
    const Signals = { ...(input as LauncherGuardSignals) };
    const Modules = ParseUnexpectedModules(input.unexpectedModules);
    delete Signals.unexpectedModules;
    if (Modules !== undefined) Signals.unexpectedModules = Modules;
    return Signals;
}

function InvalidModuleReport(): LauncherApiError {
    return new LauncherApiError("GUARD_REPORT_INVALID", "The Launcher Guard report is invalid.");
}

/**
 * [2026-10-14] The modules the launcher found outside the expected set. Each file name is a basename: a path separator, a drive
 * colon, a control or Windows-forbidden character, "." and ".." are refused. The signer is the Authenticode subject or "unsigned".
 * At most UNEXPECTED_MODULE_LIMIT entries. Absent or null means no list. Anything malformed refuses the whole heartbeat.
 */
export function ParseUnexpectedModules(value: unknown): LauncherGuardUnexpectedModule[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.length > UNEXPECTED_MODULE_LIMIT) throw InvalidModuleReport();
    return value.map((entry): LauncherGuardUnexpectedModule => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw InvalidModuleReport();
        const Input = entry as Record<string, unknown>;
        const FileName = Input.fileName;
        if (typeof FileName !== "string" || FileName.length === 0 || FileName.length > MODULE_FILE_NAME_LIMIT ||
            FileName === "." || FileName === ".." || /[\\/]/.test(FileName) || MODULE_FILE_NAME_FORBIDDEN.test(FileName)) {
            throw InvalidModuleReport();
        }
        const Signer = Input.signer;
        if (typeof Signer !== "string" || Signer.length === 0 || Signer.length > MODULE_SIGNER_LIMIT || /[\u0000-\u001f]/.test(Signer)) {
            throw InvalidModuleReport();
        }
        const Sha256 = Input.sha256;
        if (typeof Sha256 !== "string" || !MODULE_SHA256.test(Sha256)) throw InvalidModuleReport();
        const Size = Input.size;
        if (typeof Size !== "number" || !Number.isSafeInteger(Size) || Size < 0 || Size > MODULE_SIZE_LIMIT) throw InvalidModuleReport();
        return { fileName: FileName, signer: Signer, sha256: Sha256.toLowerCase(), size: Size };
    });
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

/**
 * [2026-10-14] The unexpected modules split by signer. The count (unexpectedModuleCount) is signed and is the authority; the launcher's
 * unexpectedModules list is not signed, so it only says how many of that count carry a publisher's signature, and never adds to it.
 * A signer of "unsigned" or "invalid" (case-insensitive) is untrusted; any other signer is a signed module. Without the list (older
 * launchers) every module is untrusted, as before.
 */
function SplitUnexpectedModules(signals: LauncherGuardSignals): { untrusted: number; signed: number } {
    const count = signals.unexpectedModuleCount;
    const signedListed = (signals.unexpectedModules ?? []).filter((module) => !/^(unsigned|invalid)$/i.test(module.signer.trim())).length;
    const signed = Math.min(signedListed, count);
    return { untrusted: count - signed, signed };
}

/** [2026-10-14] The score of one report, with the reason codes that gave it (the same arithmetic as before the codes). */
function explainSignals(signals: LauncherGuardSignals, privateExecutableLimit: number,
    writableExecutableLimit = 0): LauncherGuardExplanation {
    let score = 0;
    const reasons: string[] = [];
    if (signals.debuggerPresent) {
        score += 50;
        reasons.push("DEBUGGER");
    }
    // Untrusted modules weigh as before (+15 each, a hard violation). Signed modules are a low-weight finding only.
    const { untrusted, signed } = SplitUnexpectedModules(signals);
    if (untrusted > 0) {
        score += Math.min(50, untrusted * 15);
        reasons.push(`UNEXPECTED_UNSIGNED:${untrusted}`);
    }
    if (signed > 0) {
        score += Math.min(10, signed * 2);
        reasons.push(`UNEXPECTED_SIGNED:${signed}`);
    }
    if (signals.protectedPageMismatchCount > 0) {
        score += Math.min(60, signals.protectedPageMismatchCount * 30);
        reasons.push(`PAGE_MISMATCH:${signals.protectedPageMismatchCount}`);
    }
    if (signals.writableExecutableBytes > writableExecutableLimit) {
        score += 60;
        reasons.push("WRITABLE_EXEC_OVER");
    }
    if (signals.privateExecutableBytes > privateExecutableLimit) {
        score += 40;
        reasons.push("PRIVATE_EXEC_OVER");
    }
    return { score: Math.min(100, score), reasons };
}

function scoreSignals(signals: LauncherGuardSignals, privateExecutableLimit: number,
    writableExecutableLimit = 0): number {
    return explainSignals(signals, privateExecutableLimit, writableExecutableLimit).score;
}

function hasHardIntegrityViolation(signals: LauncherGuardSignals, privateExecutableLimit: number,
    writableExecutableLimit = 0): boolean {
    return signals.debuggerPresent ||
        SplitUnexpectedModules(signals).untrusted > 0 ||
        signals.protectedPageMismatchCount > 0 ||
        signals.privateExecutableBytes > privateExecutableLimit ||
        signals.writableExecutableBytes > writableExecutableLimit;
}

function guardStatus(signals: LauncherGuardSignals, privateExecutableLimit: number,
    writableExecutableLimit: number, riskScore: number): "HEALTHY" | "DEGRADED" {
    return !hasHardIntegrityViolation(signals, privateExecutableLimit, writableExecutableLimit) && riskScore < 50
        ? "HEALTHY" : "DEGRADED";
}

function explainContinuity(previous: LauncherGuardSignals | undefined, current: LauncherGuardSignals,
    previousSequence: number): LauncherGuardExplanation {
    if (previous == undefined) return { score: 0, reasons: [] };
    if (previous.gameProcessId !== current.gameProcessId || previous.gameStartedAt !== current.gameStartedAt) {
        return { score: 100, reasons: ["PROCESS_CHANGED"] };
    }
    // Allow the first two reports for normal UE/Steam lazy module loading. Once warm, a changed
    // module set is a central risk finding even when a modified client reports zero unexpected DLLs.
    if (previousSequence >= 2 && previous.moduleSetDigest !== current.moduleSetDigest) return { score: 50, reasons: ["MODULE_SET_CHANGED"] };
    return { score: 0, reasons: [] };
}

function continuityRisk(previous: LauncherGuardSignals | undefined, current: LauncherGuardSignals,
    previousSequence: number): number {
    return explainContinuity(previous, current, previousSequence).score;
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
    const explained = explainSignals(signals, manifest.maximumPrivateExecutableBytes, manifest.maximumWritableExecutableBytes);
    const continuity = explainContinuity(current.lastSignals, signals, current.lastSequence);
    const riskScore = Math.min(100, explained.score + continuity.score);
    // [2026-10-14] Why the score was given: stored with the session and in its history.
    const reasons = [...explained.reasons, ...continuity.reasons];
    const status = guardStatus(signals, manifest.maximumPrivateExecutableBytes,
        manifest.maximumWritableExecutableBytes, riskScore);
    const heartbeatAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
    const nextChallenge = opaque(24);
    const updated = await GetRepositories().launcherGuard.advance({ guardSessionId, accountId,
        expectedChallenge: current.challenge, sequence, nextChallenge, status, riskScore,
        heartbeatAt, expiresAt, signals, reasons, historyEntry: { at: heartbeatAt, status, riskScore, reasons } });
    if (!updated) throw new LauncherApiError("GUARD_SEQUENCE_CONFLICT", "The Launcher Guard heartbeat was superseded.");
    await RecordGuardModuleFindings({ accountId, modules: signals.unexpectedModules,
        previousModules: current.lastSignals?.unexpectedModules, seenAt: heartbeatAt });
    return { schema: 1, accepted: true, role: current.role, status, riskScore, reasons, nextChallenge, expiresAt };
}

function ModuleFindingKey(module: LauncherGuardUnexpectedModule): string {
    return `${module.fileName}|${module.sha256}`;
}

/**
 * [2026-10-14] Records each module of an accepted heartbeat in the findings (per file name and hash). sessionCount counts the modules
 * that are new to the session (not in its previous heartbeat). A storage failure is logged and never refuses the heartbeat: the
 * findings are a monitor. Returns how many sightings were recorded.
 */
export async function RecordGuardModuleFindings(input: {
    accountId: string;
    modules?: LauncherGuardUnexpectedModule[];
    previousModules?: LauncherGuardUnexpectedModule[];
    seenAt: string;
}): Promise<number> {
    if (input.modules == undefined || input.modules.length === 0) return 0;
    const Previous = new Set((input.previousModules ?? []).map(ModuleFindingKey));
    const Seen = new Set<string>();
    let Recorded = 0;
    for (const Module of input.modules) {
        const Key = ModuleFindingKey(Module);
        if (Seen.has(Key)) continue;
        Seen.add(Key);
        try {
            await GetRepositories().launcherGuard.recordFindingSighting({
                fileName: Module.fileName, sha256: Module.sha256, signer: Module.signer, size: Module.size,
                accountId: input.accountId, seenAt: input.seenAt, newInSession: !Previous.has(Key)
            });
            Recorded += 1;
        } catch (error) {
            logger.warn(`[GuardFindings] could not record ${Module.fileName} for account=${input.accountId}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return Recorded;
}

export async function GetLauncherGuardStatus(accountId: string, guardSessionId: string): Promise<Record<string, unknown>> {
    const session = await GetRepositories().launcherGuard.find(guardSessionId);
    if (!session || session.accountId !== accountId) throw new LauncherApiError("GUARD_SESSION_INVALID", "Launcher Guard session not found.");
    return { schema: 1, role: session.role, guardSessionId, status: session.status, riskScore: session.riskScore,
        manifestId: session.manifestId, manifestSequence: session.manifestSequence,
        lastHeartbeatAt: session.lastHeartbeatAt, expiresAt: session.expiresAt };
}

export const LauncherGuardInternals = {
    scoreSignals, hasHardIntegrityViolation, guardStatus, continuityRisk, IsGuardManifestCurrent,
    explainSignals, explainContinuity, ParseUnexpectedModules
};
