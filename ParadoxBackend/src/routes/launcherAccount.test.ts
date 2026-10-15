import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express from "express";
import { CreateSessionForUser } from "../controllers/launcherAuth";
import { UsePersistenceForTest } from "../persistence";
import type { LauncherConsentRecord } from "../persistence/contracts/LauncherAccountRepository";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { CurrentLegalRequirements } from "../legal/legalPolicy";
import { DAY_MS, DELETION_HOLD_DAYS } from "../legal/retentionPolicy";
import { HashPassword } from "../security/passwords";
import { launcherAuthRouter } from "./launcherAuth";

// [2026-10-14] The consent and account deletion routes over HTTP, with the real launcher sign-in (HasLauncherAuth), the real
// controllers and the SQLite repositories of a temporary realm (no database server). Each account is created in the test, and the
// environment flags the routes read are set per test and restored at the end.

const CURRENT = CurrentLegalRequirements();
const CURRENT_CONSENT = { termsVersion: CURRENT.termsVersion, privacyVersion: CURRENT.privacyVersion, ageConfirmed: true };
const ENV_KEYS = ["AUTH_SIGNING_PRIVKEY_B64", "AUTH_SIGNING_PUBKEY_B64", "PERSISTENCE_PROVIDER", "MYSTICPARADOX_CONSENT_REQUIRED",
    "MYSTICPARADOX_CONSENT_ENFORCE", "DEPLOYSERVER_URL", "MYSTICPARADOX_OFFICIAL_PLAY"] as const;
const SAVED_ENV = new Map<string, string | undefined>();

let Realm: TestRealm;
let Server: http.Server;
let Port = 0;
let counter = 0;

interface Reply {
    status: number;
    json: any;
}

function Call(method: string, path: string, token: string | undefined, body?: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (token !== undefined) headers.authorization = `Bearer ${token}`;
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload !== undefined) headers["content-type"] = "application/json";
        const request = http.request({ hostname: "127.0.0.1", port: Port, path, method, headers, agent: false }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => {
                let json: any;
                try { json = text.length > 0 ? JSON.parse(text) : undefined; } catch { json = text; }
                resolve({ status: res.statusCode ?? 0, json });
            });
        });
        request.on("error", reject);
        request.setTimeout(5000, () => request.destroy(new Error(`no answer: ${method} ${path}`)));
        if (payload !== undefined) request.write(payload);
        request.end();
    });
}

function ExpectError(reply: Reply, status: number, code: string): void {
    assert.equal(reply.status, status, JSON.stringify(reply.json));
    assert.equal(reply.json.error.code, code, JSON.stringify(reply.json));
    assert.equal(typeof reply.json.error.message, "string");
    assert.equal(typeof reply.json.error.requestId, "string");
}

interface TestAccount {
    userId: string;
    displayName: string;
    email: string;
    password: string;
    token: string;
}

async function NewAccount(options: { consent?: LauncherConsentRecord; deletion?: { requestedAt: string; scheduledFor: string } } = {}): Promise<TestAccount> {
    counter += 1;
    const userId = crypto.randomUUID();
    const displayName = `Slayer${counter}x${crypto.randomBytes(2).toString("hex")}`;
    const email = `${displayName.toLowerCase()}@example.test`;
    const password = "correct horse battery";
    await Realm.repos.launcherAccounts.create({
        userId,
        email,
        displayNameNormalized: displayName.toLowerCase(),
        displayName,
        passwordHash: await HashPassword(password),
        status: "active",
        approvalStatus: "approved",
        roles: ["player"],
        createdAt: new Date().toISOString(),
        usernameSet: true,
        consent: options.consent,
        deletion: options.deletion
    });
    const Session = await CreateSessionForUser(userId, "test-device", "Test PC");
    return { userId, displayName, email, password, token: Session.accessToken };
}

function ConsentNow(): LauncherConsentRecord {
    return { termsVersion: CURRENT.termsVersion, privacyVersion: CURRENT.privacyVersion, ageConfirmed: true, acceptedAt: new Date().toISOString() };
}

before(async () => {
    for (const key of ENV_KEYS) SAVED_ENV.set(key, process.env[key]);
    // An RSA pair for the launcher tokens (security/launcherTokens.ts reads the base64 PEMs at each call).
    const Keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" }
    });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey).toString("base64");
    // The official backend's defaults (consent required on MongoDB); the realm below is SQLite, which only the repositories see.
    process.env.PERSISTENCE_PROVIDER = "mongodb";
    delete process.env.MYSTICPARADOX_CONSENT_REQUIRED;
    delete process.env.MYSTICPARADOX_CONSENT_ENFORCE;

    Realm = OpenTestRealm("launcher-account");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });

    const app = express();
    app.use(express.json());
    app.use("/", launcherAuthRouter);
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
    for (const key of ENV_KEYS) {
        const Previous = SAVED_ENV.get(key);
        if (Previous === undefined) delete process.env[key];
        else process.env[key] = Previous;
    }
});

test("GET /launcher/v1/legal answers the versions and the minimum age without a sign-in", async () => {
    const Reply = await Call("GET", "/launcher/v1/legal", undefined);
    assert.equal(Reply.status, 200);
    assert.deepEqual(Reply.json, { termsVersion: CURRENT.termsVersion, privacyVersion: CURRENT.privacyVersion, minimumAge: CURRENT.minimumAge });
});

test("the consent and deletion routes need a sign-in and answer the launcher error envelope without one", async () => {
    for (const [method, path] of [["GET", "/launcher/v1/account/consent"], ["POST", "/launcher/v1/account/consent"],
        ["GET", "/launcher/v1/account/deletion"], ["POST", "/launcher/v1/account/deletion"], ["DELETE", "/launcher/v1/account/deletion"]] as const) {
        ExpectError(await Call(method, path, undefined, {}), 401, "AUTH_UNAUTHORIZED");
    }
});

test("a new account has no consent yet and the launcher must ask", async () => {
    const Account = await NewAccount();
    const Reply = await Call("GET", "/launcher/v1/account/consent", Account.token);
    assert.equal(Reply.status, 200);
    assert.deepEqual(Reply.json, {
        required: { termsVersion: CURRENT.termsVersion, privacyVersion: CURRENT.privacyVersion, minimumAge: CURRENT.minimumAge },
        accepted: null,
        upToDate: false
    });
});

test("POST consent refuses an unconfirmed age, outdated versions and missing versions, and records nothing", async () => {
    const Account = await NewAccount();

    ExpectError(await Call("POST", "/launcher/v1/account/consent", Account.token,
        { ...CURRENT_CONSENT, ageConfirmed: false }), 400, "CONSENT_AGE_REQUIRED");

    const Outdated = await Call("POST", "/launcher/v1/account/consent", Account.token,
        { ...CURRENT_CONSENT, termsVersion: "2026-01-01" });
    ExpectError(Outdated, 409, "LEGAL_VERSION_OUTDATED");
    assert.equal(Outdated.json.error.termsVersion, "2026-10-14", "the refusal names the current versions");

    ExpectError(await Call("POST", "/launcher/v1/account/consent", Account.token, { ageConfirmed: true }), 400, "AUTH_VALIDATION_FAILED");

    const Stored = await Call("GET", "/launcher/v1/account/consent", Account.token);
    assert.equal(Stored.json.upToDate, false);
    assert.equal(Stored.json.accepted, null);
});

test("POST consent with the current versions is recorded, and GET then reports it up to date", async () => {
    const Account = await NewAccount();
    const Accepted = await Call("POST", "/launcher/v1/account/consent", Account.token, CURRENT_CONSENT);
    assert.equal(Accepted.status, 200);
    assert.equal(Accepted.json.upToDate, true);
    assert.equal(Accepted.json.accepted.termsVersion, "2026-10-14");
    assert.equal(Accepted.json.accepted.ageConfirmed, true);
    assert.equal(typeof Accepted.json.accepted.acceptedAt, "string");

    const Read = await Call("GET", "/launcher/v1/account/consent", Account.token);
    assert.deepEqual(Read.json.accepted, Accepted.json.accepted);
    const Stored = await Realm.repos.launcherAccounts.findByUserId(Account.userId);
    assert.equal(Stored?.consent?.privacyVersion, CURRENT.privacyVersion);
});

test("a deletion request needs the username typed exactly (case-insensitively) and is idempotent", async () => {
    const Account = await NewAccount();
    ExpectError(await Call("POST", "/launcher/v1/account/deletion", Account.token, { confirmUsername: "Nobody" }),
        400, "DELETION_CONFIRMATION_MISMATCH");
    ExpectError(await Call("POST", "/launcher/v1/account/deletion", Account.token), 400, "DELETION_CONFIRMATION_MISMATCH");

    const First = await Call("POST", "/launcher/v1/account/deletion", Account.token, { confirmUsername: Account.displayName.toLowerCase() });
    assert.equal(First.status, 200);
    assert.equal(First.json.holdDays, DELETION_HOLD_DAYS);
    const Requested = Date.parse(First.json.request.requestedAt);
    assert.equal(Date.parse(First.json.request.scheduledFor) - Requested, DELETION_HOLD_DAYS * DAY_MS);

    const Again = await Call("POST", "/launcher/v1/account/deletion", Account.token, { confirmUsername: Account.displayName });
    assert.deepEqual(Again.json.request, First.json.request, "a second request keeps the first one");
});

test("a deletion request deactivates the account: play is refused, but sign-in, /me and the account routes keep working", async () => {
    const Account = await NewAccount();
    const Requested = await Call("POST", "/launcher/v1/account/deletion", Account.token, { confirmUsername: Account.displayName });
    const ScheduledFor = Requested.json.request.scheduledFor;

    const Read = await Call("GET", "/launcher/v1/account/deletion", Account.token);
    assert.deepEqual(Read.json, { request: Requested.json.request, holdDays: DELETION_HOLD_DAYS });

    const Refused = await Call("POST", "/launcher/v1/game-sessions", Account.token, {
        buildChangelist: 1, executableSha256: "a".repeat(64), runtimeChannel: "stable"
    });
    ExpectError(Refused, 403, "ACCOUNT_DEACTIVATED");
    assert.equal(Refused.json.error.scheduledFor, ScheduledFor, "the refusal names the day the account is erased");

    const SignIn = await Call("POST", "/launcher/v1/auth/login", undefined, { email: Account.email, password: Account.password });
    assert.equal(SignIn.status, 200, JSON.stringify(SignIn.json));
    const Me = await Call("GET", "/launcher/v1/me", Account.token);
    assert.equal(Me.status, 200, JSON.stringify(Me.json));
    const Consent = await Call("GET", "/launcher/v1/account/consent", Account.token);
    assert.equal(Consent.status, 200);
});

test("restoring during the hold clears the request; after the hold the restore is refused", async () => {
    const Account = await NewAccount();
    await Call("POST", "/launcher/v1/account/deletion", Account.token, { confirmUsername: Account.displayName });

    const Restored = await Call("DELETE", "/launcher/v1/account/deletion", Account.token);
    assert.equal(Restored.status, 200);
    assert.deepEqual(Restored.json, { request: null, holdDays: DELETION_HOLD_DAYS });
    assert.equal((await Call("GET", "/launcher/v1/account/deletion", Account.token)).json.request, null);
    assert.deepEqual((await Call("DELETE", "/launcher/v1/account/deletion", Account.token)).json.request, null, "no request: nothing to restore");

    const Ended = await NewAccount({ deletion: { requestedAt: "2026-01-01T00:00:00.000Z", scheduledFor: "2026-01-31T00:00:00.000Z" } });
    ExpectError(await Call("DELETE", "/launcher/v1/account/deletion", Ended.token), 409, "DELETION_HOLD_EXPIRED");
    assert.ok((await Realm.repos.launcherAccounts.findByUserId(Ended.userId))?.deletion, "the expired request stays for the erasure");
});

test("with MYSTICPARADOX_CONSENT_ENFORCE on, a game session needs the current consent (403 CONSENT_REQUIRED)", async () => {
    const Body = { buildChangelist: 1, executableSha256: "b".repeat(64), runtimeChannel: "stable" };
    process.env.MYSTICPARADOX_CONSENT_ENFORCE = "on";
    try {
        const Without = await NewAccount();
        const Refused = await Call("POST", "/launcher/v1/game-sessions", Without.token, Body);
        ExpectError(Refused, 403, "CONSENT_REQUIRED");

        const With = await NewAccount({ consent: ConsentNow() });
        const Passed = await Call("POST", "/launcher/v1/game-sessions", With.token, Body);
        assert.notEqual(Passed.json?.error?.code, "CONSENT_REQUIRED", "a current consent is not refused for consent");
    } finally {
        delete process.env.MYSTICPARADOX_CONSENT_ENFORCE;
    }

    const Off = await NewAccount();
    const NotEnforced = await Call("POST", "/launcher/v1/game-sessions", Off.token, Body);
    assert.notEqual(NotEnforced.json?.error?.code, "CONSENT_REQUIRED", "enforcement is off by default");
});

test("registration without a consent is refused with 400 CONSENT_REQUIRED, and a current consent is stored", async () => {
    const Name = `Newbie${crypto.randomBytes(2).toString("hex")}`;
    const Refused = await Call("POST", "/launcher/v1/auth/register", undefined,
        { displayName: Name, email: `${Name.toLowerCase()}@example.test`, password: "longenough1" });
    ExpectError(Refused, 400, "CONSENT_REQUIRED");
    assert.match(Refused.json.error.message, /Update the launcher/);

    const Accepted = await Call("POST", "/launcher/v1/auth/register", undefined,
        { displayName: Name, email: `${Name.toLowerCase()}@example.test`, password: "longenough1", consent: CURRENT_CONSENT });
    assert.equal(Accepted.status, 202, JSON.stringify(Accepted.json));
    const Stored = await Realm.repos.launcherAccounts.findByEmail(`${Name.toLowerCase()}@example.test`);
    assert.equal(Stored?.consent?.termsVersion, "2026-10-14");
    assert.equal(Stored?.consent?.ageConfirmed, true);
});

test("the erasure's list returns the accounts whose hold has ended, oldest first, and nothing still in its hold", async () => {
    const Later = await NewAccount({ deletion: { requestedAt: "2026-02-01T00:00:00.000Z", scheduledFor: "2026-03-03T00:00:00.000Z" } });
    const Earlier = await NewAccount({ deletion: { requestedAt: "2026-01-01T00:00:00.000Z", scheduledFor: "2026-01-31T00:00:00.000Z" } });
    await NewAccount({ deletion: { requestedAt: "2026-10-01T00:00:00.000Z", scheduledFor: "2099-01-01T00:00:00.000Z" } });

    const Due = await Realm.repos.launcherAccounts.listDeletionsDue("2026-10-14T12:00:00.000Z", 50);
    const Ids = Due.map((account) => account.userId);
    assert.ok(Ids.indexOf(Earlier.userId) >= 0 && Ids.indexOf(Later.userId) >= 0);
    assert.ok(Ids.indexOf(Earlier.userId) < Ids.indexOf(Later.userId), "oldest scheduledFor first");
    assert.ok(Due.every((account) => (account.deletion?.scheduledFor ?? "") <= "2026-10-14T12:00:00.000Z"));
});

// [2026-10-15] Official play (MYSTICPARADOX_OFFICIAL_PLAY, config/officialPlay.ts) over HTTP: the status answer, and the refusal of a launch
// with no realm. A realm launch is not refused by the switch; the checks after it decide that launch.
const OFFICIAL_PLAY_MESSAGE = "The official server is currently unavailable. Join or host a realm.";

/** Sets the variables (undefined removes one) and returns the function that puts them back. */
function SetEnvironment(values: Record<string, string | undefined>): () => void {
    const saved = Object.keys(values).map((key) => [key, process.env[key]] as const);
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    return () => {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

test("GET /launcher/v1/status says whether official play is offered, with the message when it is not (2026-10-15)", async () => {
    const restore = SetEnvironment({ DEPLOYSERVER_URL: undefined, MYSTICPARADOX_OFFICIAL_PLAY: undefined });
    try {
        const Unset = await Call("GET", "/launcher/v1/status", undefined);
        assert.equal(Unset.status, 200, JSON.stringify(Unset.json));
        assert.deepEqual(Unset.json.officialPlay, { available: false, message: OFFICIAL_PLAY_MESSAGE }, "no DeployServer: off by default");
        assert.equal(typeof Unset.json.supportedBuildChangelist, "number", "the existing fields are still there");
        process.env.DEPLOYSERVER_URL = "deployserver.invalid:8080";
        const Configured = await Call("GET", "/launcher/v1/status", undefined);
        assert.deepEqual(Configured.json.officialPlay, { available: true }, "a DeployServer: on by default, and no message");
        process.env.MYSTICPARADOX_OFFICIAL_PLAY = "off";
        const Off = await Call("GET", "/launcher/v1/status", undefined);
        assert.deepEqual(Off.json.officialPlay, { available: false, message: OFFICIAL_PLAY_MESSAGE });
    } finally {
        restore();
    }
});

test("a launch with no realm is refused with 503 OFFICIAL_PLAY_UNAVAILABLE while official play is off; a realm launch is not refused by it (2026-10-15)", async () => {
    const restore = SetEnvironment({ DEPLOYSERVER_URL: undefined, MYSTICPARADOX_OFFICIAL_PLAY: undefined });
    try {
        const Account = await NewAccount();
        const Body = { buildChangelist: 647472, executableSha256: "a".repeat(64), runtimeChannel: "stable", runtimeManifestVersion: 1,
            runtimeArtifacts: [] };
        const Refused = await Call("POST", "/launcher/v1/game-sessions", Account.token, Body);
        ExpectError(Refused, 503, "OFFICIAL_PLAY_UNAVAILABLE");
        assert.equal(Refused.json.error.message, OFFICIAL_PLAY_MESSAGE);

        // The switch lets a realm launch through; the runtime and build checks after it refuse this fake one for their own reasons.
        const RealmLaunch = await Call("POST", "/launcher/v1/game-sessions", Account.token, { ...Body, realm: { realmId: "realm-x" } });
        assert.notEqual(RealmLaunch.json?.error?.code, "OFFICIAL_PLAY_UNAVAILABLE", JSON.stringify(RealmLaunch.json));

        // Turned on, an official launch is not refused by the switch either.
        process.env.MYSTICPARADOX_OFFICIAL_PLAY = "on";
        const Allowed = await Call("POST", "/launcher/v1/game-sessions", Account.token, Body);
        assert.notEqual(Allowed.json?.error?.code, "OFFICIAL_PLAY_UNAVAILABLE", JSON.stringify(Allowed.json));
    } finally {
        restore();
    }
});
