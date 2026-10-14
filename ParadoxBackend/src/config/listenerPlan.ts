/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M2] Which listeners the Metagame opens, read from the environment. Pure: no sockets, no logger, so the switch is
// testable. server.ts applies the plan.
//
// MYSTICPARADOX_TLS_TERMINATED_BY_PROXY=on (default off): nginx terminates TLS on 443 and forwards to PORT on loopback. Then
// there is no HTTPS listener and no certificate is needed (also in production), the XMPP WebSocket gateway attaches to the HTTP
// listener, and BIND_HOST should be 127.0.0.1 so the plain listener is reachable only from the proxy. Off keeps the in-process
// HTTPS listener exactly as before.
// BIND_HOST: the HTTP listener's address (default: every interface, as before).
// QOS_PORT: the region-ping listener's port (default 80); "off" starts none, for a proxy that answers the pings itself.

export const DEFAULT_QOS_PORT = 80;

export interface ListenerPlan {
    tlsTerminatedByProxy: boolean;
    /** The HTTP listener's address; undefined = every interface (the Node default). */
    httpBindHost: string | undefined;
    /** Whether an HTTPS listener (and so a certificate) is used. */
    httpsListener: boolean;
    /** The listener the XMPP WebSocket gateway attaches to. */
    realtimeListener: "HTTP" | "HTTPS";
    /** The region-ping listener's port; undefined = not started. */
    qosPort: number | undefined;
    /** Why the region-ping listener is not started when QOS_PORT is neither a port nor "off". */
    qosProblem: string | undefined;
}

/** MYSTICPARADOX_TLS_TERMINATED_BY_PROXY: on/off (1, true, yes / 0, false, no). Anything else stops startup. */
export function ReadTlsTerminatedByProxy(environment: NodeJS.ProcessEnv = process.env): boolean {
    const Raw = (environment.MYSTICPARADOX_TLS_TERMINATED_BY_PROXY ?? "").trim().toLowerCase();
    if (Raw === "" || /^(0|off|false|no)$/.test(Raw)) return false;
    if (/^(1|on|true|yes)$/.test(Raw)) return true;
    throw new Error(`MYSTICPARADOX_TLS_TERMINATED_BY_PROXY must be on or off (got '${Raw}')`);
}

/** QOS_PORT: unset or blank = 80; "off" = no listener; a port number = that port. Anything else is reported, not fatal (as before). */
export function ReadQosPort(raw: string | undefined): { port: number | undefined; problem: string | undefined } {
    const Value = (raw ?? "").trim();
    if (Value === "") return { port: DEFAULT_QOS_PORT, problem: undefined };
    if (Value.toLowerCase() === "off") return { port: undefined, problem: undefined };
    const Port = Number(Value);
    if (Number.isInteger(Port) && Port >= 1 && Port <= 65535) return { port: Port, problem: undefined };
    return { port: undefined, problem: `QOS_PORT='${Value}' is not a port number or 'off'` };
}

export function ResolveListenerPlan(environment: NodeJS.ProcessEnv = process.env): ListenerPlan {
    const TlsTerminatedByProxy = ReadTlsTerminatedByProxy(environment);
    const BindHost = environment.BIND_HOST?.trim();
    const Qos = ReadQosPort(environment.QOS_PORT);
    return {
        tlsTerminatedByProxy: TlsTerminatedByProxy,
        httpBindHost: BindHost ? BindHost : undefined,
        httpsListener: !TlsTerminatedByProxy,
        realtimeListener: TlsTerminatedByProxy ? "HTTP" : "HTTPS",
        qosPort: Qos.port,
        qosProblem: Qos.problem
    };
}
