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









export interface RefreshSessionRecord {
    id: string;
    tokenHash: string;
    userId: string;
    familyId: string;
    deviceId: string;
    deviceName: string;
    createdAt: string;
    expiresAt: string;
    revokedAt?: string;
}

export interface RefreshSessionRepository {
    create(session: RefreshSessionRecord): Promise<void>;
    findByTokenHash(tokenHash: string): Promise<RefreshSessionRecord | undefined>;
    revokeById(id: string): Promise<void>;
    revokeFamily(familyId: string): Promise<void>;
    revokeAllForUser(userId: string): Promise<void>;
    isFamilyActive(familyId: string, userId: string): Promise<boolean>;
}
