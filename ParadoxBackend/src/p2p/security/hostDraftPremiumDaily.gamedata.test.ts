import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { RunInventoryTransaction } from "../../controllers/inventory";
import { WaitForEconomyRollups } from "../../diagnostics/economyLedgerMonitor";
import { logger } from "../../logger";
import { UsePersistenceForTest } from "../../persistence";
import { OpenTestRealm, TestRealm } from "../../persistence/sqlite/testSupport";
import { P2PRepositoryProvider, UseP2PPersistenceForTest } from "../persistence";
import { CreateHubKit, HOST, HubKit, InstallHubTestEnvironment, MEMBER, REALM_ID, RunningHub, StartRunningHub } from "../realm/realmHubTestKit";
import { ActivePremiumPassEntitlement } from "./hostDraftPremium";
import { BuildPlayerHostRuntimeAuthData, InvalidateHubPresence, ResolveActiveHostRuntimeContext } from "./hostCapabilities";
import { AuthorizeP2PInventoryTransaction } from "./p2pInventoryAuthorization";
import { DeriveIcePeerId } from "./transportPeerIds";

/*
 * [2026-10-15] The host's daily premium draft token, end to end: the real authorization of a realm's Ramsgate hub, the real inventory
 * transaction (its onGrant records the account's day in the same transaction), and a temporary SQLite realm for the repositories and
 * the idempotency ledger. Covers the once-a-day rule per account (two characters of one account), the idempotent replay of an accepted
 * transaction (with the token still held, and after it was spent), a changed body under a reused id, the next UTC day, and the
 * dedicated gameserver path, which the rule does not touch. The season's pass name comes from game-data (.gamedata suffix).
 */

const TOKEN = "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM";
const PASS = ActivePremiumPassEntitlement();
const TodayUtc = () => new Date().toISOString().slice(0, 10);
const YesterdayUtc = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

const OWNED_BY: Record<string, string> = { "character-member": MEMBER, "character-member-2": MEMBER, "character-host": HOST };
const CHARACTERS = {
    findByCharacterIdAndUserId: async (characterId: string, userId: string) =>
        OWNED_BY[characterId] === userId ? { characterId, userId } : undefined,
};

let restoreEnvironment: () => void;
before(() => { restoreEnvironment = InstallHubTestEnvironment(); });
after(() => restoreEnvironment());

/** The info and warn lines `body` writes: the [HostGrantAllow] and [HostGrantDeny] lines among them. */
async function Capture(body: () => Promise<void>): Promise<string[]> {
    const Lines: string[] = [];
    const Originals = { info: (logger as any).info, warn: (logger as any).warn };
    (logger as any).info = (...args: unknown[]) => { Lines.push(String(args[0])); };
    (logger as any).warn = (...args: unknown[]) => { Lines.push(String(args[0])); };
    try {
        await body();
    } finally {
        (logger as any).info = Originals.info;
        (logger as any).warn = Originals.warn;
    }
    return Lines;
}

async function Admit(kit: HubKit, hub: RunningHub, accountId: string): Promise<void> {
    await kit.presence.requestEntry({ sessionId: hub.sessionId, generation: hub.generation, realmId: REALM_ID, accountId,
        peerId: DeriveIcePeerId(accountId), candidateId: `candidate-${accountId}`, now: iso(), expiresAt: iso(90_000) });
    await kit.presence.markAdmitted({ sessionId: hub.sessionId, generation: hub.generation, accountId,
        admissionId: `admission-${accountId}`, admittedAt: iso(), now: iso(), route: "relay" });
    InvalidateHubPresence(hub.sessionId);
}

interface Scenario { realm: TestRealm; hub: RunningHub }

/**
 * A temporary SQLite realm (the real repositories and unit of work) holding the member's season pass and two characters of the member's
 * account, and a running Ramsgate hub with the member admitted. The hub and presence records are in memory.
 */
async function WithScenario(body: (scenario: Scenario) => Promise<void>): Promise<void> {
    assert.ok(PASS, "the game data names the season's pass");
    const realm = OpenTestRealm("host-draft-premium-daily");
    UsePersistenceForTest({ repos: realm.repos, uow: realm.uow });
    const kit = CreateHubKit();
    try {
        await realm.repos.entitlements.grantIfMissing(MEMBER, PASS!, 0, null, undefined);
        for (const characterId of ["character-member", "character-member-2"]) {
            await realm.repos.inventories.create({ characterId, userId: MEMBER, instancedItems: "[]", stackedItems: "[]", revision: 0 });
        }
        const hub = await StartRunningHub(kit, { hubKind: "RAMSGATE" });
        UseP2PPersistenceForTest({
            p2pHunts: kit.hunts,
            realmHub: kit.presence,
            characters: CHARACTERS,
            operationsAlerts: {},
            parties: { findById: async () => undefined, setActivity: async () => undefined, appendEvent: async () => undefined },
        } as unknown as P2PRepositoryProvider);
        await Admit(kit, hub, MEMBER);
        await body({ realm, hub });
    } finally {
        await WaitForEconomyRollups();
        UseP2PPersistenceForTest(undefined);
        kit.dispose();
        UsePersistenceForTest(undefined);
        await realm.cleanup();
    }
}

/** The body of one host transaction: `characterId` asks for the daily token unless `extra` says otherwise. */
const Grant = (characterId: string, transactionId: string, extra: Record<string, unknown> = {}): Record<string, any> =>
    ({ characterId, transactionId, addStackedItems: [{ catalogId: TOKEN, quantity: 1 }], ...extra });

/** The hub runtime's authorization of `body`, as the route calls it. */
async function Authorize(hub: RunningHub, body: Record<string, any>): Promise<any> {
    const context = await ResolveActiveHostRuntimeContext(hub.capabilitySecret);
    assert.ok(context, "the hub's capability resolves");
    const AuthData = BuildPlayerHostRuntimeAuthData(context, { userId: MEMBER });
    assert.ok(AuthData, "the runtime may act for this account");
    return AuthorizeP2PInventoryTransaction({ AuthData, body } as any, { userId: MEMBER, characterId: body.characterId, transactionId: body.transactionId });
}

/**
 * The route's path for an authorized transaction: the real inventory transaction (its onGrant included), then the accepted report.
 * A refused transaction rejects, as the route sees it.
 */
async function Commit(authorized: any, body: Record<string, any>): Promise<any> {
    assert.ok("options" in authorized, "the transaction is authorized");
    const Result = await RunInventoryTransaction(MEMBER, body.characterId, body.transactionId, body.addInstancedItems, body.addStackedItems,
        body.removeInstancedItems, body.removeStackedItems, body.saveInstancedItems, { ...authorized.options, ownershipAlreadyValidated: true });
    authorized.report?.("accepted");
    return Result;
}

/** Spends the member's token on `characterId` by a plain transaction (the game's own draft), as the gameserver would. */
async function Spend(characterId: string, transactionId: string): Promise<void> {
    await RunInventoryTransaction(MEMBER, characterId, transactionId, [], [], [], [{ catalogId: TOKEN, quantity: 1 }], [], { ownershipAlreadyValidated: true });
}

async function Tokens(realm: TestRealm, characterId: string): Promise<number> {
    const Inventory = await realm.repos.inventories.findByCharacterId(characterId);
    const Items: { catalogId: string; quantity: number }[] = JSON.parse(Inventory!.stackedItems);
    return Items.filter((Item) => Item.catalogId === TOKEN).reduce((Total, Item) => Total + Item.quantity, 0);
}

const Marker = async (realm: TestRealm) => (await realm.repos.bountyStates.get(MEMBER))?.dailyPremiumDraftGrantedOn;

test("the first grant of the day is accepted: the token is granted, the account records today, and the grant is logged with its day", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const Body = Grant("character-member", "daily-1");
        let Result: unknown;
        const Lines = await Capture(async () => { Result = await Commit(await Authorize(hub, Body), Body); });
        assert.ok(Result, "the transaction is accepted");
        assert.equal(await Tokens(realm, "character-member"), 1);
        assert.equal(await Marker(realm), TodayUtc());
        const Allowed = Lines.filter((line) => line.includes("[HostGrantAllow]"));
        assert.equal(Allowed.length, 1, Lines.join("\n"));
        assert.ok(Allowed[0].includes(`transaction=daily-1 item=${TOKEN} quantity=1 reason=PREMIUM_PASS_HELD_WITHIN_CAP_ONCE_PER_DAY day=${TodayUtc()} balance=0->1 cap=1`), Allowed[0]);
    });
});

test("an accepted transaction replayed while the token is still held succeeds, grants nothing more, and logs no second grant", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const Body = Grant("character-member", "daily-2");
        await Commit(await Authorize(hub, Body), Body);
        const Record = await realm.repos.bountyStates.get(MEMBER);
        let Replayed: unknown;
        const Lines = await Capture(async () => { Replayed = await Commit(await Authorize(hub, Body), Body); });
        assert.ok(Replayed, "the stored result is returned, not refused");
        assert.equal(await Tokens(realm, "character-member"), 1, "no second token");
        assert.deepEqual(await realm.repos.bountyStates.get(MEMBER), Record, "the account record is untouched");
        assert.deepEqual(Lines.filter((line) => line.includes("[HostGrantAllow]")), []);
    });
});

test("an accepted transaction replayed after the token was spent the same day still succeeds, and is not granted again", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const Body = Grant("character-member", "daily-3");
        await Commit(await Authorize(hub, Body), Body);
        await Spend("character-member", "spend-3");
        assert.equal(await Tokens(realm, "character-member"), 0);
        const Replayed = await Commit(await Authorize(hub, Body), Body);
        assert.ok(Replayed, "the stored result is returned");
        assert.equal(await Tokens(realm, "character-member"), 0, "the replay does not grant the token again");
    });
});

test("a new transaction on the same UTC day is refused before the transaction once the token was spent, and the [HostGrantDeny] line names the day", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const First = Grant("character-member", "daily-4a");
        await Commit(await Authorize(hub, First), First);
        await Spend("character-member", "spend-4");
        const Again = Grant("character-member", "daily-4b");
        let Refused: any;
        const Lines = await Capture(async () => { Refused = await Authorize(hub, Again); });
        assert.ok(!("options" in Refused));
        assert.equal(Refused.status, 403);
        assert.equal(Refused.body.code, "P2P_HOST_GRANT_DENIED");
        assert.equal(await Tokens(realm, "character-member"), 0);
        assert.ok(Lines.some((line) => line.includes("[HostGrantDeny]") && line.includes("transaction=daily-4b") &&
            line.includes("draftPremium=ALREADY_GRANTED_TODAY")), Lines.join("\n"));
    });
});

test("two characters of one account cannot both take the day's token: the second is refused inside its transaction and writes nothing", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const First = Grant("character-member", "race-first");
        const Second = Grant("character-member-2", "race-second");
        // [2026-10-15] Both pass the early check: neither grant is recorded yet when both are authorized.
        const FirstAuthorized = await Authorize(hub, First);
        const SecondAuthorized = await Authorize(hub, Second);
        assert.ok("options" in FirstAuthorized && "options" in SecondAuthorized, "both pass the early check");
        await Commit(FirstAuthorized, First);
        const Record = await realm.repos.bountyStates.get(MEMBER);
        let Refused: unknown;
        let Denial: any;
        const Lines = await Capture(async () => {
            Refused = await Commit(SecondAuthorized, Second).then(() => undefined, (Err: unknown) => Err);
            // [2026-10-15] The route maps the refusal to a response in the same request, so its [HostGrantDeny] line is written here.
            if (Refused instanceof Error) Denial = SecondAuthorized.errorResponse(Refused);
        });
        assert.ok(Refused instanceof Error, "the second grant is refused in its transaction");
        assert.equal(Refused.message, "P2P_LOOT_GRANT_DRAFT_PREMIUM_ALREADY_GRANTED_TODAY");
        assert.equal(Denial?.status, 403);
        assert.equal(Denial?.body.code, "P2P_LOOT_GRANT_DRAFT_PREMIUM_ALREADY_GRANTED_TODAY");
        assert.equal(await Tokens(realm, "character-member"), 1, "the first grant stands");
        assert.equal(await Tokens(realm, "character-member-2"), 0, "the second writes no token");
        assert.deepEqual(await realm.repos.bountyStates.get(MEMBER), Record, "the account record is the first grant's, unchanged");
        assert.equal(await realm.repos.inventoryTransactions.findRecord(MEMBER, "character-member-2", "race-second"), undefined,
            "the refused transaction's ledger row is rolled back");
        assert.ok(Lines.some((line) => line.includes("[HostGrantDeny]") && line.includes("transaction=race-second") &&
            line.includes("reason=ALREADY_GRANTED_TODAY at=transaction")), Lines.join("\n"));
    });
});

test("the next UTC day the account may be granted again, and the new day is recorded in one version", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const Now = iso();
        await realm.repos.bountyStates.saveIfVersion({ userId: MEMBER, bounties: [], draftData: {}, dailyPremiumDraftGrantedOn: YesterdayUtc(),
            updateVersion: 1, createdAt: Now, updatedAt: Now }, undefined);
        const Body = Grant("character-member", "daily-6");
        await Commit(await Authorize(hub, Body), Body);
        assert.equal(await Tokens(realm, "character-member"), 1);
        assert.equal(await Marker(realm), TodayUtc());
        assert.equal((await realm.repos.bountyStates.get(MEMBER))?.updateVersion, 2);
    });
});

test("the same transaction id with a different body is not a replay: it is decided as a new grant, and refused for the day", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const Body = Grant("character-member", "daily-7");
        await Commit(await Authorize(hub, Body), Body);
        // [2026-10-15] The same id, now also spending the token it was granted: a different body, so the stored result does not apply.
        const Changed = Grant("character-member", "daily-7", { removeStackedItems: [{ catalogId: TOKEN, quantity: 1 }] });
        let Refused: any;
        const Lines = await Capture(async () => { Refused = await Authorize(hub, Changed); });
        assert.ok(!("options" in Refused));
        assert.equal(Refused.status, 403);
        assert.equal(await Tokens(realm, "character-member"), 1, "nothing changed");
        assert.ok(Lines.some((line) => line.includes("draftPremium=ALREADY_GRANTED_TODAY")), Lines.join("\n"));
    });
});

test("a dedicated gameserver's token grants are not limited by the day, and write no day on the account", async () => {
    await WithScenario(async ({ realm }) => {
        await RunInventoryTransaction(MEMBER, "character-member", "gameserver-1", [], [{ catalogId: TOKEN, quantity: 1 }], [], [], [], { ownershipAlreadyValidated: true });
        await RunInventoryTransaction(MEMBER, "character-member", "gameserver-2", [], [{ catalogId: TOKEN, quantity: 1 }], [], [], [], { ownershipAlreadyValidated: true });
        assert.equal(await Tokens(realm, "character-member"), 2);
        assert.equal(await realm.repos.bountyStates.get(MEMBER), undefined);
    });
});
