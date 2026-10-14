import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express, { NextFunction, Request, Response } from "express";
import { UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { CurrentLegalRequirements } from "../legal/legalPolicy";
import { LauncherApiError, SendLauncherError } from "../security/launcherErrors";
import { CreateRealmsRouter } from "../realms/routes/realmsLauncher";
import type { RealmsService } from "../realms/realmsService";
import { RequireActiveAccount } from "./RequireActiveAccount";

// [2026-10-14] The account guard on its own (middleware/RequireActiveAccount.ts), and the realms router's hosting and joining routes with
// the default guards. The launcher sign-in is replaced by a stand-in that reads the account from x-test-user, as in the realms tests; the
// accounts live in a temporary SQLite realm.

const CURRENT = CurrentLegalRequirements();
const SCHEDULED = "2026-11-13T12:00:00.000Z";
const SAVED = { mode: process.env.MYSTICPARADOX_CONSENT_ENFORCE, provider: process.env.PERSISTENCE_PROVIDER };

let Realm: TestRealm;
let Server: http.Server;
let Port = 0;

function FakeAuth(req: Request, res: Response, next: NextFunction) {
    const user = req.headers["x-test-user"];
    if (typeof user !== "string") {
        SendLauncherError(res, new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required."));
        return;
    }
    (req as any).LauncherAuthData = { userId: user };
    next();
}

function Post(path: string, user: string | undefined): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (user !== undefined) headers["x-test-user"] = user;
        const request = http.request({ hostname: "127.0.0.1", port: Port, path, method: "POST", headers }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text.length > 0 ? JSON.parse(text) : undefined }));
        });
        request.on("error", reject);
        request.setTimeout(5000, () => request.destroy(new Error(`no answer: ${path}`)));
        request.end("{}");
    });
}

async function Account(overrides: { deletion?: { requestedAt: string; scheduledFor: string }; consent?: boolean } = {}): Promise<string> {
    const userId = crypto.randomUUID();
    const displayName = `Guard${crypto.randomBytes(3).toString("hex")}`;
    await Realm.repos.launcherAccounts.create({
        userId, email: `${displayName.toLowerCase()}@example.test`, displayNameNormalized: displayName.toLowerCase(), displayName,
        status: "active", approvalStatus: "approved", roles: ["player"], createdAt: new Date().toISOString(), usernameSet: true,
        deletion: overrides.deletion,
        consent: overrides.consent === true ? { termsVersion: CURRENT.termsVersion, privacyVersion: CURRENT.privacyVersion, ageConfirmed: true, acceptedAt: new Date().toISOString() } : undefined
    });
    return userId;
}

const DEACTIVATED = { requestedAt: "2026-10-14T12:00:00.000Z", scheduledFor: SCHEDULED };

before(async () => {
    Realm = OpenTestRealm("active-account-guard");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    process.env.PERSISTENCE_PROVIDER = "mongodb";
    delete process.env.MYSTICPARADOX_CONSENT_ENFORCE;

    const app = express();
    app.use(express.json());
    app.post("/hosting", FakeAuth, RequireActiveAccount({ consent: true }), (_req, res) => { res.json({ ok: true }); });
    app.post("/joining", FakeAuth, RequireActiveAccount({ consent: false }), (_req, res) => { res.json({ ok: true }); });
    // The realms router with its default guards; the service is never reached by the refusals tested here.
    app.use("/", CreateRealmsRouter({ service: {} as RealmsService, auth: FakeAuth }));
    app.use((_req, res) => { res.status(404).send(); });
    Server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        Server.once("listening", () => resolve());
        Server.once("error", reject);
    });
    Port = (Server.address() as AddressInfo).port;
});

after(async () => {
    await new Promise<void>((resolve) => Server.close(() => resolve()));
    UsePersistenceForTest(undefined);
    await Realm.cleanup();
    if (SAVED.mode === undefined) delete process.env.MYSTICPARADOX_CONSENT_ENFORCE; else process.env.MYSTICPARADOX_CONSENT_ENFORCE = SAVED.mode;
    if (SAVED.provider === undefined) delete process.env.PERSISTENCE_PROVIDER; else process.env.PERSISTENCE_PROVIDER = SAVED.provider;
});

test("a request with no known account gets the sign-in refusal", async () => {
    const Reply = await Post("/hosting", undefined);
    assert.equal(Reply.status, 401);
    assert.equal(Reply.json.error.code, "AUTH_UNAUTHORIZED");
    const Unknown = await Post("/joining", crypto.randomUUID());
    assert.equal(Unknown.status, 401);
});

test("a deactivated account is refused by hosting and joining guards, with the erasure day", async () => {
    const User = await Account({ deletion: DEACTIVATED });
    for (const path of ["/hosting", "/joining"]) {
        const Reply = await Post(path, User);
        assert.equal(Reply.status, 403, path);
        assert.equal(Reply.json.error.code, "ACCOUNT_DEACTIVATED", path);
        assert.equal(Reply.json.error.scheduledFor, SCHEDULED, path);
    }
});

test("the consent check applies to hosting only, and only when MYSTICPARADOX_CONSENT_ENFORCE is on", async () => {
    const WithoutConsent = await Account();
    assert.equal((await Post("/hosting", WithoutConsent)).status, 200, "enforcement off by default");
    assert.equal((await Post("/joining", WithoutConsent)).status, 200);

    process.env.MYSTICPARADOX_CONSENT_ENFORCE = "on";
    try {
        const Hosting = await Post("/hosting", WithoutConsent);
        assert.equal(Hosting.status, 403);
        assert.equal(Hosting.json.error.code, "CONSENT_REQUIRED");
        assert.equal((await Post("/joining", WithoutConsent)).status, 200, "joining is not gated by consent");

        const WithConsent = await Account({ consent: true });
        assert.equal((await Post("/hosting", WithConsent)).status, 200);
    } finally {
        delete process.env.MYSTICPARADOX_CONSENT_ENFORCE;
    }
});

test("the realms router refuses a deactivated account's hosting and joining routes before the service", async () => {
    const User = await Account({ deletion: DEACTIVATED });
    const Create = await Post("/launcher/v1/realms", User);
    assert.equal(Create.status, 403);
    assert.equal(Create.json.error.code, "ACCOUNT_DEACTIVATED");

    const Join = await Post("/launcher/v1/realms/join", User);
    assert.equal(Join.status, 403);
    assert.equal(Join.json.error.code, "ACCOUNT_DEACTIVATED");

    const Settings = await Post("/launcher/v1/realms/mine/settings", User);
    assert.equal(Settings.json.error.code, "ACCOUNT_DEACTIVATED", "every hosting route is guarded");
});

test("the realms router's hosting routes need the consent when it is enforced", async () => {
    const WithoutConsent = await Account();
    process.env.MYSTICPARADOX_CONSENT_ENFORCE = "on";
    try {
        const Refused = await Post("/launcher/v1/realms", WithoutConsent);
        assert.equal(Refused.status, 403);
        assert.equal(Refused.json.error.code, "CONSENT_REQUIRED");
    } finally {
        delete process.env.MYSTICPARADOX_CONSENT_ENFORCE;
    }
});
