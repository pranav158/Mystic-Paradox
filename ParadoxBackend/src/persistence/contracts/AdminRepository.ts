/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession } from "mongodb";

export interface AdminSessionRecord {
    id: string;
    tokenHash: string;
    userId: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
    ip: string;
    userAgent: string;
    revokedAt?: string;
}

export interface AdminAuditRecord {
    id: string;
    actorUserId: string;
    targetUserId?: string;
    action: string;
    oldState?: unknown;
    newState?: unknown;
    reason?: string;
    ip: string;
    requestId: string;
    createdAt: string;
}

export interface PlayerDeletionResult {
    deletedCounts: Record<string, number>;
    characterCount: number;
}

export interface AdminRepository {
    createSession(session: AdminSessionRecord): Promise<void>;
    findActiveSessionByTokenHash(tokenHash: string): Promise<AdminSessionRecord | undefined>;
    revokeSession(id: string): Promise<void>;
    appendAudit(record: AdminAuditRecord, session?: ClientSession): Promise<void>;
    listAudit(targetUserId: string | undefined, skip: number, limit: number): Promise<{ records: AdminAuditRecord[]; total: number }>;
    deletePlayerData(userId: string, audit: AdminAuditRecord): Promise<PlayerDeletionResult>;
}
