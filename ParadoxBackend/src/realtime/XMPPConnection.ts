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

import type { WebSocket } from "ws";

import { logger } from "../logger";
import { recordAuthFailure, recordAuthSuccess } from "./authThrottle";
import { directChatService } from "./DirectChatService";
import { onResourceAvailable, onResourceUnavailable } from "./PresenceService";
import { roomService } from "./RoomService";
import { sessionRegistry } from "./SessionRegistry";
import { summarizeFrame } from "./XMPPProtocol";
import { XMPPSession } from "./XMPPSession";
import { ConnectionInfo, RealtimeConfig, XmppState } from "./types";

let CONN_SEQ = 0;

export interface ConnectionCallbacks {
    onClose(conn: XMPPConnection): void;
}

/**
 * One live client WebSocket. In the capture foundation it:
 *   - enforces the per-message byte cap;
 *   - records a sanitized structural summary of each frame (when capture is on);
 *   - maintains protocol state;
 *   - guarantees clean teardown (timers cleared, registry notified) on
 *     close/error/timeout (plan §8.3).
 *
 * It does NOT yet authenticate, advance the full handshake, or route stanzas — that
 * arrives with WP3/WP4 once the real client protocol is captured. All inbound data
 * is treated as untrusted and never interpreted as commands.
 */
export class XMPPConnection {
    readonly connId: string;
    readonly remoteIp: string;
    readonly connectedAt: number;
    state: XmppState = XmppState.Connected;
    accountId?: string;
    resource?: string;

    private readonly ws: WebSocket;
    private readonly config: RealtimeConfig;
    private readonly callbacks: ConnectionCallbacks;
    private handshakeTimer?: NodeJS.Timeout;
    private idleTimer?: NodeJS.Timeout;
    private closed = false;
    private frameCount = 0;
    // Tracks whether THIS resource has already announced itself available, so repeated presence
    // stanzas for the same login (rich-status refreshes, travel, reconnect-in-place) don't get
    // treated as fresh online transitions and re-broadcast full presence to every friend again.
    private presenceAvailable = false;
    private readonly session = new XMPPSession();
    private processing: Promise<void> = Promise.resolve();

    constructor(ws: WebSocket, remoteIp: string, config: RealtimeConfig, callbacks: ConnectionCallbacks) {
        this.ws = ws;
        this.remoteIp = remoteIp;
        this.config = config;
        this.callbacks = callbacks;
        this.connId = `xc_${Date.now().toString(36)}_${(++CONN_SEQ).toString(36)}`;
        this.connectedAt = Date.now();

        ws.on("message", (data: Buffer, isBinary: boolean) => this.onMessage(data, isBinary));
        ws.on("close", (code: number) => this.teardown(`close(${code})`));
        ws.on("error", (err: Error) => this.teardown(`error(${err?.message ?? "?"})`));
        ws.on("pong", () => this.touchIdle());

        this.armHandshakeTimeout();
        this.armIdleTimeout();

        logger.info(`[XMPP] conn=${this.connId} state=${this.state} ip=${this.remoteIp} opened`);
    }

    info(): ConnectionInfo {
        return {
            connId: this.connId,
            remoteIp: this.remoteIp,
            connectedAt: this.connectedAt,
            state: this.state,
            accountId: this.accountId,
            resource: this.resource,
        };
    }

    private onMessage(data: Buffer, isBinary: boolean): void {
        if (this.closed) return;
        this.touchIdle();

        const bytes = data.byteLength;
        if (bytes > this.config.limits.maxMessageBytes) {
            logger.warn(`[XMPP] conn=${this.connId} frame ${bytes}B exceeds cap ${this.config.limits.maxMessageBytes}B - closing`);
            this.close(1009, "message too big");
            return;
        }

        this.frameCount++;

        // XMPP-over-WebSocket payloads are UTF-8 text. A binary frame is unexpected;
        // record and ignore rather than interpret it.
        if (isBinary) {
            logger.info(`[XMPP] conn=${this.connId} binary frame ${bytes}B (ignored in capture)`);
            return;
        }

        const text = data.toString("utf8");

        // Optional sanitized capture logging (diagnostics only; never logs text/credentials).
        if (this.config.captureEnabled) {
            const summary = summarizeFrame(text, this.config.limits);
            logger.info(`[XMPP-CAP] conn=${this.connId} #${this.frameCount} state=${this.state} parsed=${summary.parsed} ${summary.shape}`);
        }

        // Real protocol handling (auth-gated). Serialized per connection so async auth can't let a
        // later frame overtake an earlier one during the handshake.
        this.processing = this.processing.then(() => this.handleFrame(text)).catch((e) => {
            logger.error(`[XMPP] conn=${this.connId} frame handling error: ${e}`);
        });

        // NOTE: no stanza handling or responses yet. Post-capture (WP3/WP4) this is
        // where the state machine advances and stanzas are authorized + routed.
    }

    private async handleFrame(text: string): Promise<void> {
        if (this.closed) return;

        const action = await this.session.handleFrame(text);
        if (!action) return;

        for (const frame of action.send) {
            this.send(frame);
        }
        if (action.nextState) this.state = action.nextState;
        if (action.accountId) {
            this.accountId = action.accountId; // identity bound from the verified token
            recordAuthSuccess(this.remoteIp);
        }
        if (action.resource) {
            this.resource = action.resource;
            if (this.accountId) {
                // Duplicate-resource policy: deterministic replacement (plan §10.3). If the same
                // (account, resource) was already live on another socket, close the old one.
                const displaced = sessionRegistry.bind(this.accountId, this.resource, this);
                if (displaced && displaced !== this) {
                    displaced.close(1001, "replaced by a newer resource");
                }
            }
        }
        if (action.authFailed) recordAuthFailure(this.remoteIp);

        if (action.presence && this.accountId && this.resource) {
            if (action.presence.available) {
                if (!this.presenceAvailable) {
                    this.presenceAvailable = true;
                    await onResourceAvailable(this.accountId, this.resource);
                }
            } else if (this.presenceAvailable) {
                this.presenceAvailable = false;
                await onResourceUnavailable(this.accountId);
            }
        }

        if (action.room) {
            if (action.room.kind === "join") {
                for (const frame of await roomService.joinRoom(this, action.room.to)) {
                    this.send(frame);
                }
            } else if (action.room.kind === "leave") {
                roomService.leaveRoom(this, action.room.to);
            } else {
                roomService.groupMessage(this, action.room.to, action.room.stanzaId, action.room.body);
            }
        }

        if (action.direct) {
            for (const frame of await directChatService.routeDirectMessage(
                this,
                action.direct.to,
                action.direct.stanzaId,
                action.direct.body,
            )) {
                this.send(frame);
            }
        }

        logger.info(`[XMPP] conn=${this.connId} ${action.note}`
            + (action.send.length > 0 ? ` (sent ${action.send.length}, state=${this.state})` : ""));

        if (action.close) {
            this.close(action.close.code, action.close.reason);
        }
    }

    private armHandshakeTimeout(): void {
        this.handshakeTimer = setTimeout(() => {
            // Must complete SASL within the handshake deadline; otherwise reap the connection.
            if (!this.session.isAuthenticated()) {
                logger.warn(`[XMPP] conn=${this.connId} not authenticated within ${this.config.limits.handshakeTimeoutMs}ms - closing`);
                this.close(1008, "authentication timeout");
            }
        }, this.config.limits.handshakeTimeoutMs);
        this.handshakeTimer.unref();
    }

    private armIdleTimeout(): void {
        this.clearIdle();
        this.idleTimer = setTimeout(() => {
            logger.info(`[XMPP] conn=${this.connId} idle timeout - closing`);
            this.close(1000, "idle timeout");
        }, this.config.limits.idleTimeoutMs);
        this.idleTimer.unref();
    }

    private touchIdle(): void {
        if (!this.closed) this.armIdleTimeout();
    }

    private clearIdle(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    /** Send a raw RFC 7395 frame to this client (session replies + presence/room fan-out). */
    send(frame: string): void {
        if (this.closed) return;
        try {
            this.ws.send(frame);
        } catch (e) {
            logger.error(`[XMPP] conn=${this.connId} send failed: ${e}`);
        }
    }

    /** Request a graceful WebSocket close, then guarantee teardown. */
    close(code: number, reason: string): void {
        if (this.closed) return;
        this.state = XmppState.Closing;
        try {
            this.ws.close(code, reason);
        } catch {
            /* ignore */
        }
        this.teardown(`close(${code},${reason})`);
    }

    /** Force-terminate (graceful shutdown / abuse). */
    terminate(): void {
        try {
            this.ws.terminate();
        } catch {
            /* ignore */
        }
        this.teardown("terminate");
    }

    private teardown(why: string): void {
        if (this.closed) return;
        this.closed = true;
        this.state = XmppState.Closed;
        if (this.handshakeTimer) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = undefined;
        }
        this.clearIdle();
        if (this.accountId && this.resource) {
            roomService.onConnectionClosed(this);
            sessionRegistry.unbind(this.accountId, this.resource, this);
            void onResourceUnavailable(this.accountId); // offline broadcast if this was the last resource (with grace)
        }
        logger.info(`[XMPP] conn=${this.connId} closed (${why}) frames=${this.frameCount}`);
        try {
            this.callbacks.onClose(this);
        } catch (e) {
            logger.error(`[XMPP] onClose handler failed for conn=${this.connId}: ${e}`);
        }
    }
}
