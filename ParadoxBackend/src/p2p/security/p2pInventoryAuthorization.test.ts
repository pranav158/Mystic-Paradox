import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { P2PRepositoryProvider, UseP2PPersistenceForTest } from "../persistence";
import type { RealmHubKind } from "../realm/realmHubRules";
import { CreateHubKit, HOST, HubKit, InstallHubTestEnvironment, MEMBER, REALM_ID, RunningHub, StartRunningHub } from "../realm/realmHubTestKit";
import { BuildPlayerHostRuntimeAuthData, InvalidateHubPresence, ResolveActiveHostRuntimeContext } from "./hostCapabilities";
import { AuthorizeP2PInventoryTransaction, P2PMonitorAnnotator } from "./p2pInventoryAuthorization";
import { DeriveIcePeerId } from "./transportPeerIds";

// [2026-10-14 realms S4] The inventory path of a realm hub (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 7.3) through
// the real authorization: the hub's presence from the test kit, the character ownership from a stub, the grant rules and the
// ledger annotation. The inventory transaction itself is not run; onGrant is called to take the annotator it returns.

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => { restoreEnvironment(); });

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const OWNED_BY: Record<string, string> = { "character-member": MEMBER, "character-host": HOST };

interface Scenario { kit: HubKit; hub: RunningHub }

async function WithHub(hubKind: RealmHubKind, body: (scenario: Scenario) => Promise<void>): Promise<void> {
    const kit = CreateHubKit();
    try {
        const hub = await StartRunningHub(kit, { hubKind });
        // The stub knows which account owns which character; everything else is the real repositories.
        UseP2PPersistenceForTest({
            p2pHunts: kit.hunts,
            realmHub: kit.presence,
            characters: { findByCharacterIdAndUserId: async (characterId: string, userId: string) =>
                OWNED_BY[characterId] === userId ? { characterId, userId } : undefined },
            operationsAlerts: {},
            parties: { findById: async () => undefined, setActivity: async () => undefined, appendEvent: async () => undefined }
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

async function RuntimeRequest(hub: RunningHub, userId: string | undefined, body: Record<string, unknown>): Promise<any> {
    const context = await ResolveActiveHostRuntimeContext(hub.capabilitySecret);
    assert.ok(context, "the hub's capability resolves");
    const AuthData = BuildPlayerHostRuntimeAuthData(context, userId === undefined ? undefined : { userId });
    assert.ok(AuthData, "the runtime may act for this account");
    return { AuthData, body };
}

const loot = { characterId: "character-member", transactionId: "hub-loot-1",
    addInstancedItems: [{ catalogId: "PART_SAMPLE", instanceId: "part-1" }],
    addStackedItems: [{ catalogId: "BREAK_LERAWR_HIDE", quantity: 4 }] };

test("a Ramsgate hub's loot for a present member, on her own character, is accepted and its ledger row names the realm and hub", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub, MEMBER, loot);
        const result = await AuthorizeP2PInventoryTransaction(req, { userId: MEMBER, characterId: "character-member", transactionId: "hub-loot-1" });
        assert.ok("options" in result, "a transaction is authorized");
        const annotate = await (result.options.onGrant as any)({}, {});
        const ledger = annotate({ createdInstancedItems: [{ catalogId: "PART_SAMPLE" }], acceptedStackedAdds: [{ catalogId: "BREAK_LERAWR_HIDE", quantity: 4 }] });
        assert.deepEqual(ledger.p2pMonitor.items, [{ itemId: "PART_SAMPLE", quantity: 1 }, { itemId: "BREAK_LERAWR_HIDE", quantity: 4 }]);
        assert.equal(ledger.p2pMonitor.sessionId, hub.sessionId);
        assert.equal(ledger.p2pMonitor.generation, hub.generation);
        assert.equal(ledger.p2pMonitor.realmId, REALM_ID);
        assert.equal(ledger.p2pMonitor.hubKind, "RAMSGATE");
    });
});

test("the host's own loot in its Ramsgate hub needs no member row and no frozen character", async () => {
    await WithHub("RAMSGATE", async ({ hub }) => {
        const req = await RuntimeRequest(hub, undefined, { ...loot, characterId: "character-host" });
        const result = await AuthorizeP2PInventoryTransaction(req, { userId: HOST, characterId: "character-host", transactionId: "hub-loot-2" });
        assert.ok("options" in result);
    });
});

test("a member who left the hub is refused at the start and inside the transaction", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub, MEMBER, loot);
        await kit.presence.markLost({ sessionId: hub.sessionId, generation: hub.generation, accountId: MEMBER, lostAt: iso(), purgeAt: iso(604_800_000) });
        InvalidateHubPresence(hub.sessionId);
        const result = await AuthorizeP2PInventoryTransaction(req, { userId: MEMBER, characterId: "character-member", transactionId: "hub-loot-3" });
        assert.ok(!("options" in result));
        assert.equal(result.status, 403);
        assert.equal((result.body as { code?: string }).code, "P2P_LOOT_GRANT_DENIED");
    });
});

test("the character must still belong to the account: the ownership check stays in a realm hub", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const req = await RuntimeRequest(hub, MEMBER, { ...loot, characterId: "character-host" });
        const result = await AuthorizeP2PInventoryTransaction(req, { userId: MEMBER, characterId: "character-host", transactionId: "hub-loot-4" });
        assert.ok(!("options" in result));
        assert.equal(result.status, 403);
        assert.equal((result.body as { code?: string }).code, "P2P_LOOT_GRANT_DENIED");
    });
});

test("Platinum is refused in a Ramsgate hub by the grant rule, as in a hunt", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const body = { ...loot, addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 1000 }] };
        const result = await AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, MEMBER, body), { userId: MEMBER, characterId: "character-member", transactionId: "hub-plat" });
        assert.ok(!("options" in result));
        assert.equal(result.status, 403);
        assert.equal((result.body as { code?: string }).code, "P2P_HOST_GRANT_DENIED");
    });
});

// [2026-10-16] A realm's Training hub grants like its Ramsgate (the Training Grounds tutorial pays its quest rewards there).
test("a Training hub grants a reward like Ramsgate does, and accepts a save-only transaction", async () => {
    await WithHub("TRAINING", async ({ kit, hub }) => {
        await Admit(kit, hub, MEMBER);
        const granted = await AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, MEMBER, loot), { userId: MEMBER, characterId: "character-member", transactionId: "dojo-1" });
        assert.ok("options" in granted, "a quest-style grant is authorized in a Training hub");
        const saved = { characterId: "character-member", transactionId: "dojo-2",
            saveInstancedItems: [{ catalogId: "WP_AC_ARMSTRONG", instanceId: "w", itemData: "{}" }] };
        const result = await AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, MEMBER, saved), { userId: MEMBER, characterId: "character-member", transactionId: "dojo-2" });
        assert.ok("options" in result, "saves stay allowed in a Training hub");
    });
});

test("a hunt's ledger row keeps its shape: session and generation only; a realm's adds its realm and hub kind", () => {
    const hunt = P2PMonitorAnnotator("s-1", 2);
    const row = hunt({ createdInstancedItems: [{ catalogId: "PART_SAMPLE" }], acceptedStackedAdds: [] }) as { p2pMonitor: Record<string, unknown> };
    assert.deepEqual(Object.keys(row.p2pMonitor), ["sessionId", "generation", "createdAt", "items"]);
    assert.equal(hunt({ createdInstancedItems: [], acceptedStackedAdds: [] }), undefined, "no items, no row");
    const realm = P2PMonitorAnnotator("hub-1", 3, { realmId: "realm-1", hubKind: "TRAINING" });
    const tagged = realm({ createdInstancedItems: [{ catalogId: "PART_SAMPLE" }], acceptedStackedAdds: [] }) as { p2pMonitor: Record<string, unknown> };
    assert.deepEqual(Object.keys(tagged.p2pMonitor), ["sessionId", "generation", "realmId", "hubKind", "createdAt", "items"]);
    assert.equal(tagged.p2pMonitor.realmId, "realm-1");
    assert.equal(tagged.p2pMonitor.hubKind, "TRAINING");
});
