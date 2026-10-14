import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express from "express";
import { CreateSessionForUser } from "../../controllers/launcherAuth";
import { UsePersistenceForTest } from "../../persistence";
import { OpenTestRealm, TestRealm } from "../../persistence/sqlite/testSupport";
import { CurrentLegalRequirements } from "../../legal/legalPolicy";
import { CreateRealmHostingRouter } from "./realmHosting";
import { p2pLauncherRouter } from "./p2pLauncher";

// [2026-10-14] The account guards of the player-hosted routes with the real launcher sign-in: realm hub start (consent when enforced), the
// hunt peer list, the host presence, the join bootstrap and the host's offer answer (a deactivated account only). Stopping a hub and the
// status stay open, and are not tested here.

const SAVED = ["AUTH_SIGNING_PRIVKEY_B64", "AUTH_SIGNING_PUBKEY_B64", "PERSISTENCE_PROVIDER", "MYSTICPARADOX_CONSENT_ENFORCE"] as const;
const SAVED_VALUES = new Map<string, string | undefined>(SAVED.map((key) => [key, process.env[key]]));

let Realm: TestRealm;
let Server: http.Server;
let Port = 0;

async function Account(options: { deleted?: boolean; consent?: boolean } = {}): Promise<string> {
    const userId = crypto.randomUUID();
    const displayName = `Hoster${crypto.randomBytes(3).toString("hex")}`;
    await Realm.repos.launcherAccounts.create({
        userId, email: `${displayName.toLowerCase()}@example.test`, displayNameNormalized: displayName.toLowerCase(), displayName,
        status: "active", approvalStatus: "approved", roles: ["player"], createdAt: new Date().toISOString(), usernameSet: true,
        deletion: options.deleted === true ? { requestedAt: "2026-10-14T12:00:00.000Z", scheduledFor: "2026-11-13T12:00:00.000Z" } : undefined,
        consent: options.consent === true ? {
            termsVersion: CurrentLegalRequirements().termsVersion,
            privacyVersion: CurrentLegalRequirements().privacyVersion,
            ageConfirmed: true,
            acceptedAt: "2026-10-14T12:00:00.000Z"
        } : undefined
    });
    return (await CreateSessionForUser(userId, "test-device", "Test PC")).accessToken;
}

function Post(path: string, token: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
        const request = http.request({
            hostname: "127.0.0.1", port: Port, path, method: "POST", agent: false,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }
        }, (res) => {
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

before(async () => {
    const Keys = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" }
    });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey).toString("base64");
    process.env.PERSISTENCE_PROVIDER = "mongodb";
    delete process.env.MYSTICPARADOX_CONSENT_ENFORCE;

    Realm = OpenTestRealm("realm-hosting-account-guard");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });

    const app = express();
    app.use(express.json());
    app.use("/", CreateRealmHostingRouter());
    app.use("/", p2pLauncherRouter);
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
    for (const key of SAVED) {
        const Previous = SAVED_VALUES.get(key);
        if (Previous === undefined) delete process.env[key]; else process.env[key] = Previous;
    }
});

test("a deactivated account cannot start a realm hub, read a hunt's peers, post a host presence or join a hunt", async () => {
    const Token = await Account({ deleted: true, consent: true });
    for (const path of ["/launcher/v1/realm-hosting/hubs/start", "/launcher/v1/p2p/hunts/session-1/peers",
        "/launcher/v1/p2p/host-presence", "/launcher/v1/p2p/hunts/session-1/join-bootstrap", "/launcher/v1/p2p/host-offers/offer-1/respond"]) {
        const Reply = await Post(path, Token);
        assert.equal(Reply.status, 403, path);
        assert.equal(Reply.json.error.code, "ACCOUNT_DEACTIVATED", path);
        assert.equal(Reply.json.error.scheduledFor, "2026-11-13T12:00:00.000Z", path);
    }
});

test("with MYSTICPARADOX_CONSENT_ENFORCE on, realm hosting needs the current consent; a hunt peer list does not", async () => {
    process.env.MYSTICPARADOX_CONSENT_ENFORCE = "on";
    try {
        const WithoutConsent = await Account();
        const Refused = await Post("/launcher/v1/realm-hosting/hubs/start", WithoutConsent);
        assert.equal(Refused.status, 403);
        assert.equal(Refused.json.error.code, "CONSENT_REQUIRED");

        const Peers = await Post("/launcher/v1/p2p/hunts/session-1/peers", WithoutConsent);
        assert.notEqual(Peers.json?.error?.code, "CONSENT_REQUIRED", "the peer list is not gated by consent");
    } finally {
        delete process.env.MYSTICPARADOX_CONSENT_ENFORCE;
    }
});
