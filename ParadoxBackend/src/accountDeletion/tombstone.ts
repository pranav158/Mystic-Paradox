/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import type { LauncherAccountRecord } from "../persistence/contracts/LauncherAccountRepository";

// [2026-10-14] The one record kept after an account is erased (Privacy Policy section 5): that an account was deleted and when, under a
// pseudonymous id. A banned account also keeps what enforces the ban: the reason and a SHA-256 hash of its lowercased email (so a
// banned person who makes a new account can be recognized without us keeping the address). Nothing else.

export interface DeletionTombstone {
    /** The pseudonym (PseudonymousAccountId), also the document _id. */
    pseudonymousId: string;
    requestedAt: string;
    deletedAt: string;
    wasBanned: boolean;
    banReason?: string;
    emailSha256?: string;
}

/** SHA-256 (hex) of the lowercased, trimmed email address. */
export function EmailSha256(email: string): string {
    return crypto.createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export function BuildDeletionTombstone(input: {
    account: Pick<LauncherAccountRecord, "status" | "approvalReason" | "email">;
    pseudonymousId: string;
    requestedAt: string;
    deletedAt: string;
}): DeletionTombstone {
    const WasBanned = input.account.status === "banned";
    const Tombstone: DeletionTombstone = {
        pseudonymousId: input.pseudonymousId,
        requestedAt: input.requestedAt,
        deletedAt: input.deletedAt,
        wasBanned: WasBanned
    };
    if (WasBanned) {
        const Reason = input.account.approvalReason?.trim();
        if (Reason) Tombstone.banReason = Reason;
        if (input.account.email) Tombstone.emailSha256 = EmailSha256(input.account.email);
    }
    return Tombstone;
}
