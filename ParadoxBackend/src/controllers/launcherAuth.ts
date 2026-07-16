/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "crypto";
import { GetRepositories, LauncherAccountRecord } from "../persistence";
import { HashPassword, VerifyPassword } from "../security/passwords";
import { GenerateOpaqueToken, HashOpaqueToken, SignLauncherAccessToken } from "../security/launcherTokens";
import { LauncherApiError } from "../security/launcherErrors";
import { IsRateLimited } from "../security/rateLimit";
import { logger } from "../logger";
import { MongoServerError } from "mongodb";
import { AssertAccountAdmitted, AssertAccountEligible, EffectiveApprovalStatus } from "../security/accountEligibility";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; 
const EXCHANGE_CODE_TTL_MS = 60 * 1000; 
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;


const USERNAME_PATTERN = /^[A-Za-z0-9]+$/;
const USERNAME_MIN = 3;
const USERNAME_MAX = 16;







function GetApprovedExecutableHashes(): Set<string> {
    return new Set(
        (process.env.APPROVED_EXECUTABLE_SHA256 ?? "")
            .split(",")
            .map((h) => h.trim().toLowerCase())
            .filter((h) => SHA256_HEX_PATTERN.test(h))
    );
}

export interface LauncherAccountView {
    userId: string;
    displayName: string;
    email: string;
    discordLinked: boolean;
    status: "active" | "banned" | "disabled";
    approvalStatus: "pending" | "approved" | "rejected";
    
    needsUsername: boolean;
}

export interface LauncherSessionResult {
    accessToken: string;
    refreshToken: string;
    account: LauncherAccountView;
}

export interface PendingRegistrationResult {
    approvalRequired: true;
    account: LauncherAccountView;
}

function NormalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function NormalizeDisplayName(displayName: string): string {
    return displayName.trim().toLowerCase();
}


function ValidateUsername(raw: unknown): string {
    const username = typeof raw === "string" ? raw.trim() : "";

    if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", `Username must be ${USERNAME_MIN}\u2013${USERNAME_MAX} characters.`);
    }

    if (!USERNAME_PATTERN.test(username)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Username can only contain letters and numbers (no spaces or symbols).");
    }

    return username;
}

function ValidateRegistrationInput(email: string, password: string): void {
    if (typeof email !== "string" || !EMAIL_PATTERN.test(email)) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Enter a valid email address.");
    }

    if (typeof password !== "string" || password.length < 8) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Password must be at least 8 characters.");
    }
}

export async function GetAccountView(userId: string): Promise<LauncherAccountView> {
    const Account = await GetRepositories().launcherAccounts.findByUserId(userId);

    if (Account == undefined) {
        throw new LauncherApiError("NOT_FOUND", "Account not found.");
    }

    return ToAccountView(Account);
}

export async function ToAccountView(account: LauncherAccountRecord): Promise<LauncherAccountView> {
    const DiscordIdentity = await GetRepositories().authIdentities.findByUserId("discord", account.userId);

    return {
        userId: account.userId,
        displayName: account.displayName,
        email: account.email ?? "",
        discordLinked: DiscordIdentity != undefined,
        status: account.status,
        approvalStatus: EffectiveApprovalStatus(account),
        needsUsername: account.usernameSet === false
    };
}

export async function CreateSessionForUser(userId: string, deviceId: string, deviceName: string): Promise<{ accessToken: string; refreshToken: string }> {
    const FamilyId = crypto.randomUUID();
    const SessionId = crypto.randomUUID();
    const RefreshToken = GenerateOpaqueToken();
    const Now = new Date();
    const ExpiresAt = new Date(Now.getTime() + REFRESH_TOKEN_TTL_MS);

    await GetRepositories().refreshSessions.create({
        id: SessionId,
        tokenHash: HashOpaqueToken(RefreshToken),
        userId,
        familyId: FamilyId,
        deviceId,
        deviceName,
        createdAt: Now.toISOString(),
        expiresAt: ExpiresAt.toISOString()
    });

    return {
        accessToken: SignLauncherAccessToken({ userId, sid: FamilyId }),
        refreshToken: RefreshToken
    };
}

export async function RegisterAccount(
    displayName: string,
    email: string,
    password: string,
    deviceName: string,
    deviceId: string,
    ip: string
): Promise<PendingRegistrationResult> {
    if (IsRateLimited(`register:${ip}`, 5, 60 * 60 * 1000)) {
        throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many registration attempts. Try again later.");
    }

    const CleanUsername = ValidateUsername(displayName);
    ValidateRegistrationInput(email, password);

    const NormalizedEmail = NormalizeEmail(email);
    const NormalizedDisplayName = NormalizeDisplayName(CleanUsername);

    const Repos = GetRepositories();

    if ((await Repos.launcherAccounts.findByEmail(NormalizedEmail)) != undefined) {
        throw new LauncherApiError("AUTH_EMAIL_TAKEN", "That email is already registered.");
    }

    if ((await Repos.launcherAccounts.findByDisplayNameNormalized(NormalizedDisplayName)) != undefined) {
        throw new LauncherApiError("AUTH_DISPLAY_NAME_TAKEN", "That display name is already taken.");
    }

    const UserId = crypto.randomUUID();
    const PasswordHash = await HashPassword(password);

    const Account: LauncherAccountRecord = {
        userId: UserId,
        email: NormalizedEmail,
        displayNameNormalized: NormalizedDisplayName,
        displayName: CleanUsername,
        passwordHash: PasswordHash,
        status: "active",
        approvalStatus: "pending",
        roles: ["player"],
        createdAt: new Date().toISOString(),
        usernameSet: true
    };

    try {
        await Repos.launcherAccounts.create(Account);
    } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) {
            if (error.keyPattern?.email) {
                throw new LauncherApiError("AUTH_EMAIL_TAKEN", "That email is already registered.");
            }
            if (error.keyPattern?.displayNameNormalized) {
                throw new LauncherApiError("AUTH_DISPLAY_NAME_TAKEN", "That display name is already taken.");
            }
        }
        throw error;
    }

    logger.info(`Launcher account registered: ${UserId}`);

    
    
    return { approvalRequired: true, account: await ToAccountView(Account) };
}

export async function LoginWithPassword(email: string, password: string, deviceId: string, deviceName: string, ip: string): Promise<LauncherSessionResult> {
    if (IsRateLimited(`login:${ip}`, 10, 5 * 60 * 1000) || IsRateLimited(`login:${NormalizeEmail(email ?? "")}`, 10, 5 * 60 * 1000)) {
        throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many login attempts. Try again later.");
    }

    if (typeof email !== "string" || typeof password !== "string") {
        throw new LauncherApiError("AUTH_INVALID_CREDENTIALS", "The email or password is incorrect.");
    }

    const Account = await GetRepositories().launcherAccounts.findByEmail(NormalizeEmail(email));
    const PasswordOk = await VerifyPassword(Account?.passwordHash, password);

    if (Account == undefined || !PasswordOk) {
        throw new LauncherApiError("AUTH_INVALID_CREDENTIALS", "The email or password is incorrect.");
    }

    AssertAccountAdmitted(Account);

    const Now = new Date().toISOString();
    await GetRepositories().launcherAccounts.updateLastLogin(Account.userId, Now);

    const Session = await CreateSessionForUser(Account.userId, deviceId, deviceName);

    return { ...Session, account: await ToAccountView({ ...Account, lastLoginAt: Now }) };
}

export async function RefreshSession(rawRefreshToken: string, deviceId: string, deviceName: string): Promise<LauncherSessionResult> {
    if (typeof rawRefreshToken !== "string" || rawRefreshToken.length === 0) {
        throw new LauncherApiError("AUTH_REFRESH_INVALID", "Session expired. Please sign in again.");
    }

    const Repos = GetRepositories();
    const TokenHash = HashOpaqueToken(rawRefreshToken);
    const Session = await Repos.refreshSessions.findByTokenHash(TokenHash);

    if (Session == undefined) {
        throw new LauncherApiError("AUTH_REFRESH_INVALID", "Session expired. Please sign in again.");
    }

    if (Session.revokedAt != undefined) {
        
        
        logger.warn(`Refresh token reuse detected for family ${Session.familyId} — revoking.`);
        await Repos.refreshSessions.revokeFamily(Session.familyId);
        throw new LauncherApiError("AUTH_REFRESH_INVALID", "Session expired. Please sign in again.");
    }

    if (new Date(Session.expiresAt).getTime() < Date.now()) {
        throw new LauncherApiError("AUTH_REFRESH_INVALID", "Session expired. Please sign in again.");
    }

    const Account = await Repos.launcherAccounts.findByUserId(Session.userId);

    if (Account == undefined) {
        await Repos.refreshSessions.revokeFamily(Session.familyId);
        throw new LauncherApiError("AUTH_REFRESH_INVALID", "Session expired. Please sign in again.");
    }
    try {
        AssertAccountAdmitted(Account);
    } catch (error) {
        await Repos.refreshSessions.revokeFamily(Session.familyId);
        throw error;
    }

    await Repos.refreshSessions.revokeById(Session.id);

    const NewRefreshToken = GenerateOpaqueToken();
    const NewSessionId = crypto.randomUUID();
    const Now = new Date();
    const ExpiresAt = new Date(Now.getTime() + REFRESH_TOKEN_TTL_MS);

    await Repos.refreshSessions.create({
        id: NewSessionId,
        tokenHash: HashOpaqueToken(NewRefreshToken),
        userId: Session.userId,
        familyId: Session.familyId,
        deviceId: deviceId || Session.deviceId,
        deviceName: deviceName || Session.deviceName,
        createdAt: Now.toISOString(),
        expiresAt: ExpiresAt.toISOString()
    });

    return {
        accessToken: SignLauncherAccessToken({ userId: Session.userId, sid: Session.familyId }),
        refreshToken: NewRefreshToken,
        account: await ToAccountView(Account)
    };
}

export async function Logout(sid: string): Promise<void> {
    await GetRepositories().refreshSessions.revokeFamily(sid);
}

export async function LogoutAll(userId: string): Promise<void> {
    await GetRepositories().refreshSessions.revokeAllForUser(userId);
}

export async function RequestGameExchangeCode(
    userId: string,
    launcherSessionId: string,
    buildChangelist: number,
    executableSha256: string
): Promise<{ exchangeCode: string; expiresInSeconds: number }> {
    if (IsRateLimited(`game-session:${userId}`, 10, 5 * 60 * 1000)) {
        throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many launch attempts. Try again in a few minutes.");
    }

    const Account = await GetRepositories().launcherAccounts.findByUserId(userId);
    if (Account == undefined) {
        throw new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required.");
    }
    AssertAccountEligible(Account);

    const TargetChangelist = Number(process.env.TARGET_CHANGELIST ?? NaN);

    if (!Number.isFinite(TargetChangelist) || buildChangelist !== TargetChangelist) {
        throw new LauncherApiError("GAME_BUILD_UNSUPPORTED", "This Dauntless build isn't supported. Verify or repair your installation.");
    }

    const NormalizedHash = typeof executableSha256 === "string" ? executableSha256.trim().toLowerCase() : "";

    if (!SHA256_HEX_PATTERN.test(NormalizedHash) || !GetApprovedExecutableHashes().has(NormalizedHash)) {
        logger.warn(`Rejected game-session request: unapproved executable hash for user=${userId} build=${buildChangelist}`);
        throw new LauncherApiError("GAME_BUILD_UNSUPPORTED", "This Dauntless installation isn't recognized. Verify or repair your installation.");
    }

    const Code = GenerateOpaqueToken();
    const Now = new Date();
    const ExpiresAt = new Date(Now.getTime() + EXCHANGE_CODE_TTL_MS);

    await GetRepositories().gameExchangeCodes.create({
        codeHash: HashOpaqueToken(Code),
        userId,
        launcherSessionId,
        buildChangelist,
        executableSha256: NormalizedHash,
        createdAt: Now.toISOString(),
        expiresAt: ExpiresAt.toISOString()
    });

    return { exchangeCode: Code, expiresInSeconds: EXCHANGE_CODE_TTL_MS / 1000 };
}


export async function CheckUsernameAvailable(rawUsername: string): Promise<{ available: boolean; reason?: string }> {
    let Username: string;

    try {
        Username = ValidateUsername(rawUsername);
    } catch (error) {
        return { available: false, reason: error instanceof LauncherApiError ? error.message : "Invalid username." };
    }

    const Existing = await GetRepositories().launcherAccounts.findByDisplayNameNormalized(Username.toLowerCase());
    return Existing == undefined ? { available: true } : { available: false, reason: "That username is already taken." };
}



export async function SetUsername(userId: string, rawUsername: string): Promise<LauncherAccountView> {
    const Username = ValidateUsername(rawUsername);
    const Normalized = Username.toLowerCase();

    const Repos = GetRepositories();
    const Existing = await Repos.launcherAccounts.findByDisplayNameNormalized(Normalized);

    
    if (Existing != undefined && Existing.userId !== userId) {
        throw new LauncherApiError("AUTH_DISPLAY_NAME_TAKEN", "That username is already taken.");
    }

    const Account = await Repos.launcherAccounts.findByUserId(userId);
    if (Account == undefined) {
        throw new LauncherApiError("NOT_FOUND", "Account not found.");
    }

    try {
        await Repos.launcherAccounts.setUsername(userId, Username, Normalized);
    } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) {
            throw new LauncherApiError("AUTH_DISPLAY_NAME_TAKEN", "That username is already taken.");
        }
        throw error;
    }
    logger.info(`Username set for ${userId}: ${Username}`);

    return ToAccountView({ ...Account, displayName: Username, displayNameNormalized: Normalized, usernameSet: true });
}
