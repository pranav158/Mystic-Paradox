import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import { logger } from "../../logger";
import { IncrementMetric, SetMetric } from "../../observability/metrics";
import { GetMongoDb } from "../../persistence/mongo/client";
import { Collections } from "../../persistence/mongo/collections";
import {
    NormalizeOperationsPolicyRecord,
    OperationsPolicy,
    ReadOperationsPolicyRecord,
    ResolveOperationsPolicy
} from "../../services/operationsPolicy";
import { WithP2PTransaction } from "../persistence";
import { BuildRewardInvariantAlert, NormalizeOperationsAlertReason } from "./operationsAlerts";

// The module's fields of the shared operations policy document: the durable P2P emergency stop,
// the central reward rollout and the co-op transport. They share the document's optimistic `version`
// with the core fields.

/**
 * [2026-10-13] Which co-op transport player-hosted hunts use. ICE (STUN + TURN relay, public) is the default;
 * the Steam transport is experimental and only used when an operator selects it from the dashboard.
 */
export type CoopTransport = "ICE" | "STEAM_EXPERIMENTAL";
export const COOP_TRANSPORTS: readonly CoopTransport[] = ["ICE", "STEAM_EXPERIMENTAL"];
export const DEFAULT_COOP_TRANSPORT: CoopTransport = "ICE";

export function IsCoopTransport(value: unknown): value is CoopTransport {
    return typeof value === "string" && (COOP_TRANSPORTS as readonly string[]).includes(value);
}

export interface RewardRolloutState {
    /** Monotonic operator-controlled rollout document version. */
    version: number;
    tier0ShadowEnabled: boolean;
    tier1GrantsEnabled: boolean;
}

export interface P2POperationsPolicy extends OperationsPolicy {
    /** Durable operator stop for player-hosted hunts; legacy rows normalize to disabled. */
    p2pEmergencyStop: boolean;
    /** Optional for legacy rows; normalized reads always supply a safe value. */
    rewardRollout?: RewardRolloutState;
    /** Optional for legacy rows; normalized reads always supply a value (ICE). */
    coopTransport?: CoopTransport;
}

export const DEFAULT_REWARD_ROLLOUT: Readonly<RewardRolloutState> =
    { version: 0, tier0ShadowEnabled: true, tier1GrantsEnabled: false };

export const DEFAULT_P2P_OPERATIONS_POLICY: Readonly<P2POperationsPolicy> = {
    guardEnforcement: "ENFORCE",
    diagnosticsProfile: "PRODUCTION",
    p2pEmergencyStop: false,
    version: 0,
    rewardRollout: { ...DEFAULT_REWARD_ROLLOUT },
    coopTransport: DEFAULT_COOP_TRANSPORT
};

/** False when the module's fields of the document are malformed (the document then fails closed). */
export function P2PPolicyFieldsValid(record: any): boolean {
    const rollout = record?.rewardRollout;
    const rolloutValid = rollout === undefined || (rollout != undefined &&
        Number.isSafeInteger(rollout.version) && rollout.version >= 0 &&
        typeof rollout.tier0ShadowEnabled === "boolean" &&
        typeof rollout.tier1GrantsEnabled === "boolean");
    const stopValid = record?.p2pEmergencyStop === undefined || typeof record.p2pEmergencyStop === "boolean";
    const transportValid = record?.coopTransport === undefined || IsCoopTransport(record.coopTransport);
    return rolloutValid && stopValid && transportValid;
}

export function NormalizeP2POperationsPolicyRecord(record: any, now = Date.now()): {
    policy: P2POperationsPolicy;
    malformed: boolean;
} {
    const normalized = NormalizeOperationsPolicyRecord(record, now, P2PPolicyFieldsValid(record));
    const rollout = record?.rewardRollout;
    const stopValid = record?.p2pEmergencyStop === undefined || typeof record.p2pEmergencyStop === "boolean";
    return {
        malformed: normalized.malformed,
        policy: {
            ...normalized.policy,
            // A malformed stop field must fail closed even when unrelated policy values normalize.
            p2pEmergencyStop: !stopValid || record?.p2pEmergencyStop === true,
            rewardRollout: !normalized.malformed && rollout !== undefined
                ? { version: rollout.version, tier0ShadowEnabled: rollout.tier0ShadowEnabled,
                    tier1GrantsEnabled: rollout.tier1GrantsEnabled }
                : { ...DEFAULT_REWARD_ROLLOUT },
            // A malformed document falls back to the default transport, never to the experimental one.
            coopTransport: !normalized.malformed && IsCoopTransport(record?.coopTransport)
                ? record.coopTransport
                : DEFAULT_COOP_TRANSPORT
        }
    };
}

export function RewardRolloutWeakeningCodes(before: P2POperationsPolicy, after: RewardRolloutState): string[] {
    return !before.rewardRollout?.tier1GrantsEnabled && after.tier1GrantsEnabled ? ["TIER1_REWARD_GRANTS_ENABLE"] : [];
}

let TestPolicy: Partial<P2POperationsPolicy> | undefined;

/**
 * Tests that run the real controllers on in-memory repositories (UseP2PPersistenceForTest) fix the operations policy here
 * instead of reading MongoDB; `undefined` restores the real read. The emergency fence follows the same value.
 */
export function UseP2POperationsPolicyForTest(policy: Partial<P2POperationsPolicy> | undefined): void {
    TestPolicy = policy;
}

/** The shared policy plus the module's fields, from one read of the document. */
export async function GetP2POperationsPolicy(session?: ClientSession): Promise<P2POperationsPolicy> {
    if (TestPolicy != undefined) return { ...DEFAULT_P2P_OPERATIONS_POLICY, ...TestPolicy } as P2POperationsPolicy;
    const record = await ReadOperationsPolicyRecord(session);
    // A missing document normalizes to the defaults (no stop, Tier 1 grants off, ICE transport).
    const { p2pEmergencyStop, rewardRollout, coopTransport } = NormalizeP2POperationsPolicyRecord(record).policy;
    const policy: P2POperationsPolicy = { ...ResolveOperationsPolicy(record, session), p2pEmergencyStop, rewardRollout,
        coopTransport };
    SetMetric("mysticparadox_reward_rollout_enabled", policy.rewardRollout?.tier1GrantsEnabled ? 1 : 0);
    return policy;
}

/**
 * Serializes P2P admission/host mutations against an operator activating the emergency stop.
 * Call inside the same Mongo transaction as the protected write. A missing or stopped singleton
 * returns false so a legacy/misconfigured deployment cannot authorize P2P work by accident.
 */
export async function FenceP2PEmergencyStop(session: ClientSession): Promise<boolean> {
    if (TestPolicy != undefined) return TestPolicy.p2pEmergencyStop !== true;
    const db = await GetMongoDb();
    const result = await db.collection(Collections.OperationsPolicy).updateOne(
        { _id: "global" as any, p2pEmergencyStop: { $ne: true } },
        { $set: { p2pEmergencyStopGateNonce: crypto.randomUUID() } },
        { session }
    );
    return result.modifiedCount === 1;
}

export async function SetP2PEmergencyStop(enabled: boolean, actorUserId: string,
    expectedVersion: number, session?: ClientSession): Promise<P2POperationsPolicy | undefined> {
    const db = await GetMongoDb();
    const result = await db.collection(Collections.OperationsPolicy).updateOne(
        { _id: "global" as any, version: expectedVersion },
        { $set: { p2pEmergencyStop: enabled, updatedAt: new Date().toISOString(), updatedBy: actorUserId },
            $inc: { version: 1 } },
        { session }
    );
    if (result.modifiedCount !== 1) return undefined;
    return GetP2POperationsPolicy(session);
}

export async function SetCoopTransport(coopTransport: CoopTransport, actorUserId: string,
    expectedVersion: number, session?: ClientSession): Promise<P2POperationsPolicy | undefined> {
    const db = await GetMongoDb();
    const result = await db.collection(Collections.OperationsPolicy).updateOne(
        { _id: "global" as any, version: expectedVersion },
        { $set: { coopTransport, updatedAt: new Date().toISOString(), updatedBy: actorUserId },
            $inc: { version: 1 } },
        { session }
    );
    if (result.modifiedCount !== 1) return undefined;
    return GetP2POperationsPolicy(session);
}

/**
 * Serializes a Tier 1 reward grant against an operator disabling the rollout in the same Mongo
 * transaction. Hunt hosting and admission do not depend on this reward-only fence.
 */
export async function FenceTier1RewardGrants(session: ClientSession): Promise<boolean> {
    const db = await GetMongoDb();
    const result = await db.collection(Collections.OperationsPolicy).updateOne(
        { _id: "global" as any, "rewardRollout.tier1GrantsEnabled": true },
        { $set: { tier1RewardGateNonce: crypto.randomUUID() } },
        { session }
    );
    return result.modifiedCount === 1;
}

export async function SetRewardRollout(rewardRollout: RewardRolloutState, actorUserId: string,
    expectedVersion: number, session?: ClientSession): Promise<P2POperationsPolicy | undefined> {
    const db = await GetMongoDb();
    const result = await db.collection(Collections.OperationsPolicy).updateOne(
        { _id: "global" as any, version: expectedVersion },
        { $set: { rewardRollout, updatedAt: new Date().toISOString(), updatedBy: actorUserId },
            $inc: { version: 1 } },
        { session }
    );
    if (result.modifiedCount !== 1) return undefined;
    return GetP2POperationsPolicy(session);
}

export interface RewardInvariantPauseInput {
    /** Stable, non-PII reason code for the economic invariant failure. */
    reasonCode: string;
}

/**
 * Stop central Tier 1 grants and record the stop in the same Mongo transaction as the policy
 * update. A ledger/effect mismatch must stop economic output immediately. The operation is idempotent when another worker
 * has already stopped grants, and retries a version conflict so a concurrent operator edit cannot
 * leave the rollout enabled after an invariant failure.
 */
export async function PauseTier1RewardsForInvariant(input: RewardInvariantPauseInput): Promise<P2POperationsPolicy | undefined> {
    const reasonCode = NormalizeOperationsAlertReason(input?.reasonCode);
    const requestId = crypto.randomUUID();
    // Keep audit identity and event time stable across Mongo callback retries.
    const auditId = crypto.randomUUID();
    const eventAt = new Date().toISOString();
    for (let attempt = 0; attempt < 3; attempt++) {
        const outcome = await WithP2PTransaction(async (repos, session) => {
            const before = await GetP2POperationsPolicy(session);
            const currentRollout = before.rewardRollout ?? DEFAULT_REWARD_ROLLOUT;
            let after: P2POperationsPolicy = before;
            if (currentRollout.tier1GrantsEnabled) {
                const updated = await SetRewardRollout({
                    version: currentRollout.version + 1,
                    tier0ShadowEnabled: currentRollout.tier0ShadowEnabled,
                    tier1GrantsEnabled: false
                }, "system:reward-invariant", before.version, session);
                if (updated == undefined) return undefined;
                after = updated;
            }
            await repos.admin.appendAudit({
                id: auditId, actorUserId: "system:reward-invariant",
                action: "operations.reward.auto_pause", oldState: before, newState: after,
                reason: `Tier 1 grants paused after ${reasonCode}`,
                ip: "system", requestId, createdAt: eventAt
            }, session);
            // The alert is in the same transaction as the policy and audit write. A
            // retried callback reuses requestId and the repository's $setOnInsert
            // makes the alert idempotent, so a commit cannot lose the operator signal.
            await repos.operationsAlerts.enqueue(
                BuildRewardInvariantAlert(requestId, reasonCode, eventAt), session);
            return after;
        });
        if (outcome != undefined) {
            IncrementMetric("mysticparadox_reward_auto_pauses_total", 1, { code: reasonCode });
            IncrementMetric("mysticparadox_operations_alerts_enqueued_total", 1, { code: "REWARD_INVARIANT" });
            logger.error({ alertId: requestId, code: "REWARD_INVARIANT", reasonCode },
                "[OperationsPolicy] critical central Guard alert opened");
            return outcome;
        }
    }
    logger.error(`[OperationsPolicy] failed to persist automatic Tier 1 reward pause (${reasonCode})`);
    return undefined;
}
