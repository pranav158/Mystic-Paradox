import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { ReadP2PIceConfig } from "../config/p2pIcePolicy";
import { RelayTtlSeconds } from "../controllers/p2pIce";
import {
    FetchLike,
    HourlyCounter,
    IssueRelayGrant,
    MintTurnRestCredentials,
    MonthWindow,
    NormalizeProviderIceServers,
    RelayAccountTag,
    RelayUsageCache
} from "./relayCredentials";

const NOW = new Date("2026-10-13T08:00:00.000Z");
const ACCOUNT = "4f6a2d1e-0000-4000-8000-000000000001";
// [2026-10-14] What the provider sees instead of the account id (Privacy Policy section 3).
const TAG = RelayAccountTag(ACCOUNT);
const HEX96 = "a".repeat(96);

// The documented generate-ice-servers answer (developers.cloudflare.com/realtime/turn/generate-credentials).
const CLOUDFLARE_ANSWER = {
    iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp",
            "turn:turn.cloudflare.com:443?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"],
          username: HEX96, credential: HEX96 }
    ]
};

function Cloudflare(extra: Record<string, string> = {}) {
    return ReadP2PIceConfig({ P2P_CLOUDFLARE_TURN_KEY_ID: "0123456789abcdef0123456789abcdef",
        P2P_CLOUDFLARE_TURN_API_TOKEN: "token-value-123456", P2P_TRANSPORT_KEY_SECRET: "k".repeat(32), ...extra } as any);
}

function FakeFetch(answers: Array<{ status: number; json?: any }>, calls: Array<{ url: string; body: any }>): FetchLike {
    return async (url, init) => {
        calls.push({ url, body: init.body == undefined ? undefined : JSON.parse(init.body) });
        const answer = answers.shift() ?? { status: 500 };
        return { status: answer.status, json: async () => answer.json };
    };
}

test("config: STUN by default, no relay without credentials, 10 GB quota, bounded values", () => {
    const empty = ReadP2PIceConfig({} as any);
    assert.deepEqual(empty.stunUrls, ["stun:stun.cloudflare.com:3478"]);
    assert.equal(empty.turnProvider, "cloudflare");
    assert.equal(empty.cloudflare, undefined);
    assert.equal(empty.transportKeySecret, undefined);
    assert.equal(empty.monthlyRelayQuotaBytes, 10_000_000_000);
    assert.equal(empty.maxCredentialTtlSeconds, 10_800);
    const odd = ReadP2PIceConfig({ P2P_TURN_MAX_TTL_SECONDS: "999999", P2P_RELAY_MONTHLY_QUOTA_GB: "-1",
        P2P_TRANSPORT_KEY_SECRET: "short", P2P_ICE_STUN_URLS: "http://evil, stun:stun.example.org:3478" } as any);
    assert.equal(odd.maxCredentialTtlSeconds, 10_800);
    assert.equal(odd.monthlyRelayQuotaBytes, 10_000_000_000);
    assert.equal(odd.transportKeySecret, undefined);
    assert.deepEqual(odd.stunUrls, ["stun:stun.example.org:3478"]);
    const rest = ReadP2PIceConfig({ P2P_TURN_PROVIDER: "turn-rest", P2P_TURN_REST_URLS: "turn:turn.example.org:3478?transport=udp",
        P2P_TURN_REST_SECRET: "x".repeat(16) } as any);
    assert.deepEqual(rest.turnRest?.urls, ["turn:turn.example.org:3478?transport=udp"]);
    assert.ok(Cloudflare().cloudflare);
});

test("provider answers: both Cloudflare shapes, port 53 dropped, bad credentials refused", () => {
    const array = NormalizeProviderIceServers(CLOUDFLARE_ANSWER);
    assert.deepEqual(array.stunUrls, ["stun:stun.cloudflare.com:3478"]);
    assert.deepEqual(array.turn?.urls, ["turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:443?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"]);
    const single = NormalizeProviderIceServers({ iceServers: { urls: ["stun:stun.cloudflare.com:3478",
        "turn:turn.cloudflare.com:3478?transport=udp"], username: HEX96, credential: HEX96 } });
    assert.deepEqual(single.turn?.urls, ["turn:turn.cloudflare.com:3478?transport=udp"]);
    assert.equal(NormalizeProviderIceServers({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"], username: "a b",
        credential: HEX96 }] }).turn, undefined);
    assert.equal(NormalizeProviderIceServers(undefined).turn, undefined);
});

test("turn-rest credentials are expiry:relay tag signed with the shared secret", () => {
    const secret = "x".repeat(16);
    const turn = MintTurnRestCredentials({ urls: ["turn:turn.example.org:3478"], secret }, ACCOUNT, 600, NOW.getTime());
    assert.equal(turn.username, `${NOW.getTime() / 1000 + 600}:${TAG}`);
    assert.equal(turn.credential, crypto.createHmac("sha1", secret).update(turn.username).digest("base64"));
});

test("relay tag: stable per account, 32 hex characters, never the account id", () => {
    assert.equal(RelayAccountTag(ACCOUNT), TAG);
    assert.match(TAG, /^[0-9a-f]{32}$/);
    assert.notEqual(RelayAccountTag("4f6a2d1e-0000-4000-8000-000000000002"), TAG);
    assert.equal(TAG.includes(ACCOUNT), false);
});

test("relay grant: no request to the provider carries the raw account id", async () => {
    const config = Cloudflare({ P2P_CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "abcdef0123456789abcdef0123456789",
        P2P_CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token-1", P2P_RELAY_MONTHLY_QUOTA_GB: "10" });
    const calls: Array<{ url: string; body: any }> = [];
    const grant = await IssueRelayGrant(config, ACCOUNT, 600,
        { fetchImpl: FakeFetch([{ status: 200, json: { data: { viewer: { usage: [] } } } }, { status: 201, json: CLOUDFLARE_ANSWER }], calls),
            usageCache: new RelayUsageCache(), now: NOW });
    assert.equal(grant.relay.allowed, true);
    assert.equal(calls.length, 2);
    for (const call of calls) assert.equal(JSON.stringify(call).includes(ACCOUNT), false, call.url);
    assert.match(calls[0].body.query, new RegExp(`customIdentifier: "${TAG}"`));
});

test("relay grant: STUN only until a provider is configured", async () => {
    const grant = await IssueRelayGrant(ReadP2PIceConfig({} as any), ACCOUNT, 600,
        { fetchImpl: FakeFetch([], []), usageCache: new RelayUsageCache(), now: NOW });
    assert.deepEqual(grant, { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
        relay: { allowed: false, reason: "RELAY_NOT_CONFIGURED" } });
});

test("relay grant: Cloudflare credentials tagged with the relay tag, retried untagged on 400", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const grant = await IssueRelayGrant(Cloudflare(), ACCOUNT, 600,
        { fetchImpl: FakeFetch([{ status: 201, json: CLOUDFLARE_ANSWER }], calls), usageCache: new RelayUsageCache(), now: NOW });
    assert.equal(calls[0].url, "https://rtc.live.cloudflare.com/v1/turn/keys/0123456789abcdef0123456789abcdef/credentials/generate-ice-servers");
    assert.deepEqual(calls[0].body, { ttl: 600, customIdentifier: TAG });
    assert.equal(grant.relay.allowed, true);
    assert.equal(grant.iceServers[1].username, HEX96);

    const retried: Array<{ url: string; body: any }> = [];
    const second = await IssueRelayGrant(Cloudflare(), ACCOUNT, 600, { fetchImpl: FakeFetch(
        [{ status: 400 }, { status: 201, json: CLOUDFLARE_ANSWER }], retried), usageCache: new RelayUsageCache(), now: NOW });
    assert.deepEqual(retried.map((call) => call.body), [{ ttl: 600, customIdentifier: TAG }, { ttl: 600 }]);
    assert.equal(second.relay.allowed, true);

    const failed = await IssueRelayGrant(Cloudflare(), ACCOUNT, 600,
        { fetchImpl: FakeFetch([{ status: 503 }], []), usageCache: new RelayUsageCache(), now: NOW });
    assert.deepEqual(failed.relay, { allowed: false, reason: "RELAY_PROVIDER_ERROR" });
    assert.deepEqual(failed.iceServers, [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
});

test("relay grant: the monthly quota comes from the analytics query, cached, and an unreadable figure does not block", async () => {
    const config = Cloudflare({ P2P_CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "abcdef0123456789abcdef0123456789",
        P2P_CLOUDFLARE_ANALYTICS_API_TOKEN: "analytics-token-1", P2P_RELAY_MONTHLY_QUOTA_GB: "10" });
    const usage = (bytes: number) => ({ status: 200, json: { data: { viewer: { usage: [
        { callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: bytes } }] }] } } } });
    const cache = new RelayUsageCache();
    const calls: Array<{ url: string; body: any }> = [];
    const over = await IssueRelayGrant(config, ACCOUNT, 600,
        { fetchImpl: FakeFetch([usage(10_000_000_001)], calls), usageCache: cache, now: NOW });
    assert.deepEqual(over.relay, { allowed: false, reason: "RELAY_QUOTA_EXCEEDED" });
    assert.match(calls[0].body.query, new RegExp(`customIdentifier: "${TAG}"`));
    assert.match(calls[0].body.query, /date_geq: "2026-10-01", date_leq: "2026-10-13"/);
    // Cached: the second request does not ask again (an answer would be consumed otherwise).
    const again = await IssueRelayGrant(config, ACCOUNT, 600,
        { fetchImpl: FakeFetch([{ status: 201, json: CLOUDFLARE_ANSWER }], []), usageCache: cache, now: NOW });
    assert.equal(again.relay.allowed, false);

    const unreadable = await IssueRelayGrant(config, ACCOUNT, 600, { fetchImpl: FakeFetch(
        [{ status: 500 }, { status: 201, json: CLOUDFLARE_ANSWER }], []), usageCache: new RelayUsageCache(), now: NOW });
    assert.equal(unreadable.relay.allowed, true);
});

test("limits: hourly counter, month window and credential lifetime", () => {
    const counter = new HourlyCounter();
    assert.equal(counter.allow("a", 2, 0), true);
    assert.equal(counter.allow("a", 2, 1), true);
    assert.equal(counter.allow("a", 2, 2), false);
    assert.equal(counter.allow("a", 2, 3_600_001), true);
    assert.deepEqual(MonthWindow(NOW), { from: "2026-10-01", to: "2026-10-13", month: "2026-10" });
    // A hunt expiring in an hour: one hour plus the 10-minute grace.
    assert.equal(RelayTtlSeconds("2026-10-13T09:00:00.000Z", NOW.getTime(), 10_800), 4_200);
    assert.equal(RelayTtlSeconds("2026-10-13T20:00:00.000Z", NOW.getTime(), 10_800), 10_800);
    assert.equal(RelayTtlSeconds("2026-10-13T07:00:00.000Z", NOW.getTime(), 10_800), 300);
});
