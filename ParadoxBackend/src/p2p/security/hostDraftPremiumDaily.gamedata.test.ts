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
 * transaction (its onGrant decides again from the transaction's own reads), and a temporary SQLite realm for the repositories and the
 * idempotency ledger. [2026-10-16] Only the balance cap decides (no once-per-day rule, no day on the account): a later grant the same day
 * (the game's 17:00 UTC reset, its refund and re-draft) is accepted once the token was spent, two racing grants for one character end
 * with one token, an old record's day is ignored, the idempotent replay of an accepted transaction (with the token still held, and after
 * it was spent), a changed body under a reused id, and the dedicated gameserver path, which the rule does not touch. The season's pass
 * name comes from game-data (.gamedata suffix).
 */

const TOKEN = "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM";
const PASS = ActivePremiumPassEntitlement();
const TodayUtc = () => new Date().toISOString().slice(0, 10);
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

test("the first grant is accepted: the token is granted, nothing is written on the account, and the grant is logged with its day", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const Body = Grant("character-member", "daily-1");
        let Result: unknown;
        const Lines = await Capture(async () => { Result = await Commit(await Authorize(hub, Body), Body); });
        assert.ok(Result, "the transaction is accepted");
        assert.equal(await Tokens(realm, "character-member"), 1);
        assert.equal(await realm.repos.bountyStates.get(MEMBER), undefined, "the grant no longer touches the account's bounty record");
        const Allowed = Lines.filter((line) => line.includes("[HostGrantAllow]"));
        assert.equal(Allowed.length, 1, Lines.join("\n"));
        assert.ok(Allowed[0].includes(`transaction=daily-1 item=${TOKEN} quantity=1 reason=WITHIN_BALANCE_CAP day=${TodayUtc()} balance=0->1 cap=1`), Allowed[0]);
    });
});

test("an accepted transaction replayed while the token is still held succeeds, grants nothing more, and logs no second grant", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const Body = Grant("character-member", "daily-2");
        await Commit(await Authorize(hub, Body), Body);
        let Replayed: unknown;
        const Lines = await Capture(async () => { Replayed = await Commit(await Authorize(hub, Body), Body); });
        assert.ok(Replayed, "the stored result is returned, not refused");
        assert.equal(await Tokens(realm, "character-member"), 1, "no second token");
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

// [2026-10-16] The game's daily period ends at 17:00 UTC, and its RefundBounties re-adds the token after a drafted daily bounty is lost,
// then drafts again: a new grant the same UTC day, once the earlier token was spent, is the game's own and must not be refused.
test("a new transaction the same UTC day is accepted once the earlier token was spent", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const First = Grant("character-member", "daily-4a");
        await Commit(await Authorize(hub, First), First);
        await Spend("character-member", "spend-4");
        const Again = Grant("character-member", "daily-4b");
        let Result: unknown;
        const Lines = await Capture(async () => { Result = await Commit(await Authorize(hub, Again), Again); });
        assert.ok(Result, "the second grant of the day is accepted");
        assert.equal(await Tokens(realm, "character-member"), 1);
        assert.ok(Lines.some((line) => line.includes("[HostGrantAllow]") && line.includes("transaction=daily-4b") &&
            line.includes("reason=WITHIN_BALANCE_CAP")), Lines.join("\n"));
        assert.ok(!Lines.some((line) => line.includes("[HostGrantDeny]")), Lines.join("\n"));
    });
});

test("a grant while the earlier token is still unspent is refused before the transaction, over the cap", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const First = Grant("character-member", "daily-5a");
        await Commit(await Authorize(hub, First), First);
        const Again = Grant("character-member", "daily-5b");
        let Refused: any;
        const Lines = await Capture(async () => { Refused = await Authorize(hub, Again); });
        assert.ok(!("options" in Refused));
        assert.equal(Refused.status, 403);
        assert.equal(Refused.body.code, "P2P_HOST_GRANT_DENIED");
        assert.equal(await Tokens(realm, "character-member"), 1);
        assert.ok(Lines.some((line) => line.includes("[HostGrantDeny]") && line.includes("transaction=daily-5b") &&
            line.includes("draftPremium=OVER_BALANCE_CAP")), Lines.join("\n"));
    });
});

test("two racing grants for one character end with one token: the second is refused inside its transaction and writes nothing", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const First = Grant("character-member", "race-first");
        const Second = Grant("character-member", "race-second");
        // Both pass the early check: neither token is in the balance yet when both are authorized.
        const FirstAuthorized = await Authorize(hub, First);
        const SecondAuthorized = await Authorize(hub, Second);
        assert.ok("options" in FirstAuthorized && "options" in SecondAuthorized, "both pass the early check");
        await Commit(FirstAuthorized, First);
        let Refused: unknown;
        let Denial: any;
        const Lines = await Capture(async () => {
            Refused = await Commit(SecondAuthorized, Second).then(() => undefined, (Err: unknown) => Err);
            // The route maps the refusal to a response in the same request, so its [HostGrantDeny] line is written here.
            if (Refused instanceof Error) Denial = SecondAuthorized.errorResponse(Refused);
        });
        assert.ok(Refused instanceof Error, "the second grant is refused in its transaction");
        assert.equal(Refused.message, "P2P_LOOT_GRANT_DRAFT_PREMIUM_OVER_BALANCE_CAP");
        assert.equal(Denial?.status, 403);
        assert.equal(Denial?.body.code, "P2P_LOOT_GRANT_DRAFT_PREMIUM_OVER_BALANCE_CAP");
        assert.equal(await Tokens(realm, "character-member"), 1, "the first grant stands, the second adds nothing");
        assert.equal(await realm.repos.inventoryTransactions.findRecord(MEMBER, "character-member", "race-second"), undefined,
            "the refused transaction's ledger row is rolled back");
        assert.ok(Lines.some((line) => line.includes("[HostGrantDeny]") && line.includes("transaction=race-second") &&
            line.includes("reason=OVER_BALANCE_CAP at=transaction")), Lines.join("\n"));
    });
});

test("each character's balance is its own: a second character of the account may hold its token too", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const First = Grant("character-member", "chars-1");
        const Second = Grant("character-member-2", "chars-2");
        await Commit(await Authorize(hub, First), First);
        await Commit(await Authorize(hub, Second), Second);
        assert.equal(await Tokens(realm, "character-member"), 1);
        assert.equal(await Tokens(realm, "character-member-2"), 1);
    });
});

test("a bounty record that still carries an earlier grant's day (an older record) does not refuse the grant, and is not changed", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const Now = iso();
        await realm.repos.bountyStates.saveIfVersion({ userId: MEMBER, bounties: [], draftData: {}, dailyPremiumDraftGrantedOn: TodayUtc(),
            updateVersion: 1, createdAt: Now, updatedAt: Now }, undefined);
        const Record = await realm.repos.bountyStates.get(MEMBER);
        const Body = Grant("character-member", "daily-6");
        await Commit(await Authorize(hub, Body), Body);
        assert.equal(await Tokens(realm, "character-member"), 1);
        assert.deepEqual(await realm.repos.bountyStates.get(MEMBER), Record, "the record is untouched");
    });
});

test("the same transaction id with a different body is not a replay: it is decided as a new grant, by the balance", async () => {
    await WithScenario(async ({ realm, hub }) => {
        const Body = Grant("character-member", "daily-7");
        await Commit(await Authorize(hub, Body), Body);
        // The same id, now also spending the token it was granted: a different body, so the stored result does not apply. It is decided
        // as a new grant from the balance (1 held, 1 spent, 1 added: within the cap), not passed through as a replay.
        const Changed = Grant("character-member", "daily-7", { removeStackedItems: [{ catalogId: TOKEN, quantity: 1 }] });
        let Decided: any;
        const Lines = await Capture(async () => { Decided = await Authorize(hub, Changed); });
        assert.ok("options" in Decided, "decided by the balance: within the cap");
        assert.equal(await Tokens(realm, "character-member"), 1, "authorizing changes nothing");
        assert.ok(!Lines.some((line) => line.includes("[HostGrantDeny]")), Lines.join("\n"));
    });
});

test("a dedicated gameserver's token grants are not limited by the cap rule, and write nothing on the account", async () => {
    await WithScenario(async ({ realm }) => {
        await RunInventoryTransaction(MEMBER, "character-member", "gameserver-1", [], [{ catalogId: TOKEN, quantity: 1 }], [], [], [], { ownershipAlreadyValidated: true });
        await RunInventoryTransaction(MEMBER, "character-member", "gameserver-2", [], [{ catalogId: TOKEN, quantity: 1 }], [], [], [], { ownershipAlreadyValidated: true });
        assert.equal(await Tokens(realm, "character-member"), 2);
        assert.equal(await realm.repos.bountyStates.get(MEMBER), undefined);
    });
});
