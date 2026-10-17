import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { logger } from "../../logger";
import { UsePersistenceForTest } from "../../persistence";
import { OpenTestRealm, TestRealm } from "../../persistence/sqlite/testSupport";
import { P2PRepositoryProvider, UseP2PPersistenceForTest } from "../persistence";
import { InMemoryP2PHuntRepository } from "../persistence/memory/InMemoryP2PHuntRepository";
import type { RealmHubKind } from "../realm/realmHubRules";
import { CreateHubKit, HOST, HubKit, InstallHubTestEnvironment, MEMBER, REALM_ID, RunningHub, StartRunningHub, STRANGER } from "../realm/realmHubTestKit";
import { BuildPlayerHostRuntimeAuthData, InvalidateHubPresence, ResolveActiveHostRuntimeContext } from "./hostCapabilities";
import { HOST_POLICY_ENV, HostPolicyRefuses, ResolveHostPolicyMode } from "./hostPolicyMode";
import { AuthorizeHostWrite, HostWriteRow, UseHostWriteSinkForTest } from "./hostWrites";
import { AuthorizeP2PInventoryTransaction } from "./p2pInventoryAuthorization";
import { DeriveIcePeerId } from "./transportPeerIds";

/*
 * [2026-10-16] MYSTICPARADOX_HOST_POLICY's observe mode, the live default
 * (hostPolicyMode.ts): the host grant classes (Platinum, Hunt Pass items, cosmetics, entitlements), a hosted Training hunt's no-reward
 * session, the daily premium draft token's cap and the write kinds a hub does not take are logged as [HostPolicyObserve] and let
 * through; who may write is still checked. The enforce-mode refusals are pinned by the other tests (the hub test kit sets enforce).
 * The authorization runs for real against the hub test kit (hubs) and an in-memory hunt record (hunts); the draft token's in-transaction
 * decision reads a temporary SQLite realm.
 */

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => restoreEnvironment());
// The kit sets enforce for the other tests; observe is the default, so these run with the variable unset.
beforeEach(() => { delete process.env[HOST_POLICY_ENV]; });

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const OWNED_BY: Record<string, string> = { "character-member": MEMBER, "character-host": HOST, "character-stranger": STRANGER };
const CHARACTERS = {
    findByCharacterIdAndUserId: async (characterId: string, userId: string) =>
        OWNED_BY[characterId] === userId ? { characterId, userId } : undefined,
};
const TOKEN = "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM";

/** The warn lines `body` writes (the [HostPolicyObserve] and refusal lines among them). */
async function CaptureWarnings(body: () => Promise<void>): Promise<string[]> {
    const Lines: string[] = [];
    const Original = (logger as any).warn;
    (logger as any).warn = (...args: unknown[]) => { Lines.push(String(args[0])); };
    try {
        await body();
    } finally {
        (logger as any).warn = Original;
    }
    return Lines;
}

interface HubScenario { kit: HubKit; hub: RunningHub; rows: HostWriteRow[] }

async function WithHub(hubKind: RealmHubKind, body: (scenario: HubScenario) => Promise<void>): Promise<void> {
    const kit = CreateHubKit();
    const rows: HostWriteRow[] = [];
    UseHostWriteSinkForTest(async (row) => { rows.push(row); });
    try {
        const hub = await StartRunningHub(kit, { hubKind });
        UseP2PPersistenceForTest({
            p2pHunts: kit.hunts,
            realmHub: kit.presence,
            characters: CHARACTERS,
            operationsAlerts: {},
            parties: { findById: async () => undefined, setActivity: async () => undefined, appendEvent: async () => undefined },
        } as unknown as P2PRepositoryProvider);
        await body({ kit, hub, rows });
    } finally {
        UseP2PPersistenceForTest(undefined);
        UseHostWriteSinkForTest(undefined);
        kit.dispose();
    }
}

async function Admit(kit: HubKit, hub: RunningHub, accountId: string): Promise<void> {
    await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: REALM_ID, accountId,
        peerId: DeriveIcePeerId(accountId), candidateId: `candidate-${accountId}`, now: iso(), expiresAt: iso(90_000) });
    await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: hub.generation, accountId,
        admissionId: `admission-${accountId}`, admittedAt: iso(), now: iso(), route: "relay" });
    InvalidateHubPresence(hub.sessionId);
}

async function HubRequest(hub: RunningHub, userId: string, body: Record<string, unknown> = {}): Promise<any> {
    const context = await ResolveActiveHostRuntimeContext(hub.capabilitySecret);
    assert.ok(context, "the hub's capability resolves");
    const AuthData = BuildPlayerHostRuntimeAuthData(context, { userId });
    assert.ok(AuthData, "the runtime may act for this account");
    return { AuthData, body };
}

test("the mode: unset and observe let policy refusals through, enforce refuses, anything else is observe with a warning", () => {
    assert.deepEqual(ResolveHostPolicyMode({}), { mode: "observe", isDefault: true });
    assert.deepEqual(ResolveHostPolicyMode({ [HOST_POLICY_ENV]: " Observe " }), { mode: "observe", isDefault: false });
    assert.deepEqual(ResolveHostPolicyMode({ [HOST_POLICY_ENV]: "ENFORCE" }), { mode: "enforce", isDefault: false });
    const Typo = ResolveHostPolicyMode({ [HOST_POLICY_ENV]: "enforced" });
    assert.equal(Typo.mode, "observe");
    assert.match(Typo.warning ?? "", /must be observe or enforce/);
    assert.equal(HostPolicyRefuses({}), false);
    assert.equal(HostPolicyRefuses({ [HOST_POLICY_ENV]: "enforce" }), true);
});

test("observe: a Ramsgate hub's Platinum, Hunt Pass token and cosmetic grant is authorized and logged with its classes", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const Body = { characterId: "character-member", transactionId: "observe-grant-1", addStackedItems: [
            { catalogId: "CURRENCY_PLATINUM_UNIV", quantity: 50 },
            { catalogId: "TOKEN_BOUNTY_DRAFT_PREMIUM", quantity: 1 },
            { catalogId: "DYE_BLUE05_DURABLE", quantity: 1 },
        ] };
        let Result: any;
        const Lines = await CaptureWarnings(async () => {
            Result = await AuthorizeP2PInventoryTransaction(await HubRequest(hub, MEMBER, Body),
                { userId: MEMBER, characterId: "character-member", transactionId: "observe-grant-1" });
        });
        assert.ok("options" in Result, "authorized");
        const Observed = Lines.filter((Line) => Line.startsWith("[HostPolicyObserve] would refuse grant"));
        assert.equal(Observed.length, 1, Lines.join("\n"));
        for (const Class of ["PREMIUM_CURRENCY", "HUNT_PASS", "COSMETIC"]) assert.ok(Observed[0].includes(Class), Observed[0]);
        assert.ok(Observed[0].includes("transaction=observe-grant-1") && Observed[0].includes("hub=RAMSGATE"), Observed[0]);
        assert.ok(!Lines.some((Line) => Line.startsWith("[HostGrantDeny]")), Lines.join("\n"));
    });
});

/** The hub runtime's request as if it acted for `userId`, built from a present member's (the auth layer itself refuses an absent one). */
function AsAccount(req: any, userId: string, body: Record<string, unknown> = {}): any {
    return { AuthData: { ...req.AuthData, userId }, body };
}

test("observe: who may write is still checked - a grant for a player who is not in the hub is refused", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const Body = { characterId: "character-stranger", transactionId: "observe-absent-1",
            addStackedItems: [{ catalogId: "CURRENCY_PLATINUM_UNIV", quantity: 50 }] };
        const Result: any = await AuthorizeP2PInventoryTransaction(AsAccount(await HubRequest(hub, MEMBER), STRANGER, Body),
            { userId: STRANGER, characterId: "character-stranger", transactionId: "observe-absent-1" });
        assert.ok(!("options" in Result), "refused: that player was never admitted to this hub");
        assert.equal(Result.status, 403);
    });
});

// ---- a hosted Training hunt (no-reward session), on an in-memory hunt record ----

const HUNT_ID = "hunt-observe-1";

async function WithTrainingHunt(body: () => Promise<void>): Promise<void> {
    const hunts = new InMemoryP2PHuntRepository();
    await hunts.createHunt({
        sessionId: HUNT_ID, generation: 1, state: "RUNNING", stateVersion: 1, partyId: "party-1", partyRevision: 1,
        huntDefinitionId: "Training", build: 1, bridgeProtocol: 1, virtualPort: 1, hostAccountId: HOST, hostSteamId: "host-steam",
        bridgeInstanceId: "bridge-1", roster: [{ accountId: MEMBER, admissionState: "ADMITTED" }],
        frozenLoadouts: [{ accountId: MEMBER, characterId: "character-member", loadoutRevision: 1, activeIndex: 0,
            characterUpdateVersion: 1, characterDataDigest: "digest", digest: "digest" }],
        guardCompletionMode: "NO_COMPLETION", trustTier: 0, createdAt: iso(), expiresAt: iso(600_000),
    } as any);
    UseP2PPersistenceForTest({
        p2pHunts: hunts,
        characters: CHARACTERS,
        operationsAlerts: {},
        parties: { findById: async () => undefined, setActivity: async () => undefined, appendEvent: async () => undefined },
    } as unknown as P2PRepositoryProvider);
    try {
        await body();
    } finally {
        UseP2PPersistenceForTest(undefined);
    }
}

test("observe: a hosted Training hunt's Platinum spend (a no-reward session) is authorized and logged", async () => {
    await WithTrainingHunt(async () => {
        let Result: any;
        const Lines = await CaptureWarnings(async () => {
            Result = await AuthorizeP2PInventoryTransaction({ AuthData: { IsPlayerHostRuntime: true, IsGameserver: false, userId: MEMBER,
                p2pSessionId: HUNT_ID, p2pGeneration: 1 }, body: { characterId: "character-member", transactionId: "observe-training-1",
                removeStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 100 }] } } as any,
                { userId: MEMBER, characterId: "character-member", transactionId: "observe-training-1" });
        });
        assert.ok("options" in Result, "authorized");
        assert.ok(Lines.some((Line) => Line.startsWith("[HostPolicyObserve] would refuse grant") && Line.includes("NO_REWARD_SESSION")),
            Lines.join("\n"));
    });
});

// ---- the daily premium draft token's cap, decided inside the transaction ----

test("observe: a draft premium token over the cap is granted, and the cap is logged before and inside the transaction", async () => {
    const Realm: TestRealm = OpenTestRealm("host-policy-observe-draft");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    try {
        await Realm.repos.inventories.create({ characterId: "character-member", userId: MEMBER, instancedItems: "[]",
            stackedItems: JSON.stringify([{ catalogId: TOKEN, quantity: 1 }]), revision: 0 });
        await WithHub("RAMSGATE", async ({ kit, hub }) => {
            await Admit(kit, hub, MEMBER);
            const Body = { characterId: "character-member", transactionId: "observe-draft-1", addStackedItems: [{ catalogId: TOKEN, quantity: 1 }] };
            let Result: any;
            const Lines = await CaptureWarnings(async () => {
                Result = await AuthorizeP2PInventoryTransaction(await HubRequest(hub, MEMBER, Body),
                    { userId: MEMBER, characterId: "character-member", transactionId: "observe-draft-1" });
                assert.ok("options" in Result, "authorized");
                await (Result.options.onGrant as any)(Realm.repos, {});
            });
            assert.ok(Lines.some((Line) => Line.startsWith("[HostPolicyObserve] would refuse grant") && Line.includes("draftPremium=OVER_BALANCE_CAP")),
                Lines.join("\n"));
            assert.ok(Lines.some((Line) => Line.startsWith("[HostPolicyObserve] would refuse draft premium") &&
                Line.includes("reason=OVER_BALANCE_CAP at=transaction") && Line.includes("balance=1->2 cap=1")), Lines.join("\n"));
        });
    } finally {
        UsePersistenceForTest(undefined);
        await Realm.cleanup();
    }
});

// ---- write kinds ----

test("observe: a Ramsgate hub's XP write for a present member is authorized and logged; an absent player is still refused", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub, rows }) => {
        await Admit(kit, hub, MEMBER);
        const Req = await HubRequest(hub, MEMBER);
        let Denial: unknown;
        const Lines = await CaptureWarnings(async () => { Denial = await AuthorizeHostWrite(Req, "XP", MEMBER); });
        assert.equal(Denial, undefined, "authorized in observe");
        assert.ok(Lines.some((Line) => Line.startsWith("[HostPolicyObserve] would refuse write kind=XP") &&
            Line.includes("reason=WRITE_KIND_NOT_ALLOWED_IN_HUB") && Line.includes("hub=RAMSGATE")), Lines.join("\n"));
        assert.ok(!Lines.some((Line) => Line.startsWith("[HostWrite] refused")), Lines.join("\n"));

        let Refused: any;
        const AbsentLines = await CaptureWarnings(async () => { Refused = await AuthorizeHostWrite(Req, "XP", STRANGER); });
        assert.equal(Refused?.status, 403, "a write kind never lets an absent player through");
        assert.ok(AbsentLines.some((Line) => Line.startsWith("[HostWrite] refused kind=XP") && Line.includes("reason=MEMBER_NOT_PRESENT")),
            AbsentLines.join("\n"));
        assert.equal(rows.length, 0, "authorizing writes no tag; the route tags an accepted write");
    });
});

test("observe: a probe stays strict and quiet - the XP route's kind probes are refused without a log line", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const Req = await HubRequest(hub, MEMBER);
        let Probe: any;
        const Lines = await CaptureWarnings(async () => { Probe = await AuthorizeHostWrite(Req, "XP", MEMBER, { probe: true }); });
        assert.equal(Probe?.status, 403);
        assert.deepEqual(Lines, []);
        assert.equal(await AuthorizeHostWrite(Req, "HUNT_PASS_XP", MEMBER, { probe: true }), undefined, "a kind the hub takes passes a probe");
    });
});

test("observe: a Training hub's reforge write is authorized and logged", async () => {
    await WithHub("TRAINING", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        let Denial: unknown;
        const Lines = await CaptureWarnings(async () => { Denial = await AuthorizeHostWrite(await HubRequest(hub, MEMBER), "REFORGE", MEMBER); });
        assert.equal(Denial, undefined);
        assert.ok(Lines.some((Line) => Line.includes("would refuse write kind=REFORGE") && Line.includes("hub=TRAINING")), Lines.join("\n"));
    });
});

// ---- [2026-10-17] dedicated parity: a dedicated server's own work for a player of the session (the reforge repair at load) ----

test("parity: a realm hub's dedicated-server work for a present member is allowed quietly, whatever the write kind", async () => {
    await WithHub("TRAINING", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const Req = await HubRequest(hub, MEMBER);
        let Allowed: unknown;
        const Lines = await CaptureWarnings(async () => { Allowed = await AuthorizeHostWrite(Req, "REFORGE", MEMBER, { parity: true }); });
        assert.equal(Allowed, undefined, "a Training hub takes no REFORGE write, but the repair of a member's own reforge is a server's job");
        assert.deepEqual(Lines, [], "quiet: no would-refuse line, no refusal line");
        let Absent: any;
        const AbsentLines = await CaptureWarnings(async () => { Absent = await AuthorizeHostWrite(Req, "REFORGE", STRANGER, { parity: true }); });
        assert.equal(Absent?.status, 403, "a player who is not in the hub is never this server's player");
        assert.deepEqual(AbsentLines, []);
    });
});

test("parity: enforce keeps the dedicated-only paths for dedicated servers", async () => {
    process.env[HOST_POLICY_ENV] = "enforce";
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        assert.equal((await AuthorizeHostWrite(await HubRequest(hub, MEMBER), "REFORGE", MEMBER, { parity: true }))?.status, 403);
    });
});

test("enforce: the same Ramsgate XP write is refused as before", async () => {
    process.env[HOST_POLICY_ENV] = "enforce";
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        assert.equal((await AuthorizeHostWrite(await HubRequest(hub, MEMBER), "XP", MEMBER))?.status, 403);
    });
});
