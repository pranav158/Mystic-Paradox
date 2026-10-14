/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] MYSTICPARADOX_ADMIN_API: whether this backend serves its admin API and the manager's loopback preflight.
//   on    every /admin path (players, bans, approvals, activity, Guard findings, P2P operations, launcher logs, the tester tool)
//         and GET /health/release-gates are served, each behind its own admin or loopback check as before;
//   off   every /admin path answers 404 and the preflight route is not mounted;
//   blank on only when the manager bridge is on (MYSTICPARADOX_MANAGER_ADMIN=on). A self-hosted backend therefore starts with
//         no admin surface at all, and the official VPS (manager bridge on) keeps it without a new setting.
// Any other value stops startup. Pure: tests pass their own environment.
import { ReadManagerOperatorSwitch } from "../security/managerOperator";

export const ADMIN_API_SWITCH_KEY = "MYSTICPARADOX_ADMIN_API";

export interface AdminApiPolicy {
    enabled: boolean;
    /** Why: the switch itself, the manager bridge (blank switch, bridge on), or the default (blank switch, bridge off). */
    source: "switch" | "manager" | "default";
}

export function ReadAdminApiPolicy(environment: NodeJS.ProcessEnv = process.env): AdminApiPolicy {
    const Raw = (environment[ADMIN_API_SWITCH_KEY] ?? "").trim().toLowerCase();
    if (Raw === "on") return { enabled: true, source: "switch" };
    if (Raw === "off") return { enabled: false, source: "switch" };
    if (Raw !== "") throw new Error(`${ADMIN_API_SWITCH_KEY} must be on or off (blank follows MYSTICPARADOX_MANAGER_ADMIN).`);
    return ReadManagerOperatorSwitch(environment) ? { enabled: true, source: "manager" } : { enabled: false, source: "default" };
}

/** The one startup line. */
export function DescribeAdminApiPolicy(policy: AdminApiPolicy): string {
    const Why = policy.source === "switch" ? `${ADMIN_API_SWITCH_KEY}=${policy.enabled ? "on" : "off"}`
        : policy.source === "manager" ? "MYSTICPARADOX_MANAGER_ADMIN=on" : `${ADMIN_API_SWITCH_KEY} unset, manager bridge off`;
    return policy.enabled
        ? `[Startup] admin API on (${Why}): /admin routes and the release-gates preflight are served`
        : `[Startup] admin API off (${Why}): /admin answers 404, no release-gates route`;
}
