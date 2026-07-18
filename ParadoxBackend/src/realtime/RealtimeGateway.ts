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

import type { IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { logger } from "../logger";
import { isAuthThrottled } from "./authThrottle";
import { XMPPConnection } from "./XMPPConnection";
import { ConnectionInfo, RealtimeConfig } from "./types";


export class RealtimeGateway {
    private readonly config: RealtimeConfig;
    private readonly wss: WebSocketServer;
    private readonly connections = new Map<string, XMPPConnection>();
    private readonly perIp = new Map<string, number>();
    private accepting = true;
    private boundServer?: HttpsServer;
    private upgradeHandler?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

    constructor(config: RealtimeConfig) {
        this.config = config;
        
        
        this.wss = new WebSocketServer({
            noServer: true,
            maxPayload: config.limits.maxMessageBytes,
            
            
            handleProtocols: (protocols: Set<string>) => (protocols.has("xmpp") ? "xmpp" : false),
        });
    }

    attach(server: HttpsServer): void {
        this.boundServer = server;
        this.upgradeHandler = (req, socket, head) => this.onUpgrade(req, socket, head);
        server.on("upgrade", this.upgradeHandler);
        logger.info(
            `[XMPP] realtime gateway attached (enabled=${this.config.enabled}, paths=${this.config.wsPaths.join("|")}, ` +
            `capture=${this.config.captureEnabled}, hosts=${this.config.allowedHosts.length > 0 ? this.config.allowedHosts.join(",") : "*"})`,
        );
    }

    private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        const url = req.url ?? "";
        const pathOnly = url.split("?")[0];
        const remoteIp = req.socket?.remoteAddress ?? "unknown";

        if (!this.config.enabled || !this.accepting) {
            this.rejectUpgrade(socket, 503, "Service Unavailable", pathOnly);
            return;
        }
        if (!this.config.wsPaths.includes(pathOnly)) {
            
            this.rejectUpgrade(socket, 404, "Not Found", pathOnly);
            return;
        }
        
        if (this.config.allowedHosts.length > 0) {
            const host = (req.headers.host ?? "").toLowerCase().split(":")[0];
            if (!this.config.allowedHosts.includes(host)) {
                this.rejectUpgrade(socket, 403, "Forbidden Host", pathOnly);
                return;
            }
        }
        
        if (this.connections.size >= this.config.limits.maxConnectionsGlobal) {
            this.rejectUpgrade(socket, 503, "Too Many Connections", pathOnly);
            return;
        }
        if ((this.perIp.get(remoteIp) ?? 0) >= this.config.limits.maxConnectionsPerIp) {
            this.rejectUpgrade(socket, 429, "Too Many Connections (per IP)", pathOnly);
            return;
        }
        if (isAuthThrottled(remoteIp)) {
            this.rejectUpgrade(socket, 429, "Too Many Failed Auth Attempts", pathOnly);
            return;
        }

        this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
            this.onConnection(ws, remoteIp, req);
        });
    }

    private onConnection(ws: WebSocket, remoteIp: string, req: IncomingMessage): void {
        const subproto = (req.headers["sec-websocket-protocol"] as string | undefined) ?? "";
        const conn = new XMPPConnection(ws, remoteIp, this.config, {
            onClose: (c) => this.removeConnection(c),
        });
        this.connections.set(conn.connId, conn);
        this.perIp.set(remoteIp, (this.perIp.get(remoteIp) ?? 0) + 1);
        logger.info(`[XMPP] conn=${conn.connId} accepted ip=${remoteIp} subprotocol="${subproto}" total=${this.connections.size}`);
    }

    private removeConnection(conn: XMPPConnection): void {
        if (!this.connections.delete(conn.connId)) return;
        const remaining = (this.perIp.get(conn.remoteIp) ?? 1) - 1;
        if (remaining <= 0) {
            this.perIp.delete(conn.remoteIp);
        } else {
            this.perIp.set(conn.remoteIp, remaining);
        }
    }

    private rejectUpgrade(socket: Duplex, status: number, msg: string, reqPath: string): void {
        logger.warn(`[XMPP] upgrade rejected ${status} (${msg}) path=${reqPath}`);
        try {
            socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\n\r\n`);
        } catch {
            /* ignore */
        }
        try {
            socket.destroy();
        } catch {
            /* ignore */
        }
    }

    listConnections(): ConnectionInfo[] {
        return [...this.connections.values()].map((c) => c.info());
    }

    
    async shutdown(): Promise<void> {
        this.accepting = false;
        if (this.boundServer && this.upgradeHandler) {
            this.boundServer.off("upgrade", this.upgradeHandler);
        }
        const conns = [...this.connections.values()];
        logger.info(`[XMPP] gateway shutdown: closing ${conns.length} connection(s)`);
        for (const c of conns) {
            c.close(1001, "server shutting down");
        }
        
        await new Promise((resolve) => setTimeout(resolve, 250));
        for (const c of [...this.connections.values()]) {
            c.terminate();
        }
        await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    }
}
