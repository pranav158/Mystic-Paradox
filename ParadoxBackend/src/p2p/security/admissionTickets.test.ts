import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { HashAdmissionJti, IssueAdmissionTicket, VerifyAdmissionTicket } from "./admissionTickets";
import { GenerateHostCapabilitySecret, HashHostCapabilitySecret } from "./hostCapabilities";

function WithKeys(action: () => void): void {
    const prior = {
        privateKey: process.env.P2P_ADMISSION_SIGNING_PRIVKEY_B64,
        publicKey: process.env.P2P_ADMISSION_VERIFY_PUBKEY_B64,
        keyId: process.env.P2P_ADMISSION_KEY_ID
    };
    const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    process.env.P2P_ADMISSION_SIGNING_PRIVKEY_B64 = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.P2P_ADMISSION_VERIFY_PUBKEY_B64 = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    process.env.P2P_ADMISSION_KEY_ID = "test-key-1";
    try {
        action();
    } finally {
        for (const [key, value] of Object.entries({
            P2P_ADMISSION_SIGNING_PRIVKEY_B64: prior.privateKey,
            P2P_ADMISSION_VERIFY_PUBKEY_B64: prior.publicKey,
            P2P_ADMISSION_KEY_ID: prior.keyId
        })) {
            if (value == undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function Issue(now = 1_800_000_000, virtualPort = 1) {
    return IssueAdmissionTicket({
        accountId: "account-1",
        joinerSteamId: "76561198000000001",
        hostSteamId: "76561198000000002",
        sessionId: "01234567-89ab-4def-8123-456789abcdef",
        generation: 7,
        partyId: "party_abc==",
        partyRevision: 12,
        huntDefinitionId: "hunt/island-1",
        build: 392819,
        bridgeProtocol: 1,
        virtualPort,
        nowSeconds: now,
        lifetimeSeconds: 75
    });
}

test("admission ticket round-trips every production binding", () => WithKeys(() => {
    const issued = Issue();
    const claims = VerifyAdmissionTicket(issued.token, 1_800_000_010);
    assert.equal(claims.keyId, "test-key-1");
    assert.equal(claims.accountId, "account-1");
    assert.equal(claims.joinerSteamId, "76561198000000001");
    assert.equal(claims.hostSteamId, "76561198000000002");
    assert.equal(claims.sessionId, "01234567-89ab-4def-8123-456789abcdef");
    assert.equal(claims.generation, 7);
    assert.equal(claims.partyId, "party_abc==");
    assert.equal(claims.partyRevision, 12);
    assert.equal(claims.huntDefinitionId, "hunt/island-1");
    assert.equal(claims.build, 392819);
    assert.equal(claims.virtualPort, 1);
    assert.equal(issued.jtiDigest, HashAdmissionJti(claims.jti));
}));

test("admission ticket rejects tampering and expiry", () => WithKeys(() => {
    const issued = Issue();
    const parts = issued.token.split(".");
    const payload = Buffer.from(parts[1], "base64url");
    payload[payload.length - 1] ^= 1;
    assert.throws(() => VerifyAdmissionTicket(`${parts[0]}.${payload.toString("base64url")}.${parts[2]}`, 1_800_000_010));
    assert.throws(() => VerifyAdmissionTicket(issued.token, 1_800_000_200), /expired/);
}));

test("admission ticket restricts Steam P2P virtual ports to the logical range", () => WithKeys(() => {
    assert.doesNotThrow(() => Issue(1_800_000_000, 999));
    assert.throws(() => Issue(1_800_000_000, 0), /nonzero Steam logical port/);
    assert.throws(() => Issue(1_800_000_000, 1000), /outside its unsigned range/);
}));

test("host capability secrets are high entropy and stored only by digest", () => {
    const first = GenerateHostCapabilitySecret();
    const second = GenerateHostCapabilitySecret();
    assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.match(first.digest, /^[a-f0-9]{64}$/);
    assert.notEqual(first.secret, second.secret);
    assert.equal(first.digest, HashHostCapabilitySecret(first.secret));
    assert.notEqual(first.digest, first.secret);
});
