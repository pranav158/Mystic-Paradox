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




export const REALTIME_WS_PATHS = ["//", "/", "/__ws/xmpp"];


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


export interface RealtimeLimits {
    
    maxMessageBytes: number;
    
    maxXmlDepth: number;
    
    maxAttrsPerElement: number;
    
    maxTextLen: number;
    
    handshakeTimeoutMs: number;
    
    idleTimeoutMs: number;
    
    maxConnectionsGlobal: number;
    
    maxConnectionsPerIp: number;
    
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
    
    enabled: boolean;
    
    wsPaths: string[];
    
    allowedHosts: string[];
    
    captureEnabled: boolean;
    limits: RealtimeLimits;
}


export interface Jid {
    
    local: string;
    
    domain: string;
    
    resource: string;
}


export interface ConnectionInfo {
    connId: string;
    remoteIp: string;
    connectedAt: number;
    state: XmppState;
    accountId?: string;
    resource?: string;
}
