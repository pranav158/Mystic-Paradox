/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

/**
 * Shared types for the realtime (XMPP presence/chat) gateway.
 *
 * SCOPE: this is the capture-first foundation (WP0-WP3 of
 * Plans/XMPP_PRESENCE_CHAT_IMPLEMENTATION_PLAN.md). Authentication, presence,
 * roster, and direct/party chat (WP4+) are intentionally deferred until the real
 * Dauntless 1.12 client protocol has been captured against the owned endpoint;
 * their service contracts live in services.ts as interfaces only. Nothing in this
 * folder guesses the SASL mechanism, framing, or presence payload — those become
 * known only from runtime capture (plan §2.4).
 */

/**
 * WebSocket paths accepted for the XMPP upgrade. The 1.12 client builds its URL as
 * ServerAddr + ":" + ServerPort (host-only ServerAddr), so it requests the root — captured
 * as "//". We keep "/" and the original "/__ws/xmpp" too. This is an explicit allowlist; there
 * is deliberately no generic "accept any path" fallback (even in capture mode).
 */
export const REALTIME_WS_PATHS = ["//", "/", "/__ws/xmpp"];

/**
 * Protocol state machine (plan §9.2). Stanzas that are invalid for the current
 * state are rejected. This is a first model; it will be refined once the real
 * client login sequence is captured.
 */
export enum XmppState {
    Connected = "CONNECTED",
    OpenReceived = "OPEN_RECEIVED",
    AuthAdvertised = "AUTH_ADVERTISED",
    Authenticated = "AUTHENTICATED",
    ReopenReceived = "REOPEN_RECEIVED",
    ResourceBound = "RESOURCE_BOUND",
    SessionReady = "SESSION_READY",
    Closing = "CLOSING",
    Closed = "CLOSED",
}

/** Bounded resource/limit configuration (plan §8.1, §9.4, §10.4). */
export interface RealtimeLimits {
    /** Maximum size of a single inbound WebSocket message. */
    maxMessageBytes: number;
    /** Maximum XML nesting depth accepted by the parser. */
    maxXmlDepth: number;
    /** Maximum attributes per element. */
    maxAttrsPerElement: number;
    /** Maximum text-node length. */
    maxTextLen: number;
    /** Deadline to complete authentication after connect. */
    handshakeTimeoutMs: number;
    /** Idle (no inbound traffic) timeout. */
    idleTimeoutMs: number;
    /** Global concurrent connection cap. */
    maxConnectionsGlobal: number;
    /** Per-remote-IP concurrent connection cap. */
    maxConnectionsPerIp: number;
    /** Grace window before broadcasting offline on disconnect (presence; WP5). */
    reconnectGraceMs: number;
}

export const DEFAULT_LIMITS: RealtimeLimits = {
    maxMessageBytes: 64 * 1024,
    maxXmlDepth: 32,
    maxAttrsPerElement: 64,
    maxTextLen: 8 * 1024,
    handshakeTimeoutMs: 15_000,
    idleTimeoutMs: 5 * 60_000,
    maxConnectionsGlobal: 1000,
    maxConnectionsPerIp: 8,
    reconnectGraceMs: 5_000,
};

export interface RealtimeConfig {
    /** Master gate — mirrors REALTIME_XMPP_ENABLED. When false, upgrades are rejected. */
    enabled: boolean;
    /** Exact WS paths accepted for upgrade (allowlist; no generic fallback). */
    wsPaths: string[];
    /** Allowed Host header values (lowercased). Empty list = allow any (dev capture). */
    allowedHosts: string[];
    /** Emit sanitized protocol capture logs (mirrors REALTIME_XMPP_CAPTURE). */
    captureEnabled: boolean;
    limits: RealtimeLimits;
}

/** Parsed JID parts (plan §10.3, §20.1). */
export interface Jid {
    /** node/localpart, lowercased (may be empty). */
    local: string;
    /** domainpart, lowercased. */
    domain: string;
    /** resourcepart, case-sensitive, preserved verbatim (may be empty). */
    resource: string;
}

/** Read-only, secret-free metadata about a live connection (for logs/metrics). */
export interface ConnectionInfo {
    connId: string;
    remoteIp: string;
    connectedAt: number;
    state: XmppState;
    accountId?: string;
    resource?: string;
}
