/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";

// [2026-10-14] MYSTICPARADOX_GUARD_MODE=observe|enforce. observe (the default, and blank) lets no Guard verdict refuse anything: hosting,
// host selection, hub start, admission or play. Each refusal that the enforce rule would have made is logged once per Guard session as
// [GuardObserve] would refuse ... . enforce keeps the refusals as they were: the operations policy (GUARD_ENFORCEMENT, ENFORCE by default)
// or P2P_LAUNCHER_GUARD_REQUIRED=true. An unrecognised value is enforce, with a startup warning (the stricter, earlier behaviour).

export const GUARD_MODE_ENV = "MYSTICPARADOX_GUARD_MODE";

export type GuardMode = "observe" | "enforce";
export type GuardOperationsEnforcement = "OBSERVE" | "ENFORCE";

export interface GuardModePolicy {
    mode: GuardMode;
    /** True when the variable is unset or blank and observe applies by default. */
    isDefault: boolean;
    /** Set when the variable held an unrecognised value (the mode is then enforce). */
    refusal?: string;
}

/** Pure: the mode from the environment. Only observe and enforce are recognised (trimmed, case-insensitively). */
export function ResolveGuardMode(environment: NodeJS.ProcessEnv = process.env): GuardModePolicy {
    const Raw = (environment[GUARD_MODE_ENV] ?? "").trim().toLowerCase();
    if (Raw === "") return { mode: "observe", isDefault: true };
    if (Raw === "observe") return { mode: "observe", isDefault: false };
    if (Raw === "enforce") return { mode: "enforce", isDefault: false };
    return {
        mode: "enforce", isDefault: false,
        refusal: `${GUARD_MODE_ENV} must be observe or enforce (got ${JSON.stringify(Raw)}); it is treated as enforce, ` +
            "so Guard verdicts refuse as before"
    };
}

/**
 * The refusal rule the backend enforced before the switch: the operations policy's ENFORCE, or P2P_LAUNCHER_GUARD_REQUIRED=true.
 * It is the rule the observe log measures against; it refuses only when GuardVerdictRefuses also holds.
 */
export function GuardRuleRequires(operationsEnforcement: GuardOperationsEnforcement, environment: NodeJS.ProcessEnv = process.env): boolean {
    return operationsEnforcement === "ENFORCE" || environment.P2P_LAUNCHER_GUARD_REQUIRED === "true";
}

/** Whether a Guard verdict may refuse now: enforce mode, and the rule (GuardRuleRequires) asks for it. */
export function GuardVerdictRefuses(operationsEnforcement: GuardOperationsEnforcement, environment: NodeJS.ProcessEnv = process.env): boolean {
    return ResolveGuardMode(environment).mode === "enforce" && GuardRuleRequires(operationsEnforcement, environment);
}

/** The default of the host eligibility helpers' guardRequired argument (no operations policy in scope): enforce and the env switch. */
export function GuardRequiredByEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
    return ResolveGuardMode(environment).mode === "enforce" && environment.P2P_LAUNCHER_GUARD_REQUIRED === "true";
}

export interface GuardWouldRefuse {
    /** What the verdict would have refused: hosting, host candidate, realm host. */
    what: string;
    accountId: string;
    guardSessionId?: string;
    status?: string;
    riskScore?: number;
    reasons?: readonly string[];
}

const NotedWouldRefuse = new Set<string>();
const NOTED_LIMIT = 10_000;

/**
 * Logs one would-be refusal, once per Guard session and kind (an account with no session is keyed by its account id). Returns
 * whether it logged. Bounded: the set is cleared when it grows past NOTED_LIMIT, so a long run logs a session again at worst.
 */
export function NoteGuardWouldRefuse(input: GuardWouldRefuse, sink: { warn(message: string): void } = logger): boolean {
    const Key = `${input.what}|${input.guardSessionId ?? input.accountId}`;
    if (NotedWouldRefuse.has(Key)) return false;
    if (NotedWouldRefuse.size >= NOTED_LIMIT) NotedWouldRefuse.clear();
    NotedWouldRefuse.add(Key);
    sink.warn(`[GuardObserve] would refuse ${input.what} account=${input.accountId} status=${input.status ?? "NONE"} ` +
        `risk=${input.riskScore ?? "-"} reasons=[${(input.reasons ?? []).join(",")}]`);
    return true;
}

export function ResetGuardWouldRefuseNotesForTest(): void {
    NotedWouldRefuse.clear();
}

/** One startup line with the active mode (plus a warning when the value was unrecognised). */
export function LogGuardModePolicy(policy: GuardModePolicy,
    sink: { info(message: string): void; warn(message: string): void } = logger): void {
    if (policy.refusal !== undefined) sink.warn(`[Startup] WARNING: ${policy.refusal}`);
    if (policy.mode === "observe") {
        sink.info(`[Startup] ${GUARD_MODE_ENV}${policy.isDefault ? " not set (default observe)" : "=observe"}: Guard verdicts refuse nothing; ` +
            "would-be refusals are logged as [GuardObserve]");
    } else {
        sink.info(`[Startup] ${GUARD_MODE_ENV}=enforce: Guard verdicts refuse as before (GUARD_ENFORCEMENT and P2P_LAUNCHER_GUARD_REQUIRED)`);
    }
}
