/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14] Release gates: the preflight the owner's manager calls (GET /health/release-gates, routes/releaseGates.ts) before it
// starts or restarts the backend. It replaces the refusals of the old start-server.bat. Every gate is pure over an environment-like
// object (no sockets, no database, no logger) so the rules are testable with plain strings. A detail never carries a secret or the
// value of an environment variable: only names, counts, modes and booleans.
//
// The P2P gates (P2P env policy, durable emergency stop, Tier 1 grants) come from the optional module through the extension hook
// (extensions/p2p.ts, releaseGates). This file never imports the module.

import { ReadTlsTerminatedByProxy } from "../config/listenerPlan";
import { REGISTRATION_APPROVAL_ENV, LEGACY_REGISTRATION_AUTO_APPROVE_ENV, ResolveRegistrationApproval } from "../config/registrationApproval";
import { GUARD_MODE_ENV, ResolveGuardMode } from "../services/guardMode";

export interface ReleaseGate {
    name: string;
    ok: boolean;
    /** One short plain string: names, counts, modes and booleans only. */
    detail: string;
}

export interface ReleaseGatesBody {
    ok: boolean;
    gates: ReleaseGate[];
}

/** The four gates the core owns (the P2P module adds its own through its hook). */
export const CORE_RELEASE_GATE_NAMES = ["guard_mode", "registration_approval_mode", "tls_proxy_consistency", "no_legacy_env_keys"] as const;

/** The old environment prefix; the current code refuses to start with any key that has it (config/runtimeSafety.ts). */
export const LEGACY_ENV_PREFIX = "MYSTPAX_";

const LOOPBACK_BIND_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;
const LOOPBACK_PEERS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"] as const;

/** True only for the socket peers of this machine's loopback interface. Plain string in, no DNS and no header reads. */
export function IsLoopbackAddress(address: string | undefined): boolean {
    return address !== undefined && (LOOPBACK_PEERS as readonly string[]).includes(address);
}

/**
 * Aggregate body: ok only when there is at least one gate and every gate is ok. The HTTP status follows this flag
 * (200 when ok, 503 otherwise).
 */
export function BuildReleaseGatesBody(gates: readonly ReleaseGate[]): ReleaseGatesBody {
    return { ok: gates.length > 0 && gates.every((gate) => gate.ok), gates: [...gates] };
}

/** guard_mode: an unrecognised MYSTICPARADOX_GUARD_MODE value is not ok (the code treats it as enforce, with a warning). */
export function GuardModeReleaseGate(environment: NodeJS.ProcessEnv): ReleaseGate {
    const Policy = ResolveGuardMode(environment);
    if (Policy.refusal !== undefined) {
        return { name: "guard_mode", ok: false, detail: `${GUARD_MODE_ENV} has an unrecognised value (must be observe or enforce)` };
    }
    return { name: "guard_mode", ok: true, detail: `mode=${Policy.mode}${Policy.isDefault ? " (default)" : ""}` };
}

/**
 * registration_approval_mode: ok when the effective value parses. A legacy switch that has no effect is reported in the detail
 * but does not fail the gate (the value that counts is MYSTICPARADOX_REGISTRATION_APPROVAL).
 */
export function RegistrationApprovalReleaseGate(environment: NodeJS.ProcessEnv): ReleaseGate {
    const Policy = ResolveRegistrationApproval(environment);
    if (Policy.refusal !== undefined) {
        return { name: "registration_approval_mode", ok: false,
            detail: `${REGISTRATION_APPROVAL_ENV} has an unrecognised value (treated as required)` };
    }
    const Legacy = Policy.legacyWarning !== undefined ? `; ${LEGACY_REGISTRATION_AUTO_APPROVE_ENV} is set and has no effect` : "";
    return { name: "registration_approval_mode", ok: true,
        detail: `mode=${Policy.mode}${Policy.isDefault ? " (default)" : ""}${Legacy}` };
}

/**
 * tls_proxy_consistency: with the proxy mode on (nginx terminates TLS), the plain listener must bind a loopback address so only the
 * proxy reaches it. With the proxy mode off the gate is ok by definition.
 */
export function TlsProxyReleaseGate(environment: NodeJS.ProcessEnv): ReleaseGate {
    let proxyOn: boolean;
    try {
        proxyOn = ReadTlsTerminatedByProxy(environment);
    } catch {
        return { name: "tls_proxy_consistency", ok: false, detail: "MYSTICPARADOX_TLS_TERMINATED_BY_PROXY must be on or off" };
    }
    if (!proxyOn) return { name: "tls_proxy_consistency", ok: true, detail: "proxy mode off (in-process HTTPS)" };
    const BindHost = (environment.BIND_HOST ?? "").trim().toLowerCase();
    if (BindHost === "") {
        return { name: "tls_proxy_consistency", ok: false, detail: "proxy mode on but BIND_HOST is unset (every interface)" };
    }
    if ((LOOPBACK_BIND_HOSTS as readonly string[]).includes(BindHost)) {
        return { name: "tls_proxy_consistency", ok: true, detail: "proxy mode on, BIND_HOST is loopback" };
    }
    return { name: "tls_proxy_consistency", ok: false, detail: "proxy mode on but BIND_HOST is not a loopback address" };
}

/** Names of the environment keys that carry the old prefix. Key names only; values are never read. */
export function LegacyEnvKeyNames(environment: NodeJS.ProcessEnv): string[] {
    return Object.keys(environment).filter((key) => key.startsWith(LEGACY_ENV_PREFIX)).sort();
}

/** no_legacy_env_keys: ok when no key starts with MYSTPAX_. The detail names the offending keys and their count. */
export function LegacyEnvKeysReleaseGate(environment: NodeJS.ProcessEnv): ReleaseGate {
    const Names = LegacyEnvKeyNames(environment);
    if (Names.length === 0) return { name: "no_legacy_env_keys", ok: true, detail: `0 ${LEGACY_ENV_PREFIX} keys` };
    return { name: "no_legacy_env_keys", ok: false, detail: `${Names.length} ${LEGACY_ENV_PREFIX} key(s): ${Names.join(", ")}` };
}

/** The four core gates, in the order the manager reads them. */
export function CoreReleaseGates(environment: NodeJS.ProcessEnv): ReleaseGate[] {
    return [
        GuardModeReleaseGate(environment),
        RegistrationApprovalReleaseGate(environment),
        TlsProxyReleaseGate(environment),
        LegacyEnvKeysReleaseGate(environment)
    ];
}
