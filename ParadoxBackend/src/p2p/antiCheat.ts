// Hook points for the optional anti-cheat module of player-hosted hunts.
//
// The P2P module is complete without it: hunts run at Tier 0 with no evidence collected, no verdicts and no
// rewards (the reward policy is never ready, so a Tier 1 hunt routes to a dedicated server). When an
// `anticheat` folder is present next to `p2p`, GetAntiCheatExtension() loads it once and uses its hooks
// instead: Hunt Guard evidence and verdicts, central reward receipts and the reward worker.
// MYSTICPARADOX_ANTICHEAT_MODULE=off keeps the defaults even when the folder exists.
//
// P2P code never imports the module directly; it calls these hooks only.

import fs from "node:fs";
import path from "node:path";
import type { Db } from "mongodb";
import type { MetagameServiceRole } from "../config/serviceRole";
import { logger } from "../logger";
import type { AccountDeletionStep } from "../persistence/mongo/accountDeletionPlan";
import type { P2PHostCapabilityRecord } from "./persistence";
import { LauncherApiError } from "./security/p2pErrors";

/** The reward policy frozen into a Tier 1 hunt when it is routed. */
export type RewardPolicyStatus =
    | { ready: true; snapshot: { version: string; digest: string } }
    | { ready: false; reason: string };

/** The anti-cheat verdict of one hunt generation, as returned by the hunt status route. */
export interface HuntVerdict {
    progressionApplied: boolean;
    rewardsApplied: boolean;
}

/** One received evidence batch, reduced to what the operations monitor shows. */
export interface EvidenceBatchSummary {
    _id: unknown;
    sessionId: string;
    generation: number;
    firstSequence: number;
    lastSequence: number;
    events?: { type?: string }[];
    receivedAt?: string;
}

export interface AntiCheatExtension {
    readonly loaded: boolean;
    server: {
        /** Extra MYSTICPARADOX_SERVICE_ROLE values that have their own entry point. */
        serviceRoles: readonly string[];
        /** Returns the settings that make a production configuration unsafe. */
        runtimeSafetyIssues(environment: NodeJS.ProcessEnv): string[];
        /** Collections, indexes and data the module needs. */
        ensureDatabase(db: Db): Promise<void>;
        /** [2026-10-14] The module's steps of the account deletion plan (persistence/mongo/accountDeletionPlan.ts). */
        accountDeletionSteps(): AccountDeletionStep[];
        start(role: MetagameServiceRole): void;
        stop(): Promise<void>;
    };
    hunts: {
        /** POST /mystic/v1/hunts/:sessionId/event-batches. */
        submitEvidence(capability: P2PHostCapabilityRecord, body: unknown): Promise<unknown>;
        /** POST /mystic/v1/hunts/:sessionId/completion. */
        complete(capability: P2PHostCapabilityRecord, body: unknown): Promise<unknown>;
        result(sessionId: string, generation: number): Promise<HuntVerdict | undefined>;
        rewardReceipt(sessionId: string, generation: number, accountId: string): Promise<unknown | undefined>;
        /** POST /internal/v1/hunt-guard/shadow-comparisons. */
        recordShadowComparison(apiKey: string | undefined, body: unknown): Promise<unknown>;
    };
    rewards: {
        policyStatus(huntId: string, expectedVersion?: string): RewardPolicyStatus;
    };
    operations: {
        recentFindings(limit: number): Promise<Record<string, unknown>[]>;
        recentReceipts(limit: number): Promise<Record<string, unknown>[]>;
        /** Active and archived evidence batches of these hunt generations, newest first. */
        evidenceBatches(pairs: { sessionId: string; generation: number }[], limit: number):
            Promise<{ active: EvidenceBatchSummary[]; archived: EvidenceBatchSummary[] }>;
    };
}

function NotCollected(): never {
    throw new LauncherApiError("HUNT_EVIDENCE_NOT_COLLECTED", "This server does not collect hunt evidence.");
}

const NO_ANTICHEAT: AntiCheatExtension = {
    loaded: false,
    server: {
        serviceRoles: [],
        runtimeSafetyIssues: () => [],
        ensureDatabase: async () => undefined,
        accountDeletionSteps: () => [],
        start: () => undefined,
        stop: async () => undefined
    },
    hunts: {
        submitEvidence: async () => NotCollected(),
        complete: async () => NotCollected(),
        result: async () => undefined,
        rewardReceipt: async () => undefined,
        recordShadowComparison: async () => NotCollected()
    },
    rewards: {
        policyStatus: () => ({ ready: false, reason: "ANTICHEAT_MODULE_ABSENT" })
    },
    operations: {
        recentFindings: async () => [],
        recentReceipts: async () => [],
        evidenceBatches: async () => ({ active: [], archived: [] })
    }
};

let Extension: AntiCheatExtension | undefined;

function LoadAntiCheatExtension(): AntiCheatExtension {
    if (/^(0|false|off|no)$/i.test(process.env.MYSTICPARADOX_ANTICHEAT_MODULE?.trim() ?? "")) {
        logger.info("[AntiCheat] module disabled by MYSTICPARADOX_ANTICHEAT_MODULE; player-hosted hunts are unmonitored and earn no rewards");
        return NO_ANTICHEAT;
    }
    const modulePath = path.join(__dirname, "..", "anticheat");
    if (!fs.existsSync(modulePath)) {
        logger.info("[AntiCheat] module not present; player-hosted hunts are unmonitored and earn no rewards");
        return NO_ANTICHEAT;
    }
    const module = require(modulePath) as { CreateAntiCheatExtension?: () => AntiCheatExtension };
    if (typeof module.CreateAntiCheatExtension !== "function") {
        throw new Error(`${modulePath} does not export CreateAntiCheatExtension().`);
    }
    logger.info("[AntiCheat] hunt evidence and reward module loaded");
    return module.CreateAntiCheatExtension();
}

export function GetAntiCheatExtension(): AntiCheatExtension {
    Extension ??= LoadAntiCheatExtension();
    return Extension;
}
