/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M2] The XMPP WebSocket gateway on the plain HTTP listener, as nginx forwards to it: the upgrade is accepted for the
// public Host (nginx passes Host through), refused for any other, and the connection's address is the forwarded client only behind
// the proxy. Real loopback sockets, no database.

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import test, { before } from "node:test";

import { DEFAULT_LIMITS, REALTIME_WS_PATHS, RealtimeConfig } from "./types";

type Gateway = import("./RealtimeGateway").RealtimeGateway;
let RealtimeGateway: typeof import("./RealtimeGateway").RealtimeGateway;

// The connection module loads the auth module, which reads its signing keys when it is imported. These tests sign nothing,
// so placeholder keys are enough, and the gateway is loaded after they are set.
before(async () => {
    process.env.AUTH_SIGNING_PRIVKEY_B64 ??= Buffer.from("unused-test-key").toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 ??= Buffer.from("unused-test-key").toString("base64");
    ({ RealtimeGateway } = await import("./RealtimeGateway"));
});

const PUBLIC_HOST = "paradox.mysticfox.dev";
const WS_PATH = "/__ws/xmpp";
const HANDSHAKE = [
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13"
];

function Config(overrides: Partial<RealtimeConfig> = {}): RealtimeConfig {
    return { enabled: true, wsPaths: REALTIME_WS_PATHS, allowedHosts: [PUBLIC_HOST], captureEnabled: false, limits: DEFAULT_LIMITS, ...overrides };
}

async function Listen(server: http.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return (server.address() as AddressInfo).port;
}

async function Close(server: http.Server, gateway: Gateway, sockets: net.Socket[]): Promise<void> {
    for (const socket of sockets) socket.destroy();
    await gateway.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A WebSocket upgrade on a raw socket. Resolves with the response's status line; the socket stays open for the caller. */
function Upgrade(port: number, headers: string[]): Promise<{ status: string; socket: net.Socket }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
            socket.write([`GET ${WS_PATH} HTTP/1.1`, ...headers, "", ""].join("\r\n"));
        });
        let data = "";
        socket.on("data", (chunk) => {
            data += chunk.toString("latin1");
            if (data.includes("\r\n")) resolve({ status: data.split("\r\n")[0], socket });
        });
        socket.on("error", reject);
        socket.on("close", () => {
            if (!data.includes("\r\n")) reject(new Error("closed before a response"));
        });
    });
}

test("behind the proxy the gateway is attached to the HTTP listener, and the Host allowlist applies to what nginx passes on", async () => {
    const Gateway = new RealtimeGateway(Config());
    const Server = http.createServer();
    Gateway.attach(Server);
    assert.equal(Server.listenerCount("upgrade"), 1, "the upgrade handler is on this listener");
    const Port = await Listen(Server);
    const Sockets: net.Socket[] = [];
    try {
        // nginx passes Host through (proxy_set_header Host $host), so the public host is what the gateway sees.
        const Accepted = await Upgrade(Port, [`Host: ${PUBLIC_HOST}`, ...HANDSHAKE]);
        Sockets.push(Accepted.socket);
        assert.equal(Accepted.status, "HTTP/1.1 101 Switching Protocols");
        // Without the pass-through the Host is nginx's own upstream address, and the allowlist refuses it.
        const Refused = await Upgrade(Port, [`Host: 127.0.0.1:${Port}`, ...HANDSHAKE]);
        Sockets.push(Refused.socket);
        assert.equal(Refused.status, "HTTP/1.1 403 Forbidden Host");
        const Foreign = await Upgrade(Port, ["Host: evil.example", ...HANDSHAKE]);
        Sockets.push(Foreign.socket);
        assert.equal(Foreign.status, "HTTP/1.1 403 Forbidden Host");
    } finally {
        await Close(Server, Gateway, Sockets);
    }
});

test("behind the proxy the connection's address is the client nginx forwarded, not the proxy", async () => {
    const Gateway = new RealtimeGateway(Config({ trustForwardedFor: true }));
    const Server = http.createServer();
    Gateway.attach(Server);
    const Port = await Listen(Server);
    const Sockets: net.Socket[] = [];
    try {
        const Accepted = await Upgrade(Port, [`Host: ${PUBLIC_HOST}`, "X-Forwarded-For: 1.2.3.4, 198.51.100.7", ...HANDSHAKE]);
        Sockets.push(Accepted.socket);
        assert.equal(Accepted.status, "HTTP/1.1 101 Switching Protocols");
        assert.deepEqual(Gateway.listConnections().map((connection) => connection.remoteIp), ["198.51.100.7"]);
    } finally {
        await Close(Server, Gateway, Sockets);
    }
});

test("without the proxy setting the connection keeps the socket address, whatever X-Forwarded-For says", async () => {
    const Gateway = new RealtimeGateway(Config());
    const Server = http.createServer();
    Gateway.attach(Server);
    const Port = await Listen(Server);
    const Sockets: net.Socket[] = [];
    try {
        const Accepted = await Upgrade(Port, [`Host: ${PUBLIC_HOST}`, "X-Forwarded-For: 198.51.100.7", ...HANDSHAKE]);
        Sockets.push(Accepted.socket);
        assert.equal(Accepted.status, "HTTP/1.1 101 Switching Protocols");
        assert.deepEqual(Gateway.listConnections().map((connection) => connection.remoteIp), ["127.0.0.1"]);
    } finally {
        await Close(Server, Gateway, Sockets);
    }
});
