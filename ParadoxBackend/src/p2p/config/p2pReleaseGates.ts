/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14] The P2P release gates the manager preflight reads (observability/releaseGates.ts): the P2P env policy, the durable
// emergency stop and the Tier 1 reward grants. They are the old start-server.bat gates, rebuilt on the existing readers
// (ReadP2PPolicy, RelayOnlyWarning) and on the operations policy record. Pure functions take plain values; the only I/O is the
// injected read of the operations policy record, so tests never touch a database.

import type { ReleaseGate } from "../../observability/releaseGates";
import { ReadOperationsPolicyRecord } from "../../services/operationsPolicy";
import { NormalizeP2POperationsPolicyRecord } from "../services/p2pOperationsPolicy";
import { ReadP2PPolicy, RelayOnlyWarning } from "./p2pPolicy";

/** How long the operations policy read may take before the gates report it unreadable (fail closed). */
export const P2P_RELEASE_GATE_READ_TIMEOUT_MS = 5_000;

/**
 * p2p_env_policy. With hunts enabled, relay-only traffic (P2P_FORCE_SDR=true) and the scoped rules (no allow-all switches, private
 * parties) must hold. Trust tier 0 is the default; trust tier 1 is accepted only with every Tier 1 switch and allowlist set.
 * Tier 1 switches set while the trust tier is 0 are refused, because they would look like a deliberate Tier 1 when they are not.
 */
export function P2PEnvReleaseGate(environment: NodeJS.ProcessEnv): ReleaseGate {
    const Problems: string[] = [];
    // ReadP2PPolicy maps any value other than "1" to tier 0; a malformed value is reported here instead of being read as 0.
    const RawTrustTier = (environment.P2P_TRUST_TIER ?? "").trim();
    if (RawTrustTier !== "" && RawTrustTier !== "0" && RawTrustTier !== "1") Problems.push("P2P_TRUST_TIER is not 0 or 1");

    const Policy = ReadP2PPolicy(environment);
    if (Policy.enabled) {
        if (RelayOnlyWarning(environment) !== undefined) Problems.push("P2P_FORCE_SDR is not true while hunts are enabled");
        if (Policy.allowAllAccounts) Problems.push("P2P_ALLOW_ALL_ACCOUNTS is true");
        if (Policy.allowAllResolvableHunts) Problems.push("P2P_ALLOW_ALL_RESOLVABLE_HUNTS is true");
        if (Policy.allowHighRiskHuntClasses) Problems.push("P2P_ALLOW_HIGH_RISK_HUNT_CLASSES is true");
        if (!Policy.privatePartiesOnly) Problems.push("P2P_PRIVATE_PARTIES_ONLY is false");
    }
    const Tier1Set = Policy.tier1RewardsEnabled || Policy.tier1ShadowApproved;
    if (Policy.trustTier === 1) {
        if (!Policy.tier1RewardsEnabled) Problems.push("trust tier 1 without P2P_TIER1_REWARDS_ENABLED=true");
        if (!Policy.tier1ShadowApproved) Problems.push("trust tier 1 without P2P_TIER1_SHADOW_APPROVED=true");
        if (Policy.tier1AllowedAccounts.size === 0) Problems.push("trust tier 1 with an empty P2P_TIER1_ALLOWED_ACCOUNTS");
        if (Policy.tier1AllowedHunts.size === 0) Problems.push("trust tier 1 with an empty P2P_TIER1_ALLOWED_HUNTS");
    } else if (Tier1Set) {
        Problems.push("Tier 1 switches are set while P2P_TRUST_TIER is 0");
    }

    const Summary = `hunts=${Policy.enabled ? "on" : "off"}, relay_only=${Policy.forceSdr ? "on" : "off"}, ` +
        `trust_tier=${Policy.trustTier}, tier1_switches=${Tier1Set ? "on" : "off"}`;
    if (Problems.length === 0) return { name: "p2p_env_policy", ok: true, detail: Summary };
    return { name: "p2p_env_policy", ok: false, detail: `${Summary}; ${Problems.join("; ")}` };
}

/**
 * The durable emergency stop and the Tier 1 grants, from one read of the operations policy record. Pure: the caller passes whether the
 * read succeeded and the record it returned (null when the document is missing). A missing or malformed document fails closed for both
 * gates, as the old start script did for a missing or stopped policy.
 */
export function DurableP2PReleaseGates(input: { readable: boolean; record?: unknown }): ReleaseGate[] {
    const Names = ["p2p_emergency_stop_durable", "tier1_reward_grants"];
    const NotOk = (detail: string): ReleaseGate[] => Names.map((name) => ({ name, ok: false, detail }));
    if (!input.readable) return NotOk("unreadable");
    if (input.record == undefined) return NotOk("missing");
    const Normalized = NormalizeP2POperationsPolicyRecord(input.record);
    if (Normalized.malformed) return NotOk("malformed");
    const Stop = Normalized.policy.p2pEmergencyStop === true;
    const Tier1Grants = Normalized.policy.rewardRollout?.tier1GrantsEnabled === true;
    return [
        { name: "p2p_emergency_stop_durable", ok: !Stop, detail: `emergency_stop=${Stop ? "on" : "off"}` },
        { name: "tier1_reward_grants", ok: !Tier1Grants, detail: `tier1_grants=${Tier1Grants ? "on" : "off"}` }
    ];
}

/**
 * Reads the operations policy record through the injected reader and applies DurableP2PReleaseGates. A read that throws or does
 * not answer within the timeout is unreadable. The default reader is the shared raw read (SQLite or MongoDB, whichever the
 * deployment uses); it writes nothing and does not apply the logging profile.
 */
export async function ReadDurableP2PReleaseGates(read: () => Promise<unknown> = ReadOperationsPolicyRecord,
    timeoutMs = P2P_RELEASE_GATE_READ_TIMEOUT_MS): Promise<ReleaseGate[]> {
    let timer: NodeJS.Timeout | undefined;
    try {
        const record = await Promise.race([
            read(),
            new Promise<never>((_resolve, reject) => {
                // Cleared in finally on every path, so it never outlives the read.
                timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
            })
        ]);
        return DurableP2PReleaseGates({ readable: true, record });
    } catch {
        return DurableP2PReleaseGates({ readable: false });
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Every gate the P2P module contributes to the preflight. */
export async function CollectP2PReleaseGates(environment: NodeJS.ProcessEnv,
    read: () => Promise<unknown> = ReadOperationsPolicyRecord): Promise<ReleaseGate[]> {
    return [P2PEnvReleaseGate(environment), ...(await ReadDurableP2PReleaseGates(read))];
}
