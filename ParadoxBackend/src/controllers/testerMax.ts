/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { Request, Response } from "express";
import { GetRepositories, GetUnitOfWork } from "../persistence";
import { logger } from "../logger";
import { tryLoadGameData } from "../gameData/loader";
import type { EconomySource } from "../diagnostics/economyLedgerMonitor";
import { TESTER_ROLE } from "../security/testerFeatures";
import { GetInventoryStoragePolicy } from "../inventoryStoragePolicy";
import { PLATINUM_AGGREGATE_ID } from "../platinumWallet";
import { ConfirmPublicProgressionRank, GrantProgressionXp, IsApprovedXpProgressionTrack, MAX_PROGRESSION_GRANT_AMOUNT, RankForProgress, TrackCapXp } from "./progression";
import { RunInventoryTransaction } from "./inventory";
import {
    IsValidTesterMaxRunId,
    RunTesterMax,
    TESTER_MAX_KIT_FILE,
    TesterMaxDeps,
    TesterMaxKit,
    TesterMaxKitChecks,
    TesterMaxRefusal,
    TesterMaxReport,
    ValidateTesterMaxKit
} from "./testerMaxCore";

// [2026-10-14, launch plan section 5] Route side of "max this tester account" (POST /admin/v1/players/:userId/tester-max) and the
// real ledgers behind the pure run in testerMaxCore.ts. The kit is game-data/tester_max_kit.json; without it the route answers 503.

const RunsInProgress = new Set<string>();

function ErrorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** The kit as stored, or undefined when there is no file. A file that is not JSON is reported as a problem, not thrown. */
export function LoadTesterMaxKit(): { kit?: unknown; problem?: string } {
    try {
        const Kit = tryLoadGameData<unknown>(TESTER_MAX_KIT_FILE);
        return Kit === undefined ? {} : { kit: Kit };
    } catch {
        return { problem: `${TESTER_MAX_KIT_FILE} is not valid JSON` };
    }
}

export function DefaultTesterMaxChecks(): TesterMaxKitChecks {
    return {
        isApprovedXpTrack: IsApprovedXpProgressionTrack,
        trackCapXp: TrackCapXp,
        rankForProgress: RankForProgress,
        isKnownCatalogId: (CatalogId) => GetInventoryStoragePolicy(CatalogId) !== undefined,
        isPlatinumAggregate: (CatalogId) => CatalogId === PLATINUM_AGGREGATE_ID,
        maxXpGrant: MAX_PROGRESSION_GRANT_AMOUNT
    };
}

/** The ledgers of the real backend: every grant goes through the same functions the game's own requests use. */
export function DefaultTesterMaxDeps(): TesterMaxDeps {
    return {
        async findCharacterId(UserId) {
            const Characters = await GetRepositories().characters.findManyByUserId(UserId);
            return Characters[0]?.characterId;
        },
        async readTrackProgress(UserId, ProgressionId) {
            return (await GetRepositories().progressionTracks.get(UserId, ProgressionId))?.progress ?? 0;
        },
        async grantXp(UserId, ProgressionId, Amount, GrantId, EconomySource) {
            // "gameserver": the host limits do not apply; the economy source keeps the grant out of the activity counters.
            return GrantProgressionXp(UserId, ProgressionId, Amount, GrantId, GetUnitOfWork(), undefined, "gameserver", EconomySource);
        },
        async confirmRank(UserId, ProgressionId, Rank) {
            const Result = await ConfirmPublicProgressionRank(UserId, ProgressionId, Rank);
            if (!Result.ok) throw new Error(`rank ${Rank} confirm refused: ${Result.reason}`);
        },
        async runInventory(UserId, CharacterId, TransactionId, StackedAdds, EconomySource) {
            // The character was read from this account's own records just above, so the ownership check is not repeated.
            return RunInventoryTransaction(UserId, CharacterId, TransactionId, [], StackedAdds, [], [], [], {
                ownershipAlreadyValidated: true,
                // [2026-10-16] The Reward Cache coin is prestige-gated; this admin tool credits it without banked prestige.
                operatorTestFunding: true,
                economy: { source: EconomySource as EconomySource }
            });
        }
    };
}

function ReportSummary(Report: TesterMaxReport): Record<string, unknown> {
    return {
        runId: Report.runId,
        status: Report.status,
        progression: Report.progression.map((Row) => ({
            progressionId: Row.progressionId, target: Row.target, startProgress: Row.startProgress,
            granted: Row.granted, grants: Row.grants, confirmedRank: Row.confirmedRank, status: Row.status
        })),
        items: Report.items === undefined ? undefined : { status: Report.items.status, stacks: Report.items.stacks }
    };
}

// POST /admin/v1/players/:userId/tester-max. Body: { confirm: "MAX <displayName>", runId: "<8-64 characters, unique per run>" }.
export async function TesterMaxPlayer(req: Request, res: Response): Promise<void> {
    const Actor = (req as any).AdminAuth.account as { userId: string };
    const TargetUserId = String(req.params.userId ?? "");
    const Repos = GetRepositories();
    const Target = await Repos.launcherAccounts.findByUserId(TargetUserId);
    if (!Target) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Player not found." } });
        return;
    }
    if (!Target.roles.includes(TESTER_ROLE)) {
        res.status(409).json({ error: { code: "ADMIN_TESTER_REQUIRED", message: "Only an account with the tester role can be maxed." } });
        return;
    }
    const ExpectedConfirmation = `MAX ${Target.displayName}`;
    if (req.body?.confirm !== ExpectedConfirmation) {
        res.status(400).json({ error: { code: "ADMIN_TESTER_MAX_CONFIRMATION", message: `Type "${ExpectedConfirmation}" to confirm.` } });
        return;
    }
    const RunId = req.body?.runId;
    if (!IsValidTesterMaxRunId(RunId)) {
        res.status(400).json({ error: { code: "ADMIN_TESTER_MAX_RUN_ID", message: "runId must be 8 to 64 characters: letters, digits, dot, underscore or hyphen." } });
        return;
    }
    const Loaded = LoadTesterMaxKit();
    if (Loaded.problem !== undefined) {
        res.status(422).json({ error: { code: "ADMIN_TESTER_MAX_KIT_INVALID", message: "The tester kit cannot run.", problems: [Loaded.problem] } });
        return;
    }
    if (Loaded.kit === undefined) {
        res.status(503).json({ error: { code: "ADMIN_TESTER_MAX_KIT_MISSING", message: `Copy game-data/${TESTER_MAX_KIT_FILE.replace(".json", ".example.json")} to ${TESTER_MAX_KIT_FILE} and fill it in.` } });
        return;
    }
    const Checks = DefaultTesterMaxChecks();
    const Problems = ValidateTesterMaxKit(Loaded.kit, Checks);
    if (Problems.length > 0) {
        res.status(422).json({ error: { code: "ADMIN_TESTER_MAX_KIT_INVALID", message: "The tester kit cannot run.", problems: Problems } });
        return;
    }
    if (RunsInProgress.has(TargetUserId)) {
        res.status(409).json({ error: { code: "ADMIN_TESTER_MAX_BUSY", message: "A max run for this account is already in progress." } });
        return;
    }

    const RequestId = crypto.randomUUID();
    RunsInProgress.add(TargetUserId);
    let Report: TesterMaxReport | undefined;
    let Refusal: TesterMaxRefusal | undefined;
    let Failure: string | undefined;
    try {
        Report = await RunTesterMax({ userId: TargetUserId, runId: RunId, kit: Loaded.kit as TesterMaxKit, checks: Checks }, DefaultTesterMaxDeps());
    } catch (Err) {
        if (Err instanceof TesterMaxRefusal) Refusal = Err;
        else Failure = ErrorText(Err);
    } finally {
        RunsInProgress.delete(TargetUserId);
    }

    // One audit record per attempt that got past validation, whatever it did; the actor is the signed-in operator (manager:<id> for the manager).
    await Repos.admin.appendAudit({
        id: crypto.randomUUID(),
        actorUserId: Actor.userId,
        targetUserId: TargetUserId,
        action: Report !== undefined ? "player.tester_max" : "player.tester_max.failed",
        oldState: { roles: Target.roles },
        newState: Report !== undefined ? ReportSummary(Report) : { refused: Refusal?.code ?? "ERROR" },
        reason: `tester max run ${RunId}`,
        ip: req.ip ?? "unknown",
        requestId: RequestId,
        createdAt: new Date().toISOString()
    });

    if (Report !== undefined) {
        logger.info(`[TesterMax] run=${RunId} user=${TargetUserId} status=${Report.status} actor=${Actor.userId}`);
        res.json({ requestId: RequestId, report: Report });
        return;
    }
    if (Refusal !== undefined) {
        logger.warn(`[TesterMax] run=${RunId} user=${TargetUserId} refused: ${Refusal.code}`);
        res.status(409).json({ error: { code: Refusal.code, message: Refusal.message }, requestId: RequestId });
        return;
    }
    logger.error(`[TesterMax] run=${RunId} user=${TargetUserId} failed: ${Failure}`);
    res.status(500).json({ error: { code: "ADMIN_TESTER_MAX_FAILED", message: "The tester max run failed; see the audit record." }, requestId: RequestId });
}
