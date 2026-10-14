/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14 M2] Which address the Metagame believes for a client. req.ip comes from X-Forwarded-For only when the socket peer
// is loopback (the nginx on this machine); any other peer is its own address. Checked with Express's own trust function and over
// a real loopback request.

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { ForwardedClientAddress, IsLoopbackAddress, TRUST_PROXY_SETTING } from "./proxyTrust";

test("loopback is 127/8, ::1 and their IPv4-mapped forms; every other address is not", () => {
    for (const address of ["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1"]) assert.equal(IsLoopbackAddress(address), true, address);
    for (const address of ["203.0.113.9", "10.0.0.5", "::ffff:203.0.113.9", "2001:db8::1", "1270.0.0.1", "127.0.0.1.evil.example", ""]) {
        assert.equal(IsLoopbackAddress(address), false, address);
    }
    assert.equal(IsLoopbackAddress(undefined), false);
});

test("the client is the rightmost X-Forwarded-For entry that is not loopback, and only a loopback peer is believed", () => {
    // nginx appends the address it received from the client: the rightmost entry is the client, whatever the request sent first.
    assert.equal(ForwardedClientAddress("127.0.0.1", "1.2.3.4, 203.0.113.9"), "203.0.113.9");
    assert.equal(ForwardedClientAddress("127.0.0.1", ["1.2.3.4", "203.0.113.9"]), "203.0.113.9", "a repeated header is joined");
    assert.equal(ForwardedClientAddress("::ffff:127.0.0.1", "203.0.113.9, 127.0.0.1"), "203.0.113.9", "loopback hops on the right are skipped");
    assert.equal(ForwardedClientAddress("127.0.0.1", undefined), "127.0.0.1", "no header: the proxy's own address");
    assert.equal(ForwardedClientAddress("127.0.0.1", "  "), "127.0.0.1");
    // A direct peer is the client: a forged header is ignored.
    assert.equal(ForwardedClientAddress("203.0.113.50", "198.51.100.1"), "203.0.113.50");
    assert.equal(ForwardedClientAddress(undefined, "198.51.100.1"), undefined);
    // An absurdly long entry is not an address and is skipped.
    assert.equal(ForwardedClientAddress("127.0.0.1", `203.0.113.9, ${"9".repeat(80)}`), "203.0.113.9");
});

function Get(port: number, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: "127.0.0.1", port, path: "/ip", headers }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => { body += chunk; });
            response.on("end", () => resolve(body));
        });
        request.on("error", reject);
    });
}

test("Express, with the Metagame's setting, takes req.ip from X-Forwarded-For only for a loopback peer", async () => {
    const App = express();
    App.set("trust proxy", TRUST_PROXY_SETTING);
    App.get("/ip", (req, res) => { res.send(req.ip ?? "none"); });
    const Server = http.createServer(App);
    await new Promise<void>((resolve) => Server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = Server.address() as AddressInfo;
    try {
        assert.equal(await Get(port, { "X-Forwarded-For": "198.51.100.7" }), "198.51.100.7", "behind the loopback proxy");
        assert.equal(await Get(port, {}), "127.0.0.1", "a direct loopback caller with no header");
    } finally {
        await new Promise<void>((resolve) => Server.close(() => resolve()));
    }
    const Trusts = App.get("trust proxy fn") as (address: string, hop: number) => boolean;
    assert.equal(Trusts("127.0.0.1", 0), true);
    assert.equal(Trusts("::1", 0), true);
    assert.equal(Trusts("203.0.113.50", 0), false, "a non-loopback peer is never believed about its client");
});
