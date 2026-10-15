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

import { ClientSession } from "mongodb";

// Launcher-owned view of the SAME `accounts` collection AccountRepository already
// reads/writes (see Plans/LAUNCHER_BACKEND_AUTH_REQUIREMENTS.md — "userId continues
// to serve as the opaque accountId, no second identity system"). This repository
// adds the launcher-specific fields (email/displayName/passwordHash/status/roles)
// as additional document fields, and never modifies AccountRepository's code.
//
// On create() it ALSO seeds the two fields AccountRepository/the game path actually
// reads — `name` (mirrors displayName) and `notes` (0) — because this is the only
// place a launcher-created account's document comes into existence. Without this,
// a launcher account has no `name`, and GetUsernameForUserId/EnsureDevUser-adjacent
// game code falls back to showing the raw userId (a UUID) as the player's in-game
// name. AccountRepository itself is still never imported or edited here — this
// repository just writes fields AccountRepository's own shape expects to find.
export type AccountApprovalStatus = "pending" | "approved" | "rejected";
export type AccountOperationalStatus = "active" | "banned" | "disabled";

export interface LauncherAccountRecord {
    userId: string;
    /** Normalized (lowercased, trimmed). Absent for Discord-only accounts that
     *  never set a password (no `email` OAuth scope is requested — see spec). */
    email?: string;
    /** Normalized (lowercased, trimmed) for uniqueness checks; display value is
     *  stored separately so casing/spacing the player chose is preserved. */
    displayNameNormalized: string;
    displayName: string;
    /** Argon2id hash. Absent for Discord-only accounts. */
    passwordHash?: string;
    status: AccountOperationalStatus;
    /** Closed-test admission state. Legacy rows without this field are treated as
     * approved until the explicit migration script is run, avoiding accidental
     * lockout during deployment. New accounts always set it to pending. */
    approvalStatus?: AccountApprovalStatus;
    approvalUpdatedAt?: string;
    approvalUpdatedBy?: string;
    approvalReason?: string;
    roles: string[];
    /** Set whenever roles are changed via the admin API (see UpdatePlayerRoles) — lets
     *  GET /launcher/v1/policy report a value that changes exactly when this account's
     *  roles do. */
    rolesUpdatedAt?: string;
    rolesUpdatedBy?: string;
    createdAt: string;
    lastLoginAt?: string;
    /** False for a freshly Discord-created account that hasn't chosen its unique username
     *  yet (the launcher forces a set-username step). Absent/true once a username is set —
     *  email/password accounts set it at registration. */
    usernameSet?: boolean;
    /** [2026-10-14] The Terms of Use and Privacy Policy the player accepted, and the age confirmation (accountConsent.ts). Absent
     *  for a Discord account that has not accepted yet, and for accounts created before consent existed. */
    consent?: LauncherConsentRecord;
    /** [2026-10-14] A deletion request (routes/launcherAuth.ts). While present the account is deactivated: it can sign in
     *  and restore it, but it cannot play, host or join. scripts/process_account_deletions.ts erases it after scheduledFor. */
    deletion?: LauncherDeletionRecord;
    /** [2026-10-15] When the email was verified (a code entered, or a password reset by code). Absent until then, and for accounts
     *  from before email verification (they verify at their next sign-in under MYSTICPARADOX_EMAIL_VERIFICATION=required). */
    emailVerifiedAt?: string;
    /** [2026-10-15] Set on a registration made under MYSTICPARADOX_EMAIL_VERIFICATION=required, cleared when the email is verified. A
     *  registration still unverified 48 h after this time is removed by the sweep in controllers/launcherEmail.ts. */
    emailVerificationPendingSince?: string;
}

export interface LauncherConsentRecord {
    termsVersion: string;
    privacyVersion: string;
    ageConfirmed: true;
    acceptedAt: string;
}

export interface LauncherDeletionRecord {
    requestedAt: string;
    /** requestedAt plus the hold (retentionPolicy.ts DELETION_HOLD_DAYS). */
    scheduledFor: string;
}

export interface LauncherAccountRepository {
    findByUserId(userId: string, session?: ClientSession): Promise<LauncherAccountRecord | undefined>;
    findByEmail(normalizedEmail: string): Promise<LauncherAccountRecord | undefined>;
    findByDisplayNameNormalized(normalizedDisplayName: string): Promise<LauncherAccountRecord | undefined>;

    /** Inserts a brand-new account document. Caller generates a fresh opaque
     *  userId (crypto.randomUUID()) — this never reuses an existing dev/game
     *  account's id. */
    create(account: LauncherAccountRecord, session?: ClientSession): Promise<void>;

    updateLastLogin(userId: string, whenIso: string): Promise<void>;

    /** Sets the account's unique username (display name, shown in-game) and marks
     *  usernameSet=true. Also updates the game-owned `name` field. Caller has already
     *  validated the format and confirmed availability. */
    setUsername(userId: string, displayName: string, displayNameNormalized: string): Promise<void>;

    /** [2026-10-14] Records the account's consent to the current documents (replaces an earlier record). */
    setConsent(userId: string, consent: LauncherConsentRecord): Promise<void>;

    /** [2026-10-14] Sets or, with undefined, clears the deletion request. */
    setDeletion(userId: string, deletion: LauncherDeletionRecord | undefined): Promise<void>;

    /** [2026-10-14] Launcher accounts whose deletion hold has ended by `nowIso` (oldest first, at most `limit`). */
    listDeletionsDue(nowIso: string, limit: number): Promise<LauncherAccountRecord[]>;

    /** [2026-10-15] Records the email as verified and clears the pending mark (the account record is otherwise unchanged). */
    setEmailVerified(userId: string, verifiedAt: string): Promise<void>;

    /** [2026-10-15] Replaces the password hash (a password reset by code). */
    setPasswordHash(userId: string, passwordHash: string): Promise<void>;

    /**
     * [2026-10-15] Launcher accounts whose email is still unverified and whose registration has been pending since before
     * `pendingBeforeIso` (oldest first, at most `limit`). Accounts that never were pending (existing accounts) are never listed.
     */
    listUnverifiedRegistrations(pendingBeforeIso: string, limit: number): Promise<LauncherAccountRecord[]>;

    /**
     * [2026-10-15] Removes a launcher account, but only while it is still an unverified registration pending since before
     * `pendingBeforeIso`. Returns whether this call removed it (an account verified meanwhile is kept).
     */
    deleteUnverifiedRegistration(userId: string, pendingBeforeIso: string): Promise<boolean>;

    listForAdmin(filters: {
        approvalStatus?: AccountApprovalStatus;
        status?: AccountOperationalStatus;
        search?: string;
        skip: number;
        limit: number;
    }): Promise<{ accounts: LauncherAccountRecord[]; total: number }>;

    setAccessState(
        userId: string,
        changes: {
            approvalStatus?: AccountApprovalStatus;
            status?: AccountOperationalStatus;
            approvalUpdatedAt: string;
            approvalUpdatedBy: string;
            approvalReason?: string;
        }
    ): Promise<LauncherAccountRecord | undefined>;

    /** The only write path for roles — see controllers/admin.ts#UpdatePlayerRoles. */
    updateRoles(
        userId: string,
        roles: string[],
        changes: { rolesUpdatedAt: string; rolesUpdatedBy: string },
        session?: ClientSession
    ): Promise<LauncherAccountRecord | undefined>;
}
