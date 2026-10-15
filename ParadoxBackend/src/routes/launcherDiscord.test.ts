/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] Discord over HTTP: sign-in never creates an account (an unlinked Discord user is refused), and an account is linked from
// Settings through the same OAuth (link/done or link/error). Unlinking needs a code mailed to the account's address (unlink/start mails it,
// unlink checks it); a Discord-only account, or one without an address, cannot unlink. Discord's token and user endpoints are answered by a
// stub; the code 'code-<id>' is the Discord user <id>. The realm is SQLite, the router the real one, the mail a recording transport.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import express from "express";
import { CreateSessionForUser } from "../controllers/launcherAuth";
import { UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { HashPassword } from "../security/passwords";
import { EmailCodeHash, MaskEmail } from "../security/emailCodes";
import { SetMailTransportForTest } from "../mail/mailSender";
import { RecordingMailTransport } from "../mail/testSupport";
import { launcherAuthRouter } from "./launcherAuth";

const ENV_KEYS = ["AUTH_SIGNING_PRIVKEY_B64", "AUTH_SIGNING_PUBKEY_B64", "PERSISTENCE_PROVIDER", "API_KEY_HASH_SECRET",
    "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI", "MYSTICPARADOX_EMAIL_VERIFICATION", "LAUNCHER_DEEPLINK_SCHEME",
    "MYSTICPARADOX_SMTP_HOST", "MYSTICPARADOX_SMTP_USER", "MYSTICPARADOX_SMTP_PASSWORD", "MYSTICPARADOX_SMTP_PORT",
    "MYSTICPARADOX_SMTP_SECURE", "MYSTICPARADOX_MAIL_FROM"] as const;
const SAVED_ENV = new Map<string, string | undefined>();
const SAVED_FETCH = globalThis.fetch;
const SMTP_ENV: Record<string, string | undefined> = {
    MYSTICPARADOX_SMTP_HOST: "smtp.example.test", MYSTICPARADOX_SMTP_USER: "postmaster", MYSTICPARADOX_SMTP_PASSWORD: "fixture-password"
};
const NO_SMTP_ENV: Record<string, string | undefined> = {
    MYSTICPARADOX_SMTP_HOST: undefined, MYSTICPARADOX_SMTP_USER: undefined, MYSTICPARADOX_SMTP_PASSWORD: undefined
};
const Recorder = new RecordingMailTransport();

let Realm: TestRealm;
let Server: http.Server;
let Port = 0;
let Seq = 0;

function SetEnv(values: Record<string, string | undefined>): void {
    for (const [Key, Value] of Object.entries(values)) {
        if (Value === undefined) delete process.env[Key];
        else process.env[Key] = Value;
    }
}

/** A Discord user id per link: the identifiers the stub answers for. */
function DiscordId(n: number): string {
    return `90000000000000${String(n).padStart(4, "0")}`;
}

function StubFetch(input: unknown, init?: RequestInit): Promise<Response> {
    const Url = String(input);
    const Json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (Url === "https://discord.com/api/oauth2/token") {
        const Form = new URLSearchParams(String(init?.body ?? ""));
        const Code = Form.get("code") ?? "";
        if (!Code.startsWith("code-")) return Promise.resolve(Json({ error: "invalid_grant" }, 400));
        return Promise.resolve(Json({ access_token: `tok-${Code.slice("code-".length)}`, token_type: "Bearer" }));
    }
    if (Url === "https://discord.com/api/users/@me") {
        const Auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
        const Id = Auth.replace(/^Bearer tok-/, "");
        return Promise.resolve(Json({ id: Id, username: `user-${Id.slice(-4)}`, global_name: null, avatar: null }));
    }
    return Promise.reject(new Error(`unexpected fetch in the test: ${Url}`));
}

interface Reply { status: number; json: any; location?: string }

function Call(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
        Seq += 1;
        const headers: Record<string, string> = { "x-test-ip": `10.9.${Math.floor(Seq / 256) % 256}.${Seq % 256}` };
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
                resolve({ status: res.statusCode ?? 0, json, location: res.headers.location });
            });
        });
        request.on("error", reject);
        request.setTimeout(5000, () => request.destroy(new Error(`no answer: ${method} ${path}`)));
        if (payload !== undefined) request.write(payload);
        request.end();
    });
}

interface Account { userId: string; token: string; email?: string }

/** An account made in the realm. A Discord-only account has no password; `email: false` makes one without an address. */
async function Seed(options: { password?: boolean; email?: boolean } = {}): Promise<Account> {
    Seq += 1;
    const userId = crypto.randomUUID();
    const Now = new Date().toISOString();
    const WithPassword = options.password !== false;
    const Email = (options.email ?? WithPassword) ? `discord${Seq}@example.test` : undefined;
    await Realm.repos.launcherAccounts.create({
        userId, email: Email,
        displayNameNormalized: `discordslayer${Seq}`, displayName: `DiscordSlayer${Seq}`,
        ...(WithPassword ? { passwordHash: await HashPassword("correct horse battery") } : {}),
        status: "active", approvalStatus: "approved", roles: ["player"], createdAt: Now, usernameSet: true
    });
    const Session = await CreateSessionForUser(userId, "discord-device", "Discord PC");
    return { userId, token: Session.accessToken, email: Email };
}

/** Links a Discord user to the account through the Settings flow (the start, then the callback). */
async function LinkDiscord(account: Account, n: number): Promise<void> {
    const Start = await Call("POST", "/launcher/v1/account/discord/link/start", {}, account.token);
    const Callback = await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(n)}&state=${StateOf(Start.json.authorizeUrl)}`);
    assert.equal(Callback.location, "mysticparadox://link/done");
}

/** The 6-digit code the unlink mail to the account carries (the mail is awaited by the start route, so it is recorded by now). */
function UnlinkCodeMailedTo(email: string): string {
    const Code = Recorder.codeFor(email);
    assert.match(Code ?? "", /^\d{6}$/, `an unlink code was mailed to ${email}`);
    return Code!;
}

function WrongCodeFor(code: string): string {
    return code === "000000" ? "000001" : "000000";
}

async function Linked(account: Account): Promise<boolean> {
    return (await Call("GET", "/launcher/v1/me", undefined, account.token)).json.discord.linked === true;
}

/** The state of the authorize URL a start answered (the callback must carry it back). */
function StateOf(authorizeUrl: string): string {
    const State = new URL(authorizeUrl).searchParams.get("state");
    assert.match(State ?? "", /^[0-9a-f]{48}$/);
    return State!;
}

async function AccountCount(): Promise<number> {
    return Realm.db.read(undefined, (c) => Number(c.get("SELECT COUNT(*) AS n FROM accounts")?.n ?? 0));
}

before(async () => {
    for (const key of ENV_KEYS) SAVED_ENV.set(key, process.env[key]);
    const Keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" }
    });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey).toString("base64");
    process.env.PERSISTENCE_PROVIDER = "mongodb";
    process.env.API_KEY_HASH_SECRET = "discord-route-test-secret-that-is-long-enough-7788";
    process.env.DISCORD_CLIENT_ID = "1111";
    process.env.DISCORD_CLIENT_SECRET = "discord-client-secret-fixture";
    process.env.DISCORD_REDIRECT_URI = "https://paradox.example.test/launcher/v1/auth/discord/callback";
    delete process.env.LAUNCHER_DEEPLINK_SCHEME;
    delete process.env.MYSTICPARADOX_EMAIL_VERIFICATION;
    globalThis.fetch = StubFetch as typeof fetch;

    Realm = OpenTestRealm("launcher-discord-routes");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    SetMailTransportForTest(Recorder);

    const App = express();
    App.use(express.json());
    // Test-only: the client address a request claims (x-test-ip) stands in for the socket address the per-address limits read.
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
    SetEnv(SMTP_ENV);
});

after(async () => {
    await new Promise<void>((resolve) => Server.close(() => resolve()));
    globalThis.fetch = SAVED_FETCH;
    SetMailTransportForTest(undefined);
    UsePersistenceForTest(undefined);
    await Realm.cleanup();
    for (const key of ENV_KEYS) {
        const Previous = SAVED_ENV.get(key);
        if (Previous === undefined) delete process.env[key];
        else process.env[key] = Previous;
    }
});

test("linking needs a sign-in; the link start answers the Discord authorize URL with the account's state", async () => {
    const Account = await Seed();
    const Anonymous = await Call("POST", "/launcher/v1/account/discord/link/start");
    assert.equal(Anonymous.status, 401);
    const Start = await Call("POST", "/launcher/v1/account/discord/link/start", {}, Account.token);
    assert.equal(Start.status, 200, JSON.stringify(Start.json));
    assert.match(Start.json.authorizeUrl, /^https:\/\/discord\.com\/api\/oauth2\/authorize\?/);
    assert.equal(new URL(Start.json.authorizeUrl).searchParams.get("client_id"), "1111");
    StateOf(Start.json.authorizeUrl);
});

test("the callback links the Discord user to the signed-in account, answers link/done, and Me shows the link", async () => {
    const Account = await Seed();
    const Start = await Call("POST", "/launcher/v1/account/discord/link/start", {}, Account.token);
    const State = StateOf(Start.json.authorizeUrl);
    const Callback = await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(1)}&state=${State}`);
    assert.equal(Callback.status, 302);
    assert.equal(Callback.location, "mysticparadox://link/done");

    const Me = await Call("GET", "/launcher/v1/me", undefined, Account.token);
    assert.deepEqual(Me.json.discord, { linked: true, username: `user-${DiscordId(1).slice(-4)}` });
    assert.equal(Me.json.discordLinked, true, "the older flag still answers");
});

test("an account that already has a Discord link cannot start another (409), and the state is single-use", async () => {
    const Account = await Seed();
    const First = await Call("POST", "/launcher/v1/account/discord/link/start", {}, Account.token);
    const State = StateOf(First.json.authorizeUrl);
    assert.equal((await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(2)}&state=${State}`)).location,
        "mysticparadox://link/done");

    const Again = await Call("POST", "/launcher/v1/account/discord/link/start", {}, Account.token);
    assert.equal(Again.status, 409);
    assert.equal(Again.json.error.code, "AUTH_DISCORD_ACCOUNT_HAS_LINK");

    const Replay = await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(3)}&state=${State}`);
    assert.equal(Replay.location, "mysticparadox://auth/error?code=AUTH_DISCORD_CANCELLED", "a used state cannot link again");
});

test("a Discord user linked to another account is refused at the callback: link/error AUTH_DISCORD_ALREADY_LINKED", async () => {
    const Owner = await Seed();
    const Start = await Call("POST", "/launcher/v1/account/discord/link/start", {}, Owner.token);
    await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(4)}&state=${StateOf(Start.json.authorizeUrl)}`);

    const Other = await Seed();
    const Second = await Call("POST", "/launcher/v1/account/discord/link/start", {}, Other.token);
    const Callback = await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(4)}&state=${StateOf(Second.json.authorizeUrl)}`);
    assert.equal(Callback.location, "mysticparadox://link/error?code=AUTH_DISCORD_ALREADY_LINKED");
    assert.equal((await Call("GET", "/launcher/v1/me", undefined, Other.token)).json.discord.linked, false);
});

test("an account that gained a link while its link was pending is refused at the callback: AUTH_DISCORD_ACCOUNT_HAS_LINK", async () => {
    const Account = await Seed();
    const Start = await Call("POST", "/launcher/v1/account/discord/link/start", {}, Account.token);
    await Realm.repos.authIdentities.create({
        provider: "discord", providerSubject: DiscordId(5), userId: Account.userId, providerUsername: "earlier", linkedAt: new Date().toISOString()
    });
    const Callback = await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(6)}&state=${StateOf(Start.json.authorizeUrl)}`);
    assert.equal(Callback.location, "mysticparadox://link/error?code=AUTH_DISCORD_ACCOUNT_HAS_LINK");
});

test("sign-in with an unlinked Discord user is refused (auth/error AUTH_DISCORD_NOT_LINKED) and creates no account", async () => {
    const Before = await AccountCount();
    const Start = await Call("POST", "/launcher/v1/auth/discord/start");
    const Callback = await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(7)}&state=${StateOf(Start.json.authorizeUrl)}`);
    assert.equal(Callback.location, "mysticparadox://auth/error?code=AUTH_DISCORD_NOT_LINKED");
    assert.equal(await AccountCount(), Before, "no account was created");
});

test("sign-in with a linked Discord user completes: auth/complete, then the completion code gives a session", async () => {
    const Account = await Seed();
    const Link = await Call("POST", "/launcher/v1/account/discord/link/start", {}, Account.token);
    await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(8)}&state=${StateOf(Link.json.authorizeUrl)}`);

    const Start = await Call("POST", "/launcher/v1/auth/discord/start");
    const Callback = await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(8)}&state=${StateOf(Start.json.authorizeUrl)}`);
    assert.match(Callback.location ?? "", /^mysticparadox:\/\/auth\/complete\?code=[0-9a-f]{64}$/);
    const CompletionCode = new URL(Callback.location!).searchParams.get("code");
    const Complete = await Call("POST", "/launcher/v1/auth/discord/complete", { code: CompletionCode });
    assert.equal(Complete.status, 200, JSON.stringify(Complete.json));
    assert.equal(Complete.json.account.userId, Account.userId);
    assert.equal(typeof Complete.json.accessToken, "string");
});

function ExpectRefusal(reply: { status: number; json: any }, status: number, code: string): void {
    assert.equal(reply.status, status, JSON.stringify(reply.json));
    assert.equal(reply.json?.error?.code, code, JSON.stringify(reply.json));
}

const UNLINK_START = "/launcher/v1/account/discord/unlink/start";
const UNLINK = "/launcher/v1/account/discord/unlink";

test("the unlink routes need a sign-in, and the old one-click DELETE answers 404 (the link stays)", async () => {
    const Account = await Seed();
    await LinkDiscord(Account, 20);
    assert.equal((await Call("POST", UNLINK_START, {})).status, 401);
    assert.equal((await Call("POST", UNLINK, { code: "123456" })).status, 401);
    assert.equal((await Call("DELETE", "/launcher/v1/account/discord", undefined, Account.token)).status, 404);
    assert.equal(await Linked(Account), true, "the link stays");
});

test("unlink/start mails one unlink code, answers the masked address, and unlinks nothing; a second start in the minute mails nothing", async () => {
    const Account = await Seed();
    await LinkDiscord(Account, 21);
    const Before = Recorder.sent.length;

    const Start = await Call("POST", UNLINK_START, {}, Account.token);
    assert.equal(Start.status, 200, JSON.stringify(Start.json));
    assert.deepEqual(Start.json, { sent: true, email: MaskEmail(Account.email!) });
    assert.equal(Recorder.sent.length, Before + 1, "one mail");
    const Mail = Recorder.lastTo(Account.email!)!;
    assert.match(Mail.subject, /^Your Mystic Paradox code to unlink Discord: \d{6}$/);
    assert.equal(Mail.subject, `Your Mystic Paradox code to unlink Discord: ${UnlinkCodeMailedTo(Account.email!)}`);
    assert.equal(await Linked(Account), true, "a start unlinks nothing");

    const Again = await Call("POST", UNLINK_START, {}, Account.token);
    assert.equal(Again.status, 200, JSON.stringify(Again.json));
    assert.deepEqual(Again.json, { sent: true, email: MaskEmail(Account.email!) }, "the answer is the same when a send limit held the mail back");
    assert.equal(Recorder.sent.length, Before + 1, "the second start within the minute mails no second code");
});

test("a wrong code is refused and the link stays; the right code unlinks (account discord.linked false); a used code is refused", async () => {
    const Account = await Seed();
    await LinkDiscord(Account, 22);
    assert.equal((await Call("POST", UNLINK_START, {}, Account.token)).status, 200);
    const Code = UnlinkCodeMailedTo(Account.email!);

    ExpectRefusal(await Call("POST", UNLINK, { code: WrongCodeFor(Code) }, Account.token), 400, "AUTH_CODE_INVALID");
    assert.equal(await Linked(Account), true, "a wrong code keeps the link");

    const Right = await Call("POST", UNLINK, { code: Code }, Account.token);
    assert.equal(Right.status, 200, JSON.stringify(Right.json));
    assert.deepEqual(Right.json.account.discord, { linked: false });
    assert.equal(await Linked(Account), false);

    // The code was used up by that unlink. Linking again gives the same code no second use.
    await LinkDiscord(Account, 23);
    ExpectRefusal(await Call("POST", UNLINK, { code: Code }, Account.token), 400, "AUTH_CODE_INVALID");
    assert.equal(await Linked(Account), true, "a used code unlinks nothing");
});

test("an expired code is refused (400 AUTH_CODE_INVALID) and the link stays", async () => {
    const Account = await Seed();
    await LinkDiscord(Account, 24);
    assert.equal((await Call("POST", UNLINK_START, {}, Account.token)).status, 200);
    const Code = UnlinkCodeMailedTo(Account.email!);

    // The live code is made as if issued ten minutes ago (the time to live is five): the same row the start stored, past its expiry.
    const Past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await Realm.repos.emailCodes.replace({
        userId: Account.userId, purpose: "unlink", codeHash: EmailCodeHash(Account.userId, "unlink", Code),
        attempts: 0, createdAt: Past, expiresAt: Past
    });

    ExpectRefusal(await Call("POST", UNLINK, { code: Code }, Account.token), 400, "AUTH_CODE_INVALID");
    assert.equal(await Linked(Account), true, "an expired code keeps the link");
});

test("unlink needs a Discord link: without one both steps answer 403 AUTH_DISCORD_NOT_LINKED, and nothing is mailed", async () => {
    const Account = await Seed();
    const Before = Recorder.sent.length;
    ExpectRefusal(await Call("POST", UNLINK_START, {}, Account.token), 403, "AUTH_DISCORD_NOT_LINKED");
    ExpectRefusal(await Call("POST", UNLINK, { code: "123456" }, Account.token), 403, "AUTH_DISCORD_NOT_LINKED");
    assert.equal(Recorder.sent.length, Before, "no code is mailed");
});

test("a Discord-only account (no password) cannot unlink: both steps answer 409 AUTH_DISCORD_ONLY_LOGIN, the link stays, nothing is mailed", async () => {
    const DiscordOnly = await Seed({ password: false });
    await Realm.repos.authIdentities.create({
        provider: "discord", providerSubject: DiscordId(25), userId: DiscordOnly.userId, providerUsername: "only", linkedAt: new Date().toISOString()
    });
    const Before = Recorder.sent.length;
    ExpectRefusal(await Call("POST", UNLINK_START, {}, DiscordOnly.token), 409, "AUTH_DISCORD_ONLY_LOGIN");
    ExpectRefusal(await Call("POST", UNLINK, { code: "123456" }, DiscordOnly.token), 409, "AUTH_DISCORD_ONLY_LOGIN");
    assert.equal(await Linked(DiscordOnly), true, "the link stays");
    assert.equal(Recorder.sent.length, Before, "no code is mailed");
});

test("an account with a password but no email address cannot unlink: both steps answer 409 AUTH_DISCORD_ONLY_LOGIN", async () => {
    const NoAddress = await Seed({ email: false });
    await Realm.repos.authIdentities.create({
        provider: "discord", providerSubject: DiscordId(26), userId: NoAddress.userId, providerUsername: "noaddr", linkedAt: new Date().toISOString()
    });
    ExpectRefusal(await Call("POST", UNLINK_START, {}, NoAddress.token), 409, "AUTH_DISCORD_ONLY_LOGIN");
    ExpectRefusal(await Call("POST", UNLINK, { code: "123456" }, NoAddress.token), 409, "AUTH_DISCORD_ONLY_LOGIN");
    assert.equal(await Linked(NoAddress), true, "the link stays");
});

test("without the mail settings both unlink steps answer 503 AUTH_EMAIL_UNAVAILABLE, and the link stays", async () => {
    const Account = await Seed();
    await LinkDiscord(Account, 27);
    SetEnv(NO_SMTP_ENV);
    const Before = Recorder.sent.length;
    ExpectRefusal(await Call("POST", UNLINK_START, {}, Account.token), 503, "AUTH_EMAIL_UNAVAILABLE");
    ExpectRefusal(await Call("POST", UNLINK, { code: "123456" }, Account.token), 503, "AUTH_EMAIL_UNAVAILABLE");
    assert.equal(Recorder.sent.length, Before, "no code is mailed");
    assert.equal(await Linked(Account), true, "the link stays");
});

// [2026-10-15] The player is signed in, so a mail that could not be sent is said (503), not answered "sent" with no mail coming.
test("a code mail that cannot be sent makes unlink/start answer 503 AUTH_EMAIL_UNAVAILABLE, and the link stays", async () => {
    const Account = await Seed();
    await LinkDiscord(Account, 29);
    SetMailTransportForTest({ send: async () => { throw Object.assign(new Error("connection refused"), { code: "ECONNECTION" }); } });
    try {
        ExpectRefusal(await Call("POST", UNLINK_START, {}, Account.token), 503, "AUTH_EMAIL_UNAVAILABLE");
    } finally {
        SetMailTransportForTest(Recorder);
    }
    assert.equal(await Linked(Account), true, "the link stays");
});

test("unlink/start is limited to five an hour per account: the sixth answers 429 AUTH_RATE_LIMITED", async () => {
    const Account = await Seed();
    await LinkDiscord(Account, 28);
    for (let Attempt = 1; Attempt <= 5; Attempt += 1) {
        assert.equal((await Call("POST", UNLINK_START, {}, Account.token)).status, 200, `start ${Attempt}`);
    }
    ExpectRefusal(await Call("POST", UNLINK_START, {}, Account.token), 429, "AUTH_RATE_LIMITED");
});
