import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { RunInventoryTransaction } from "../../controllers/inventory";
import { WaitForEconomyRollups } from "../../diagnostics/economyLedgerMonitor";
import { logger } from "../../logger";
import { UsePersistenceForTest } from "../../persistence";
import { OpenTestRealm, TestRealm } from "../../persistence/sqlite/testSupport";
import { P2PRepositoryProvider, UseP2PPersistenceForTest } from "../persistence";
import { InMemoryP2PHuntRepository } from "../persistence/memory/InMemoryP2PHuntRepository";
import type { RealmHubKind } from "../realm/realmHubRules";
import { CreateHubKit, HOST, HubKit, InstallHubTestEnvironment, MEMBER, REALM_ID, RunningHub, StartRunningHub } from "../realm/realmHubTestKit";
import { BuildPlayerHostRuntimeAuthData, InvalidateHubPresence, ResolveActiveHostRuntimeContext } from "./hostCapabilities";
import { AuthorizeP2PInventoryTransaction } from "./p2pInventoryAuthorization";
import { DeriveIcePeerId } from "./transportPeerIds";

// [2026-10-14 owner decision] A host may spend a player's Platinum (a stacked removal) in a hunt and in a realm's Ramsgate hub.
// It may never grant Platinum, and a Training hub or a no-reward hunt refuses every spend. The spend is logged by the economy
// ledger with the host's session and host (diagnostics/economyLedgerMonitor.ts). The authorization runs for real, against the
// hub test kit (hubs) and an in-memory hunt repository (hunts); the transaction runs against a temporary SQLite realm.

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => restoreEnvironment());

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const OWNED_BY: Record<string, string> = { "character-member": MEMBER, "character-host": HOST };
const CHARACTERS = {
    findByCharacterIdAndUserId: async (characterId: string, userId: string) =>
        OWNED_BY[characterId] === userId ? { characterId, userId } : undefined,
};
const SPEND = { removeStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 100 }] };

/** Captures the monitor's info lines while `body` runs. */
async function CaptureInfo(body: () => Promise<void>): Promise<string[]> {
    const Lines: string[] = [];
    const Original = (logger as any).info;
    (logger as any).info = (...args: unknown[]) => { Lines.push(String(args[0])); };
    try {
        await body();
        await WaitForEconomyRollups();
    } finally {
        (logger as any).info = Original;
    }
    return Lines.filter((Line) => Line.startsWith("[PlatMon]"));
}

// ---- realm hubs (the hub test kit) ----

interface HubScenario { kit: HubKit; hub: RunningHub }

async function WithHub(hubKind: RealmHubKind, body: (scenario: HubScenario) => Promise<void>): Promise<void> {
    const kit = CreateHubKit();
    try {
        const hub = await StartRunningHub(kit, { hubKind });
        UseP2PPersistenceForTest({
            p2pHunts: kit.hunts,
            realmHub: kit.presence,
            characters: CHARACTERS,
            operationsAlerts: {},
            parties: { findById: async () => undefined, setActivity: async () => undefined, appendEvent: async () => undefined },
        } as unknown as P2PRepositoryProvider);
        await body({ kit, hub });
    } finally {
        UseP2PPersistenceForTest(undefined);
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

async function HubRequest(hub: RunningHub, userId: string, body: Record<string, unknown>): Promise<any> {
    const context = await ResolveActiveHostRuntimeContext(hub.capabilitySecret);
    assert.ok(context, "the hub's capability resolves");
    const AuthData = BuildPlayerHostRuntimeAuthData(context, { userId });
    assert.ok(AuthData, "the runtime may act for this account");
    return { AuthData, body };
}

test("a host's Platinum spend in a Ramsgate hub is authorized, and its transaction names the hub's session and the host", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const req = await HubRequest(hub, MEMBER, { characterId: "character-member", ...SPEND, transactionId: "hub-spend-1" });
        const result = await AuthorizeP2PInventoryTransaction(req, { userId: MEMBER, characterId: "character-member", transactionId: "hub-spend-1" });
        assert.ok("options" in result, "the spend is authorized");
        assert.deepEqual(result.options.economy, { source: "INVENTORY_HOST", p2pSessionId: hub.sessionId, hostAccountId: HOST });
    });
});

test("a host's Platinum grant in a Ramsgate hub stays refused", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const req = await HubRequest(hub, MEMBER, { characterId: "character-member",
            addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 1000 }], transactionId: "hub-grant-1" });
        const result = await AuthorizeP2PInventoryTransaction(req, { userId: MEMBER, characterId: "character-member", transactionId: "hub-grant-1" });
        assert.ok(!("options" in result));
        assert.equal(result.status, 403);
        assert.equal((result.body as { code?: string }).code, "P2P_HOST_GRANT_DENIED");
    });
});

// [2026-10-16] A Training hub decides a spend as its Ramsgate does (it was a no-reward session).
test("a Training hub authorizes a Platinum spend the way a Ramsgate hub does", async () => {
    await WithHub("TRAINING", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const req = await HubRequest(hub, MEMBER, { characterId: "character-member", ...SPEND, transactionId: "training-spend-1" });
        const result = await AuthorizeP2PInventoryTransaction(req, { userId: MEMBER, characterId: "character-member", transactionId: "training-spend-1" });
        assert.ok("options" in result, "authorized");
    });
});

// ---- hunts (an in-memory hunt record) ----

const HUNT_ID = "hunt-spend-1";

/** A running hunt with one admitted member on her frozen character; the hunt repository is in memory. */
async function WithHunt(guardCompletionMode: "END_OF_HUNT" | "NO_COMPLETION", body: () => Promise<void>): Promise<void> {
    const hunts = new InMemoryP2PHuntRepository();
    await hunts.createHunt({
        sessionId: HUNT_ID, generation: 1, state: "RUNNING", stateVersion: 1, partyId: "party-1", partyRevision: 1,
        huntDefinitionId: "IslandA", build: 1, bridgeProtocol: 1, virtualPort: 1, hostAccountId: HOST, hostSteamId: "host-steam",
        bridgeInstanceId: "bridge-1", roster: [{ accountId: MEMBER, admissionState: "ADMITTED" }],
        frozenLoadouts: [{ accountId: MEMBER, characterId: "character-member", loadoutRevision: 1, activeIndex: 0,
            characterUpdateVersion: 1, characterDataDigest: "digest", digest: "digest" }],
        guardCompletionMode, trustTier: 0, createdAt: iso(), expiresAt: iso(600_000),
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

function HuntRequest(body: Record<string, unknown>): any {
    return { AuthData: { IsPlayerHostRuntime: true, IsGameserver: false, userId: MEMBER, p2pSessionId: HUNT_ID, p2pGeneration: 1 }, body };
}

test("a host's Platinum spend in a hunt is authorized, and a Platinum grant in the same hunt is still refused", async () => {
    await WithHunt("END_OF_HUNT", async () => {
        const Spend = await AuthorizeP2PInventoryTransaction(HuntRequest({ characterId: "character-member", ...SPEND, transactionId: "h-1" }),
            { userId: MEMBER, characterId: "character-member", transactionId: "h-1" });
        assert.ok("options" in Spend, "the spend is authorized");
        assert.deepEqual(Spend.options.economy, { source: "INVENTORY_HOST", p2pSessionId: HUNT_ID, hostAccountId: HOST });
        const Grant = await AuthorizeP2PInventoryTransaction(HuntRequest({ characterId: "character-member",
            addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 1000 }], transactionId: "h-2" }),
            { userId: MEMBER, characterId: "character-member", transactionId: "h-2" });
        assert.ok(!("options" in Grant));
        assert.equal(Grant.status, 403);
        assert.equal((Grant.body as { code?: string }).code, "P2P_HOST_GRANT_DENIED");
    });
});

test("a no-reward hunt (a hosted Training hunt) refuses a Platinum spend", async () => {
    await WithHunt("NO_COMPLETION", async () => {
        const Result = await AuthorizeP2PInventoryTransaction(HuntRequest({ characterId: "character-member", ...SPEND, transactionId: "h-3" }),
            { userId: MEMBER, characterId: "character-member", transactionId: "h-3" });
        assert.ok(!("options" in Result));
        assert.equal(Result.status, 403);
    });
});

test("a host's Platinum spend in a hunt is accepted by the transaction and logged with its session, host and what it granted", async () => {
    const Realm: TestRealm = OpenTestRealm("hunt-platinum-spend");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    try {
        await Realm.repos.inventories.create({ characterId: "character-member", userId: MEMBER, instancedItems: "[]", stackedItems: "[]", revision: 0 });
        await RunInventoryTransaction(MEMBER, "character-member", "fund-hunt", [], [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 400 }], [], [], [],
            { ownershipAlreadyValidated: true, economy: { source: "INVENTORY_GAMESERVER" } });
        await WithHunt("END_OF_HUNT", async () => {
            const Adds = [{ catalogId: "BREAK_LERAWR_HIDE", quantity: 3 }];
            const Removes = [{ catalogId: "CURRENCY_PLATINUM", quantity: 150 }];
            const Result = await AuthorizeP2PInventoryTransaction(
                HuntRequest({ characterId: "character-member", transactionId: "hunt-spend-txn", addStackedItems: Adds, removeStackedItems: Removes }),
                { userId: MEMBER, characterId: "character-member", transactionId: "hunt-spend-txn" });
            assert.ok("options" in Result);
            // The ledger fence (onGrant) is the P2P emergency-stop check, tested with the authorization; the transaction runs without it here.
            const { onGrant: _ledgerFence, ...Options } = Result.options;
            const Lines = await CaptureInfo(async () => {
                await RunInventoryTransaction(MEMBER, "character-member", "hunt-spend-txn", [], Adds, [], Removes, [],
                    { ...Options, ownershipAlreadyValidated: true });
            });
            assert.deepEqual(Lines.filter((Line) => Line.startsWith("[PlatMon] spend")), [
                `[PlatMon] spend user=${MEMBER} amount=150 balanceAfter=250 source=INVENTORY_HOST for=BREAK_LERAWR_HIDE:3 session=${HUNT_ID} host=${HOST} ref=hunt-spend-txn`,
            ]);
        });
    } finally {
        UsePersistenceForTest(undefined);
        await Realm.cleanup();
    }
});

test("a host's Platinum spend in a Ramsgate hub is accepted by the transaction and logged with its hub session, host and what it granted", async () => {
    const Realm: TestRealm = OpenTestRealm("hub-platinum-spend");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    try {
        await Realm.repos.inventories.create({ characterId: "character-member", userId: MEMBER, instancedItems: "[]", stackedItems: "[]", revision: 0 });
        await RunInventoryTransaction(MEMBER, "character-member", "fund-hub", [], [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 400 }], [], [], [],
            { ownershipAlreadyValidated: true, economy: { source: "INVENTORY_GAMESERVER" } });
        await WithHub("RAMSGATE", async ({ kit, hub }) => {
            await Admit(kit, hub, MEMBER);
            const Adds = [{ catalogId: "BREAK_LERAWR_HIDE", quantity: 2 }];
            const Removes = [{ catalogId: "CURRENCY_PLATINUM", quantity: 120 }];
            const Req = await HubRequest(hub, MEMBER, { characterId: "character-member", transactionId: "hub-spend-txn", addStackedItems: Adds, removeStackedItems: Removes });
            const Result = await AuthorizeP2PInventoryTransaction(Req, { userId: MEMBER, characterId: "character-member", transactionId: "hub-spend-txn" });
            assert.ok("options" in Result, "the spend is authorized");
            const { onGrant: _ledgerFence, ...Options } = Result.options;
            const Lines = await CaptureInfo(async () => {
                await RunInventoryTransaction(MEMBER, "character-member", "hub-spend-txn", [], Adds, [], Removes, [], { ...Options, ownershipAlreadyValidated: true });
            });
            assert.deepEqual(Lines.filter((Line) => Line.startsWith("[PlatMon] spend")), [
                `[PlatMon] spend user=${MEMBER} amount=120 balanceAfter=280 source=INVENTORY_HOST for=BREAK_LERAWR_HIDE:2 session=${hub.sessionId} host=${HOST} ref=hub-spend-txn`,
            ]);
        });
    } finally {
        UsePersistenceForTest(undefined);
        await Realm.cleanup();
    }
});
