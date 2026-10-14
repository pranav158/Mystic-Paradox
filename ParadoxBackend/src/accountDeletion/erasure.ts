/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { Db, MongoClient } from "mongodb";
import type { LauncherAccountRecord } from "../persistence/contracts/LauncherAccountRepository";
import { Collections } from "../persistence/mongo/collections";
import {
    AccountDeletionContext,
    AccountDeletionSteps,
    AccountDeletionStepCount,
    ApplyAccountDeletionSteps,
    BuildAccountDeletionContext,
    CountAccountDeletion
} from "../persistence/mongo/accountDeletionPlan";
import { PseudonymousAccountId } from "../security/apiKeyHash";
import { RemoveUploadedLogsOfAccount } from "../services/launcherLogRetention";
import { BuildDeletionTombstone } from "./tombstone";

// [2026-10-14] The 30-day erasure of one account (scripts/process_account_deletions.ts). Order: the plan is counted and any live activity
// (a guard) stops the account for this run; the uploaded logs are removed (idempotent, so a retry is safe); then, in one transaction,
// every keyed row is removed or pseudonymised, the account record is deleted and the tombstone is written. Logs go first on purpose: if
// the transaction fails, the next run repeats the database part and the logs are already gone.

export type ErasureOutcome =
    | { status: "BLOCKED"; blockers: string[]; counts: AccountDeletionStepCount[] }
    | { status: "DRY_RUN"; counts: AccountDeletionStepCount[] }
    | { status: "ERASED"; counts: AccountDeletionStepCount[]; logSessionsRemoved: number };

/** The account's erasure plan, counted without changing anything. */
export async function PlanAccountErasure(db: Db, account: LauncherAccountRecord, nowIso: string): Promise<{
    context: AccountDeletionContext;
    counts: AccountDeletionStepCount[];
    blockers: string[];
}> {
    const Context = await BuildAccountDeletionContext(db, account.userId, nowIso, PseudonymousAccountId(account.userId));
    const Plan = await CountAccountDeletion(db, Context, AccountDeletionSteps());
    return { context: Context, counts: Plan.counts, blockers: Plan.blockers };
}

/**
 * Erases the account when the plan has no live activity. `apply` false only counts. The uploaded logs are removed from `logRoot`.
 */
export async function EraseAccount(client: MongoClient, db: Db, account: LauncherAccountRecord, options: {
    logRoot: string;
    nowIso: string;
    apply: boolean;
}): Promise<ErasureOutcome> {
    if (account.deletion === undefined) {
        throw new Error("EraseAccount needs an account with a deletion request");
    }
    const Plan = await PlanAccountErasure(db, account, options.nowIso);
    if (Plan.blockers.length > 0) {
        return { status: "BLOCKED", blockers: Plan.blockers, counts: Plan.counts };
    }
    if (!options.apply) {
        return { status: "DRY_RUN", counts: Plan.counts };
    }

    const LogSessionsRemoved = RemoveUploadedLogsOfAccount(options.logRoot, account.userId);
    const Tombstone = BuildDeletionTombstone({
        account,
        pseudonymousId: Plan.context.pseudonymousId,
        requestedAt: account.deletion.requestedAt,
        deletedAt: options.nowIso
    });

    const Session = client.startSession();
    try {
        await Session.withTransaction(async () => {
            const Steps = AccountDeletionSteps().filter((step) => step.kind !== "guard");
            await ApplyAccountDeletionSteps(db, Session, Plan.context, Steps);
            // Deleted with the same filter as the admin delete: a launcher account only.
            await db.collection(Collections.Accounts).deleteOne(
                { _id: account.userId as any, displayNameNormalized: { $exists: true } },
                { session: Session }
            );
            await db.collection(Collections.AccountDeletions).replaceOne(
                { _id: Tombstone.pseudonymousId as any },
                { _id: Tombstone.pseudonymousId as any, ...Tombstone },
                { upsert: true, session: Session }
            );
        });
    } finally {
        await Session.endSession();
    }

    return { status: "ERASED", counts: Plan.counts, logSessionsRemoved: LogSessionsRemoved };
}
