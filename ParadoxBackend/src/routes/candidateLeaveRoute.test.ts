/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test, { before } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { logger } from "../logger";

// [2026-10-14 cancel] The leave routes: their registration and auth, and the handler over HTTP (the answer and the [CandidateLeave] line).
// The dedicated-only build keeps the P2P hook inert; the route file itself needs no database for a leave with no search.
process.env.MYSTICPARADOX_P2P_MODULE = "off";
// The auth controller reads its signing keys when it loads (this file signs nothing): throwaway keys generated here, read from no file.
const AuthKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(AuthKeys.privateKey.export({ type: "pkcs8", format: "pem" }) as string).toString("base64");
process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(AuthKeys.publicKey.export({ type: "spki", format: "pem" }) as string).toString("base64");

let Routes: typeof import("./matchmaking");
let Auth: typeof import("../middleware/HasParadoxBackendAuth");

before(async () => {
    Routes = await import("./matchmaking");
    Auth = await import("../middleware/HasParadoxBackendAuth");
});

interface RouteEntry {
    path: string;
    method: string;
    handlers: Array<(...args: any[]) => unknown>;
}

function RouteTable(): RouteEntry[] {
    const entries: RouteEntry[] = [];
    for (const layer of (Routes.matchmakingRouter as any).stack) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods).filter((name) => layer.route.methods[name])) {
            entries.push({
                path: layer.route.path,
                method,
                handlers: layer.route.stack.map((entry: any) => entry.handle)
            });
        }
    }
    return entries;
}

test("the leave is routed on DELETE, POST and PUT /candidate/leave and on DELETE /candidate and /candidate/:candidateId, behind the candidate auth", () => {
    const table = RouteTable();
    for (const [method, path] of [["delete", "/candidate/leave"], ["post", "/candidate/leave"], ["put", "/candidate/leave"],
        ["delete", "/candidate"], ["delete", "/candidate/:candidateId"]] as const) {
        const entry = table.find((route) => route.method === method && route.path === path);
        assert.ok(entry, `${method.toUpperCase()} ${path} is routed`);
        assert.equal(entry.handlers[0], Auth.HasParadoxBackendAuth, `${method.toUpperCase()} ${path} is behind the candidate auth`);
        assert.equal(entry.handlers.at(-1), Routes.CandidateLeaveHandler, `${method.toUpperCase()} ${path} answers with the leave`);
    }
});

test("the leave answers 200 {} for every shape and logs one line per call with the body key names, never the values", async (t) => {
    const lines: string[] = [];
    t.mock.method(logger as any, "info", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.AuthData = { userId: "route-user-0001" };
        next();
    });
    app.delete("/candidate/leave", Routes.CandidateLeaveHandler);
    app.post("/candidate/leave", Routes.CandidateLeaveHandler);
    app.put("/candidate/leave", Routes.CandidateLeaveHandler);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const shapes: Array<{ method: string; body?: string }> = [
        { method: "DELETE", body: JSON.stringify({ secret: "tok-SECRET-123" }) },
        { method: "POST" },
        { method: "PUT", body: JSON.stringify({ partyId: "party-secret-456", other: 1 }) }
    ];
    for (const shape of shapes) {
        const response = await fetch(`${base}/candidate/leave`, {
            method: shape.method,
            headers: shape.body === undefined ? undefined : { "content-type": "application/json" },
            body: shape.body
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {});
    }

    const leaveLines = lines.filter((line) => line.includes("[CandidateLeave]"));
    assert.equal(leaveLines.length, shapes.length, "one [CandidateLeave] line per call");
    assert.ok(leaveLines[0].includes("user=route-user-0001 method=DELETE path=/candidate/leave bodyKeys=[secret] candidate=none state=none -> no-candidate"),
        leaveLines[0]);
    assert.ok(leaveLines[2].includes("method=PUT") && leaveLines[2].includes("bodyKeys=[partyId,other]"), leaveLines[2]);
    for (const line of leaveLines) {
        assert.equal(line.includes("tok-SECRET-123"), false, "a body value is never logged");
        assert.equal(line.includes("party-secret-456"), false, "a body value is never logged");
    }
});
