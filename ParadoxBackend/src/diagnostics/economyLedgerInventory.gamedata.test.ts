import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { GameDailyWindowKey } from "../bountyState";
import { RunInventoryTransaction } from "../controllers/inventory";
import { InsufficientBalanceError } from "../controllers/wallet";
import { logger } from "../logger";
import { UsePersistenceForTest } from "../persistence";
import { OpenTestRealm, TestRealm } from "../persistence/sqlite/testSupport";
import { Tables } from "../persistence/sqlite/tables";
import { EconomyScope, WaitForEconomyRollups } from "./economyLedgerMonitor";

// The economy ledger inside the real inventory transaction, against a temporary SQLite realm (the same repositories and unit of
// work the SQLite provider uses). Only core code is involved; the P2P authorization of a host's transaction is tested in p2p/.

const USER = "ledger-user-1";
const CHARACTER = "ledger-character-1";
const TODAY = new Date().toISOString().slice(0, 10);
const ROLLUP_ID = `${USER}:${TODAY}:CURRENCY_PLATINUM`;

let Realm: TestRealm;

beforeEach(async () => {
    Realm = OpenTestRealm("ledger-inventory");
    UsePersistenceForTest({ repos: Realm.repos, uow: Realm.uow });
    await Realm.repos.inventories.create({ characterId: CHARACTER, userId: USER, instancedItems: "[]", stackedItems: "[]", revision: 0 });
});

afterEach(async () => {
    await WaitForEconomyRollups();
    UsePersistenceForTest(undefined);
    await Realm.cleanup();
});

async function Transact(transactionId: string, adds: any[], removes: any[], economy?: EconomyScope) {
    return RunInventoryTransaction(USER, CHARACTER, transactionId, [], adds, [], removes, [],
        { ownershipAlreadyValidated: true, economy });
}

/** Captures the monitor's info and warn lines while `body` runs. */
async function CaptureLogs(body: () => Promise<void>): Promise<{ info: string[]; warn: string[] }> {
    const Captured = { info: [] as string[], warn: [] as string[] };
    const Originals = { info: (logger as any).info, warn: (logger as any).warn };
    (logger as any).info = (...args: unknown[]) => { Captured.info.push(String(args[0])); };
    (logger as any).warn = (...args: unknown[]) => { Captured.warn.push(String(args[0])); };
    try {
        await body();
        await WaitForEconomyRollups();
    } finally {
        (logger as any).info = Originals.info;
        (logger as any).warn = Originals.warn;
    }
    return Captured;
}

async function RollupDocument(id: string): Promise<any> {
    return Realm.db.read(undefined, (c) => Tables.economyDaily.get(c, id));
}

test("a Platinum credit is logged once with its balance and source, and a Platinum spend names what it bought", async () => {
    const Logs = await CaptureLogs(async () => {
        await Transact("credit-1", [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 1000 }], [], { source: "INVENTORY_GAMESERVER" });
        await Transact("spend-1", [], [{ catalogId: "CURRENCY_PLATINUM", quantity: 300 }], { source: "STORE", storeSkuId: "SKU_TEST_1" });
    });
    assert.deepEqual(Logs.info.filter((Line) => Line.startsWith("[PlatMon]")), [
        `[PlatMon] credit user=${USER} amount=1000 balanceAfter=1000 source=INVENTORY_GAMESERVER ref=credit-1`,
        `[PlatMon] spend user=${USER} amount=300 balanceAfter=700 source=STORE for=SKU_TEST_1 session=- host=- ref=spend-1`,
    ]);
});

test("a replayed transaction logs and rolls up nothing again", async () => {
    const First = await CaptureLogs(async () => {
        await Transact("credit-replay", [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 50 }], [], { source: "INVENTORY_GAMESERVER" });
    });
    assert.equal(First.info.filter((Line) => Line.startsWith("[PlatMon] credit")).length, 1);
    const Before = await RollupDocument(ROLLUP_ID);
    const Logs = await CaptureLogs(async () => {
        const Replayed = await Transact("credit-replay", [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 50 }], [],
            { source: "INVENTORY_GAMESERVER" });
        assert.ok(Replayed, "the stored result is returned");
    });
    assert.deepEqual(Logs.info.filter((Line) => Line.startsWith("[PlatMon]")), []);
    assert.deepEqual(await RollupDocument(ROLLUP_ID), Before);
});

test("the daily rollup holds the account's credits and spends, by source and by the item bought", async () => {
    await CaptureLogs(async () => {
        await Transact("roll-credit", [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 800 }], [], { source: "INVENTORY_GAMESERVER" });
        await Transact("roll-spend", [], [{ catalogId: "CURRENCY_PLATINUM", quantity: 250 }], { source: "STORE", storeSkuId: "SKU_ROLL" });
    });
    const Doc = await RollupDocument(ROLLUP_ID);
    assert.equal(Doc._id, ROLLUP_ID);
    assert.equal(Doc.userId, USER);
    assert.equal(Doc.day, TODAY);
    assert.equal(Doc.currency, "CURRENCY_PLATINUM");
    assert.equal(Doc.credited, 800);
    assert.equal(Doc.debited, 250);
    assert.equal(Doc.count, 2);
    assert.equal(Doc.bySource.INVENTORY_GAMESERVER.credited, 800);
    assert.equal(Doc.bySource.STORE.debited, 250);
    assert.equal(Doc.byItem.SKU_ROLL.debited, 250);
    assert.ok(typeof Doc.ttlAt === "string" && Date.parse(Doc.ttlAt) > Date.now() + 399 * 24 * 60 * 60 * 1000, "kept about 400 days");
});

test("an overspend is refused with the wallet's error, nothing is logged or rolled up, and the balance is unchanged", async () => {
    await CaptureLogs(async () => {
        await Transact("fund", [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 1000 }], [], { source: "INVENTORY_GAMESERVER" });
    });
    const Before = await RollupDocument(ROLLUP_ID);
    const Logs = await CaptureLogs(async () => {
        await assert.rejects(
            () => Transact("overspend", [], [{ catalogId: "CURRENCY_PLATINUM", quantity: 5000 }], { source: "INVENTORY_HOST", p2pSessionId: "hunt-x", hostAccountId: "host-x" }),
            InsufficientBalanceError
        );
    });
    assert.deepEqual(Logs.info.filter((Line) => Line.startsWith("[PlatMon]")), []);
    assert.deepEqual(await RollupDocument(ROLLUP_ID), Before);
    const Balance = await Realm.repos.wallets.findByUserId(USER);
    assert.equal(Balance?.balances.CURRENCY_PLATINUM_EPIC, 1000, "the spend did not reach the wallet");
});

test("a host's Platinum spend names its session and host, and what the transaction granted", async () => {
    await CaptureLogs(async () => {
        await Transact("host-fund", [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 600 }], [], { source: "INVENTORY_GAMESERVER" });
    });
    const Logs = await CaptureLogs(async () => {
        await Transact("host-spend", [{ catalogId: "BREAK_LERAWR_HIDE", quantity: 2 }],
            [{ catalogId: "CURRENCY_PLATINUM", quantity: 100 }],
            { source: "INVENTORY_HOST", p2pSessionId: "hunt-5", hostAccountId: "host-5" });
    });
    assert.deepEqual(Logs.info.filter((Line) => Line.startsWith("[PlatMon]")), [
        `[PlatMon] spend user=${USER} amount=100 balanceAfter=500 source=INVENTORY_HOST for=BREAK_LERAWR_HIDE:2 session=hunt-5 host=host-5 ref=host-spend`,
    ]);
});

test("a Hunt Pass reward that is not Platinum is logged as a Hunt Pass reward with its transaction", async () => {
    const Logs = await CaptureLogs(async () => {
        await Transact("token-1", [{ catalogId: "TOKEN_HUNTPASS_PRESTIGE_S08A", quantity: 1 }], [], { source: "INVENTORY_GAMESERVER" });
    });
    assert.deepEqual(Logs.info.filter((Line) => Line.startsWith("[HuntPassMon]")), [
        `[HuntPassMon] reward user=${USER} item=TOKEN_HUNTPASS_PRESTIGE_S08A amount=1 source=HUNT_PASS ref=token-1`,
    ]);
});

test("season challenge coins funded by their claim are logged as a QUEST reward", async () => {
    const Now = new Date().toISOString();
    await Realm.repos.bountyStates.saveIfVersion({
        userId: USER,
        bounties: [{ group: "weekly", bounty: { bounty_id: "Challenge_Season43_Week1_Slot1", claimed: true }, claimedAt: Now }],
        draftData: {}, updateVersion: 0, createdAt: Now, updatedAt: Now,
    } as any, undefined);
    const Logs = await CaptureLogs(async () => {
        await RunInventoryTransaction(USER, CHARACTER, "challenge-coins-1", [], [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity: 400 }], [], [], [],
            { ownershipAlreadyValidated: true, allowChallengeRewardFunding: true, economy: { source: "INVENTORY_GAMESERVER" } });
    });
    assert.deepEqual(Logs.info.filter((Line) => Line.startsWith("[HuntPassMon]")), [
        `[HuntPassMon] reward user=${USER} item=CURRENCY_SEASONAL_COIN amount=400 source=QUEST ref=challenge-coins-1`,
    ]);
    const Record = await Realm.repos.bountyStates.get(USER);
    assert.equal(Record?.bounties[0].rewardCredit?.amount, 400, "the claim is credited once");
});

// [2026-10-17] Once per game day (from 17:00 UTC, bountyState.ts GameDailyWindowKey); a second daily's coins the same game day are
// skipped and the transaction kept (it was refused whole, and the game sent it again to be refused again).
test("a claimed daily challenge pays its Cache Coins once per game day; a second daily's coins the same day are skipped, not refused", async () => {
    const DAILY_USER = "economy-daily-user";
    const Now = new Date().toISOString();
    await Realm.repos.bountyStates.saveIfVersion({
        userId: DAILY_USER,
        bounties: [
            { group: "daily", bounty: { bounty_id: "Challenge_Daily_Bronze_KillBlazeFrost", claimed: true }, claimedAt: Now },
            { group: "daily", bounty: { bounty_id: "Challenge_Daily_Bronze_KillBlazeWeapon", claimed: true }, claimedAt: Now },
        ],
        draftData: {}, updateVersion: 0, createdAt: Now, updatedAt: Now,
    } as any, undefined);
    await RunInventoryTransaction(DAILY_USER, CHARACTER, "daily-coins-1", [], [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity: 100 }], [], [], [],
        { ownershipAlreadyValidated: true, allowChallengeRewardFunding: true, economy: { source: "INVENTORY_GAMESERVER" } });
    const Paid = await Realm.repos.bountyStates.get(DAILY_USER);
    assert.equal(Paid?.dailyRewardCreditedOn, GameDailyWindowKey(Date.parse(Now)), "the account records the game day a daily paid");
    assert.equal(Paid?.bounties.filter((Entry) => Entry.rewardCredit).length, 1, "exactly one daily is credited");
    const NotesBefore = (await Realm.repos.wallets.findByUserId(DAILY_USER))?.balances.CURRENCY_NOTES ?? 0;
    await RunInventoryTransaction(DAILY_USER, CHARACTER, "daily-coins-2", [],
        [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity: 100 }, { catalogId: "CURRENCY_NOTES", quantity: 50 }], [], [], [],
        { ownershipAlreadyValidated: true, allowChallengeRewardFunding: true, economy: { source: "INVENTORY_GAMESERVER" } });
    const Wallet = await Realm.repos.wallets.findByUserId(DAILY_USER);
    assert.equal(Wallet?.balances.CURRENCY_SEASONAL_COIN, 100, "the second daily's coins were skipped");
    assert.equal(Wallet?.balances.CURRENCY_NOTES, NotesBefore + 50, "and the rest of its transaction applied");
    assert.equal((await Realm.repos.bountyStates.get(DAILY_USER))?.bounties.filter((Entry) => Entry.rewardCredit).length, 1,
        "still exactly one daily credited");
});
