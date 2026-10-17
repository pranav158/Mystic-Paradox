import assert from "node:assert/strict";
import test from "node:test";
import { ActivePremiumPassEntitlement, DecideHostDraftPremium, HoldsEntitlementNamed, StackedBalanceOf } from "./hostDraftPremium";
import type { HostDraftPremiumInputs } from "./hostDraftPremium";

/*
 * [2026-10-15] The decision for a host's daily premium draft token (hostDraftPremium.ts). Pure: the progression data and the player's
 * balance and pass are passed in. The game-data reads (the real season's pass name) are in hostDraftPremium.gamedata.test.ts; the
 * transaction and the replay path are in hostDraftPremiumDaily.gamedata.test.ts. [2026-10-16] Only the balance cap decides: no pass and
 * no once-per-day rule.
 */

const PASS = "season43_premium";
const TOKEN = { catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", quantity: 1 };
const inputs = (overrides: Partial<HostDraftPremiumInputs> = {}): HostDraftPremiumInputs => ({
    balanceBefore: 0, passEntitlement: PASS, holdsPremiumPass: true, ...overrides,
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

test("a whole token for a player with no unspent token is allowed, and the balance after is 1", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs()),
        { allowed: true, reason: "WITHIN_BALANCE_CAP", balanceBefore: 0, balanceAfter: 1 });
});

test("a player who already holds an unspent token is over the cap, so the second is refused", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ balanceBefore: 1 })),
        { allowed: false, reason: "OVER_BALANCE_CAP", balanceBefore: 1, balanceAfter: 2 });
});

test("a token spent in the same transaction keeps the balance within the cap, so the grant is allowed", () => {
    const spend = { addStackedItems: [TOKEN], removeStackedItems: [{ catalogId: TOKEN.catalogId, quantity: 1 }] };
    assert.deepEqual(DecideHostDraftPremium(spend, inputs({ balanceBefore: 1 })),
        { allowed: true, reason: "WITHIN_BALANCE_CAP", balanceBefore: 1, balanceAfter: 1 });
});

// [2026-10-16] Every account may have the token (the game grants it to every player on the daily draft); refusing players without
// the premium pass left a new player's bounty load unfinished and the hub sent them back to the menu.
test("a player without the season's premium pass is granted the token too, within the same cap", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ holdsPremiumPass: false })),
        { allowed: true, reason: "WITHIN_BALANCE_CAP", balanceBefore: 0, balanceAfter: 1 });
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ holdsPremiumPass: false, balanceBefore: 1 })),
        { allowed: false, reason: "OVER_BALANCE_CAP", balanceBefore: 1, balanceAfter: 2 });
});

test("game data that names no pass entitlement does not matter any more", () => {
    assert.deepEqual(DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ passEntitlement: undefined, holdsPremiumPass: false })),
        { allowed: true, reason: "WITHIN_BALANCE_CAP", balanceBefore: 0, balanceAfter: 1 });
});

// [2026-10-16] The game's daily period ends at 17:00 UTC and its RefundBounties re-adds the token after a drafted daily bounty is lost:
// the decision has no day to compare, so a later grant on the same UTC day is decided by the balance alone.
test("a later grant on the same UTC day is allowed whenever the balance is within the cap", () => {
    const first = DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ balanceBefore: 0 }));
    const refund = DecideHostDraftPremium({ addStackedItems: [TOKEN] }, inputs({ balanceBefore: 0 }));
    assert.deepEqual(first, refund, "the same balance gives the same decision, whatever was granted earlier");
    assert.equal(refund?.allowed, true);
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
