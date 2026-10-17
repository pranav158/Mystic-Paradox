import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

/*
 * [2026-10-15] The daily premium draft token through the real inventory authorization of a realm hub (AuthorizeP2PInventoryTransaction),
 * with the season's pass name read from game-data/progression_config.json (a .gamedata test). The hub, presence and character reads are
 * the realm hub test kit's; the core repositories (inventory, entitlements, the account's bounty record) are in memory. The logger
 * records its lines, so the [HostGrantAllow] and [HostGrantDeny] lines are checked too. The replay path needs the real ledger and is in
 * hostDraftPremiumDaily.gamedata.test.ts. [2026-10-16] Only the balance cap decides; the bounty record is kept in memory to show that the
 * grant neither reads a day from it nor writes one.
 */

const TodayUtc = () => new Date().toISOString().slice(0, 10);

const Lines: string[] = [];
const Quiet = () => undefined;
const Recorder = (message: unknown) => { Lines.push(String(message)); };
const LoggerStub = { level: "silent", trace: Quiet, debug: Recorder, info: Recorder, warn: Recorder, error: Recorder, fatal: Quiet, child: () => ({}) };
require.cache[require.resolve("../../logger")] = {
    id: require.resolve("../../logger"), filename: require.resolve("../../logger"), loaded: true,
    exports: { logger: LoggerStub, ApplyDiagnosticsLogProfile: Quiet }, children: [], paths: [],
} as unknown as NodeJS.Module;

const TOKEN = "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM";
const Inventories = new Map<string, { stackedItems: string }>();
const Entitlements = new Map<string, { userId: string; entitlements: { name: string; duration: number; activatedDate: null }[] }>();
const Bounties = new Map<string, any>();
const CoreRepos = {
    inventories: { findByCharacterId: async (characterId: string) => Inventories.get(characterId) },
    entitlements: { findByUserId: async (userId: string) => Entitlements.get(userId) },
    // [2026-10-15] The account's bounty record, written with the same version check as the real repository (a stale write is refused).
    bountyStates: {
        get: async (userId: string) => Bounties.get(userId),
        saveIfVersion: async (record: any, expectedVersion: number | undefined) => {
            const Current = Bounties.get(record.userId);
            const Matches = expectedVersion === undefined ? Current === undefined : Current?.updateVersion === expectedVersion;
            if (!Matches) return undefined;
            Bounties.set(record.userId, record);
            return record;
        },
    },
    // [2026-10-15] No ledger rows here: the replay path is tested with the real ledger in hostDraftPremiumDaily.gamedata.test.ts.
    inventoryTransactions: { findRecord: async () => undefined },
};
const RecordOf = (userId: string, dailyPremiumDraftGrantedOn: string, updateVersion = 2) =>
    ({ userId, bounties: [], draftData: {}, dailyPremiumDraftGrantedOn, updateVersion, createdAt: iso(), updatedAt: iso() });
beforeEach(() => { Bounties.clear(); });

let Authorization: typeof import("./p2pInventoryAuthorization");
let Kit: typeof import("../realm/realmHubTestKit");
let P2P: typeof import("../persistence");
let HostCapabilities: typeof import("./hostCapabilities");
let Peers: typeof import("./transportPeerIds");
let Core: typeof import("../../persistence");
let PassName: string | undefined;
let restoreEnvironment: () => void;

before(() => {
    Authorization = require("./p2pInventoryAuthorization");
    Kit = require("../realm/realmHubTestKit");
    P2P = require("../persistence");
    HostCapabilities = require("./hostCapabilities");
    Peers = require("./transportPeerIds");
    Core = require("../../persistence");
    PassName = require("./hostDraftPremium").ActivePremiumPassEntitlement();
    restoreEnvironment = Kit.InstallHubTestEnvironment();
    Core.UsePersistenceForTest({ repos: CoreRepos as unknown as import("../../persistence").RepositoryProvider, uow: {} as never });
});

after(() => {
    restoreEnvironment?.();
    Core.UsePersistenceForTest(undefined);
});

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const OWNED_BY: Record<string, string> = { "character-member": "member-1", "character-host": "host-1" };

async function WithHub(hubKind: "RAMSGATE" | "TRAINING", body: (scenario: { kit: any; hub: any }) => Promise<void>): Promise<void> {
    const kit = Kit.CreateHubKit();
    try {
        const hub = await Kit.StartRunningHub(kit, { hubKind });
        P2P.UseP2PPersistenceForTest({
            p2pHunts: kit.hunts,
            realmHub: kit.presence,
            characters: { findByCharacterIdAndUserId: async (characterId: string, userId: string) =>
                OWNED_BY[characterId] === userId ? { characterId, userId } : undefined },
            operationsAlerts: {},
            parties: { findById: async () => undefined, setActivity: async () => undefined, appendEvent: async () => undefined }
        } as unknown as import("../persistence").P2PRepositoryProvider);
        await body({ kit, hub });
    } finally {
        P2P.UseP2PPersistenceForTest(undefined);
        kit.dispose();
    }
}

async function Admit(kit: any, hub: any, accountId: string): Promise<void> {
    await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: Kit.REALM_ID, accountId,
        peerId: Peers.DeriveIcePeerId(accountId), candidateId: `candidate-${accountId}`, now: iso(), expiresAt: iso(90_000) });
    await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: hub.generation, accountId,
        admissionId: `admission-${accountId}`, admittedAt: iso(), now: iso(), route: "relay" });
    HostCapabilities.InvalidateHubPresence(hub.sessionId);
}

async function RuntimeRequest(hub: any, userId: string | undefined, body: Record<string, unknown>): Promise<any> {
    const context = await HostCapabilities.ResolveActiveHostRuntimeContext(hub.capabilitySecret);
    assert.ok(context, "the hub's capability resolves");
    const AuthData = HostCapabilities.BuildPlayerHostRuntimeAuthData(context, userId === undefined ? undefined : { userId });
    assert.ok(AuthData, "the runtime may act for this account");
    return { AuthData, body };
}

function StackOf(...items: { catalogId: string; quantity: number }[]): string {
    return JSON.stringify(items);
}

function Holds(userId: string, ...names: string[]): void {
    Entitlements.set(userId, { userId, entitlements: names.map((name) => ({ name, duration: 0, activatedDate: null })) });
}

const grant = (characterId: string, extra: Record<string, unknown> = {}) => ({
    characterId, transactionId: `draft-${characterId}-${Math.random().toString(36).slice(2)}`,
    addStackedItems: [{ catalogId: TOKEN, quantity: 1 }], ...extra,
});

test("the season's pass name is read from the game data", () => {
    assert.equal(PassName, "season43_premium");
});

test("a realm hub grants the daily premium token to a member who holds the pass and has none unspent; the accepted grant is logged", async () => {
    Lines.length = 0;
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, "member-1");
        Holds("member-1", PassName!);
        Inventories.set("character-member", { stackedItems: StackOf() });
        const body = grant("character-member", { transactionId: "draft-premium-1" });
        const result = await Authorization.AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, "member-1", body),
            { userId: "member-1", characterId: "character-member", transactionId: "draft-premium-1" });
        assert.ok("options" in result, "authorized");
        await (result.options.onGrant as any)(CoreRepos, {});
        (result as any).report("accepted");
        const allow = Lines.filter((line) => line.includes("[HostGrantAllow]"));
        assert.equal(allow.length, 1);
        assert.ok(allow[0].includes(`item=${TOKEN} quantity=1 reason=WITHIN_BALANCE_CAP day=${TodayUtc()} balance=0->1 cap=1`), allow[0]);
        assert.equal(Bounties.get("member-1"), undefined, "nothing is written on the account");
        assert.ok(allow[0].includes("transaction=draft-premium-1"));
    });
});

test("the host's own token in its Ramsgate hub is decided the same way (the host counts as the player)", async () => {
    await WithHub("RAMSGATE", async ({ hub }) => {
        Holds("host-1", PassName!);
        Inventories.set("character-host", { stackedItems: StackOf() });
        const result = await Authorization.AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, undefined, grant("character-host", { transactionId: "draft-host-1" })),
            { userId: "host-1", characterId: "character-host", transactionId: "draft-host-1" });
        assert.ok("options" in result, "authorized");
    });
});

test("the balance is read again inside the transaction: a token that arrived after the early check is refused there, with 403", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, "member-1");
        Holds("member-1", PassName!);
        Inventories.set("character-member", { stackedItems: StackOf() });
        const body = grant("character-member", { transactionId: "draft-race-1" });
        const result = await Authorization.AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, "member-1", body),
            { userId: "member-1", characterId: "character-member", transactionId: "draft-race-1" });
        assert.ok("options" in result, "the early check passed");
        Inventories.set("character-member", { stackedItems: StackOf({ catalogId: TOKEN, quantity: 1 }) });
        await assert.rejects((result.options.onGrant as any)(CoreRepos, {}), /P2P_LOOT_GRANT_DRAFT_PREMIUM_OVER_BALANCE_CAP/);
        const denial = (result as any).errorResponse(new Error("P2P_LOOT_GRANT_DRAFT_PREMIUM_OVER_BALANCE_CAP"));
        assert.equal(denial?.status, 403);
        assert.equal(denial?.body.code, "P2P_LOOT_GRANT_DRAFT_PREMIUM_OVER_BALANCE_CAP");
    });
});

// [2026-10-16] Every account may have the daily token: a member without the season's pass is granted it like anyone else (the
// refusal left a new player's bounty load unfinished and the hub sent them back to the menu).
test("a member without the season's pass is granted the daily token too, and the grant is logged", async () => {
    Lines.length = 0;
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, "member-1");
        Holds("member-1", "season42_premium");
        Inventories.set("character-member", { stackedItems: StackOf() });
        const result = await Authorization.AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, "member-1", grant("character-member", { transactionId: "draft-nopass-1" })),
            { userId: "member-1", characterId: "character-member", transactionId: "draft-nopass-1" });
        assert.ok("options" in result, "authorized");
        await (result.options.onGrant as any)(CoreRepos, {});
        (result as any).report("accepted");
    });
    const allow = Lines.filter((line) => line.includes("[HostGrantAllow]"));
    assert.equal(allow.length, 1);
    assert.ok(allow[0].includes("reason=WITHIN_BALANCE_CAP"), allow[0]);
});

test("a member who already holds an unspent token is refused before the transaction", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, "member-1");
        Holds("member-1", PassName!);
        Inventories.set("character-member", { stackedItems: StackOf({ catalogId: TOKEN, quantity: 1 }) });
        const result = await Authorization.AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, "member-1", grant("character-member")),
            { userId: "member-1", characterId: "character-member", transactionId: "draft-cap-1" });
        assert.ok(!("options" in result));
        assert.equal((result.body as { code?: string }).code, "P2P_HOST_GRANT_DENIED");
    });
});

test("the token next to another Hunt Pass item, or as an instanced add, is refused as a whole", async () => {
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, "member-1");
        Holds("member-1", PassName!);
        Inventories.set("character-member", { stackedItems: StackOf() });
        const next = await Authorization.AuthorizeP2PInventoryTransaction(
            await RuntimeRequest(hub, "member-1", grant("character-member", { addStackedItems: [{ catalogId: TOKEN, quantity: 1 }, { catalogId: "CURRENCY_REWARDCACHE", quantity: 5 }] })),
            { userId: "member-1", characterId: "character-member", transactionId: "draft-next-1" });
        assert.ok(!("options" in next));
        assert.equal((next.body as { payload?: { classes?: string[] } }).payload?.classes?.[0], "HUNT_PASS");
        const instanced = await Authorization.AuthorizeP2PInventoryTransaction(
            await RuntimeRequest(hub, "member-1", { characterId: "character-member", transactionId: "draft-inst-1", addInstancedItems: [{ catalogId: TOKEN, instanceId: "x" }] }),
            { userId: "member-1", characterId: "character-member", transactionId: "draft-inst-1" });
        assert.ok(!("options" in instanced));
        assert.equal(instanced.status, 403);
    });
});

// [2026-10-16] A Training hub decides the token as its Ramsgate does.
test("a Training hub grants the daily token like a Ramsgate hub", async () => {
    await WithHub("TRAINING", async ({ kit, hub }) => {
        await Admit(kit, hub, "member-1");
        Holds("member-1", PassName!);
        Inventories.set("character-member", { stackedItems: StackOf() });
        const result = await Authorization.AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, "member-1", grant("character-member", { transactionId: "draft-training-1" })),
            { userId: "member-1", characterId: "character-member", transactionId: "draft-training-1" });
        assert.ok("options" in result, "authorized");
    });
});

// [2026-10-16] No once-per-day rule: the game's daily period ends at 17:00 UTC and its RefundBounties re-adds the token, so a record that
// still names today (an older record) must neither refuse the grant, early or inside the transaction, nor be rewritten.
test("an account record that already names today's day does not refuse the grant, and the grant does not rewrite it", async () => {
    Lines.length = 0;
    await WithHub("RAMSGATE", async ({ kit, hub }) => {
        await Admit(kit, hub, "member-1");
        Holds("member-1", PassName!);
        Inventories.set("character-member", { stackedItems: StackOf() });
        const Recorded = RecordOf("member-1", TodayUtc(), 5);
        Bounties.set("member-1", Recorded);
        const result = await Authorization.AuthorizeP2PInventoryTransaction(await RuntimeRequest(hub, "member-1", grant("character-member", { transactionId: "draft-again-1" })),
            { userId: "member-1", characterId: "character-member", transactionId: "draft-again-1" });
        assert.ok("options" in result, "authorized: the day is not a condition any more");
        await (result.options.onGrant as any)(CoreRepos, {});
        (result as any).report("accepted");
        assert.deepEqual(Bounties.get("member-1"), Recorded, "the record is untouched");
    });
    assert.ok(!Lines.some((line) => line.includes("[HostGrantDeny]")), Lines.join("\n"));
    assert.equal(Lines.filter((line) => line.includes("[HostGrantAllow]") && line.includes("reason=WITHIN_BALANCE_CAP")).length, 1, Lines.join("\n"));
});
