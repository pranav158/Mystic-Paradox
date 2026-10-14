import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { HasAdminAuth } from "./HasAdminAuth";
import { CaptureAdminRawBody, ManagerOperatorSignature } from "../security/managerOperator";

const SECRET = "http-manager-operator-secret-0123456789abcdef";
const OPERATOR = "987654321098765432";

type Reply = { status: number; body: any };

/** The probe route: what HasAdminAuth decided, and whether a backend session was involved. */
function ProbeApp(): express.Express {
    const app = express();
    app.use(express.json({ verify: CaptureAdminRawBody }));
    app.all("/admin/v1/probe", HasAdminAuth, (req, res) => {
        const Auth = (req as any).AdminAuth;
        res.json({
            actor: Auth.account.userId,
            roles: Auth.account.roles,
            manager: Auth.manager === true,
            hasSession: Auth.session !== undefined
        });
    });
    return app;
}

function Send(port: number, method: string, target: string, headers: Record<string, string>, body?: Buffer): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path: target, method, headers }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => {
                let parsed: any = text;
                try { parsed = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode ?? 0, body: parsed });
            });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

/** A signed request: the headers the manager would send for this method, target, body and time. */
function SignedHeaders(method: string, target: string, body: Buffer | undefined, timestamp: number, secret = SECRET): Record<string, string> {
    const BodyHash = crypto.createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex");
    const Canonical = [method, target, String(timestamp), OPERATOR, BodyHash].join("\n");
    const Headers: Record<string, string> = {
        "x-paradox-operator-id": OPERATOR,
        "x-paradox-operator-name": "Pranav",
        "x-paradox-operator-timestamp": String(timestamp),
        "x-paradox-operator-signature": ManagerOperatorSignature(secret, Canonical)
    };
    if (body !== undefined) {
        Headers["content-type"] = "application/json";
        Headers["content-length"] = String(body.length);
    }
    return Headers;
}

async function WithServer(run: (port: number) => Promise<void>): Promise<void> {
    const Previous = {
        switch: process.env.MYSTICPARADOX_MANAGER_ADMIN,
        secret: process.env.MYSTICPARADOX_MANAGER_OPERATOR_SECRET
    };
    process.env.MYSTICPARADOX_MANAGER_ADMIN = "on";
    process.env.MYSTICPARADOX_MANAGER_OPERATOR_SECRET = SECRET;
    const server = ProbeApp().listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
    });
    const Port = (server.address() as AddressInfo).port;
    try {
        await run(Port);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (Previous.switch == undefined) delete process.env.MYSTICPARADOX_MANAGER_ADMIN; else process.env.MYSTICPARADOX_MANAGER_ADMIN = Previous.switch;
        if (Previous.secret == undefined) delete process.env.MYSTICPARADOX_MANAGER_OPERATOR_SECRET; else process.env.MYSTICPARADOX_MANAGER_OPERATOR_SECRET = Previous.secret;
    }
}

test("a signed loopback GET is served as manager:<id> with no session and no cookie", async () => {
    await WithServer(async (port) => {
        const Target = "/admin/v1/probe?case=get-ok";
        const Reply1 = await Send(port, "GET", Target, SignedHeaders("GET", Target, undefined, Date.now()));
        assert.equal(Reply1.status, 200);
        assert.equal(Reply1.body.actor, `manager:${OPERATOR}`);
        assert.deepEqual(Reply1.body.roles, ["admin"]);
        assert.equal(Reply1.body.manager, true);
        assert.equal(Reply1.body.hasSession, false);
    });
});

test("a signed JSON POST is served when the body hash matches what was sent", async () => {
    await WithServer(async (port) => {
        const Target = "/admin/v1/probe?case=post-ok";
        const Body = Buffer.from(JSON.stringify({ confirm: "MAX Tester" }));
        const Reply1 = await Send(port, "POST", Target, SignedHeaders("POST", Target, Body, Date.now()), Body);
        assert.equal(Reply1.status, 200);
        assert.equal(Reply1.body.actor, `manager:${OPERATOR}`);
    });
});

test("the same signed request is accepted once and refused as a replay the second time", async () => {
    await WithServer(async (port) => {
        const Target = "/admin/v1/probe?case=replay";
        const Headers = SignedHeaders("GET", Target, undefined, Date.now());
        assert.equal((await Send(port, "GET", Target, Headers)).status, 200);
        const Second = await Send(port, "GET", Target, Headers);
        assert.equal(Second.status, 401);
        assert.equal(Second.body.error.code, "ADMIN_OPERATOR_REPLAY");
    });
});

test("a signature over another body is refused with 401", async () => {
    await WithServer(async (port) => {
        const Target = "/admin/v1/probe?case=wrong-body";
        const Signed = Buffer.from("{\"confirm\":\"MAX A\"}");
        const Sent = Buffer.from("{\"confirm\":\"MAX B\"}");
        const Reply1 = await Send(port, "POST", Target, SignedHeaders("POST", Target, Signed, Date.now()), Sent);
        assert.equal(Reply1.status, 401);
        assert.equal(Reply1.body.error.code, "ADMIN_OPERATOR_SIGNATURE");
    });
});

test("a timestamp older than 60 s is refused with 401", async () => {
    await WithServer(async (port) => {
        const Target = "/admin/v1/probe?case=stale";
        const Reply1 = await Send(port, "GET", Target, SignedHeaders("GET", Target, undefined, Date.now() - 61_000));
        assert.equal(Reply1.status, 401);
        assert.equal(Reply1.body.error.code, "ADMIN_OPERATOR_STALE");
    });
});

test("a forwarding header on an otherwise valid signed request is refused with 403", async () => {
    await WithServer(async (port) => {
        const Target = "/admin/v1/probe?case=forwarded";
        const Headers = { ...SignedHeaders("GET", Target, undefined, Date.now()), "x-forwarded-for": "203.0.113.7" };
        const Reply1 = await Send(port, "GET", Target, Headers);
        assert.equal(Reply1.status, 403);
        assert.equal(Reply1.body.error.code, "ADMIN_OPERATOR_FORWARDED");
    });
});

test("a body sent as text (not captured as JSON) is refused with 400 rather than hashed as empty", async () => {
    await WithServer(async (port) => {
        const Target = "/admin/v1/probe?case=text-body";
        const Body = Buffer.from("confirm=MAX");
        // Signed over the empty body, sent with a body the JSON parser does not capture.
        const Headers = SignedHeaders("POST", Target, undefined, Date.now());
        Headers["content-type"] = "text/plain";
        Headers["content-length"] = String(Body.length);
        const Reply1 = await Send(port, "POST", Target, Headers, Body);
        assert.equal(Reply1.status, 400);
        assert.equal(Reply1.body.error.code, "ADMIN_OPERATOR_BODY");
    });
});

test("with the switch off, operator headers are ignored and the cookie session decides (401, no cookie)", async () => {
    const Previous = process.env.MYSTICPARADOX_MANAGER_ADMIN;
    const PreviousSecret = process.env.MYSTICPARADOX_MANAGER_OPERATOR_SECRET;
    process.env.MYSTICPARADOX_MANAGER_ADMIN = "off";
    process.env.MYSTICPARADOX_MANAGER_OPERATOR_SECRET = SECRET;
    try {
        const server = ProbeApp().listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server.once("listening", () => resolve()));
        const Port = (server.address() as AddressInfo).port;
        try {
            const Target = "/admin/v1/probe?case=switch-off";
            const Reply1 = await Send(Port, "GET", Target, SignedHeaders("GET", Target, undefined, Date.now()));
            assert.equal(Reply1.status, 401);
            assert.equal(Reply1.body.error.code, "ADMIN_UNAUTHORIZED");
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    } finally {
        if (Previous == undefined) delete process.env.MYSTICPARADOX_MANAGER_ADMIN; else process.env.MYSTICPARADOX_MANAGER_ADMIN = Previous;
        if (PreviousSecret == undefined) delete process.env.MYSTICPARADOX_MANAGER_OPERATOR_SECRET; else process.env.MYSTICPARADOX_MANAGER_OPERATOR_SECRET = PreviousSecret;
    }
});

test("a request with no operator headers still needs the cookie (unchanged behaviour)", async () => {
    await WithServer(async (port) => {
        const Reply1 = await Send(port, "GET", "/admin/v1/probe?case=no-headers", {});
        assert.equal(Reply1.status, 401);
        assert.equal(Reply1.body.error.code, "ADMIN_UNAUTHORIZED");
    });
});
