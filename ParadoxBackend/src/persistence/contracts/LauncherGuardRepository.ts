import { ClientSession } from "mongodb";

/** One module the launcher found outside the game's expected set (the launcher sends basenames only; see launcherGuard.ts). */
export interface LauncherGuardUnexpectedModule {
    fileName: string;
    /** The Authenticode subject, or "unsigned". */
    signer: string;
    sha256: string;
    size: number;
}

export interface LauncherGuardSignals {
    gameProcessId: number;
    gameStartedAt: string;
    moduleCount: number;
    moduleSetDigest: string;
    privateExecutableBytes: number;
    writableExecutableBytes: number;
    unexpectedModuleCount: number;
    protectedPageMismatchCount: number;
    debuggerPresent: boolean;
    /** [2026-10-14] Optional: at most 32 entries, validated by the controller. Not part of the signed material. */
    unexpectedModules?: LauncherGuardUnexpectedModule[];
}

/** A Guard session is bound to one protected process role. */
export type LauncherGuardRole = "client" | "host";

export type LauncherGuardStatus = "CHALLENGED" | "HEALTHY" | "DEGRADED" | "REVOKED" | "EXPIRED";

/** One heartbeat as the session remembers it (the last GUARD_HISTORY_LIMIT, newest first). */
export interface LauncherGuardHeartbeatEntry {
    at: string;
    status: "HEALTHY" | "DEGRADED";
    riskScore: number;
    /** Why the score was given: DEBUGGER, UNEXPECTED_UNSIGNED:n, UNEXPECTED_SIGNED:n, PAGE_MISMATCH:n, WRITABLE_EXEC_OVER, PRIVATE_EXEC_OVER, PROCESS_CHANGED, MODULE_SET_CHANGED. */
    reasons: string[];
}

export const GUARD_HISTORY_LIMIT = 20;
/** Accounts kept per module finding (exact up to this; accountCount stops at it). */
export const GUARD_FINDING_ACCOUNT_LIMIT = 1000;

export interface LauncherGuardSessionRecord {
    guardSessionId: string;
    accountId: string;
    role: LauncherGuardRole;
    publicKeyBase64: string;
    manifestId: string;
    manifestSequence: number;
    channel: string;
    launcherVersion: string;
    challenge: string;
    lastSequence: number;
    status: LauncherGuardStatus;
    riskScore: number;
    createdAt: string;
    expiresAt: string;
    lastHeartbeatAt?: string;
    lastSignals?: LauncherGuardSignals;
    /** Reason codes of the latest accepted heartbeat. */
    reasons?: string[];
    /** The last GUARD_HISTORY_LIMIT heartbeats, newest first. */
    history?: LauncherGuardHeartbeatEntry[];
}

export interface LauncherGuardSessionFilter {
    status?: LauncherGuardStatus;
    /** Sessions whose latest riskScore is at least this value. */
    minRisk?: number;
}

/** A module seen outside the expected set, across every account that reported it. */
export interface GuardFindingRecord {
    fileName: string;
    sha256: string;
    signer: string;
    size: number;
    firstSeenAt: string;
    lastSeenAt: string;
    /** Guard sessions that reported the module (counted when it is new to that session's latest heartbeat). */
    sessionCount: number;
    /** Distinct accounts that reported it, exact up to GUARD_FINDING_ACCOUNT_LIMIT. */
    accountCount: number;
}

export interface GuardFindingSummary extends GuardFindingRecord {}

export interface GuardFindingSighting {
    fileName: string;
    sha256: string;
    signer: string;
    size: number;
    accountId: string;
    seenAt: string;
    /** True when the module was not among the same session's previous heartbeat. */
    newInSession: boolean;
}

export interface LauncherGuardRepository {
    create(record: LauncherGuardSessionRecord, session?: ClientSession): Promise<void>;
    find(guardSessionId: string, session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined>;
    findHealthyForAccount(accountId: string, guardSessionId: string, role: LauncherGuardRole, now: string, session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined>;
    advance(input: {
        guardSessionId: string;
        accountId: string;
        expectedChallenge: string;
        sequence: number;
        nextChallenge: string;
        status: "HEALTHY" | "DEGRADED";
        riskScore: number;
        heartbeatAt: string;
        expiresAt: string;
        signals: LauncherGuardSignals;
        reasons: string[];
        historyEntry: LauncherGuardHeartbeatEntry;
    }, session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined>;
    revokeForAccount(accountId: string, role: LauncherGuardRole, revokedAt: string, session?: ClientSession): Promise<void>;
    /** Sessions newest first (createdAt), with the optional filters. The records keep their secrets: callers redact them. */
    listSessions(filter: LauncherGuardSessionFilter, skip: number, limit: number): Promise<{ records: LauncherGuardSessionRecord[]; total: number }>;
    /** Findings most seen first (sessionCount, then lastSeenAt); signer is a case-insensitive substring filter. */
    listFindings(filter: { signer?: string }, skip: number, limit: number): Promise<{ records: GuardFindingSummary[]; total: number }>;
    /** Upserts one module finding and records the account (up to GUARD_FINDING_ACCOUNT_LIMIT). Atomic per provider. */
    recordFindingSighting(input: GuardFindingSighting): Promise<void>;
}
