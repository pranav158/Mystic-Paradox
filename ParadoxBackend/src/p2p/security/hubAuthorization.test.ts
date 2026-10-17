import assert from "node:assert/strict";
import test from "node:test";
import { P2PHostCapabilityRecord, P2PHuntSessionRecord } from "../persistence";
import {
    ActiveHostRuntimeContext,
    BuildPlayerHostRuntimeAuthData,
    GenerateHostCapabilitySecret,
    HostRuntimeContextDependencies,
    HubPresenceCache,
    ResolveActiveHostRuntimeContext
} from "./hostCapabilities";
import {
    HubAllowsWriteKind,
    HubRuntimeRoster,
    HubWriteDenialReason,
    HuntAllowsWriteKind,
    IsHubRuntimeAccount,
    IsRamsgateHubSession,
    IsRealmHubSession
} from "./hubAuthorization";
import { IsRuntimeRosterTarget } from "../../security/runtimeRoster";
import type { HostWriteKind } from "../../extensions/p2p";

const HOST = "host-account";
const MEMBER = "member-account";
const LATE = "late-account";
const NOW = Date.parse("2026-10-14T12:00:00.000Z");

function Hub(overrides: Partial<P2PHuntSessionRecord> = {}): P2PHuntSessionRecord {
    return {
        sessionId: "hub-1", generation: 1, state: "RUNNING", stateVersion: 7, partyId: "realmhub:r1:ramsgate",
        activePartyKey: "realmhub:r1:ramsgate", partyRevision: 1, huntDefinitionId: "ShatteredIsles_ReturnToRamsgate", build: 647472,
        bridgeProtocol: 1, virtualPort: 1, hostAccountId: HOST, hostSteamId: "4242", bridgeInstanceId: "bridge-1", roster: [],
        createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 86_400_000).toISOString(),
        sessionKind: "REALM_HUB", hubKind: "RAMSGATE", realmId: "r1", hostParticipates: true, maxPeers: 16,
        ...overrides
    };
}

function Capability(secretDigest: string, overrides: Partial<P2PHostCapabilityRecord> = {}): P2PHostCapabilityRecord {
    return {
        capabilityId: "cap-1", secretDigest, sessionId: "hub-1", generation: 1, hostAccountId: HOST, hostSteamId: "4242",
        bridgeInstanceId: "bridge-1", scopes: ["HOST_READY", "LEASE_HEARTBEAT", "PEER_ADMITTED", "GAME_SERVER_RUNTIME", "ABORT"],
        issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 86_400_000).toISOString(), lastSequence: 0, ...overrides
    };
}

interface Fixture {
    raw: string;
    deps: HostRuntimeContextDependencies;
    calls: { listPresent: number };
    set(overrides: { capability?: Partial<P2PHostCapabilityRecord> | null; hunt?: Partial<P2PHuntSessionRecord> | null; present?: string[] }): void;
}

function Fixture(): Fixture {
    const { secret, digest } = GenerateHostCapabilitySecret();
    let capability: P2PHostCapabilityRecord | undefined = Capability(digest);
    let hunt: P2PHuntSessionRecord | undefined = Hub();
    let present = [MEMBER];
    const calls = { listPresent: 0 };
    return {
        raw: secret,
        calls,
        deps: {
            findCapability: async (requested) => (capability?.secretDigest === requested ? capability : undefined),
            findHunt: async (sessionId) => (hunt?.sessionId === sessionId ? hunt : undefined),
            listPresent: async () => { calls.listPresent++; return [...present]; }
        },
        set(overrides) {
            if (overrides.capability === null) capability = undefined;
            else if (overrides.capability) capability = { ...capability!, ...overrides.capability };
            if (overrides.hunt === null) hunt = undefined;
            else if (overrides.hunt) hunt = { ...hunt!, ...overrides.hunt };
            if (overrides.present) present = overrides.present;
        }
    };
}

test("the hub's runtime roster is the host and the members present, once each", () => {
    assert.deepEqual(HubRuntimeRoster(HOST, []), [HOST]);
    assert.deepEqual(HubRuntimeRoster(HOST, [MEMBER, LATE]), [HOST, MEMBER, LATE]);
    assert.deepEqual(HubRuntimeRoster(HOST, [MEMBER, HOST, MEMBER]), [HOST, MEMBER]);
    assert.equal(IsHubRuntimeAccount(HOST, [MEMBER], HOST), true);
    assert.equal(IsHubRuntimeAccount(HOST, [MEMBER], MEMBER), true);
    assert.equal(IsHubRuntimeAccount(HOST, [MEMBER], LATE), false);
});

test("hub capability auth: no Bearer identity falls back to the host, which is in the roster even before its row exists", () => {
    const capability = Capability("a".repeat(64));
    const context: ActiveHostRuntimeContext = { capability, hunt: Hub(), presence: { presentAccountIds: [] } };
    const auth = BuildPlayerHostRuntimeAuthData(context);
    assert.equal(auth?.userId, HOST);
    assert.equal(auth?.IsPlayerHostRuntime, true);
    assert.equal(auth?.IsGameserver, false);
    assert.equal(auth?.p2pSessionId, "hub-1");
    assert.equal(auth?.p2pGeneration, 1);
    assert.deepEqual(auth?.RuntimeRosterAccountIds, [HOST]);
});

test("hub capability auth: a present member may be acted for, by Bearer or by route identity; an absent one may not", () => {
    const capability = Capability("a".repeat(64));
    const context: ActiveHostRuntimeContext = { capability, hunt: Hub(), presence: { presentAccountIds: [MEMBER] } };
    const byBearer = BuildPlayerHostRuntimeAuthData(context, { userId: MEMBER, sub: "member-sub" });
    assert.equal(byBearer?.userId, MEMBER);
    assert.equal(byBearer?.sub, "member-sub");
    assert.deepEqual(byBearer?.RuntimeRosterAccountIds, [HOST, MEMBER]);
    const byRoute = BuildPlayerHostRuntimeAuthData(context, undefined, { requestedUserId: MEMBER });
    assert.equal(byRoute?.userId, MEMBER);
    // Not present (never entered, lost, left for a hunt, kicked): refused, whatever the identity source.
    assert.equal(BuildPlayerHostRuntimeAuthData(context, { userId: LATE }), undefined);
    assert.equal(BuildPlayerHostRuntimeAuthData(context, undefined, { requestedUserId: LATE }), undefined);
    assert.equal(BuildPlayerHostRuntimeAuthData({ ...context, presence: { presentAccountIds: [] } }, { userId: MEMBER }), undefined);
    // A signed identity wins over the route's, as for a hunt.
    const both = BuildPlayerHostRuntimeAuthData(context, { userId: MEMBER }, { requestedUserId: HOST });
    assert.equal(both?.userId, MEMBER);
    // A payload without an account id is malformed.
    assert.equal(BuildPlayerHostRuntimeAuthData(context, { sub: "x" } as any), undefined);
});

test("hub capability auth cannot be promoted to the central gameserver by a crafted payload", () => {
    const context: ActiveHostRuntimeContext = { capability: Capability("a".repeat(64)), hunt: Hub(), presence: { presentAccountIds: [MEMBER] } };
    const auth = BuildPlayerHostRuntimeAuthData(context, { userId: MEMBER, IsGameserver: true, IsPlayerHostRuntime: false, p2pSessionId: "other" } as any);
    assert.equal(auth?.IsGameserver, false);
    assert.equal(auth?.IsPlayerHostRuntime, true);
    assert.equal(auth?.p2pSessionId, "hub-1");
});

test("the hub's roster feeds the existing roster checks unchanged", () => {
    const context: ActiveHostRuntimeContext = { capability: Capability("a".repeat(64)), hunt: Hub(), presence: { presentAccountIds: [MEMBER] } };
    const auth = BuildPlayerHostRuntimeAuthData(context, { userId: MEMBER })!;
    assert.equal(IsRuntimeRosterTarget(auth as any, MEMBER), true);
    assert.equal(IsRuntimeRosterTarget(auth as any, HOST), true);
    assert.equal(IsRuntimeRosterTarget(auth as any, LATE), false);
});

test("a hunt's capability still reads its frozen roster (no presence)", () => {
    const hunt: P2PHuntSessionRecord = { ...Hub({ sessionKind: undefined, hubKind: undefined, realmId: undefined }),
        roster: [
            { accountId: HOST, steamId: "4242", candidateId: "c1", reconnectEpoch: 0, admissionState: "PENDING" },
            { accountId: MEMBER, steamId: "4243", candidateId: "c2", reconnectEpoch: 0, admissionState: "ADMITTED" },
            { accountId: LATE, steamId: "4244", candidateId: "c3", reconnectEpoch: 0, admissionState: "ISSUED" }
        ] };
    const context: ActiveHostRuntimeContext = { capability: Capability("a".repeat(64)), hunt };
    assert.equal(BuildPlayerHostRuntimeAuthData(context, { userId: MEMBER })?.userId, MEMBER);
    assert.equal(BuildPlayerHostRuntimeAuthData(context, { userId: LATE }), undefined);
});

test("resolving a hub capability: serving states include SUSPECT, and the present members come with it", async () => {
    const fixture = Fixture();
    for (const state of ["STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"] as const) {
        fixture.set({ hunt: { state } });
        const context = await ResolveActiveHostRuntimeContext(fixture.raw, fixture.deps, NOW);
        assert.ok(context, state);
        assert.deepEqual(context.presence, { presentAccountIds: [MEMBER] }, state);
    }
    for (const state of ["HOST_OFFERED", "FENCED", "ABORTING", "RECOVERING", "COMPLETED", "ABORTED"] as const) {
        fixture.set({ hunt: { state } });
        assert.equal(await ResolveActiveHostRuntimeContext(fixture.raw, fixture.deps, NOW), undefined, state);
    }
});

test("resolving a hunt capability is unchanged: no SUSPECT, no presence read", async () => {
    const fixture = Fixture();
    fixture.set({ hunt: { sessionKind: undefined, hubKind: undefined, state: "RUNNING" } });
    const running = await ResolveActiveHostRuntimeContext(fixture.raw, fixture.deps, NOW);
    assert.ok(running);
    assert.equal(running.presence, undefined);
    fixture.set({ hunt: { state: "SUSPECT" } });
    assert.equal(await ResolveActiveHostRuntimeContext(fixture.raw, fixture.deps, NOW), undefined, "a hunt's runtime stops at SUSPECT");
    assert.equal(fixture.calls.listPresent, 0);
});

test("a hub capability is refused when it is revoked, expired, lacks the runtime scope, or no longer matches the session", async () => {
    const fixture = Fixture();
    assert.ok(await ResolveActiveHostRuntimeContext(fixture.raw, fixture.deps, NOW));
    const refuse = async (note: string, change: Parameters<Fixture["set"]>[0]) => {
        const f = Fixture();
        f.set(change);
        assert.equal(await ResolveActiveHostRuntimeContext(f.raw, f.deps, NOW), undefined, note);
    };
    await refuse("revoked", { capability: { revokedAt: new Date(NOW - 1).toISOString() } });
    await refuse("expired", { capability: { expiresAt: new Date(NOW).toISOString() } });
    await refuse("no runtime scope", { capability: { scopes: ["HOST_READY", "ABORT"] } });
    await refuse("unknown capability", { capability: null });
    await refuse("session gone", { hunt: null });
    await refuse("older generation", { hunt: { generation: 2 } });
    await refuse("another host", { hunt: { hostAccountId: "someone-else" } });
    await refuse("another transport peer", { hunt: { hostSteamId: "9999" } });
    assert.equal(await ResolveActiveHostRuntimeContext("not-a-capability", fixture.deps, NOW), undefined);
    assert.equal(await ResolveActiveHostRuntimeContext(undefined, fixture.deps, NOW), undefined);
});

test("hub presence cache: one load per second, invalidated by a local write, a stale in-flight load is not kept", async () => {
    let now = 1_000_000;
    const cache = new HubPresenceCache(1000, 8, () => now);
    let loads = 0;
    let present = ["a"];
    const load = async () => { loads++; return [...present]; };
    assert.deepEqual(await cache.listPresent("hub-1", 1, load), ["a"]);
    present = ["a", "b"];
    assert.deepEqual(await cache.listPresent("hub-1", 1, load), ["a"], "cached");
    assert.equal(loads, 1);
    now += 999;
    assert.deepEqual(await cache.listPresent("hub-1", 1, load), ["a"]);
    now += 2;
    assert.deepEqual(await cache.listPresent("hub-1", 1, load), ["a", "b"], "reloaded after the cache time");
    assert.equal(loads, 2);
    present = ["b"];
    cache.invalidate("hub-1");
    assert.deepEqual(await cache.listPresent("hub-1", 1, load), ["b"], "a local write shows at once");
    assert.equal(loads, 3);
    // Another hub is its own entry; the generation is part of the key.
    assert.deepEqual(await cache.listPresent("hub-2", 1, async () => ["z"]), ["z"]);
    cache.invalidate("hub-1");
    assert.deepEqual(await cache.listPresent("hub-2", 1, async () => ["not reloaded"]), ["z"]);
    assert.deepEqual(await cache.listPresent("hub-1", 2, async () => ["gen2"]), ["gen2"]);
    // A caller cannot corrupt the cache by changing its answer.
    const answer = await cache.listPresent("hub-1", 2, async () => ["x"]);
    answer.push("tampered");
    assert.deepEqual(await cache.listPresent("hub-1", 2, async () => ["x"]), ["gen2"]);

    // Concurrent callers share one load; a write during it keeps the (possibly stale) answer out of the cache.
    const fresh = new HubPresenceCache(1000, 8, () => now);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let racing = 0;
    const slow = async () => { racing++; await gate; return ["old"]; };
    const first = fresh.listPresent("hub-3", 1, slow);
    const second = fresh.listPresent("hub-3", 1, slow);
    fresh.invalidate("hub-3");
    release();
    assert.deepEqual(await first, ["old"]);
    assert.deepEqual(await second, ["old"]);
    assert.equal(racing, 1, "single flight");
    assert.deepEqual(await fresh.listPresent("hub-3", 1, async () => ["new"]), ["new"], "the stale load was not stored");
});

test("hub presence cache: a failed load is not cached and the next caller loads again", async () => {
    const cache = new HubPresenceCache(1000, 8, () => 5);
    let attempts = 0;
    await assert.rejects(cache.listPresent("hub-1", 1, async () => { attempts++; throw new Error("mongo unavailable"); }), /mongo unavailable/);
    assert.deepEqual(await cache.listPresent("hub-1", 1, async () => { attempts++; return ["a"]; }), ["a"]);
    assert.equal(attempts, 2);
});

test("hub presence cache: bounded", async () => {
    const cache = new HubPresenceCache(60_000, 3, () => 5);
    for (const hub of ["h1", "h2", "h3", "h4", "h5"]) await cache.listPresent(hub, 1, async () => [hub]);
    let reloaded = 0;
    await cache.listPresent("h1", 1, async () => { reloaded++; return ["h1"]; });
    assert.equal(reloaded, 1, "the oldest entries were evicted");
    await cache.listPresent("h5", 1, async () => { reloaded++; return ["h5"]; });
    assert.equal(reloaded, 1, "the newest is still cached");
});

// [2026-10-14 realms S4] Host write kinds by hub (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 7.2).
// [2026-10-16] HUNT_PASS_XP: the active Hunt Pass track's XP, which a hub takes (the game awards it in town).
const ALL_WRITE_KINDS: readonly HostWriteKind[] = ["XP", "MASTERY", "OBJECTIVES", "ESCALATION", "COOLDOWN", "BOUNTY", "SLAYERS_PATH", "REFORGE", "RANK_CONFIRM", "HUNT_PASS_XP"];
const RAMSGATE_WRITE_KINDS: readonly HostWriteKind[] = ["BOUNTY", "COOLDOWN", "SLAYERS_PATH", "ESCALATION", "OBJECTIVES", "MASTERY", "REFORGE", "RANK_CONFIRM", "HUNT_PASS_XP"];
const RAMSGATE_HUB = { sessionKind: "REALM_HUB" as const, hubKind: "RAMSGATE" as const, hostAccountId: HOST };
const TRAINING_HUB = { sessionKind: "REALM_HUB" as const, hubKind: "TRAINING" as const, hostAccountId: HOST };

test("a realm's Ramsgate hub accepts exactly the section 7.2 write kinds, and never XP (decision D4)", () => {
    for (const kind of ALL_WRITE_KINDS) {
        assert.equal(HubAllowsWriteKind("RAMSGATE", kind), RAMSGATE_WRITE_KINDS.includes(kind), kind);
    }
    assert.equal(HubAllowsWriteKind("RAMSGATE", "XP"), false);
});

// [2026-10-16] A Training hub writes what Ramsgate writes, except the reforge (the Training Grounds tutorial saves its quest
// step through the bounty component).
test("a Training hub accepts Ramsgate's write kinds but the reforge; an unknown hub kind or a missing kind accepts none", () => {
    for (const kind of ALL_WRITE_KINDS) {
        assert.equal(HubAllowsWriteKind("TRAINING", kind), kind !== "REFORGE" && HubAllowsWriteKind("RAMSGATE", kind), kind);
    }
    assert.equal(HubAllowsWriteKind("TRAINING", "BOUNTY"), true);
    assert.equal(HubAllowsWriteKind("TRAINING", "REFORGE"), false);
    assert.equal(HubAllowsWriteKind("TRAINING", "XP"), false, "no XP source in a hub");
    assert.equal(HubAllowsWriteKind("SOMETHING_ELSE", "BOUNTY"), false);
    assert.equal(HubAllowsWriteKind(undefined, "BOUNTY"), false);
    assert.equal(HubAllowsWriteKind("RAMSGATE", undefined), false);
});

test("a hunt refuses only the hub-only REFORGE kind; the per-write rules stay with the routes", () => {
    assert.equal(HuntAllowsWriteKind(undefined), true);
    for (const kind of ALL_WRITE_KINDS) assert.equal(HuntAllowsWriteKind(kind), kind !== "REFORGE", kind);
});

// [2026-10-14 realms S4] A rank confirm (RANK_CONFIRM) is the one kind a Ramsgate hub takes that a hunt takes too, for a present member.
test("a rank confirm is allowed in a Ramsgate or Training hub for a present member and the host", () => {
    const presence = { presentAccountIds: [MEMBER] };
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "RANK_CONFIRM", MEMBER, presence), undefined);
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "RANK_CONFIRM", HOST, undefined), undefined);
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "RANK_CONFIRM", LATE, presence), "MEMBER_NOT_PRESENT");
    assert.equal(HubWriteDenialReason(TRAINING_HUB, "RANK_CONFIRM", MEMBER, presence), undefined);
    assert.equal(HubWriteDenialReason(TRAINING_HUB, "RANK_CONFIRM", LATE, presence), "MEMBER_NOT_PRESENT");
    assert.equal(HuntAllowsWriteKind("RANK_CONFIRM"), true);
});

// [2026-10-15] A loadout unlock: a Ramsgate hub's write for a present member and the host; a Training hub refuses it; a hunt allows it.
test("a loadout unlock is allowed in a Ramsgate or Training hub for a present member and the host, and in a hunt", () => {
    const presence = { presentAccountIds: [MEMBER] };
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "LOADOUT_UNLOCK", MEMBER, presence), undefined);
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "LOADOUT_UNLOCK", HOST, undefined), undefined);
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "LOADOUT_UNLOCK", LATE, presence), "MEMBER_NOT_PRESENT");
    assert.equal(HubWriteDenialReason(TRAINING_HUB, "LOADOUT_UNLOCK", MEMBER, presence), undefined);
    assert.equal(HuntAllowsWriteKind("LOADOUT_UNLOCK"), true);
});

test("a hub write needs its kind in that hub and a target present in it (the host counts, nobody else without presence)", () => {
    const presence = { presentAccountIds: [MEMBER] };
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "BOUNTY", MEMBER, presence), undefined);
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "REFORGE", HOST, undefined), undefined, "the host counts with no presence view");
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "BOUNTY", LATE, presence), "MEMBER_NOT_PRESENT");
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "BOUNTY", MEMBER, undefined), "MEMBER_NOT_PRESENT", "no view: only the host");
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, "XP", MEMBER, presence), "WRITE_KIND_NOT_ALLOWED_IN_HUB");
    assert.equal(HubWriteDenialReason(RAMSGATE_HUB, undefined, MEMBER, presence), "WRITE_KIND_NOT_ALLOWED_IN_HUB");
    // [2026-10-16] A Training hub takes a present member's bounty (the tutorial's quest step); the reforge stays Ramsgate's.
    assert.equal(HubWriteDenialReason(TRAINING_HUB, "BOUNTY", MEMBER, presence), undefined);
    assert.equal(HubWriteDenialReason(TRAINING_HUB, "BOUNTY", LATE, presence), "MEMBER_NOT_PRESENT");
    assert.equal(HubWriteDenialReason(TRAINING_HUB, "REFORGE", HOST, undefined), "WRITE_KIND_NOT_ALLOWED_IN_HUB", "the reforge is Ramsgate's");
});

test("the realm-hub and Ramsgate predicates read the session kind and the hub kind only", () => {
    assert.equal(IsRealmHubSession({ sessionKind: "REALM_HUB", hubKind: "TRAINING" }), true);
    assert.equal(IsRealmHubSession({ sessionKind: undefined, hubKind: undefined }), false);
    assert.equal(IsRealmHubSession(undefined), false);
    assert.equal(IsRamsgateHubSession({ sessionKind: "REALM_HUB", hubKind: "RAMSGATE" }), true);
    assert.equal(IsRamsgateHubSession({ sessionKind: "REALM_HUB", hubKind: "TRAINING" }), false);
    assert.equal(IsRamsgateHubSession({ sessionKind: undefined, hubKind: "RAMSGATE" }), false, "a hunt is never a hub");
    assert.equal(IsRamsgateHubSession(undefined), false);
});
