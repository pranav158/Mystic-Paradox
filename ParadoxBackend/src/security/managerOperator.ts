/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14, launch plan P5.1] Operator credential for the manager (ParadoxManager, on this host). The manager signs the
// operator in (Discord allowlist + passkey) and proxies the admin dashboard's calls to /admin/v1/* over loopback. This module
// is the backend half of that contract; the manager implements the sender from the text below.
//
// SWITCH: MYSTICPARADOX_MANAGER_ADMIN=on enables the credential. Blank or off (the default) leaves /admin/v1 with the cookie
// session only. Any other value stops startup. SECRET: MYSTICPARADOX_MANAGER_OPERATOR_SECRET, at least 32 characters, required
// while the switch is on (startup refuses otherwise). It is read as UTF-8 after trimming.
//
// REQUEST HEADERS (all four are required except the name):
//   X-Paradox-Operator-Id         Discord user id of the operator: 1-32 decimal digits.
//   X-Paradox-Operator-Name       Display name, optional, at most 64 characters (control characters are dropped; default
//                                 "operator"). NOT SIGNED: informational only. It is never used for identity or authorization,
//                                 and the audit trail records the signed id.
//   X-Paradox-Operator-Timestamp  Unix time in milliseconds, decimal digits (no sign, no fraction). Accepted when it is at most
//                                 60 s old and at most 5 s ahead of the server clock.
//   X-Paradox-Operator-Signature  HMAC-SHA256 as 64 hex characters (lowercase is what the manager sends; upper case is accepted),
//                                 over the CANONICAL STRING below, keyed with the SECRET.
//
// CANONICAL STRING: five fields joined with a single LF ("\n"), no trailing LF:
//     METHOD \n REQUEST_TARGET \n TIMESTAMP \n OPERATOR_ID \n BODY_SHA256
//   METHOD          the HTTP method, upper case (GET, PATCH, POST, DELETE).
//   REQUEST_TARGET  the request target exactly as sent on the wire: path and query string, for example
//                   /admin/v1/players?page=2&limit=25. No scheme, host or fragment.
//   TIMESTAMP       the X-Paradox-Operator-Timestamp value exactly as sent.
//   OPERATOR_ID     the X-Paradox-Operator-Id value exactly as sent.
//   BODY_SHA256     lowercase hex SHA-256 of the raw body bytes. An empty body hashes zero bytes
//                   (e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855).
// The body must be sent with Content-Type application/json (or be empty). The JSON parser in app.ts keeps the raw bytes for
// /admin/v1/* only (CaptureAdminRawBody); a request that carries a body the server did not capture is refused.
//
// ACCEPTED ONLY WHEN ALL OF THESE HOLD (checked in this order; each refusal is logged by reason code, never with the secret):
//   1. The switch is on and the secret is configured (otherwise the request falls through to the cookie session).
//   2. The TCP peer (req.socket.remoteAddress, not req.ip) is loopback: 127.0.0.0/8, ::1 or ::ffff:127.0.0.0/8.
//   3. No forwarding header is present: any X-Forwarded-* header, X-Real-IP, Forwarded or Via. (403 ADMIN_OPERATOR_FORWARDED.)
//   4. The four headers are well formed, and the body is hashed as received.
//   5. The timestamp is inside the window above (401 ADMIN_OPERATOR_STALE).
//   6. The signature matches, compared in constant time (401 ADMIN_OPERATOR_SIGNATURE).
//   7. The signature has not been accepted in the last 120 s (401 ADMIN_OPERATOR_REPLAY). The signature is the nonce.
// Effect: the request is an administrator whose actor is `manager:<operatorId>` in every audit record. It needs no cookie and no
// X-CSRF-Token (the signature covers the request). It never creates or uses a backend admin session, and POST /admin/v1/auth/login
// is unchanged. The backend's own sign-in stays for direct use and as the fallback.
//
// Failure statuses: 403 ADMIN_OPERATOR_PEER_REFUSED (non-loopback peer), 403 ADMIN_OPERATOR_FORWARDED, 400 ADMIN_OPERATOR_BODY,
// 401 ADMIN_OPERATOR_INVALID / _STALE / _SIGNATURE / _REPLAY, 503 ADMIN_OPERATOR_NOT_CONFIGURED.

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LauncherAccountRecord } from "../persistence/contracts/LauncherAccountRepository";
import { IsLoopbackAddress } from "../config/proxyTrust";

export const MANAGER_OPERATOR_SWITCH_KEY = "MYSTICPARADOX_MANAGER_ADMIN";
export const MANAGER_OPERATOR_SECRET_KEY = "MYSTICPARADOX_MANAGER_OPERATOR_SECRET";
/** Audit actor prefix: every record written for a manager request carries `manager:<operatorId>`. */
export const MANAGER_ACTOR_PREFIX = "manager:";

const MAX_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const NONCE_TTL_MS = 120_000;
const MIN_SECRET_LENGTH = 32;
const MAX_NAME_LENGTH = 64;
const OPERATOR_HEADER_PREFIX = "x-paradox-operator-";
const FORWARDING_PREFIX = "x-forwarded-";
const FORWARDING_HEADERS = new Set(["x-real-ip", "forwarded", "via"]);
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Reads the switch. Blank and off are off; on is on; any other value throws (startup refuses). */
export function ReadManagerOperatorSwitch(environment: NodeJS.ProcessEnv = process.env): boolean {
    const Raw = (environment[MANAGER_OPERATOR_SWITCH_KEY] ?? "").trim().toLowerCase();
    if (Raw === "" || Raw === "off") return false;
    if (Raw === "on") return true;
    throw new Error(`${MANAGER_OPERATOR_SWITCH_KEY} must be on or off (blank means off).`);
}

/** Request-time form of the switch: an invalid value counts as off (AssertRuntimeSafety refuses it at startup). */
export function ManagerOperatorEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
    try {
        return ReadManagerOperatorSwitch(environment);
    } catch {
        return false;
    }
}

/** The secret, trimmed, or undefined when blank. */
export function ManagerOperatorSecret(environment: NodeJS.ProcessEnv = process.env): string | undefined {
    const Secret = (environment[MANAGER_OPERATOR_SECRET_KEY] ?? "").trim();
    return Secret.length > 0 ? Secret : undefined;
}

/** Startup check: with the switch on, the secret must be configured and at least 32 characters. */
export function AssertManagerOperatorConfig(environment: NodeJS.ProcessEnv = process.env): void {
    if (!ReadManagerOperatorSwitch(environment)) return;
    const Secret = ManagerOperatorSecret(environment);
    if (Secret == undefined || Secret.length < MIN_SECRET_LENGTH) {
        throw new Error(`${MANAGER_OPERATOR_SECRET_KEY} must contain at least ${MIN_SECRET_LENGTH} characters when ${MANAGER_OPERATOR_SWITCH_KEY}=on.`);
    }
}

export function ManagerOperatorCanonical(method: string, target: string, timestamp: string, operatorId: string, bodySha256: string): string {
    return [method.toUpperCase(), target, timestamp, operatorId, bodySha256].join("\n");
}

export function ManagerOperatorSignature(secret: string, canonical: string): string {
    return crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(canonical, "utf8").digest("hex");
}

/** Remembers accepted signatures (the nonce) for NONCE_TTL_MS. Only signatures that verified are ever stored. */
export class ManagerOperatorNonceStore {
    private readonly expiries = new Map<string, number>();

    constructor(private readonly ttlMs: number = NONCE_TTL_MS) {}

    /** True when the nonce is new (now recorded); false when it was already accepted and has not expired. */
    Claim(nonce: string, nowMs: number): boolean {
        for (const [Key, Expiry] of this.expiries) {
            if (Expiry <= nowMs) this.expiries.delete(Key);
        }
        if (this.expiries.has(nonce)) return false;
        this.expiries.set(nonce, nowMs + this.ttlMs);
        return true;
    }

    Size(): number {
        return this.expiries.size;
    }
}

const SharedNonces = new ManagerOperatorNonceStore();

export function SharedManagerOperatorNonces(): ManagerOperatorNonceStore {
    return SharedNonces;
}

export interface ManagerOperatorRequest {
    method: string;
    /** req.originalUrl: the request target as sent (path and query). */
    target: string;
    /** req.socket.remoteAddress: the TCP peer. */
    peerAddress: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    /** The raw body bytes captured by CaptureAdminRawBody, or undefined when no body was captured. */
    rawBody: Buffer | undefined;
}

export interface ManagerOperatorOptions {
    secret: string | undefined;
    nonces: ManagerOperatorNonceStore;
    nowMs: number;
}

export type ManagerOperatorVerdict =
    | { ok: true; operatorId: string; operatorName: string; actorUserId: string }
    | { ok: false; status: 400 | 401 | 403 | 503; code: string; message: string };

/** True when any x-paradox-operator-* header is present (the request is trying the manager credential). */
export function HasManagerOperatorHeaders(headers: Record<string, string | string[] | undefined>): boolean {
    return Object.keys(headers).some((Key) => Key.toLowerCase().startsWith(OPERATOR_HEADER_PREFIX));
}

/** Verifies one request against the contract above. Pure apart from the nonce store it is given. */
export function VerifyManagerOperatorRequest(request: ManagerOperatorRequest, options: ManagerOperatorOptions): ManagerOperatorVerdict {
    const Refuse = (status: 400 | 401 | 403 | 503, code: string, message: string): ManagerOperatorVerdict => ({ ok: false, status, code, message });

    if (!IsLoopbackAddress(request.peerAddress)) {
        return Refuse(403, "ADMIN_OPERATOR_PEER_REFUSED", "Operator requests are accepted only from the loopback interface.");
    }

    const Lower = new Map<string, string | string[] | undefined>();
    for (const [Key, Value] of Object.entries(request.headers)) Lower.set(Key.toLowerCase(), Value);
    for (const Key of Lower.keys()) {
        if (Key.startsWith(FORWARDING_PREFIX) || FORWARDING_HEADERS.has(Key)) {
            return Refuse(403, "ADMIN_OPERATOR_FORWARDED", "Operator requests must not pass through a forwarding proxy.");
        }
    }

    const Invalid = () => Refuse(401, "ADMIN_OPERATOR_INVALID", "The operator credential is malformed.");
    // A repeated header is malformed: arrays are refused rather than guessed at.
    const Single = (Name: string): string | undefined | null => {
        const Value = Lower.get(Name);
        if (Value === undefined) return undefined;
        return typeof Value === "string" ? Value.trim() : null;
    };
    const OperatorIdText = Single("x-paradox-operator-id");
    const NameText = Single("x-paradox-operator-name");
    const TimestampText = Single("x-paradox-operator-timestamp");
    const SignatureText = Single("x-paradox-operator-signature");
    if (OperatorIdText == undefined || TimestampText == undefined || SignatureText == undefined || NameText === null) return Invalid();
    if (!/^\d{1,32}$/.test(OperatorIdText)) return Invalid();
    if (!/^\d{1,15}$/.test(TimestampText)) return Invalid();
    if (!/^[0-9a-fA-F]{64}$/.test(SignatureText)) return Invalid();

    if (options.secret == undefined || options.secret.length < MIN_SECRET_LENGTH) {
        return Refuse(503, "ADMIN_OPERATOR_NOT_CONFIGURED", "The operator credential is not configured on this server.");
    }

    const TimestampMs = Number(TimestampText);
    const Skew = options.nowMs - TimestampMs;
    if (Skew > MAX_AGE_MS || -Skew > MAX_FUTURE_SKEW_MS) {
        return Refuse(401, "ADMIN_OPERATOR_STALE", "The operator request timestamp is outside the accepted window.");
    }

    const LengthHeader = Lower.get("content-length");
    const BodyPresent = Lower.has("transfer-encoding") || (LengthHeader !== undefined && String(LengthHeader) !== "0");
    if (BodyPresent && request.rawBody == undefined) {
        return Refuse(400, "ADMIN_OPERATOR_BODY", "An operator request with a body must send Content-Type application/json.");
    }
    const BodySha256 = request.rawBody == undefined
        ? EMPTY_BODY_SHA256
        : crypto.createHash("sha256").update(request.rawBody).digest("hex");

    const Canonical = ManagerOperatorCanonical(request.method, request.target, TimestampText, OperatorIdText, BodySha256);
    const Expected = ManagerOperatorSignature(options.secret, Canonical);
    const Given = SignatureText.toLowerCase();
    if (!crypto.timingSafeEqual(Buffer.from(Expected, "hex"), Buffer.from(Given, "hex"))) {
        return Refuse(401, "ADMIN_OPERATOR_SIGNATURE", "The operator signature does not match the request.");
    }

    if (!options.nonces.Claim(Given, options.nowMs)) {
        return Refuse(401, "ADMIN_OPERATOR_REPLAY", "This operator request was already accepted.");
    }

    // The name is unsigned: strip control characters and bound it; it only labels the synthetic actor.
    const Name = (NameText ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_NAME_LENGTH).trim();
    return {
        ok: true,
        operatorId: OperatorIdText,
        operatorName: Name.length > 0 ? Name : "operator",
        actorUserId: MANAGER_ACTOR_PREFIX + OperatorIdText
    };
}

/**
 * The synthetic administrator a verified manager request acts as. It is not a stored account: the controllers read only its
 * userId (the audit actor), its roles and its display name, and it is never written back to the repositories.
 */
export function ManagerActorAccount(verdict: { operatorId: string; operatorName: string }, nowIso: string): LauncherAccountRecord {
    return {
        userId: MANAGER_ACTOR_PREFIX + verdict.operatorId,
        displayName: verdict.operatorName,
        displayNameNormalized: verdict.operatorName.toLowerCase(),
        status: "active",
        approvalStatus: "approved",
        roles: ["admin"],
        usernameSet: true,
        createdAt: nowIso
    };
}

/** express.json verify hook (app.ts): keeps the raw bytes of /admin/v1 request bodies for the body hash. */
export function CaptureAdminRawBody(req: IncomingMessage, _res: ServerResponse, buffer: Buffer): void {
    if (typeof req.url === "string" && req.url.startsWith("/admin/v1/")) {
        (req as IncomingMessage & { RawBody?: Buffer }).RawBody = buffer;
    }
}

export function RawBodyOf(req: IncomingMessage): Buffer | undefined {
    return (req as IncomingMessage & { RawBody?: Buffer }).RawBody;
}
