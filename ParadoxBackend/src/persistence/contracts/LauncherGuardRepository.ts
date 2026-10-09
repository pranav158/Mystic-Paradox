import { ClientSession } from "mongodb";

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
}

/** A Guard session is bound to one protected process role. */
export type LauncherGuardRole = "client" | "host";

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
    status: "CHALLENGED" | "HEALTHY" | "DEGRADED" | "REVOKED" | "EXPIRED";
    riskScore: number;
    createdAt: string;
    expiresAt: string;
    lastHeartbeatAt?: string;
    lastSignals?: LauncherGuardSignals;
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
    }, session?: ClientSession): Promise<LauncherGuardSessionRecord | undefined>;
    revokeForAccount(accountId: string, role: LauncherGuardRole, revokedAt: string, session?: ClientSession): Promise<void>;
}
