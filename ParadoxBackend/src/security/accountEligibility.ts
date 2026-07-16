/*
 * Copyright (C) 2026 Mystic Paradox (pranav158/MysticParadox)
 * Licensed under the GNU Affero General Public License v3.0.
 */

import { LauncherAccountRecord } from "../persistence";
import { LauncherApiError } from "./launcherErrors";


export function EffectiveApprovalStatus(account: LauncherAccountRecord): "pending" | "approved" | "rejected" {
    return account.approvalStatus ?? "approved";
}

export function AssertAccountAdmitted(account: LauncherAccountRecord): void {
    if (account.status === "banned") {
        throw new LauncherApiError("AUTH_ACCOUNT_BANNED", "This account has been banned.");
    }
    if (account.status === "disabled") {
        throw new LauncherApiError("AUTH_ACCOUNT_DISABLED", "This account has been disabled.");
    }

    const Approval = EffectiveApprovalStatus(account);
    if (Approval === "pending") {
        throw new LauncherApiError("AUTH_APPROVAL_PENDING", "Your closed-test access request is waiting for approval.");
    }
    if (Approval === "rejected") {
        throw new LauncherApiError("AUTH_APPROVAL_REJECTED", "Your closed-test access request was not approved.");
    }
}

export function AssertAccountEligible(account: LauncherAccountRecord): void {
    AssertAccountAdmitted(account);
    if (account.usernameSet === false) {
        throw new LauncherApiError("AUTH_USERNAME_REQUIRED", "Choose a launcher username before playing.");
    }
}

export function IsAccountEligible(account: LauncherAccountRecord): boolean {
    try {
        AssertAccountEligible(account);
        return true;
    } catch {
        return false;
    }
}
