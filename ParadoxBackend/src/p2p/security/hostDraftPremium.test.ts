import assert from "node:assert/strict";
import test from "node:test";
import { ActivePremiumPassEntitlement, DecideHostDraftPremium, HoldsEntitlementNamed, RecordHostDraftPremiumGrant, StackedBalanceOf } from "./hostDraftPremium";
import type { HostDraftPremiumInputs } from "./hostDraftPremium";
import { UtcDay } from "../../bountyState";

/*
 * [2026-10-15] The decision for a host's daily premium draft token (hostDraftPremium.ts). Pure: the progression data, the player's
 * balance and pass, and the account's last host-granted day and today are passed in. The game-data reads (the real season's pass name)
 * are in hostDraftPremium.gamedata.test.ts; the account record and the replay path are in hostDraftPremiumDaily.gamedata.test.ts.
 */

const PASS = "season43_premium";
const TOKEN = { catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", quantity: 1 };
const TODAY = "2026-10-15";
const YESTERDAY = "2026-10-14";
const inputs = (overrides: Partial<HostDraftPremiumInputs> = {}): HostDraftPremiumInputs => ({
    balanceBefore: 0, passEntitlement: PASS, holdsPremiumPass: true, grantedOnDay: undefined, today: TODAY, ...overrides,
});

test("the active season's premium pass comes from its progression path, and nothing when the data names none", () => {
    const progression = { payload: { paths: [
        { progression_id: "season42", premium_gating_entitlement: "season42_premium" },
        { progression_id: "season43", premium_gating_entitlement: "season43_premium" },
    ] } };
    assert.equal(ActivePremiumPassEntitlement(progression), PASS);
    assert.equal(ActivePremiumPassEntitlement({ payload: { paths: [{ progression_id: "season43", premium_gating_entitlement: "" }] } }), undefined);
    assert.equal(ActivePremiumPassEntitlement({ payload: { paths: [{ progression_id: "season43" }] } }), undefined);
    // null, not undefined: an undefined argument takes the default (the real game data).
    assert.equal(ActivePremiumPassEntitlement(null), undefined);
});

test("a balance is the stacked quantity of the token; an absent inventory is 0; an unreadable stack list is undefined (refused)", () => {
    assert.equal(StackedBalanceOf(undefined, TOKEN.catalogId), 0);
    assert.equal(StackedBalanceOf({ stackedItems: JSON.stringify([{ catalogId: "CURRENCY_NOTES", quantity: 5 }]) }, TOKEN.catalogId), 0);
    assert.equal(StackedBalanceOf({ stackedItems: JSON.stringify([{ catalogId: TOKEN.catalogId, quantity: 1 }]) }, TOKEN.catalogId), 1);
    assert.equal(StackedBalanceOf({ stackedItems: JSON.stringify([{ catalogId: TOKEN.catalogId, quantity: 2 }, { catalogId: TOKEN.catalogId, quantity: 3 }]) }, TOKEN.catalogId), 5);
    assert.equal(StackedBalanceOf({ stackedItems: "not json" }, TOKEN.catalogId), undefined);
    assert.equal(StackedBalanceOf({ stackedItems: JSON.stringify({ catalogId: TOKEN.catalogId }) }, TOKEN.catalogId), undefined);
    assert.equal(StackedBalanceOf({ stackedItems: JSON.stringify([{ catalogId: TOKEN.catalogId, quantity: 1.5 }]) }, TOKEN.catalogId), undefined);
});

test("a held entitlement is read by name, and an unnamed pass is never held", () => {
    assert.equal(HoldsEntitlementNamed({ entitlements: [{ name: PASS, duration: 0, activatedDate: null }] }, PASS), true);
    assert.equal(HoldsEntitlementNamed({ entitlements: [{ name: "season42_premium", duration: 0, activatedDate: null }] }, PASS), false);
    assert.equal(HoldsEntitlementNamed(undefined, PASS), false);
    assert.equal(HoldsEntitlementNamed({ entitlements: [{ name: PASS, duration: 0, activatedDate: null }] }, undefined), false);
});

test("a body that does not add the token is not decided at all", () => {
    assert.equal(DecideHostDraftPremium({ addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }] }, inputs()), undefined);
    assert.equal(DecideHostDraftPremium({ removeStackedItems: [TOKEN] }, inputs()), undefined, "a removal is not a grant");
    assert.equal(DecideHostDraftPremium({ addInstancedItems: [{ catalogId: TOKEN.catalogId, instanceId: "i" }] }, inputs()), undefined,
        "an instanced add is the policy's to refuse, not a decision");
});

test("a whole token for a player with the pass and no unspent token is allowed, and the balance after is 1", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs()),
        { allowed: true, reason: "PREMIUM_PASS_HELD_WITHIN_CAP_ONCE_PER_DAY", balanceBefore: 0, balanceAfter: 1 });
});

test("a player who already holds an unspent token is over the cap, so the second is refused", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ balanceBefore: 1 })),
        { allowed: false, reason: "OVER_BALANCE_CAP", balanceBefore: 1, balanceAfter: 2 });
});

test("a token spent in the same transaction keeps the balance within the cap, so the grant is allowed", () => {
    const spend = { addStackedItems: [TOKEN], removeStackedItems: [{ catalogId: TOKEN.catalogId, quantity: 1 }] };
    assert.deepEqual(DecideHostDraftPremium(spend, inputs({ balanceBefore: 1 })),
        { allowed: true, reason: "PREMIUM_PASS_HELD_WITHIN_CAP_ONCE_PER_DAY", balanceBefore: 1, balanceAfter: 1 });
});

test("a player without the season's premium pass is refused, whatever the balance", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ holdsPremiumPass: false })),
        { allowed: false, reason: "NO_PREMIUM_PASS", balanceBefore: 0, balanceAfter: 1 });
});

test("without a pass entitlement in the game data nothing is granted (fail closed)", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ passEntitlement: undefined, holdsPremiumPass: false })),
        { allowed: false, reason: "NO_PASS_ENTITLEMENT_DATA", balanceBefore: 0, balanceAfter: 1 });
});

test("one whole token per transaction: a second add, a quantity other than 1, or a list of tokens is refused", () => {
    for (const body of [
        { addStackedItems: [TOKEN, TOKEN] },
        { addStackedItems: [{ catalogId: TOKEN.catalogId, quantity: 2 }] },
        { addStackedItems: [{ catalogId: TOKEN.catalogId, quantity: 0 }] },
        { addStackedItems: [{ catalogId: TOKEN.catalogId, quantity: 1.5 }] },
    ]) {
        assert.deepEqual(DecideHostDraftPremium(body, inputs()), { allowed: false, reason: "ONE_WHOLE_TOKEN_PER_TRANSACTION" }, JSON.stringify(body));
    }
});

test("an unreadable balance is refused, never taken as zero", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ balanceBefore: undefined })),
        { allowed: false, reason: "BALANCE_UNREADABLE" });
});

test("the first grant of a UTC day is allowed, and so is a grant after an earlier day's grant", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ grantedOnDay: undefined })),
        { allowed: true, reason: "PREMIUM_PASS_HELD_WITHIN_CAP_ONCE_PER_DAY", balanceBefore: 0, balanceAfter: 1 });
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ grantedOnDay: YESTERDAY })),
        { allowed: true, reason: "PREMIUM_PASS_HELD_WITHIN_CAP_ONCE_PER_DAY", balanceBefore: 0, balanceAfter: 1 });
});

test("a second grant on the same UTC day is refused ALREADY_GRANTED_TODAY, also when the token was spent in the same transaction", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ grantedOnDay: TODAY })),
        { allowed: false, reason: "ALREADY_GRANTED_TODAY", balanceBefore: 0, balanceAfter: 1 });
    const spend = { addStackedItems: [TOKEN], removeStackedItems: [{ catalogId: TOKEN.catalogId, quantity: 1 }] };
    assert.deepEqual(DecideHostDraftPremium(spend, inputs({ balanceBefore: 1, grantedOnDay: TODAY })),
        { allowed: false, reason: "ALREADY_GRANTED_TODAY", balanceBefore: 1, balanceAfter: 1 });
});

test("the day is checked after the pass and before the balance cap", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ balanceBefore: 1, grantedOnDay: TODAY })),
        { allowed: false, reason: "ALREADY_GRANTED_TODAY", balanceBefore: 1, balanceAfter: 2 }, "granted today and over the cap: the day is named");
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ holdsPremiumPass: false, grantedOnDay: TODAY })),
        { allowed: false, reason: "NO_PREMIUM_PASS", balanceBefore: 0, balanceAfter: 1 });
});

test("the next UTC day allows the grant again, and the day is the UTC day of the instant", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ grantedOnDay: TODAY, today: "2026-10-16" })),
        { allowed: true, reason: "PREMIUM_PASS_HELD_WITHIN_CAP_ONCE_PER_DAY", balanceBefore: 0, balanceAfter: 1 });
    assert.equal(UtcDay(Date.parse("2026-10-15T23:59:59.999Z")), TODAY);
    assert.equal(UtcDay(Date.parse("2026-10-16T00:00:00.000Z")), "2026-10-16");
});

test("the day write is conditional on the version the grant read: a record that moved under it refuses the grant", async () => {
    const Writes: [any, number | undefined][] = [];
    const Stored = { userId: "member", bounties: [], draftData: {}, updateVersion: 3, createdAt: YESTERDAY, updatedAt: YESTERDAY };
    const Repos = (answer: unknown) => ({ bountyStates: {
        get: async () => Stored,
        saveIfVersion: async (record: any, expectedVersion: number | undefined) => { Writes.push([record, expectedVersion]); return answer; },
    } });
    const Session = {} as any;
    assert.equal(await RecordHostDraftPremiumGrant(Repos(undefined) as any, "member", TODAY, Session), false);
    assert.equal(await RecordHostDraftPremiumGrant(Repos({ ...Stored, updateVersion: 4 }) as any, "member", TODAY, Session), true);
    const [Record, Expected] = Writes[1];
    assert.equal(Expected, 3, "the write names the version it read");
    assert.equal(Record.dailyPremiumDraftGrantedOn, TODAY);
    assert.equal(Record.updateVersion, 4);
});
