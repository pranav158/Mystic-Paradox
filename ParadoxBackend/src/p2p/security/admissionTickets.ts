import crypto from "crypto";

const TOKEN_PREFIX = "mpt1";
const PAYLOAD_MAGIC = Buffer.from("MPT2", "ascii");
const PAYLOAD_VERSION = 2;
const FIXED_BYTES = 106;
const MAX_TOKEN_BYTES = 4096;
const MAX_LIFETIME_SECONDS = 180;
const CLOCK_SKEW_SECONDS = 30;

const SAFE_KEY = /^[A-Za-z0-9._-]{1,32}$/;
const SAFE_ACCOUNT = /^[A-Za-z0-9._:-]{1,96}$/;
const SAFE_HUNT = /^[A-Za-z0-9._:/-]{1,128}$/;
const SAFE_PARTY = /^[A-Za-z0-9._:+/=-]{1,192}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX_128 = /^[a-f0-9]{32}$/i;
const STEAM_ID = /^[1-9][0-9]{0,19}$/;

export interface AdmissionTicketClaims {
    issuer: "paradox-backend";
    audience: "mysticparadox-steam-bridge";
    purpose: "JOIN_HUNT";
    version: 2;
    keyId: string;
    jti: string;
    accountId: string;
    joinerSteamId: string;
    hostSteamId: string;
    sessionId: string;
    generation: number;
    partyId: string;
    partyRevision: number;
    huntDefinitionId: string;
    build: number;
    bridgeProtocol: number;
    virtualPort: number;
    issuedAt: number;
    notBefore: number;
    expiresAt: number;
}

export interface AdmissionTicketIssueInput {
    accountId: string;
    joinerSteamId: string;
    hostSteamId: string;
    sessionId: string;
    generation: number;
    partyId: string;
    partyRevision: number;
    huntDefinitionId: string;
    build: number;
    bridgeProtocol: number;
    virtualPort: number;
    nowSeconds?: number;
    lifetimeSeconds?: number;
}

export interface IssuedAdmissionTicket {
    token: string;
    claims: AdmissionTicketClaims;
    jtiDigest: string;
}

function RequiredPem(name: string): crypto.KeyObject {
    const encoded = process.env[name];
    if (!encoded) throw new Error(`Missing required P2P admission key ${name}.`);
    const pem = Buffer.from(encoded, "base64").toString("utf8");
    return name.includes("PRIVKEY") ? crypto.createPrivateKey(pem) : crypto.createPublicKey(pem);
}

function KeyId(): string {
    const value = process.env.P2P_ADMISSION_KEY_ID ?? "";
    if (!SAFE_KEY.test(value)) throw new Error("P2P_ADMISSION_KEY_ID is missing or invalid.");
    return value;
}

function SteamId(value: string): bigint {
    if (!STEAM_ID.test(value)) throw new Error("invalid SteamID64");
    const parsed = BigInt(value);
    if (parsed <= 0n || parsed > 0xffffffffffffffffn) throw new Error("invalid SteamID64 range");
    return parsed;
}

function AssertUnsigned(name: string, value: number, maximum: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
        throw new Error(`${name} is outside its unsigned range`);
    }
}

function UuidBytes(value: string): Buffer {
    if (!UUID.test(value)) throw new Error("sessionId must be a canonical UUID");
    return Buffer.from(value.replaceAll("-", ""), "hex");
}

function FormatUuid(bytes: Buffer): string {
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function EncodeClaims(claims: AdmissionTicketClaims): Buffer {
    if (!SAFE_KEY.test(claims.keyId) || !SAFE_ACCOUNT.test(claims.accountId) ||
        !SAFE_HUNT.test(claims.huntDefinitionId) || !SAFE_PARTY.test(claims.partyId) ||
        !HEX_128.test(claims.jti)) {
        throw new Error("admission ticket contains an unsafe identifier");
    }
    AssertUnsigned("generation", claims.generation, 0xffffffff);
    AssertUnsigned("build", claims.build, 0xffffffff);
    AssertUnsigned("bridgeProtocol", claims.bridgeProtocol, 0xffff);
    AssertUnsigned("virtualPort", claims.virtualPort, 999);
    if (claims.virtualPort === 0) throw new Error("virtualPort must be a nonzero Steam logical port");
    AssertUnsigned("partyRevision", claims.partyRevision, Number.MAX_SAFE_INTEGER);

    const key = Buffer.from(claims.keyId, "utf8");
    const account = Buffer.from(claims.accountId, "utf8");
    const hunt = Buffer.from(claims.huntDefinitionId, "utf8");
    const party = Buffer.from(claims.partyId, "utf8");
    if (key.length > 32 || account.length > 96 || hunt.length > 128 || party.length > 192) {
        throw new Error("admission ticket identifier is too long");
    }

    const payload = Buffer.alloc(FIXED_BYTES + key.length + account.length + hunt.length + party.length);
    let offset = 0;
    PAYLOAD_MAGIC.copy(payload, offset); offset += 4;
    payload.writeUInt8(PAYLOAD_VERSION, offset++);
    payload.writeUInt8(key.length, offset++);
    payload.writeUInt16BE(account.length, offset); offset += 2;
    payload.writeUInt16BE(hunt.length, offset); offset += 2;
    payload.writeUInt16BE(party.length, offset); offset += 2;
    payload.writeUInt16BE(claims.bridgeProtocol, offset); offset += 2;
    payload.writeUInt16BE(claims.virtualPort, offset); offset += 2;
    payload.writeUInt16BE(0, offset); offset += 2;
    payload.writeUInt32BE(claims.generation, offset); offset += 4;
    payload.writeUInt32BE(claims.build, offset); offset += 4;
    payload.writeBigUInt64BE(BigInt(claims.partyRevision), offset); offset += 8;
    payload.writeBigUInt64BE(BigInt(claims.issuedAt), offset); offset += 8;
    payload.writeBigUInt64BE(BigInt(claims.notBefore), offset); offset += 8;
    payload.writeBigUInt64BE(BigInt(claims.expiresAt), offset); offset += 8;
    payload.writeBigUInt64BE(SteamId(claims.joinerSteamId), offset); offset += 8;
    payload.writeBigUInt64BE(SteamId(claims.hostSteamId), offset); offset += 8;
    UuidBytes(claims.sessionId).copy(payload, offset); offset += 16;
    Buffer.from(claims.jti, "hex").copy(payload, offset); offset += 16;
    key.copy(payload, offset); offset += key.length;
    account.copy(payload, offset); offset += account.length;
    hunt.copy(payload, offset); offset += hunt.length;
    party.copy(payload, offset);
    return payload;
}

function DecodeClaims(payload: Buffer): AdmissionTicketClaims {
    if (payload.length < FIXED_BYTES || !payload.subarray(0, 4).equals(PAYLOAD_MAGIC)) {
        throw new Error("malformed admission ticket payload");
    }
    let offset = 4;
    const version = payload.readUInt8(offset++);
    const keyLength = payload.readUInt8(offset++);
    const accountLength = payload.readUInt16BE(offset); offset += 2;
    const huntLength = payload.readUInt16BE(offset); offset += 2;
    const partyLength = payload.readUInt16BE(offset); offset += 2;
    const bridgeProtocol = payload.readUInt16BE(offset); offset += 2;
    const virtualPort = payload.readUInt16BE(offset); offset += 2;
    const reserved = payload.readUInt16BE(offset); offset += 2;
    const generation = payload.readUInt32BE(offset); offset += 4;
    const build = payload.readUInt32BE(offset); offset += 4;
    const partyRevision = Number(payload.readBigUInt64BE(offset)); offset += 8;
    const issuedAt = Number(payload.readBigUInt64BE(offset)); offset += 8;
    const notBefore = Number(payload.readBigUInt64BE(offset)); offset += 8;
    const expiresAt = Number(payload.readBigUInt64BE(offset)); offset += 8;
    const joinerSteamId = payload.readBigUInt64BE(offset).toString(); offset += 8;
    const hostSteamId = payload.readBigUInt64BE(offset).toString(); offset += 8;
    const sessionId = FormatUuid(payload.subarray(offset, offset + 16)); offset += 16;
    const jti = payload.subarray(offset, offset + 16).toString("hex"); offset += 16;
    const expectedSize = FIXED_BYTES + keyLength + accountLength + huntLength + partyLength;
    if (version !== PAYLOAD_VERSION || reserved !== 0 || payload.length !== expectedSize ||
        keyLength === 0 || accountLength === 0 || huntLength === 0 || partyLength === 0) {
        throw new Error("invalid admission ticket framing");
    }
    const keyId = payload.subarray(offset, offset + keyLength).toString("utf8"); offset += keyLength;
    const accountId = payload.subarray(offset, offset + accountLength).toString("utf8"); offset += accountLength;
    const huntDefinitionId = payload.subarray(offset, offset + huntLength).toString("utf8"); offset += huntLength;
    const partyId = payload.subarray(offset, offset + partyLength).toString("utf8");
    const claims: AdmissionTicketClaims = {
        issuer: "paradox-backend",
        audience: "mysticparadox-steam-bridge",
        purpose: "JOIN_HUNT",
        version: 2,
        keyId,
        jti,
        accountId,
        joinerSteamId,
        hostSteamId,
        sessionId,
        generation,
        partyId,
        partyRevision,
        huntDefinitionId,
        build,
        bridgeProtocol,
        virtualPort,
        issuedAt,
        notBefore,
        expiresAt
    };
    // Re-encoding performs all identifier/range checks and rejects noncanonical payloads.
    if (!EncodeClaims(claims).equals(payload)) throw new Error("noncanonical admission ticket payload");
    return claims;
}

export function HashAdmissionJti(jti: string): string {
    if (!HEX_128.test(jti)) throw new Error("invalid admission JTI");
    return crypto.createHash("sha256").update(Buffer.from(jti, "hex")).digest("hex");
}

export function IssueAdmissionTicket(input: AdmissionTicketIssueInput): IssuedAdmissionTicket {
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const lifetime = input.lifetimeSeconds ?? Number(process.env.P2P_ADMISSION_TICKET_TTL_SECONDS ?? 75);
    if (!Number.isInteger(lifetime) || lifetime < 15 || lifetime > MAX_LIFETIME_SECONDS) {
        throw new Error("P2P admission ticket lifetime must be between 15 and 180 seconds");
    }
    const claims: AdmissionTicketClaims = {
        issuer: "paradox-backend",
        audience: "mysticparadox-steam-bridge",
        purpose: "JOIN_HUNT",
        version: 2,
        keyId: KeyId(),
        jti: crypto.randomBytes(16).toString("hex"),
        accountId: input.accountId,
        joinerSteamId: input.joinerSteamId,
        hostSteamId: input.hostSteamId,
        sessionId: input.sessionId,
        generation: input.generation,
        partyId: input.partyId,
        partyRevision: input.partyRevision,
        huntDefinitionId: input.huntDefinitionId,
        build: input.build,
        bridgeProtocol: input.bridgeProtocol,
        virtualPort: input.virtualPort,
        issuedAt: now,
        notBefore: now,
        expiresAt: now + lifetime
    };
    const payload = EncodeClaims(claims);
    const signature = crypto.sign("sha256", payload, {
        key: RequiredPem("P2P_ADMISSION_SIGNING_PRIVKEY_B64"),
        dsaEncoding: "ieee-p1363"
    });
    if (signature.length !== 64) throw new Error("ES256 signer returned a non-P1363 signature");
    const token = `${TOKEN_PREFIX}.${payload.toString("base64url")}.${signature.toString("base64url")}`;
    if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw new Error("admission token exceeds size limit");
    return { token, claims, jtiDigest: HashAdmissionJti(claims.jti) };
}

export function VerifyAdmissionTicket(token: string, nowSeconds = Math.floor(Date.now() / 1000)): AdmissionTicketClaims {
    if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
        throw new Error("admission token is missing or oversized");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) {
        throw new Error("malformed admission token");
    }
    const payload = Buffer.from(parts[1], "base64url");
    const signature = Buffer.from(parts[2], "base64url");
    if (signature.length !== 64 || payload.toString("base64url") !== parts[1] ||
        signature.toString("base64url") !== parts[2]) {
        throw new Error("noncanonical admission token encoding");
    }
    const valid = crypto.verify("sha256", payload, {
        key: RequiredPem("P2P_ADMISSION_VERIFY_PUBKEY_B64"),
        dsaEncoding: "ieee-p1363"
    }, signature);
    if (!valid) throw new Error("invalid admission token signature");
    const claims = DecodeClaims(payload);
    if (claims.keyId !== KeyId()) throw new Error("admission token key is not active");
    if (claims.expiresAt < claims.issuedAt || claims.notBefore < claims.issuedAt ||
        claims.expiresAt - claims.issuedAt > MAX_LIFETIME_SECONDS) {
        throw new Error("invalid admission token lifetime");
    }
    if (claims.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS || claims.notBefore > nowSeconds + CLOCK_SKEW_SECONDS) {
        throw new Error("admission token is not yet valid");
    }
    if (nowSeconds > claims.expiresAt + CLOCK_SKEW_SECONDS) throw new Error("admission token expired");
    return claims;
}
