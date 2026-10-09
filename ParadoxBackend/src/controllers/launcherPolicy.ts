/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { GetRepositories } from "../persistence";
import { LauncherApiError } from "../security/launcherErrors";
import { TESTER_ROLE } from "../security/testerFeatures";
import { GetOperationsPolicy } from "../services/operationsPolicy";
import { GetP2PExtension } from "../extensions/p2p";

export interface LauncherPolicyView {
    // Changes whenever this account's roles change; the launcher can use it to skip a
    // redundant flag-reconcile pass if it already applied the same value.
    policyVersion: string;
    roles: string[];
    channel: "stable" | "beta" | "dev";
    managedFeatureIds: string[];
    logUpload: { auto: boolean };
    guardEnforcement: "OBSERVE" | "ENFORCE";
    diagnosticsProfile: "PRODUCTION" | "DEVELOPMENT";
    /** Fields of an optional module (src/extensions). */
    [field: string]: unknown;
}

export async function GetLauncherPolicy(userId: string): Promise<LauncherPolicyView> {
    const Account = await GetRepositories().launcherAccounts.findByUserId(userId);
    if (Account == undefined) {
        throw new LauncherApiError("NOT_FOUND", "Account not found.");
    }

    const IsTester = Account.roles.includes(TESTER_ROLE);
    const Operations = await GetOperationsPolicy();
    const DevelopmentDiagnostics = Operations.diagnosticsProfile === "DEVELOPMENT" &&
        (IsTester || Account.roles.includes("admin"));

    return {
        policyVersion: `${Account.rolesUpdatedAt ?? Account.createdAt}:ops-${Operations.version}`,
        roles: Account.roles,
        channel: IsTester ? "beta" : "stable",
        // Verbose diagnostics are centrally controlled, audited, and restricted to tester/admin
        // accounts. Production remains the default because one verbose hunt can generate tens of
        // megabytes and recreate the historical stdout-pipe stall class.
        managedFeatureIds: DevelopmentDiagnostics ? ["diagnostics.verbose"] : [],
        logUpload: { auto: DevelopmentDiagnostics },
        guardEnforcement: Operations.guardEnforcement,
        diagnosticsProfile: DevelopmentDiagnostics ? "DEVELOPMENT" : "PRODUCTION",
        ...GetP2PExtension().launcher.policyFields(),
    };
}
