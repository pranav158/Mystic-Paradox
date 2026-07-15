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














export type AccountApprovalStatus = "pending" | "approved" | "rejected";
export type AccountOperationalStatus = "active" | "banned" | "disabled";

export interface LauncherAccountRecord {
    userId: string;
    
    email?: string;
    
    displayNameNormalized: string;
    displayName: string;
    
    passwordHash?: string;
    status: AccountOperationalStatus;
    
    approvalStatus?: AccountApprovalStatus;
    approvalUpdatedAt?: string;
    approvalUpdatedBy?: string;
    approvalReason?: string;
    roles: string[];
    createdAt: string;
    lastLoginAt?: string;
    
    usernameSet?: boolean;
}

export interface LauncherAccountRepository {
    findByUserId(userId: string): Promise<LauncherAccountRecord | undefined>;
    findByEmail(normalizedEmail: string): Promise<LauncherAccountRecord | undefined>;
    findByDisplayNameNormalized(normalizedDisplayName: string): Promise<LauncherAccountRecord | undefined>;

    
    create(account: LauncherAccountRecord): Promise<void>;

    updateLastLogin(userId: string, whenIso: string): Promise<void>;

    
    setUsername(userId: string, displayName: string, displayNameNormalized: string): Promise<void>;

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
}
