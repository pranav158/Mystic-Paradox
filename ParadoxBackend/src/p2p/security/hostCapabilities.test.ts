import assert from "node:assert/strict";
import test from "node:test";
import { JwtPayload } from "jsonwebtoken";
import { P2PHostCapabilityRecord, P2PHuntSessionRecord } from "../persistence";
import {
    ActiveHostRuntimeContext,
    BuildPlayerHostRuntimeAuthData,
    GenerateHostCapabilitySecret,
    ParseOptionalHostRuntimeBearerToken,
    ResetHostRateLimitBucketCacheForTest,
    ResolveActiveHostRuntimeContext,
    ResolveHostRateLimitBucket,
    ResolvePlayerHostRuntimeRequestIdentity
} from "./hostCapabilities";
import { IsRuntimeRosterTarget } from "../../security/runtimeRoster";

const HOST_ACCOUNT_ID = "host-account";
const REMOTE_ACCOUNT_ID = "remote-account";

function runtimeContext(remoteAdmissionState: "PENDING" | "ISSUED" | "ADMITTED" | "LOST" = "ADMITTED"): ActiveHostRuntimeContext {
    const capability: P2PHostCapabilityRecord = {
        capabilityId: "capability-1",
        secretDigest: "a".repeat(64),
        sessionId: "session-1",
        generation: 7,
        hostAccountId: HOST_ACCOUNT_ID,
        hostSteamId: "76561198000000001",
        bridgeInstanceId: "bridge-instance-1",
        scopes: ["GAME_SERVER_RUNTIME"],
        issuedAt: new Date(0).toISOString(),
        expiresAt: new Date(8640000000000000).toISOString(),
        lastSequence: 0
    };
    const hunt: P2PHuntSessionRecord = {
        sessionId: capability.sessionId,
        generation: capability.generation,
        state: "RUNNING",
        stateVersion: 4,
        partyId: "party-1",
        partyRevision: 2,
        huntDefinitionId: "hunt-1",
        build: 392819,
        bridgeProtocol: 1,
        virtualPort: 1,
        hostAccountId: capability.hostAccountId,
        hostSteamId: capability.hostSteamId,
        bridgeInstanceId: capability.bridgeInstanceId,
        roster: [
            {
                accountId: HOST_ACCOUNT_ID,
                steamId: capability.hostSteamId,
                candidateId: "candidate-host",
                reconnectEpoch: 0,
                admissionState: "PENDING"
            },
            {
                accountId: REMOTE_ACCOUNT_ID,
                steamId: "76561198000000002",
                candidateId: "candidate-remote",
                reconnectEpoch: 0,
                admissionState: remoteAdmissionState
            }
        ],
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(8640000000000000).toISOString()
    };
    return { capability, hunt };
}

test("host capability without Bearer identity falls back to the host account", () => {
    const auth = BuildPlayerHostRuntimeAuthData(runtimeContext());
    assert.equal(auth?.userId, HOST_ACCOUNT_ID);
    assert.equal(auth?.IsPlayerHostRuntime, true);
    assert.equal(auth?.IsGameserver, false);
});

test("no-Bearer player-data request binds to an admitted remote route identity", () => {
    const auth = BuildPlayerHostRuntimeAuthData(
        runtimeContext("ADMITTED"),
        undefined,
        { requestedUserId: REMOTE_ACCOUNT_ID }
    );
    assert.equal(auth?.userId, REMOTE_ACCOUNT_ID);
    assert.equal(auth?.IsPlayerHostRuntime, true);
    assert.equal(auth?.IsGameserver, false);
});

test("no-Bearer player-data request rejects non-admitted and outsider route identities", () => {
    assert.equal(
        BuildPlayerHostRuntimeAuthData(runtimeContext("PENDING"), undefined, { requestedUserId: REMOTE_ACCOUNT_ID }),
        undefined
    );
    assert.equal(
        BuildPlayerHostRuntimeAuthData(runtimeContext("ADMITTED"), undefined, { requestedUserId: "outsider" }),
        undefined
    );
});

test("signed Bearer identity wins over an unsigned route identity hint", () => {
    const auth = BuildPlayerHostRuntimeAuthData(
        runtimeContext("ADMITTED"),
        { userId: REMOTE_ACCOUNT_ID, sub: "remote-sub" },
        { requestedUserId: HOST_ACCOUNT_ID }
    );
    assert.equal(auth?.userId, REMOTE_ACCOUNT_ID);
    assert.equal(auth?.sub, "remote-sub");
});

test("request identity resolver recognizes player-data route and body contracts only", () => {
    assert.equal(
        ResolvePlayerHostRuntimeRequestIdentity({
            params: { userId: ` ${REMOTE_ACCOUNT_ID} ` },
            path: `/inventory/${REMOTE_ACCOUNT_ID}/character`
        }),
        REMOTE_ACCOUNT_ID
    );
    assert.equal(
        ResolvePlayerHostRuntimeRequestIdentity({
            path: "/inventory",
            body: { accountId: REMOTE_ACCOUNT_ID }
        }),
        REMOTE_ACCOUNT_ID
    );
    assert.equal(
        ResolvePlayerHostRuntimeRequestIdentity({
            path: "/accountinfo/public",
            body: { accountId: REMOTE_ACCOUNT_ID }
        }),
        undefined
    );
    assert.equal(
        ResolvePlayerHostRuntimeRequestIdentity({
            params: { characterId: REMOTE_ACCOUNT_ID },
            path: "/breadcrumbs/value"
        }),
        undefined
    );
});

test("host Bearer identity remains bound to the host account", () => {
    const auth = BuildPlayerHostRuntimeAuthData(runtimeContext(), { userId: HOST_ACCOUNT_ID, sub: "host-sub" });
    assert.equal(auth?.userId, HOST_ACCOUNT_ID);
    assert.equal(auth?.sub, "host-sub");
});

test("admitted remote Bearer identity is preserved for per-player server requests", () => {
    const payload = {
        userId: REMOTE_ACCOUNT_ID,
        sub: "remote-sub",
        IsGameserver: true,
        IsPlayerHostRuntime: false,
        p2pSessionId: "forged-session"
    } as JwtPayload;
    const auth = BuildPlayerHostRuntimeAuthData(runtimeContext("ADMITTED"), payload);
    assert.equal(auth?.userId, REMOTE_ACCOUNT_ID);
    assert.equal(auth?.sub, "remote-sub");
    assert.equal(auth?.IsGameserver, false);
    assert.equal(auth?.IsPlayerHostRuntime, true);
    assert.equal(auth?.p2pSessionId, "session-1");
    assert.equal(auth?.p2pGeneration, 7);
});

test("remote identity must already be admitted in the frozen roster", () => {
    for (const state of ["PENDING", "ISSUED", "LOST"] as const) {
        assert.equal(
            BuildPlayerHostRuntimeAuthData(runtimeContext(state), { userId: REMOTE_ACCOUNT_ID }),
            undefined
        );
    }
});

test("outsider and identity-less JWT payloads are rejected", () => {
    assert.equal(BuildPlayerHostRuntimeAuthData(runtimeContext(), { userId: "outsider" }), undefined);
    assert.equal(BuildPlayerHostRuntimeAuthData(runtimeContext(), { sub: "missing-user" }), undefined);
});

test("optional host-runtime Bearer parser accepts case variants and fails closed", () => {
    assert.equal(ParseOptionalHostRuntimeBearerToken(undefined), undefined);
    assert.equal(ParseOptionalHostRuntimeBearerToken("Bearer signed.jwt.value"), "signed.jwt.value");
    assert.equal(ParseOptionalHostRuntimeBearerToken("BEARER signed.jwt.value"), "signed.jwt.value");
    assert.throws(() => ParseOptionalHostRuntimeBearerToken("Basic value"));
    assert.throws(() => ParseOptionalHostRuntimeBearerToken("Bearer "));
    assert.throws(() => ParseOptionalHostRuntimeBearerToken(["Bearer one", "Bearer two"]));
});

test("host runtime auth data carries the frozen roster, never one from the signed payload (B5/B8, 2026-10-11)", () => {
    const auth = BuildPlayerHostRuntimeAuthData(runtimeContext("ADMITTED"),
        { userId: REMOTE_ACCOUNT_ID, RuntimeRosterAccountIds: ["outsider"] } as JwtPayload);
    assert.deepEqual(auth?.RuntimeRosterAccountIds, [HOST_ACCOUNT_ID, REMOTE_ACCOUNT_ID]);
    assert.equal(IsRuntimeRosterTarget(auth, HOST_ACCOUNT_ID), true);
    assert.equal(IsRuntimeRosterTarget(auth, "outsider"), false);
});

test("only a live, validated host capability gets its own request-budget bucket (B4, 2026-10-11)", async () => {
    ResetHostRateLimitBucketCacheForTest();
    const live = GenerateHostCapabilitySecret();
    const revoked = GenerateHostCapabilitySecret();
    const records = new Map<string, P2PHostCapabilityRecord>([
        [live.digest, { ...runtimeContext().capability, capabilityId: "cap-live", secretDigest: live.digest }],
        [revoked.digest, { ...runtimeContext().capability, capabilityId: "cap-revoked", secretDigest: revoked.digest,
            revokedAt: new Date(0).toISOString() }]
    ]);
    let lookups = 0;
    const find = async (digest: string) => { lookups++; return records.get(digest); };
    assert.equal(await ResolveHostRateLimitBucket(live.secret, find), "host:cap-live");
    assert.equal(await ResolveHostRateLimitBucket(live.secret, find), "host:cap-live");
    assert.equal(lookups, 1, "the second request is served from the short cache");
    assert.equal(await ResolveHostRateLimitBucket(revoked.secret, find), undefined);
    assert.equal(await ResolveHostRateLimitBucket(GenerateHostCapabilitySecret().secret, find), undefined);
    assert.equal(await ResolveHostRateLimitBucket("not-a-capability", find), undefined);
    assert.equal(await ResolveHostRateLimitBucket(undefined, find), undefined);
    const failing = async () => { throw new Error("mongo down"); };
    assert.equal(await ResolveHostRateLimitBucket(GenerateHostCapabilitySecret().secret, failing), undefined);
});

test("a drained hunt's server keeps its runtime capability; a suspect or completed hunt's does not (2026-10-15)", async () => {
    const context = runtimeContext();
    const { secret, digest } = GenerateHostCapabilitySecret();
    const resolve = (state: P2PHuntSessionRecord["state"]) => ResolveActiveHostRuntimeContext(secret, {
        findCapability: async () => ({ ...context.capability, secretDigest: digest }),
        findHunt: async () => ({ ...context.hunt, state }),
        listPresent: async () => []
    }, Date.now());
    assert.ok(await resolve("DRAINING"), "the drained server keeps serving the players still in it");
    assert.ok(await resolve("RUNNING"));
    assert.equal(await resolve("SUSPECT"), undefined, "a suspect hunt keeps no runtime: only a drain does");
    assert.equal(await resolve("COMPLETED"), undefined);
});
