import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
    AssertManagerOperatorConfig,
    ManagerActorAccount,
    ManagerOperatorEnabled,
    ManagerOperatorNonceStore,
    ManagerOperatorSignature,
    ReadManagerOperatorSwitch,
    VerifyManagerOperatorRequest,
    ManagerOperatorRequest
} from "./managerOperator";

const SECRET = "manager-operator-test-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const OPERATOR = "123456789012345678";
const LOOPBACK = "127.0.0.1";

function Sha256Hex(body: Buffer | undefined): string {
    return crypto.createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex");
}

/** Builds the headers a manager would send, signed over the contract's canonical string. */
function Signed(options: {
    method?: string;
    target?: string;
    timestamp?: number;
    operatorId?: string;
    body?: Buffer;
    signBody?: Buffer;
    secret?: string;
    name?: string;
    contentLength?: string;
}): { request: ManagerOperatorRequest; headers: Record<string, string> } {
    const Method = options.method ?? "GET";
    const Target = options.target ?? "/admin/v1/players?page=1";
    const Timestamp = String(options.timestamp ?? NOW);
    const OperatorId = options.operatorId ?? OPERATOR;
    const Canonical = [Method, Target, Timestamp, OperatorId, Sha256Hex(options.signBody ?? options.body)].join("\n");
    const Signature = ManagerOperatorSignature(options.secret ?? SECRET, Canonical);
    const Headers: Record<string, string> = {
        "x-paradox-operator-id": OperatorId,
        "x-paradox-operator-timestamp": Timestamp,
        "x-paradox-operator-signature": Signature
    };
    if (options.name !== undefined) Headers["x-paradox-operator-name"] = options.name;
    if (options.body !== undefined) {
        Headers["content-length"] = String(options.body.length);
        Headers["content-type"] = "application/json";
    }
    if (options.contentLength !== undefined) Headers["content-length"] = options.contentLength;
    return {
        headers: Headers,
        request: {
            method: Method,
            target: Target,
            peerAddress: LOOPBACK,
            headers: Headers,
            rawBody: options.body
        }
    };
}

function Verify(request: ManagerOperatorRequest, nonces = new ManagerOperatorNonceStore(), nowMs = NOW, secret: string | undefined = SECRET) {
    return VerifyManagerOperatorRequest(request, { secret, nonces, nowMs });
}

test("a correctly signed loopback request is accepted as manager:<operatorId>", () => {
    const { request } = Signed({ name: "Pranav" });
    const Verdict = Verify(request);
    assert.equal(Verdict.ok, true);
    if (!Verdict.ok) return;
    assert.equal(Verdict.actorUserId, `manager:${OPERATOR}`);
    assert.equal(Verdict.operatorId, OPERATOR);
    assert.equal(Verdict.operatorName, "Pranav");
});

test("a signed JSON body is accepted and the signature covers its bytes", () => {
    const Body = Buffer.from(JSON.stringify({ confirm: "MAX Tester" }));
    const { request } = Signed({ method: "POST", target: "/admin/v1/players/42/tester-max", body: Body });
    assert.equal(Verify(request).ok, true);
});

test("an empty body hashes as zero bytes and the name is optional", () => {
    const { request } = Signed({ method: "GET" });
    const Verdict = Verify(request);
    assert.equal(Verdict.ok, true);
    if (!Verdict.ok) return;
    assert.equal(Verdict.operatorName, "operator");
});

test("a stale timestamp (older than 60 s) is refused", () => {
    const { request } = Signed({ timestamp: NOW - 61_000 });
    const Verdict = Verify(request);
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.status, 401);
    assert.equal(Verdict.code, "ADMIN_OPERATOR_STALE");
});

test("a timestamp just inside the 60 s window is accepted", () => {
    const { request } = Signed({ timestamp: NOW - 59_000 });
    assert.equal(Verify(request).ok, true);
});

test("a timestamp more than 5 s in the future is refused", () => {
    const { request } = Signed({ timestamp: NOW + 6_000 });
    const Verdict = Verify(request);
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.code, "ADMIN_OPERATOR_STALE");
});

test("the same signed request is accepted once, then refused as a replay", () => {
    const Nonces = new ManagerOperatorNonceStore();
    const { request } = Signed({ target: "/admin/v1/audit?page=3" });
    assert.equal(Verify(request, Nonces).ok, true);
    const Second = Verify(request, Nonces, NOW + 1_000);
    assert.equal(Second.ok, false);
    if (Second.ok) return;
    assert.equal(Second.code, "ADMIN_OPERATOR_REPLAY");
    assert.equal(Second.status, 401);
});

test("the nonce cache keeps a signature for 120 s and then forgets it", () => {
    const Nonces = new ManagerOperatorNonceStore();
    const Built = Signed({ target: "/admin/v1/audit?page=9" });
    const { request } = Built;
    const Signature = Built.headers["x-paradox-operator-signature"];
    assert.equal(Verify(request, Nonces).ok, true);
    assert.equal(Nonces.Size(), 1);
    assert.equal(Nonces.Claim(Signature, NOW + 119_000), false);
    assert.equal(Nonces.Claim(Signature, NOW + 121_000), true);
});

test("a signature over a different body is refused (wrong body hash)", () => {
    const Sent = Buffer.from(JSON.stringify({ confirm: "MAX Tester" }));
    const Signed1 = Signed({ method: "POST", target: "/admin/v1/players/42/tester-max", body: Sent, signBody: Buffer.from("{\"confirm\":\"MAX Someone\"}") });
    const Verdict = Verify(Signed1.request);
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.status, 401);
    assert.equal(Verdict.code, "ADMIN_OPERATOR_SIGNATURE");
});

test("a changed query string breaks the signature (the target is signed as sent)", () => {
    const { request } = Signed({ target: "/admin/v1/players?page=1" });
    const Tampered: ManagerOperatorRequest = { ...request, target: "/admin/v1/players?page=2" };
    const Verdict = Verify(Tampered);
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.code, "ADMIN_OPERATOR_SIGNATURE");
});

test("a signature made with another secret is refused in constant time", () => {
    const { request } = Signed({ secret: "some-other-secret-that-is-also-long-enough" });
    const Verdict = Verify(request);
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.code, "ADMIN_OPERATOR_SIGNATURE");
});

test("a request from a non-loopback peer is refused even with a valid signature", () => {
    const { request } = Signed({});
    const Verdict = Verify({ ...request, peerAddress: "10.0.0.5" });
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.status, 403);
    assert.equal(Verdict.code, "ADMIN_OPERATOR_PEER_REFUSED");
});

test("an IPv4-mapped loopback peer is accepted and a missing peer is refused", () => {
    const { request } = Signed({});
    assert.equal(Verify({ ...request, peerAddress: "::ffff:127.0.0.1" }).ok, true);
    assert.equal(Verify({ ...request, peerAddress: undefined }).ok, false);
});

test("any forwarding header present refuses the request, even from loopback", () => {
    for (const Name of ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-proto", "x-forwarded-host", "via"]) {
        const { request } = Signed({});
        const Verdict = Verify({ ...request, headers: { ...request.headers, [Name]: "203.0.113.9" } });
        assert.equal(Verdict.ok, false, Name);
        if (Verdict.ok) continue;
        assert.equal(Verdict.status, 403, Name);
        assert.equal(Verdict.code, "ADMIN_OPERATOR_FORWARDED", Name);
    }
});

test("an empty forwarding header still counts as present", () => {
    const { request } = Signed({});
    const Verdict = Verify({ ...request, headers: { ...request.headers, "x-forwarded-for": "" } });
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.code, "ADMIN_OPERATOR_FORWARDED");
});

test("malformed operator headers are refused", () => {
    const { request } = Signed({});
    const Cases: Array<[string, string]> = [
        ["x-paradox-operator-id", "pranav"],
        ["x-paradox-operator-id", ""],
        ["x-paradox-operator-timestamp", "1.5"],
        ["x-paradox-operator-signature", "abc"],
    ];
    for (const [Name, Value] of Cases) {
        const Verdict = Verify({ ...request, headers: { ...request.headers, [Name]: Value } });
        assert.equal(Verdict.ok, false, `${Name}=${Value}`);
        if (Verdict.ok) continue;
        assert.equal(Verdict.code, "ADMIN_OPERATOR_INVALID", `${Name}=${Value}`);
    }
});

test("a repeated operator header is refused rather than guessed at", () => {
    const { request } = Signed({});
    const Verdict = Verify({ ...request, headers: { ...request.headers, "x-paradox-operator-name": ["a", "b"] } });
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.code, "ADMIN_OPERATOR_INVALID");
});

test("a body the server did not capture is refused, not hashed as empty", () => {
    const Body = Buffer.from("plain text body");
    const { request } = Signed({ method: "POST", target: "/admin/v1/players/1/tester-max", body: Body });
    const Verdict = Verify({ ...request, rawBody: undefined });
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.status, 400);
    assert.equal(Verdict.code, "ADMIN_OPERATOR_BODY");
});

test("a chunked body that was not captured is refused", () => {
    const { request } = Signed({});
    const Verdict = Verify({ ...request, headers: { ...request.headers, "transfer-encoding": "chunked" } });
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.code, "ADMIN_OPERATOR_BODY");
});

test("without a configured secret the credential answers 503 and never verifies", () => {
    const { request } = Signed({});
    // Called directly: the Verify helper's default would substitute SECRET for an explicit undefined.
    const Verdict = VerifyManagerOperatorRequest(request, { secret: undefined, nonces: new ManagerOperatorNonceStore(), nowMs: NOW });
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.status, 503);
    assert.equal(Verdict.code, "ADMIN_OPERATOR_NOT_CONFIGURED");
});

test("the switch is off by default and only on/off are accepted", () => {
    assert.equal(ReadManagerOperatorSwitch({}), false);
    assert.equal(ReadManagerOperatorSwitch({ MYSTICPARADOX_MANAGER_ADMIN: "" }), false);
    assert.equal(ReadManagerOperatorSwitch({ MYSTICPARADOX_MANAGER_ADMIN: "off" }), false);
    assert.equal(ReadManagerOperatorSwitch({ MYSTICPARADOX_MANAGER_ADMIN: "on" }), true);
    assert.equal(ReadManagerOperatorSwitch({ MYSTICPARADOX_MANAGER_ADMIN: " ON " }), true);
    assert.throws(() => ReadManagerOperatorSwitch({ MYSTICPARADOX_MANAGER_ADMIN: "true" }), /must be on or off/);
    // Request-time read never throws: an invalid value counts as off.
    assert.equal(ManagerOperatorEnabled({ MYSTICPARADOX_MANAGER_ADMIN: "true" }), false);
});

test("startup refuses the switch on without a 32-character secret, and allows switch off without one", () => {
    assert.doesNotThrow(() => AssertManagerOperatorConfig({}));
    assert.doesNotThrow(() => AssertManagerOperatorConfig({ MYSTICPARADOX_MANAGER_ADMIN: "off" }));
    assert.throws(() => AssertManagerOperatorConfig({ MYSTICPARADOX_MANAGER_ADMIN: "on" }), /at least 32 characters/);
    assert.throws(
        () => AssertManagerOperatorConfig({ MYSTICPARADOX_MANAGER_ADMIN: "on", MYSTICPARADOX_MANAGER_OPERATOR_SECRET: "x".repeat(31) }),
        /at least 32 characters/
    );
    assert.doesNotThrow(() => AssertManagerOperatorConfig({
        MYSTICPARADOX_MANAGER_ADMIN: "on",
        MYSTICPARADOX_MANAGER_OPERATOR_SECRET: "x".repeat(32)
    }));
});

test("a non-numeric operator id is refused even when everything else is valid", () => {
    const { request } = Signed({ operatorId: "not-digits" });
    const Verdict = Verify(request);
    assert.equal(Verdict.ok, false);
    if (Verdict.ok) return;
    assert.equal(Verdict.code, "ADMIN_OPERATOR_INVALID");
});

test("the operator name is unsigned and sanitised: control characters dropped, at most 64 characters", () => {
    const Long = `Pranav\u0001${"x".repeat(100)}`;
    const { request } = Signed({ name: Long });
    const Verdict = Verify(request);
    assert.equal(Verdict.ok, true);
    if (!Verdict.ok) return;
    assert.equal(Verdict.operatorName.length, 64);
    assert.equal(Verdict.operatorName.startsWith("Pranav"), true);
    assert.equal(Verdict.operatorName.includes("\u0001"), false);
});

test("the synthetic actor is an admin with the manager userId and no session", () => {
    const Account = ManagerActorAccount({ operatorId: OPERATOR, operatorName: "Pranav" }, new Date(NOW).toISOString());
    assert.equal(Account.userId, `manager:${OPERATOR}`);
    assert.deepEqual(Account.roles, ["admin"]);
    assert.equal(Account.status, "active");
});
