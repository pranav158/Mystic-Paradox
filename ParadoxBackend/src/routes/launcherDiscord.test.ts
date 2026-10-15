/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-15] Discord over HTTP: sign-in never creates an account (an unlinked Discord user is refused), and an account is linked from
// Settings through the same OAuth (link/done or link/error), and unlinked again (refused for a Discord-only account). Discord's token and
// user endpoints are answered by a stub; the code 'code-<id>' is the Discord user <id>. The realm is SQLite, the router the real one.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express from "express";
import { CreateSessionForUser } from "../controllers/launcherAuth";
import { UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { HashPassword } from "../security/passwords";
import { launcherAuthRouter } from "./launcherAuth";

const ENV_KEYS = ["AUTH_SIGNING_PRIVKEY_B64", "AUTH_SIGNING_PUBKEY_B64", "PERSISTENCE_PROVIDER", "API_KEY_HASH_SECRET",
    "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI", "MYSTICPARADOX_EMAIL_VERIFICATION", "LAUNCHER_DEEPLINK_SCHEME"] as const;
const SAVED_ENV = new Map<string, string | undefined>();
const SAVED_FETCH = globalThis.fetch;

let Realm: TestRealm;
let Server: http.Server;
let Port = 0;
let Seq = 0;

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

interface Account { userId: string; token: string }

async function Seed(options: { password?: boolean } = {}): Promise<Account> {
    Seq += 1;
    const userId = crypto.randomUUID();
    const Now = new Date().toISOString();
    await Realm.repos.launcherAccounts.create({
        userId, email: options.password === false ? undefined : `discord${Seq}@example.test`,
        displayNameNormalized: `discordslayer${Seq}`, displayName: `DiscordSlayer${Seq}`,
        ...(options.password === false ? {} : { passwordHash: await HashPassword("correct horse battery") }),
        status: "active", approvalStatus: "approved", roles: ["player"], createdAt: Now, usernameSet: true
    });
    const Session = await CreateSessionForUser(userId, "discord-device", "Discord PC");
    return { userId, token: Session.accessToken };
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

    const App = express();
    App.use(express.json());
    App.use("/", launcherAuthRouter);
    App.use((_req, res) => { res.status(404).send(); });
    Server = App.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        Server.once("listening", () => resolve());
        Server.once("error", reject);
    });
    Port = (Server.address() as AddressInfo).port;
});

after(async () => {
    await new Promise<void>((resolve) => Server.close(() => resolve()));
    globalThis.fetch = SAVED_FETCH;
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

test("unlinking: a password account can unlink (and answers its account); a Discord-only account cannot (409 AUTH_DISCORD_ONLY_LOGIN)", async () => {
    const WithPassword = await Seed();
    const Link = await Call("POST", "/launcher/v1/account/discord/link/start", {}, WithPassword.token);
    await Call("GET", `/launcher/v1/auth/discord/callback?code=code-${DiscordId(9)}&state=${StateOf(Link.json.authorizeUrl)}`);
    const Unlinked = await Call("DELETE", "/launcher/v1/account/discord", undefined, WithPassword.token);
    assert.equal(Unlinked.status, 200, JSON.stringify(Unlinked.json));
    assert.deepEqual(Unlinked.json.account.discord, { linked: false });
    assert.equal((await Call("GET", "/launcher/v1/me", undefined, WithPassword.token)).json.discord.linked, false);

    const DiscordOnly = await Seed({ password: false });
    await Realm.repos.authIdentities.create({
        provider: "discord", providerSubject: DiscordId(10), userId: DiscordOnly.userId, providerUsername: "only", linkedAt: new Date().toISOString()
    });
    const Refused = await Call("DELETE", "/launcher/v1/account/discord", undefined, DiscordOnly.token);
    assert.equal(Refused.status, 409);
    assert.equal(Refused.json.error.code, "AUTH_DISCORD_ONLY_LOGIN");
    assert.equal((await Call("GET", "/launcher/v1/me", undefined, DiscordOnly.token)).json.discord.linked, true, "the link stays");
});

test("unlinking needs a sign-in", async () => {
    const Reply = await Call("DELETE", "/launcher/v1/account/discord");
    assert.equal(Reply.status, 401);
});
