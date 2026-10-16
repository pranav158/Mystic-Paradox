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

import { ClassifyReportedLauncherBuild, RecordLauncherBuild, TouchGameSession } from "../activity/activityMonitor";
import { ParseLauncherBuildReport } from "../activity/activityRules";
import crypto from "crypto";
import { GetRepositories, LauncherAccountRecord } from "../persistence";
import { ResolveRegistrationApproval } from "../config/registrationApproval";
import { HashPassword, VerifyPassword } from "../security/passwords";
import { GenerateOpaqueToken, HashOpaqueToken, SignLauncherAccessToken } from "../security/launcherTokens";
import { LauncherApiError } from "../security/launcherErrors";
import { AssertUsernameAllowed, ValidateUsername } from "../security/usernamePolicy";
import { CurrentUnofficialLauncherPolicy, UNOFFICIAL_LAUNCHER_MESSAGE, UnofficialLauncherRefuses } from "../security/unofficialLauncherPolicy";
import { IsRateLimited } from "../security/rateLimit";
import { MaskEmail } from "../security/emailCodes";
import { EmailVerificationRequired } from "../config/emailVerification";
import { DescribeMailError } from "../mail/mailSender";
import { IssueEmailCode, RequireEmailSending } from "./emailCodes";
import { logger } from "../logger";
import { AuthorizeGameSessionRealm } from "../realms/entry";
import { MongoServerError } from "mongodb";
import { OFFICIAL_PLAY_UNAVAILABLE_MESSAGE, ReadOfficialPlay } from "../config/officialPlay";
import { AssertAccountAdmitted, AssertAccountEligible, EffectiveApprovalStatus } from "../security/accountEligibility";
import { AssertAccountNotDeactivated, AssertConsentCurrentWhenEnforced, ValidateRegistrationConsent } from "../security/accountConsent";
import {
    AssertRuntimeArtifactSetApproved,
    AssertRuntimeChannelMatchesAccount,
    RuntimeChannel
} from "../security/runtimeAuthorization";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EXCHANGE_CODE_TTL_MS = 60 * 1000; // 60 seconds
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
// Usernames (the in-game display name AND the /invite <name> handle) follow security/usernamePolicy.ts: letters and digits, 3–16 chars,
// unique case-insensitively, and [2026-10-16] at least one letter, no staff/project impersonation, nothing vulgar, abusive or a slur.

// Comma-separated allow-list of the exact executable hashes this server will hand
// out a game session for — the "approved build manifest" referenced in
// Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md. Deliberately fails closed: an unset
// or empty list rejects every request rather than silently trusting any hash a
// client claims, matching this codebase's existing fail-closed conventions
// (routes/eos.ts's ALLOW_NO_AUTH_DEV_MODE, the TARGET_CHANGELIST check below).
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
    /** [2026-10-15] The Discord identity linked in Settings (the name only: the sign-in asks for identify, no email). */
    discord: { linked: boolean; username?: string };
    /** [2026-10-15] True once the email was verified by a code (or a password reset by code). */
    emailVerified: boolean;
    status: "active" | "banned" | "disabled";
    approvalStatus: "pending" | "approved" | "rejected";
    /** True when the account has no chosen username yet (fresh Discord account) — the
     *  launcher must force a set-username step before the account is usable in-game. */
    needsUsername: boolean;
}

export interface LauncherSessionResult {
    accessToken: string;
    refreshToken: string;
    account: LauncherAccountView;
}

export interface PendingRegistrationResult {
    /** False when the account was approved at once (MYSTICPARADOX_REGISTRATION_APPROVAL=off, the default). */
    approvalRequired: boolean;
    account: LauncherAccountView;
    /** [2026-10-15] Present (true, with the normalized address) when a code was mailed and the launcher must ask for it (EMAIL_VERIFICATION=required). */
    verificationRequired?: true;
    email?: string;
}

function NormalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function NormalizeDisplayName(displayName: string): string {
    return displayName.trim().toLowerCase();
}

/** [2026-10-16] True when another account (not `exceptUserId`) holds this name in any letter case. */
async function UsernameTaken(username: string, exceptUserId?: string): Promise<boolean> {
    const Existing = await GetRepositories().launcherAccounts.findByDisplayNameNormalized(username.toLowerCase());
    return Existing != undefined && Existing.userId !== exceptUserId;
}

// [2026-10-09, ported from the public repo's August security follow-ups] Linear-time email check. The old
// /^[^\s@]+@[^\s@]+\.[^\s@]+$/ backtracks quadratically: a 50 KB "a@...." body held the event loop for 2.2 s
// (measured), and express.json accepts 100 KB, so one unauthenticated registration could stall the Metagame.
export function IsValidEmailAddress(raw: unknown): raw is string {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 254) {
        return false;
    }
    const at = raw.indexOf("@");
    if (at <= 0 || at !== raw.lastIndexOf("@") || at > 64) {
        return false;
    }
    const local = raw.slice(0, at);
    const domain = raw.slice(at + 1);
    if (
        domain.length < 3
        || domain.startsWith(".")
        || domain.endsWith(".")
        || !domain.includes(".")
    ) {
        return false;
    }
    for (const char of local + domain) {
        if (char === " " || char === "\t" || char === "\r" || char === "\n") {
            return false;
        }
    }
    return true;
}

function ValidateRegistrationInput(email: string, password: string): void {
    if (!IsValidEmailAddress(email)) {
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
        discord: DiscordIdentity == undefined ? { linked: false } : { linked: true, username: DiscordIdentity.providerUsername },
        emailVerified: account.emailVerifiedAt != undefined,
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

/**
 * [2026-10-15] Refuses a banned or disabled account with its own error. The approval state is not looked at here: the sign-in checks it
 * afterwards, so a banned account never gets a code.
 */
export function AssertAccountNotBlocked(account: LauncherAccountRecord): void {
    if (account.status === "banned" || account.status === "disabled") AssertAccountAdmitted(account);
}

/**
 * [2026-10-15] The answer of a sign-in that proved the email with a code (verify or reset): the session a password sign-in gives when the
 * account is admitted, or, while the approval is pending, the registration's approval answer (no session). Banned, disabled and rejected
 * accounts are refused as at password sign-in.
 */
export async function SignInAfterEmailProof(account: LauncherAccountRecord, deviceId: string, deviceName: string):
    Promise<LauncherSessionResult | { approvalRequired: true; account: LauncherAccountView }> {
    try {
        AssertAccountAdmitted(account);
    } catch (error) {
        if (error instanceof LauncherApiError && error.code === "AUTH_APPROVAL_PENDING") {
            return { approvalRequired: true, account: await ToAccountView(account) };
        }
        throw error;
    }

    const Now = new Date().toISOString();
    await GetRepositories().launcherAccounts.updateLastLogin(account.userId, Now);

    const Session = await CreateSessionForUser(account.userId, deviceId, deviceName);

    return { ...Session, account: await ToAccountView({ ...account, lastLoginAt: Now }) };
}

export async function RegisterAccount(
    displayName: unknown,
    email: string,
    password: string,
    deviceName: string,
    deviceId: string,
    ip: string,
    // [2026-10-14] The consent the launcher sends ({termsVersion, privacyVersion, ageConfirmed}); see ValidateRegistrationConsent.
    consent?: unknown
): Promise<PendingRegistrationResult> {
    if (IsRateLimited(`register:${ip}`, 5, 60 * 60 * 1000)) {
        throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many registration attempts. Try again later.");
    }

    // [2026-10-15] displayName is optional. Without one (absent, null or blank) the account carries its userId as its placeholder name and
    // usernameSet false, exactly as Discord accounts do; the launcher then asks for the name (account.needsUsername). A name that is sent is
    // validated as before. [2026-10-16] Launcher 0.1.71 asks for the name on the sign-up form again (a pending account has no session to set
    // one after its email code); the name stays optional here so launchers 0.1.67-0.1.70 can still register.
    const GivenName = displayName === undefined || displayName === null || (typeof displayName === "string" && displayName.trim() === "")
        ? undefined
        : ValidateUsername(displayName);
    if (GivenName !== undefined) AssertUsernameAllowed(GivenName);
    ValidateRegistrationInput(email, password);
    const AcceptedConsent = ValidateRegistrationConsent(consent, new Date().toISOString());

    const NormalizedEmail = NormalizeEmail(email);
    const NormalizedDisplayName = GivenName === undefined ? undefined : NormalizeDisplayName(GivenName);

    const Repos = GetRepositories();
    // [2026-10-15] Under MYSTICPARADOX_EMAIL_VERIFICATION=required the code mail must be set up before an account is created: an account
    // that can never be verified would only wait for the 48 h sweep.
    const VerificationRequired = EmailVerificationRequired();
    if (VerificationRequired) RequireEmailSending();

    if ((await Repos.launcherAccounts.findByEmail(NormalizedEmail)) != undefined) {
        throw new LauncherApiError("AUTH_EMAIL_TAKEN", "That email is already registered.");
    }

    if (GivenName !== undefined && await UsernameTaken(GivenName)) {
        throw new LauncherApiError("AUTH_DISPLAY_NAME_TAKEN", "That display name is already taken.");
    }

    const UserId = crypto.randomUUID();
    const PasswordHash = await HashPassword(password);
    // [2026-10-14] MYSTICPARADOX_REGISTRATION_APPROVAL: off (the default) approves at once on every provider; required keeps pending.
    const approvalStatus = ResolveRegistrationApproval(process.env).approvalStatus;
    const CreatedAt = new Date().toISOString();

    const Account: LauncherAccountRecord = {
        userId: UserId,
        email: NormalizedEmail,
        // The placeholder is the userId, lower-cased for the unique index, as Discord accounts use it.
        displayNameNormalized: (NormalizedDisplayName ?? UserId).toLowerCase(),
        displayName: GivenName ?? UserId,
        passwordHash: PasswordHash,
        status: "active",
        approvalStatus,
        roles: ["player"],
        createdAt: CreatedAt,
        usernameSet: GivenName !== undefined,
        ...(AcceptedConsent === undefined ? {} : { consent: AcceptedConsent }),
        // [2026-10-15] The sweep (controllers/launcherEmail.ts) removes this registration if it is not verified within 48 h.
        ...(VerificationRequired ? { emailVerificationPendingSince: CreatedAt } : {})
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

    // Pending accounts deliberately receive no access/refresh token. Possession
    // of the open-source launcher cannot bypass server-side admission.
    const approvalRequired = approvalStatus === "pending";
    const View = await ToAccountView(Account);
    if (!VerificationRequired) return { approvalRequired, account: View };

    // [2026-10-15] The first code is mailed now (no send limit applies yet). A failure leaves the account in place: the launcher can ask
    // for a code again, and the sweep removes the account if it never verifies. Still no token is issued here.
    try {
        await IssueEmailCode(UserId, NormalizedEmail, "verify", ip);
    } catch (error) {
        logger.warn(`[Email] the first code for user ${UserId} could not be stored (${DescribeMailError(error)})`);
    }
    return { approvalRequired, verificationRequired: true, email: NormalizedEmail, account: View };
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

    // [2026-10-15] A banned or disabled account is refused first: no code is mailed to it.
    AssertAccountNotBlocked(Account);

    // [2026-10-15] MYSTICPARADOX_EMAIL_VERIFICATION=required: the right password is not enough while the email is unverified (accounts from
    // before the switch included). A code is mailed within the send limits (when they are reached none is mailed, and the answer is the
    // same) and the sign-in waits for it. A wrong password never gets here.
    if (EmailVerificationRequired() && Account.emailVerifiedAt == undefined) {
        RequireEmailSending();
        await IssueEmailCode(Account.userId, Account.email ?? "", "verify", ip);
        throw new LauncherApiError(
            "AUTH_EMAIL_UNVERIFIED",
            `Enter the 6-digit code we sent to ${MaskEmail(Account.email ?? "")}. Older launchers: update the launcher to verify your email.`
        );
    }

    AssertAccountAdmitted(Account);

    const Now = new Date().toISOString();
    await GetRepositories().launcherAccounts.updateLastLogin(Account.userId, Now);

    const Session = await CreateSessionForUser(Account.userId, deviceId, deviceName);

    return { ...Session, account: await ToAccountView({ ...Account, lastLoginAt: Now }) };
}

/** [2026-10-15] How old lastLoginAt may get before a session restore or a Discord sign-in writes it again. */
export const LAST_SIGN_IN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * [2026-10-15] Records a sign-in that does not go through the password form. The launcher restores its saved session (RefreshSession) and
 * Discord signs in by OAuth; neither wrote lastLoginAt, so the dashboard's "Last sign-in" stayed at the last password sign-in (weeks old
 * for players who never retype their password). Token refreshes repeat while the launcher runs, so the write happens at most once every
 * LAST_SIGN_IN_WRITE_INTERVAL_MS per account. Returns the account as it now reads.
 */
export async function NoteSignIn(account: LauncherAccountRecord, now: Date = new Date()): Promise<LauncherAccountRecord> {
    const Last = Date.parse(account.lastLoginAt ?? "");
    if (Number.isFinite(Last) && now.getTime() - Last >= 0 && now.getTime() - Last < LAST_SIGN_IN_WRITE_INTERVAL_MS) return account;
    const WhenIso = now.toISOString();
    await GetRepositories().launcherAccounts.updateLastLogin(account.userId, WhenIso);
    return { ...account, lastLoginAt: WhenIso };
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
        // Someone replayed an already-rotated token — revoke the whole lineage
        // (spec: "reuse of an already-rotated refresh token revokes that token family").
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
    // [2026-10-15] A restored session is a sign-in for "Last sign-in" (NoteSignIn).
    const SignedIn = await NoteSignIn(Account);

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
        account: await ToAccountView(SignedIn)
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
    executableSha256: string,
    runtimeChannel: RuntimeChannel,
    runtimeManifestVersion: unknown,
    runtimeArtifacts: unknown,
    // [2026-10-13 realms hub design section 2.1] The optional `realm` of the request body, untouched. Absent (or null) = official
    // play, exactly as before; present = the realms module decides, and the code then carries the realm it was authorized for.
    realm?: unknown,
    // [2026-10-15] The body's `launcher` ({version, sha256} of the launcher's own exe; launchers from 0.1.65). Malformed = absent.
    launcherBuild?: unknown
): Promise<{ exchangeCode: string; expiresInSeconds: number }> {
    if (IsRateLimited(`game-session:${userId}`, 10, 5 * 60 * 1000)) {
        throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many launch attempts. Try again in a few minutes.");
    }

    const Account = await GetRepositories().launcherAccounts.findByUserId(userId);
    if (Account == undefined) {
        throw new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required.");
    }
    AssertAccountEligible(Account);
    // [2026-10-14] A deletion request deactivates the account (ACCOUNT_DEACTIVATED); MYSTICPARADOX_CONSENT_ENFORCE gates the consent.
    AssertAccountNotDeactivated(Account);
    AssertConsentCurrentWhenEnforced(Account);
    // [2026-10-15] Official play (no realm) is refused while MYSTICPARADOX_OFFICIAL_PLAY is off. A realm launch is not refused here: the
    // realm decides at the end of this function, as before.
    if ((realm === undefined || realm === null) && !ReadOfficialPlay().available) {
        throw new LauncherApiError("OFFICIAL_PLAY_UNAVAILABLE", OFFICIAL_PLAY_UNAVAILABLE_MESSAGE);
    }

    // The server derives the channel from CURRENT roles and verifies the exact runtime DLL hash
    // against that channel's signed release manifest. The launcher cannot retain a cached beta
    // DLL, claim "stable", and receive a ticket after Tester is revoked.
    AssertRuntimeChannelMatchesAccount(runtimeChannel, Account.roles);
    const RuntimeAttestation = AssertRuntimeArtifactSetApproved(runtimeChannel,
        runtimeManifestVersion, runtimeArtifacts);

    const TargetChangelist = Number(process.env.TARGET_CHANGELIST ?? NaN);

    if (!Number.isFinite(TargetChangelist) || buildChangelist !== TargetChangelist) {
        throw new LauncherApiError("GAME_BUILD_UNSUPPORTED", "This Dauntless build isn't supported. Verify or repair your installation.");
    }

    const NormalizedHash = typeof executableSha256 === "string" ? executableSha256.trim().toLowerCase() : "";

    if (!SHA256_HEX_PATTERN.test(NormalizedHash) || !GetApprovedExecutableHashes().has(NormalizedHash)) {
        logger.warn(`Rejected game-session request: unapproved executable hash for user=${userId} build=${buildChangelist}`);
        throw new LauncherApiError("GAME_BUILD_UNSUPPORTED", "This Dauntless installation isn't recognized. Verify or repair your installation.");
    }

    // [2026-10-16] An unofficial launcher build (security/unofficialLauncherPolicy.ts): refused only with
    // MYSTICPARADOX_UNOFFICIAL_LAUNCHER=refuse, and never an outdated official build, a report-less older launcher, an allowed test hash
    // or (by default) a tester or admin. Before the realm gate below, which may use an invite.
    const LauncherReport = ParseLauncherBuildReport(launcherBuild);
    const LauncherVerdict = ClassifyReportedLauncherBuild(runtimeChannel, LauncherReport);
    if (LauncherVerdict === "unofficial") {
        const LauncherPolicy = CurrentUnofficialLauncherPolicy();
        const Refused = UnofficialLauncherRefuses(LauncherVerdict, LauncherReport, Account.roles, LauncherPolicy);
        logger.info(`[UnofficialLauncher] ${Refused ? "refused" : LauncherPolicy.mode === "refuse" ? "exempt" : "observe, would refuse"}`
            + ` Play user=${userId} launcher=${LauncherReport?.version ?? "?"} sha256=${LauncherReport?.sha256.slice(0, 16) ?? "?"}...`);
        if (Refused) throw new LauncherApiError("LAUNCHER_UNOFFICIAL", UNOFFICIAL_LAUNCHER_MESSAGE);
    }

    // Last gate before the code exists: entering a realm may use an invite and add the member, so nothing above may still refuse.
    const RealmEntry = await AuthorizeGameSessionRealm(userId, realm);

    const Code = GenerateOpaqueToken();
    const Now = new Date();
    const ExpiresAt = new Date(Now.getTime() + EXCHANGE_CODE_TTL_MS);

    await GetRepositories().gameExchangeCodes.create({
        codeHash: HashOpaqueToken(Code),
        userId,
        launcherSessionId,
        buildChangelist,
        executableSha256: NormalizedHash,
        runtimeChannel,
        runtimeSha256: RuntimeAttestation.runtimeSha256,
        runtimeManifestVersion: RuntimeAttestation.version,
        runtimeArtifactSetSha256: RuntimeAttestation.artifactSetSha256,
        ...(RealmEntry === undefined ? {} : { realmId: RealmEntry.realmId }),
        createdAt: Now.toISOString(),
        expiresAt: ExpiresAt.toISOString()
    });

    // [2026-10-14] A game session starts here (the activity monitor's playtime; presence touches extend it).
    TouchGameSession(userId);
    // [2026-10-15] The launcher build this Play came from (UNOFFICIAL_LAUNCHER flag; a monitor, never awaited, never throws).
    void RecordLauncherBuild(userId, runtimeChannel, LauncherReport);
    return { exchangeCode: Code, expiresInSeconds: EXCHANGE_CODE_TTL_MS / 1000 };
}

// Registration-time (pre-auth) availability check: is this username valid and free?
export async function CheckUsernameAvailable(rawUsername: string): Promise<{ available: boolean; reason?: string }> {
    let Username: string;

    try {
        Username = ValidateUsername(rawUsername);
        AssertUsernameAllowed(Username);
    } catch (error) {
        return { available: false, reason: error instanceof LauncherApiError ? error.message : "Invalid username." };
    }

    return await UsernameTaken(Username) ? { available: false, reason: "That username is already taken." } : { available: true };
}

// Sets the authenticated account's unique username (used by the Discord set-username step, and
// safe to reuse if a username change flow is ever added). Validates format + uniqueness.
export async function SetUsername(userId: string, rawUsername: string): Promise<LauncherAccountView> {
    const Username = ValidateUsername(rawUsername);
    const Normalized = Username.toLowerCase();

    const Repos = GetRepositories();
    const Account = await Repos.launcherAccounts.findByUserId(userId);
    if (Account == undefined) {
        throw new LauncherApiError("NOT_FOUND", "Account not found.");
    }

    // Allow keeping your own name (even one the policy would refuse now, set before it existed); block taking someone else's.
    if (Account.usernameSet === false || Account.displayNameNormalized !== Normalized) AssertUsernameAllowed(Username);
    if (await UsernameTaken(Username, userId)) {
        throw new LauncherApiError("AUTH_DISPLAY_NAME_TAKEN", "That username is already taken.");
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
