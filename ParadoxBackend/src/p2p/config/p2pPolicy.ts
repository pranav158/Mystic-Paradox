/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { DedicatedServersConfigured } from "../../config/dedicatedServers";

export type HuntRoute = "DEDICATED" | "PLAYER_HOSTED";
export type P2PTrustTier = 0 | 1;

export type HuntRouteReason =
    | "P2P_EMERGENCY_STOP"
    | "FEATURE_DISABLED"
    | "NOT_A_PLAYER_HOSTED_HUNT"
    | "PRIVATE_PARTY_REQUIRED"
    | "PARTY_SIZE_EXCEEDED"
    | "ACCOUNT_ALLOWLIST_EMPTY"
    | "ACCOUNT_NOT_ALLOWLISTED"
    | "HUNT_ALLOWLIST_EMPTY"
    | "HUNT_NOT_ALLOWLISTED"
    | "HUNT_CLASS_EXCLUDED"
    | "HUNT_RUNTIME_INCOMPATIBLE"
    | "CANARY_DISABLED"
    | "TIER1_REWARDS_DISABLED"
    | "TIER1_SHADOW_NOT_APPROVED"
    | "TIER1_ACCOUNT_NOT_ALLOWLISTED"
    | "TIER1_HUNT_NOT_ALLOWLISTED"
    | "ROLLOUT_DISABLED"
    | "ROLLOUT_EXCLUDED"
    | "PLAYER_HOSTED_NOT_IMPLEMENTED"
    | "ELIGIBLE";

export interface P2PPolicy {
    enabled: boolean;
    allowedAccounts: ReadonlySet<string>;
    allowAllAccounts: boolean;
    allowedHunts: ReadonlySet<string>;
    allowAllResolvableHunts: boolean;
    allowHighRiskHuntClasses: boolean;
    privatePartiesOnly: boolean;
    maxPartySize: number;
    percentRollout: number;
    forceSdr: boolean;
    canaryEnabled: boolean;
    trustTier: P2PTrustTier;
    tier1RewardsEnabled: boolean;
    tier1ShadowApproved: boolean;
    tier1AllowedAccounts: ReadonlySet<string>;
    tier1AllowedHunts: ReadonlySet<string>;
    dedicatedHuntsDisabled: boolean;
    /** [2026-10-11] Training Grounds may be hosted on a player's PC (no-reward session); off by default. */
    trainingEnabled: boolean;
}

export interface HuntRouteInput {
    gameMode: string;
    huntId: string;
    accountIds: readonly string[];
    partySize: number;
    isPrivateParty: boolean;
}

export interface HuntRouteCapabilities {
    playerHostedImplemented: boolean;
    emergencyStop?: boolean;
}

export interface HuntRouteDecision {
    route: HuntRoute;
    reason: HuntRouteReason;
    rolloutBucket: number | null;
}

function IsStrictTrue(Value: string | undefined): boolean {
    return Value?.trim().toLowerCase() === "true";
}

/**
 * [2026-10-14] With hunts enabled and P2P_FORCE_SDR not true, the traffic between players may go direct, so players can see each
 * other's IP address, which the Privacy Policy says they do not. Undefined when hunts are off or relay-only is on. Pure: the caller logs it.
 */
export function RelayOnlyWarning(Environment: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!IsStrictTrue(Environment.P2P_HUNTS_ENABLED) || IsStrictTrue(Environment.P2P_FORCE_SDR)) return undefined;
    return "WARNING: P2P hunts are enabled without P2P_FORCE_SDR=true: players may see each other's IP address during a hunt, " +
        "which the Privacy Policy says they do not. Set P2P_FORCE_SDR=true to relay all hunt traffic.";
}

function ReadCsvSet(Value: string | undefined): ReadonlySet<string> {
    return new Set(
        (Value ?? "")
            .split(",")
            .map((Entry) => Entry.trim())
            .filter((Entry) => Entry.length > 0)
    );
}

function ReadBoundedInteger(Value: string | undefined, Fallback: number, Min: number, Max: number): number {
    if (Value == undefined || Value.trim().length === 0) return Fallback;
    const Parsed = Number(Value);
    if (!Number.isSafeInteger(Parsed) || Parsed < Min || Parsed > Max) return Fallback;
    return Parsed;
}

function ReadBoundedPercent(Value: string | undefined): number {
    if (Value == undefined || Value.trim().length === 0) return 0;
    const Parsed = Number(Value);
    if (!Number.isFinite(Parsed) || Parsed < 0 || Parsed > 100) return 0;
    return Parsed;
}

export function ReadP2PPolicy(Environment: NodeJS.ProcessEnv = process.env): P2PPolicy {
    return {
        // Literal "true" is required. Values such as 1/on/yes intentionally fail closed.
        enabled: IsStrictTrue(Environment.P2P_HUNTS_ENABLED),
        allowedAccounts: ReadCsvSet(Environment.P2P_ALLOWED_ACCOUNTS),
        allowAllAccounts: IsStrictTrue(Environment.P2P_ALLOW_ALL_ACCOUNTS),
        allowedHunts: ReadCsvSet(Environment.P2P_ALLOWED_HUNTS),
        // This is intentionally separate from the hunt CSV. The route still freezes a manifest
        // from DeployServer before starting, so an unknown/malformed hunt can never become a
        // client-supplied map path. Operators must opt in with the literal value "true".
        allowAllResolvableHunts: IsStrictTrue(Environment.P2P_ALLOW_ALL_RESOLVABLE_HUNTS),
        // Trials, Escalations and other competitive/progression-sensitive classes used to be
        // hard-coded out of the transport canary. They may now be exercised only behind this
        // second explicit switch; Tier 0 remains no-reward authority.
        allowHighRiskHuntClasses: IsStrictTrue(Environment.P2P_ALLOW_HIGH_RISK_HUNT_CLASSES),
        privatePartiesOnly: Environment.P2P_PRIVATE_PARTIES_ONLY?.trim().toLowerCase() !== "false",
        maxPartySize: ReadBoundedInteger(Environment.P2P_MAX_PARTY_SIZE, 4, 1, 4),
        percentRollout: ReadBoundedPercent(Environment.P2P_PERCENT_ROLLOUT),
        forceSdr: IsStrictTrue(Environment.P2P_FORCE_SDR),
        canaryEnabled: IsStrictTrue(Environment.P2P_TIER0_CANARY_ENABLED),
        // Tier promotion is deliberately source-recognized and operator-explicit. An absent,
        // malformed, or future value stays at the no-reward transport tier.
        trustTier: Environment.P2P_TRUST_TIER?.trim() === "1" ? 1 : 0,
        tier1RewardsEnabled: IsStrictTrue(Environment.P2P_TIER1_REWARDS_ENABLED),
        tier1ShadowApproved: IsStrictTrue(Environment.P2P_TIER1_SHADOW_APPROVED),
        tier1AllowedAccounts: ReadCsvSet(Environment.P2P_TIER1_ALLOWED_ACCOUNTS),
        tier1AllowedHunts: ReadCsvSet(Environment.P2P_TIER1_ALLOWED_HUNTS),
        // This disables only non-hub dedicated instances. Ramsgate and Training Dojo remain
        // persistent dedicated infrastructure, and active P2P failures may still recover there.
        // [2026-10-15] Without a DeployServer (DEPLOYSERVER_URL unset or blank, as on the VPS) there is no dedicated route at all, so the
        // same rail applies: a hunt that cannot be player-hosted is cancelled instead of sent to a server that does not exist.
        dedicatedHuntsDisabled: IsStrictTrue(Environment.P2P_DISABLE_DEDICATED_HUNTS) || !DedicatedServersConfigured(Environment),
        // [2026-10-11 P2P on 1.14.7, plan 39_ §13.1 B7] The owner's target hosts Training on players' PCs as a
        // no-reward session type (decision 3 of 39_ §13). Literal "true" only; the dedicated Training hub stays the
        // fallback (and is still what every request uses while this is off).
        trainingEnabled: IsStrictTrue(Environment.P2P_TRAINING_ENABLED)
    };
}

/** The Training Grounds' player hunt id (ShatteredIsles_TrainingDojo); the client asks for it with GameMode SHARED. */
export function IsTrainingHuntId(HuntId: string | undefined): boolean {
    return typeof HuntId === "string" && HuntId.includes("TrainingDojo");
}

/** True for a Training request this policy may host on a player's PC (P2P_HUNTS_ENABLED and P2P_TRAINING_ENABLED). */
export function IsP2PTrainingRequest(GameMode: string, HuntId: string | undefined, Policy: P2PPolicy): boolean {
    return Policy.enabled && Policy.trainingEnabled && GameMode === "SHARED" && IsTrainingHuntId(HuntId);
}

function IsPlayerHostedHunt(GameMode: string, HuntId: string, TrainingEnabled: boolean): boolean {
    // Dauntless 1.12 sends Hunting Grounds as SHARED even though each selected destination is an
    // island hunt. The exact hunt allowlist below remains the authority; accepting SHARED here
    // does not admit Ramsgate, Training Dojo, or an unlisted public destination.
    if (GameMode !== "ISLAND" && GameMode !== "SHARED") return false;
    if (HuntId.trim().length === 0) return false;
    if (HuntId.includes("ReturnToRamsgate")) return false;
    // [2026-10-11] Training only with P2P_TRAINING_ENABLED, and only as the SHARED request the client sends.
    if (IsTrainingHuntId(HuntId)) return TrainingEnabled && GameMode === "SHARED";
    return true;
}

function IsExcludedCanaryClass(HuntId: string): boolean {
    // The real 1.12 Trials player IDs use "Arena", not "Trials". Keep both names so the
    // high-risk opt-in cannot be bypassed merely by the client's canonical identifier.
    return /(trial|arena|leaderboard|gauntlet|escalation|race|competitive)/i.test(HuntId);
}

/** A hunt class this runtime is known to break (the 1.12 FTUE). Realm hunts keep the same exclusion (realmHuntRouting). */
export function IsKnownRuntimeIncompatible(HuntId: string): boolean {
    // The 1.12 FTUE depends on missing tutorial content and its cinematic enters a known
    // client-RPC recursion on this runtime. This is a measured runtime exclusion, not a
    // trust/reward-policy class, so no rollout switch may override it.
    return /(?:^|_)FTUE(?:_|$)/i.test(HuntId);
}

/**
 * Stable allocation keeps a party in the same canary bucket across retries and service restarts.
 * This is rollout selection, not a security primitive.
 */
export function P2PRolloutBucket(AccountIds: readonly string[], HuntId: string): number {
    const StableRoster = [...new Set(AccountIds)].sort().join(",");
    const Digest = crypto.createHash("sha256").update(`${StableRoster}\n${HuntId}`).digest();
    return (Digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
}

function Dedicated(Reason: HuntRouteReason, RolloutBucket: number | null = null): HuntRouteDecision {
    return { route: "DEDICATED", reason: Reason, rolloutBucket: RolloutBucket };
}

export function DecideHuntRoute(
    Input: HuntRouteInput,
    Policy: P2PPolicy,
    Capabilities: HuntRouteCapabilities
): HuntRouteDecision {
    if (Capabilities.emergencyStop === true) return Dedicated("P2P_EMERGENCY_STOP");
    if (!Policy.enabled) return Dedicated("FEATURE_DISABLED");
    if (!IsPlayerHostedHunt(Input.gameMode, Input.huntId, Policy.trainingEnabled)) return Dedicated("NOT_A_PLAYER_HOSTED_HUNT");
    if (Policy.privatePartiesOnly && !Input.isPrivateParty) return Dedicated("PRIVATE_PARTY_REQUIRED");
    if (Input.partySize < 1 || Input.partySize > Policy.maxPartySize) return Dedicated("PARTY_SIZE_EXCEEDED");
    if (!Policy.allowAllAccounts && Policy.allowedAccounts.size === 0) return Dedicated("ACCOUNT_ALLOWLIST_EMPTY");
    if (!Policy.allowAllAccounts && Input.accountIds.some((AccountId) => !Policy.allowedAccounts.has(AccountId))) {
        return Dedicated("ACCOUNT_NOT_ALLOWLISTED");
    }
    if (!Policy.allowAllResolvableHunts && Policy.allowedHunts.size === 0) return Dedicated("HUNT_ALLOWLIST_EMPTY");
    if (!Policy.allowAllResolvableHunts && !Policy.allowedHunts.has(Input.huntId)) return Dedicated("HUNT_NOT_ALLOWLISTED");
    if (IsKnownRuntimeIncompatible(Input.huntId)) return Dedicated("HUNT_RUNTIME_INCOMPATIBLE");
    if (!Policy.allowHighRiskHuntClasses && IsExcludedCanaryClass(Input.huntId)) return Dedicated("HUNT_CLASS_EXCLUDED");
    if (!Policy.canaryEnabled) return Dedicated("CANARY_DISABLED");
    if (Policy.trustTier === 1) {
        if (!Policy.tier1RewardsEnabled) return Dedicated("TIER1_REWARDS_DISABLED");
        if (!Policy.tier1ShadowApproved) return Dedicated("TIER1_SHADOW_NOT_APPROVED");
        if (Input.accountIds.some((accountId) => !Policy.tier1AllowedAccounts.has(accountId))) {
            return Dedicated("TIER1_ACCOUNT_NOT_ALLOWLISTED");
        }
        if (!Policy.tier1AllowedHunts.has(Input.huntId)) return Dedicated("TIER1_HUNT_NOT_ALLOWLISTED");
    }
    if (Policy.percentRollout <= 0) return Dedicated("ROLLOUT_DISABLED");

    const RolloutBucket = P2PRolloutBucket(Input.accountIds, Input.huntId);
    if (RolloutBucket >= Policy.percentRollout) return Dedicated("ROLLOUT_EXCLUDED", RolloutBucket);

    // Phase 0 deliberately has no player-hosted implementation. This non-environment capability
    // prevents an operator typo from routing a real client into a nonexistent/unsafe transport.
    if (!Capabilities.playerHostedImplemented) {
        return Dedicated("PLAYER_HOSTED_NOT_IMPLEMENTED", RolloutBucket);
    }

    return { route: "PLAYER_HOSTED", reason: "ELIGIBLE", rolloutBucket: RolloutBucket };
}

export function P2PPolicySummary(Policy: P2PPolicy): Record<string, boolean | number> {
    return {
        enabled: Policy.enabled,
        allowedAccountCount: Policy.allowedAccounts.size,
        allowAllAccounts: Policy.allowAllAccounts,
        allowedHuntCount: Policy.allowedHunts.size,
        allowAllResolvableHunts: Policy.allowAllResolvableHunts,
        allowHighRiskHuntClasses: Policy.allowHighRiskHuntClasses,
        privatePartiesOnly: Policy.privatePartiesOnly,
        maxPartySize: Policy.maxPartySize,
        percentRollout: Policy.percentRollout,
        forceSdr: Policy.forceSdr,
        canaryEnabled: Policy.canaryEnabled,
        trustTier: Policy.trustTier,
        tier1RewardsEnabled: Policy.tier1RewardsEnabled,
        tier1ShadowApproved: Policy.tier1ShadowApproved,
        tier1AllowedAccountCount: Policy.tier1AllowedAccounts.size,
        tier1AllowedHuntCount: Policy.tier1AllowedHunts.size,
        dedicatedHuntsDisabled: Policy.dedicatedHuntsDisabled,
        trainingEnabled: Policy.trainingEnabled
    };
}
