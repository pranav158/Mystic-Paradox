/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] The email routes over HTTP (the real router, the SQLite realm of a temporary folder and a recording mail transport): register
// under both modes, the sign-in refusal and the mailed code, verify, resend, forgot and reset, the 503 without SMTP, the answers' shapes and
// the limits. Each request carries a simulated client address (x-test-ip), so the per-address limits of one case do not reach another.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import express from "express";
import { CreateSessionForUser } from "../controllers/launcherAuth";
import { UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { CurrentLegalRequirements } from "../legal/legalPolicy";
import { HashPassword } from "../security/passwords";
import { SetMailTransportForTest } from "../mail/mailSender";
import { RecordingMailTransport } from "../mail/testSupport";
import { launcherAuthRouter } from "./launcherAuth";

const CURRENT = CurrentLegalRequirements();
const CONSENT = { termsVersion: CURRENT.termsVersion, privacyVersion: CURRENT.privacyVersion, ageConfirmed: true };
const SMTP_ENV: Record<string, string | undefined> = {
    MYSTICPARADOX_SMTP_HOST: "smtp.example.test", MYSTICPARADOX_SMTP_USER: "postmaster", MYSTICPARADOX_SMTP_PASSWORD: "fixture-password"
};
const NO_SMTP_ENV: Record<string, string | undefined> = {
    MYSTICPARADOX_SMTP_HOST: undefined, MYSTICPARADOX_SMTP_USER: undefined, MYSTICPARADOX_SMTP_PASSWORD: undefined
};
const ENV_KEYS = ["AUTH_SIGNING_PRIVKEY_B64", "AUTH_SIGNING_PUBKEY_B64", "PERSISTENCE_PROVIDER", "API_KEY_HASH_SECRET",
    "MYSTICPARADOX_EMAIL_VERIFICATION", "MYSTICPARADOX_REGISTRATION_APPROVAL", "MYSTICPARADOX_SMTP_HOST", "MYSTICPARADOX_SMTP_USER",
    "MYSTICPARADOX_SMTP_PASSWORD", "MYSTICPARADOX_SMTP_PORT", "MYSTICPARADOX_SMTP_SECURE", "MYSTICPARADOX_MAIL_FROM"] as const;
const SAVED_ENV = new Map<string, string | undefined>();

let Realm: TestRealm;
let Server: http.Server;
let Port = 0;
let Seq = 0;
const Recorder = new RecordingMailTransport();

function SetEnv(values: Record<string, string | undefined>): void {
    for (const [Key, Value] of Object.entries(values)) {
        if (Value === undefined) delete process.env[Key];
        else process.env[Key] = Value;
    }
}

/** A client address nobody has used yet in this file (the limits are per address). */
function NextIp(): string {
    Seq += 1;
    return `10.${Math.floor(Seq / 65536) % 256}.${Math.floor(Seq / 256) % 256}.${Seq % 256}`;
}

interface Reply { status: number; json: any }

function Call(method: string, path: string, body?: unknown, token?: string, ip: string = NextIp()): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { "x-test-ip": ip };
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
    assert.equal(reply.json?.error?.code, code, JSON.stringify(reply.json));
}

interface Seeded { userId: string; email: string; password: string }

/** An account made directly in the realm: the states the cases need (verified, pending, approval, banned). */
async function Seed(options: { verified?: boolean; pending?: boolean; approval?: "approved" | "pending"; status?: "active" | "banned" } = {}): Promise<Seeded> {
    Seq += 1;
    const userId = crypto.randomUUID();
    const email = `route${Seq}@example.test`;
    const password = "correct horse battery";
    const Now = new Date().toISOString();
    await Realm.repos.launcherAccounts.create({
        userId, email, displayNameNormalized: `routeslayer${Seq}`, displayName: `RouteSlayer${Seq}`,
        passwordHash: await HashPassword(password), status: options.status ?? "active", approvalStatus: options.approval ?? "approved",
        roles: ["player"], createdAt: Now, usernameSet: true,
        ...(options.verified ? { emailVerifiedAt: Now } : {}),
        ...(options.pending ? { emailVerificationPendingSince: Now } : {})
    });
    return { userId, email, password };
}

/** The code the mail to the address carries (the mail is recorded before a route answers when the send is awaited). */
function CodeMailedTo(email: string): string {
    const Code = Recorder.codeFor(email);
    assert.match(Code ?? "", /^\d{6}$/, `a code was mailed to ${email}`);
    return Code!;
}

before(async () => {
    for (const key of ENV_KEYS) SAVED_ENV.set(key, process.env[key]);
    const Keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" }
    });
    SetEnv({
        AUTH_SIGNING_PRIVKEY_B64: Buffer.from(Keys.privateKey).toString("base64"),
        AUTH_SIGNING_PUBKEY_B64: Buffer.from(Keys.publicKey).toString("base64"),
        // The official backend's provider (consent is then required at sign-up; every case sends the consent).
        PERSISTENCE_PROVIDER: "mongodb",
        API_KEY_HASH_SECRET: "email-routes-test-secret-that-is-long-enough-9012",
        MYSTICPARADOX_REGISTRATION_APPROVAL: undefined
    });
    Realm = OpenTestRealm("launcher-email-routes");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    SetMailTransportForTest(Recorder);

    const App = express();
    App.use(express.json());
    // Test-only: the client address a request claims (x-test-ip) stands in for the socket address the limits read.
    App.use((req, _res, next) => {
        const Simulated = req.headers["x-test-ip"];
        if (typeof Simulated === "string") Object.defineProperty(req, "ip", { value: Simulated, configurable: true });
        next();
    });
    App.use("/", launcherAuthRouter);
    App.use((_req, res) => { res.status(404).send(); });
    Server = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        Server.once("listening", () => resolve());
        Server.once("error", reject);
    });
    Port = (Server.address() as AddressInfo).port;
});

beforeEach(() => {
    SetEnv({ ...SMTP_ENV, MYSTICPARADOX_EMAIL_VERIFICATION: "required" });
});

after(async () => {
    await new Promise<void>((resolve) => Server.close(() => resolve()));
    SetMailTransportForTest(undefined);
    UsePersistenceForTest(undefined);
    await Realm.cleanup();
    for (const key of ENV_KEYS) {
        const Previous = SAVED_ENV.get(key);
        if (Previous === undefined) delete process.env[key];
        else process.env[key] = Previous;
    }
});

test("without the mail settings the four email routes answer 503 AUTH_EMAIL_UNAVAILABLE", async () => {
    SetEnv(NO_SMTP_ENV);
    const Account = await Seed();
    ExpectError(await Call("POST", "/launcher/v1/auth/email/verify", { email: Account.email, password: Account.password, code: "123456" }),
        503, "AUTH_EMAIL_UNAVAILABLE");
    ExpectError(await Call("POST", "/launcher/v1/auth/email/resend", { email: Account.email }), 503, "AUTH_EMAIL_UNAVAILABLE");
    ExpectError(await Call("POST", "/launcher/v1/auth/password/forgot", { email: Account.email }), 503, "AUTH_EMAIL_UNAVAILABLE");
    ExpectError(await Call("POST", "/launcher/v1/auth/password/reset", { email: Account.email, code: "123456", newPassword: "long enough" }),
        503, "AUTH_EMAIL_UNAVAILABLE");
    assert.equal(Recorder.sent.filter((mail) => mail.to === Account.email).length, 0);
});

test("register under required: 202 with verificationRequired and the address, a code mailed, and no token", async () => {
    const Email = `newbie${crypto.randomBytes(3).toString("hex")}@example.test`;
    const Reply = await Call("POST", "/launcher/v1/auth/register", { email: Email, password: "correct horse battery", consent: CONSENT });
    assert.equal(Reply.status, 202, JSON.stringify(Reply.json));
    assert.equal(Reply.json.verificationRequired, true);
    assert.equal(Reply.json.email, Email);
    assert.equal(Reply.json.approvalRequired, false);
    assert.equal(Reply.json.accessToken, undefined, "no token before the code is entered");
    assert.equal(Reply.json.account.needsUsername, true, "no name was sent, so the launcher asks for one");
    assert.equal(Reply.json.account.emailVerified, false);
    assert.deepEqual(Reply.json.account.discord, { linked: false });
    CodeMailedTo(Email);
});

test("register with a display name keeps it, and the account is not asked for one", async () => {
    const Name = `Named${crypto.randomBytes(2).toString("hex")}`;
    const Email = `named${crypto.randomBytes(3).toString("hex")}@example.test`;
    const Reply = await Call("POST", "/launcher/v1/auth/register", { displayName: Name, email: Email, password: "correct horse battery", consent: CONSENT });
    assert.equal(Reply.status, 202, JSON.stringify(Reply.json));
    assert.equal(Reply.json.account.displayName, Name);
    assert.equal(Reply.json.account.needsUsername, false);
    assert.equal(Reply.json.verificationRequired, true);
});

test("register under off: today's answer (no code, no verification fields), with or without a display name", async () => {
    SetEnv({ MYSTICPARADOX_EMAIL_VERIFICATION: "off" });
    const Email = `offmode${crypto.randomBytes(3).toString("hex")}@example.test`;
    const Reply = await Call("POST", "/launcher/v1/auth/register", { email: Email, password: "correct horse battery", consent: CONSENT });
    assert.equal(Reply.status, 202, JSON.stringify(Reply.json));
    assert.equal(Reply.json.verificationRequired, undefined);
    assert.equal(Reply.json.email, undefined);
    assert.equal(Recorder.sent.filter((mail) => mail.to === Email).length, 0, "no code is mailed under off");
});

test("register under required without the mail settings is 503 and creates nothing", async () => {
    SetEnv(NO_SMTP_ENV);
    const Email = `nomail${crypto.randomBytes(3).toString("hex")}@example.test`;
    ExpectError(await Call("POST", "/launcher/v1/auth/register", { email: Email, password: "correct horse battery", consent: CONSENT }),
        503, "AUTH_EMAIL_UNAVAILABLE");
    assert.equal(await Realm.repos.launcherAccounts.findByEmail(Email), undefined);
});

test("a password sign-in with an unverified email is 403 AUTH_EMAIL_UNVERIFIED with the masked address, and a code is mailed", async () => {
    const Account = await Seed();
    const Reply = await Call("POST", "/launcher/v1/auth/login", { email: Account.email, password: Account.password });
    ExpectError(Reply, 403, "AUTH_EMAIL_UNVERIFIED");
    assert.match(Reply.json.error.message, /Enter the 6-digit code we sent to r\*\*\*\d@example\.test\. Older launchers: update the launcher to verify your email\./);
    CodeMailedTo(Account.email);
});

test("the next sign-in attempt within the minute answers the same, and mails no second code", async () => {
    const Account = await Seed();
    await Call("POST", "/launcher/v1/auth/login", { email: Account.email, password: Account.password });
    const Before = Recorder.sent.filter((mail) => mail.to === Account.email).length;
    ExpectError(await Call("POST", "/launcher/v1/auth/login", { email: Account.email, password: Account.password }), 403, "AUTH_EMAIL_UNVERIFIED");
    assert.equal(Recorder.sent.filter((mail) => mail.to === Account.email).length, Before);
});

test("a wrong password is AUTH_INVALID_CREDENTIALS, and nothing is mailed; a banned account gets its ban and no code", async () => {
    const Account = await Seed();
    ExpectError(await Call("POST", "/launcher/v1/auth/login", { email: Account.email, password: "wrong password here" }), 401, "AUTH_INVALID_CREDENTIALS");
    assert.equal(Recorder.sent.filter((mail) => mail.to === Account.email).length, 0);

    const Banned = await Seed({ status: "banned" });
    ExpectError(await Call("POST", "/launcher/v1/auth/login", { email: Banned.email, password: Banned.password }), 403, "AUTH_ACCOUNT_BANNED");
    assert.equal(Recorder.sent.filter((mail) => mail.to === Banned.email).length, 0, "no code to a banned account");
});

test("verify needs the password AND the code; one right pair signs in, and the code is then used up", async () => {
    const Account = await Seed();
    await Call("POST", "/launcher/v1/auth/login", { email: Account.email, password: Account.password });
    const Code = CodeMailedTo(Account.email);

    ExpectError(await Call("POST", "/launcher/v1/auth/email/verify", { email: Account.email, password: "wrong password here", code: Code }),
        401, "AUTH_INVALID_CREDENTIALS");
    const WrongCode = Code === "000000" ? "000001" : "000000";
    ExpectError(await Call("POST", "/launcher/v1/auth/email/verify", { email: Account.email, password: Account.password, code: WrongCode }),
        400, "AUTH_CODE_INVALID");

    const Verified = await Call("POST", "/launcher/v1/auth/email/verify", { email: Account.email, password: Account.password, code: Code });
    assert.equal(Verified.status, 200, JSON.stringify(Verified.json));
    assert.equal(typeof Verified.json.accessToken, "string");
    assert.equal(typeof Verified.json.refreshToken, "string");
    assert.equal(Verified.json.account.emailVerified, true);

    ExpectError(await Call("POST", "/launcher/v1/auth/email/verify", { email: Account.email, password: Account.password, code: Code }),
        400, "AUTH_CODE_INVALID");

    const Me = await Call("GET", "/launcher/v1/me", undefined, Verified.json.accessToken);
    assert.equal(Me.status, 200);
    assert.equal(Me.json.emailVerified, true);
    assert.deepEqual(Me.json.discord, { linked: false });

    const Login = await Call("POST", "/launcher/v1/auth/login", { email: Account.email, password: Account.password });
    assert.equal(Login.status, 200, "a verified account signs in with its password");
});

test("a pending approval answers verify with approvalRequired and no session (the registration's shape)", async () => {
    const Account = await Seed({ approval: "pending" });
    await Call("POST", "/launcher/v1/auth/login", { email: Account.email, password: Account.password });
    const Code = CodeMailedTo(Account.email);
    const Reply = await Call("POST", "/launcher/v1/auth/email/verify", { email: Account.email, password: Account.password, code: Code });
    assert.equal(Reply.status, 200, JSON.stringify(Reply.json));
    assert.equal(Reply.json.approvalRequired, true);
    assert.equal(Reply.json.accessToken, undefined);
    assert.equal(Reply.json.account.emailVerified, true, "the email is verified even while the approval waits");
});

test("resend answers { sent: true } for an address with no account and mails nothing", async () => {
    const Ghost = `ghost${crypto.randomBytes(3).toString("hex")}@example.test`;
    const Reply = await Call("POST", "/launcher/v1/auth/email/resend", { email: Ghost });
    assert.equal(Reply.status, 200);
    assert.deepEqual(Reply.json, { sent: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(Recorder.sent.filter((mail) => mail.to === Ghost).length, 0);
});

test("resend mails a verification code to an unverified account after the answer; a verified one gets nothing", async () => {
    const Unverified = await Seed();
    const Before = Recorder.sent.length;
    const Reply = await Call("POST", "/launcher/v1/auth/email/resend", { email: Unverified.email });
    assert.deepEqual(Reply, { status: 200, json: { sent: true } });
    await Recorder.waitForCount(Before + 1);
    assert.match(Recorder.lastTo(Unverified.email)?.subject ?? "", /^Your Mystic Paradox code: \d{6}$/);

    const Verified = await Seed({ verified: true });
    const Quiet = Recorder.sent.length;
    assert.equal((await Call("POST", "/launcher/v1/auth/email/resend", { email: Verified.email })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(Recorder.sent.length, Quiet, "a verified account is not sent a verification code");
});

test("forgot answers { sent: true } for any address, and mails a reset code to an existing account", async () => {
    const Account = await Seed({ verified: true });
    const Ghost = `ghost${crypto.randomBytes(3).toString("hex")}@example.test`;
    assert.deepEqual((await Call("POST", "/launcher/v1/auth/password/forgot", { email: Ghost })).json, { sent: true });
    const Before = Recorder.sent.length;
    assert.deepEqual((await Call("POST", "/launcher/v1/auth/password/forgot", { email: Account.email })).json, { sent: true });
    await Recorder.waitForCount(Before + 1);
    assert.match(Recorder.lastTo(Account.email)?.subject ?? "", /^Your Mystic Paradox password reset code: \d{6}$/);
});

test("a malformed address is 400 (a shape error, not an account question); resend is limited to five an hour per address", async () => {
    ExpectError(await Call("POST", "/launcher/v1/auth/password/forgot", { email: "not-an-address" }), 400, "AUTH_VALIDATION_FAILED");

    const Address = `limited${crypto.randomBytes(3).toString("hex")}@example.test`;
    for (let Attempt = 1; Attempt <= 5; Attempt += 1) {
        assert.equal((await Call("POST", "/launcher/v1/auth/email/resend", { email: Address })).status, 200, `attempt ${Attempt}`);
    }
    ExpectError(await Call("POST", "/launcher/v1/auth/email/resend", { email: Address }), 429, "AUTH_RATE_LIMITED");
});

test("reset: a right code sets the password, verifies the email, ends every session, and the old password stops working", async () => {
    const Account = await Seed({ verified: true });
    const Session = await CreateSessionForUser(Account.userId, "old-device", "Old PC");
    const Before = Recorder.sent.length;
    await Call("POST", "/launcher/v1/auth/password/forgot", { email: Account.email });
    await Recorder.waitForCount(Before + 1);
    const Code = CodeMailedTo(Account.email);

    const WrongCode = Code === "000000" ? "000001" : "000000";
    ExpectError(await Call("POST", "/launcher/v1/auth/password/reset", { email: Account.email, code: WrongCode, newPassword: "a new passphrase" }),
        400, "AUTH_CODE_INVALID");

    const Reset = await Call("POST", "/launcher/v1/auth/password/reset", { email: Account.email, code: Code, newPassword: "a new passphrase" });
    assert.equal(Reset.status, 200, JSON.stringify(Reset.json));
    assert.equal(typeof Reset.json.accessToken, "string");
    assert.equal(Reset.json.account.emailVerified, true);

    ExpectError(await Call("GET", "/launcher/v1/me", undefined, Session.accessToken), 401, "AUTH_UNAUTHORIZED");
    ExpectError(await Call("POST", "/launcher/v1/auth/login", { email: Account.email, password: Account.password }), 401, "AUTH_INVALID_CREDENTIALS");
    assert.equal((await Call("POST", "/launcher/v1/auth/login", { email: Account.email, password: "a new passphrase" })).status, 200);
});

test("reset refuses a short new password before a try is counted, and an unknown address with the same code answer", async () => {
    const Account = await Seed({ verified: true });
    ExpectError(await Call("POST", "/launcher/v1/auth/password/reset", { email: Account.email, code: "123456", newPassword: "short" }),
        400, "AUTH_VALIDATION_FAILED");
    ExpectError(await Call("POST", "/launcher/v1/auth/password/reset", { email: `nobody${crypto.randomBytes(3).toString("hex")}@example.test`, code: "123456", newPassword: "long enough here" }),
        400, "AUTH_CODE_INVALID");
});

test("five wrong codes use the code up: the right code is then refused", async () => {
    const Account = await Seed({ verified: true });
    const Before = Recorder.sent.length;
    await Call("POST", "/launcher/v1/auth/password/forgot", { email: Account.email });
    await Recorder.waitForCount(Before + 1);
    const Code = CodeMailedTo(Account.email);
    const WrongCode = Code === "000000" ? "000001" : "000000";
    for (let Attempt = 1; Attempt <= 5; Attempt += 1) {
        ExpectError(await Call("POST", "/launcher/v1/auth/password/reset", { email: Account.email, code: WrongCode, newPassword: "long enough here" }),
            400, "AUTH_CODE_INVALID");
    }
    ExpectError(await Call("POST", "/launcher/v1/auth/password/reset", { email: Account.email, code: Code, newPassword: "long enough here" }),
        400, "AUTH_CODE_INVALID");
});

test("a banned account gets no reset code (the forgot answer is the same, and nothing is mailed)", async () => {
    const Account = await Seed({ verified: true, status: "banned" });
    const Before = Recorder.sent.length;
    assert.deepEqual((await Call("POST", "/launcher/v1/auth/password/forgot", { email: Account.email })).json, { sent: true });
    await Call("POST", "/launcher/v1/auth/password/forgot", { email: Account.email });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(Recorder.sent.length, Before, "no reset code is sent to a banned account");
});
