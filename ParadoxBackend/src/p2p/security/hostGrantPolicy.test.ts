import assert from "node:assert/strict";
import test from "node:test";
import {
    ClassifyHostGrant,
    CollectEntitlementNames,
    CollectPrestigeRewardIds,
    HOST_DRAFT_PREMIUM_BALANCE_CAP,
    HostGrantCatalog,
    HostGrantDenial,
    HostGrantViolations,
    HOST_STARTER_COSMETIC_IDS,
    IsClaimFundedCoinGrant,
    IsHostDraftPremiumAdd,
    IsPrestigeFundedGrant
} from "./hostGrantPolicy";

// A synthetic catalogue view (no game data needed): storage-policy tags for two ids, the prestige rewards (and the two of
// them the prestige gate pays) and the entitlement names a real game-data directory would supply.
const PRESTIGE_GATED = new Set(["CURRENCY_PRESTIGE", "CURRENCY_PJM_PRESTIGE_FILLED"]);
const CATALOG: HostGrantCatalog = {
    tagsOf: (catalogId) => ({
        WP_AC_ARMSTRONG: ["WEAPON", "transmog", "owned"],
        STRANGE_NEW_EMOTE: ["EMOTE", "emote"],
        CURRENCY_NEW_SEASON_COIN: ["currency", "seasonal_currency"]
    } as Record<string, string[]>)[catalogId],
    prestigeRewardIds: new Set(["CURRENCY_SEASONAL_COIN", "CURRENCY_PJM_PRESTIGE_FILLED"]),
    isPrestigeGated: (catalogId) => PRESTIGE_GATED.has(catalogId),
    entitlementNames: new Set(["season43_premium", "character_facepaint_furious"])
};

test("hosts may never grant Platinum, Hunt Pass items, cosmetics or entitlements (B9, 2026-10-11)", () => {
    for (const id of ["CURRENCY_PLATINUM", "CURRENCY_PLATINUM_EPIC_BONUS", "id_currency_platinum", "DEBUG_CURRENCY_PLATINUM_10K"]) {
        assert.equal(ClassifyHostGrant(id, CATALOG), "PREMIUM_CURRENCY", id);
    }
    for (const id of ["CURRENCY_SEASONAL_COIN", "CURRENCY_REWARDCACHE", "CURRENCY_S19_COIN", "CURRENCY_S13_DAILY", "CURRENCY_PRESTIGE",
        "CURRENCY_PJM_PRESTIGE_FILLED", "GrantProgressItem_HuntPass", "TOKEN_HUNTPASS_PRESTIGE_S08A", "TOKEN_HUNT_PASS_TUTORIAL",
        "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", "CONTAINER_CORE_PRESTIGE_HP08A_00", "CURRENCY_NEW_SEASON_COIN"]) {
        assert.equal(ClassifyHostGrant(id, CATALOG), "HUNT_PASS", id);
    }
    for (const id of ["DYE_BABYBLUE_DURABLE", "EM_INTRO_3POINT_00", "EJ_PLAYER_OMG", "TITLE_PHOENIX_00", "BNC_ANIMATION_001",
        "BN_BEGINNER_00", "AC_BACK_TRIALS_00", "GD_FRAME_A_BASE", "CC_HAIR_SPIKED", "TY_FIREWORK_BASE", "MP_PUFFLEHOP_SPRING_BASE",
        "CHANGE_APPEARANCE_TOKEN", "CURRENCY_TOKEN_TRANSMOG", "CONTAINER_PROMO_KIWO_00", "CONTAINER_CORE_FOUNDER_SLAYER",
        "CONTAINER_CORE_SLAYERPACK", "STRANGE_NEW_EMOTE"]) {
        assert.equal(ClassifyHostGrant(id, CATALOG), "COSMETIC", id);
    }
    for (const id of ["season43_premium", "exchange_slot_2", "ent_cchd_hp09a_assassins_00", "pass_rewardcache_season15a",
        "character_facepaint_furious"]) {
        assert.equal(ClassifyHostGrant(id, CATALOG), "ENTITLEMENT", id);
    }
});

test("the loot a hunt really produces stays allowed", () => {
    // From [GrantMon] on dedicated hunts and the 1.14.7 catalogue.
    for (const id of ["CURRENCY_NOTES", "CURRENCY_PJM_PRESTIGE_EMPTY", "CURRENCY_PJM_WEAPON", "CURRENCY_CELLDUST",
        "CURRENCY_EVENT_FROSTFALL", "BREAK_LERAWR_HIDE", "TOKEN_KILL_COUNT_LERAWR_BETA", "TOKEN_DAILY_CHALLENGE_DRAFT",
        "GATHER_DEFENSE_01", "CELL_PREVENT_STAGGER_UC", "CONTAINER_CORE_REWARD_DAILY", "Container_Core_Slayer_Bronze",
        "ARC_ZONE_0", "QI_ATTACK_SPEED_POTION", "LT_UNSEEN_01", "WP_AC_ARMSTRONG", "PART_AC_LEGENDARY_SHOCK", ""]) {
        assert.equal(ClassifyHostGrant(id, CATALOG), undefined, id);
    }
});

test("violations cover grants of every class, and removals of other premium currency and entitlements (a Platinum spend passes)", () => {
    const body = {
        addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }, { catalogId: "CURRENCY_PLATINUM", quantity: 1000 }],
        addInstancedItems: [{ catalogId: "DYE_BABYBLUE_DURABLE", instanceId: "i" }],
        removeStackedItems: [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 5 }, { catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", quantity: 1 }],
        removeInstancedItems: [{ catalogId: "exchange_slot_2", instanceId: "j" }]
    };
    assert.deepEqual(HostGrantViolations(body, CATALOG), [
        { catalogId: "CURRENCY_PLATINUM", deniedClass: "PREMIUM_CURRENCY", field: "addStackedItems" },
        { catalogId: "DYE_BABYBLUE_DURABLE", deniedClass: "COSMETIC", field: "addInstancedItems" },
        { catalogId: "exchange_slot_2", deniedClass: "ENTITLEMENT", field: "removeInstancedItems" }
    ]);
    const loot = { addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }, { catalogId: "BREAK_LERAWR_HIDE", quantity: 4 }] };
    assert.deepEqual(HostGrantViolations(loot, CATALOG), []);
    assert.equal(HostGrantDenial({ guardCompletionMode: "END_OF_HUNT" }, loot, CATALOG), undefined);
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "FIRST_DEFEAT" }, body, CATALOG)?.classes,
        ["PREMIUM_CURRENCY", "COSMETIC", "ENTITLEMENT"]);
});

test("a no-reward session (Training) refuses every grant and spend but keeps saves", () => {
    const training = { guardCompletionMode: "NO_COMPLETION" as const };
    const loot = { addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }] };
    assert.deepEqual(HostGrantDenial(training, loot, CATALOG)?.classes, ["NO_REWARD_SESSION"]);
    assert.deepEqual(HostGrantDenial(training, { removeStackedItems: [{ catalogId: "QI_ATTACK_SPEED_POTION", quantity: 1 }] }, CATALOG)?.classes,
        ["NO_REWARD_SESSION"]);
    assert.equal(HostGrantDenial(training, { saveInstancedItems: [{ catalogId: "WP_AC_ARMSTRONG", instanceId: "w", itemData: "{}" }] }, CATALOG),
        undefined);
});

test("game-data readers collect entitlement names and prestige rewards", () => {
    const names = CollectEntitlementNames({
        payload: { paths: [{ premium_gating_entitlement: "Season43_Premium",
            free_rewards: [{ entitlements: [{ duration: 0, entitlement: "ent_hp09a_basic_50" }] }] }] },
        skus: [{ grants: { entitlements: [{ name: "character_facepaint_furious", duration: 0 }, "exchange_slot_3"] } }]
    });
    assert.deepEqual([...names].sort(), ["character_facepaint_furious", "ent_hp09a_basic_50", "exchange_slot_3", "season43_premium"]);
    assert.deepEqual([...CollectPrestigeRewardIds({ payload: { paths: [
        { prestige: { free_rewards: { stacked_items: [{ catalog_id: "CURRENCY_SEASONAL_COIN", quantity: 5 }] },
            premium_rewards: { stacked_items: [{ catalog_id: "CURRENCY_SEASONAL_COIN", quantity: 20 }] } } },
        { prestige: { free_rewards: { stacked_items: [{ catalog_id: "CURRENCY_PJM_PRESTIGE_FILLED", quantity: 1 }] } } },
        { requirements: [] }
    ] } })].sort(), ["CURRENCY_PJM_PRESTIGE_FILLED", "CURRENCY_SEASONAL_COIN"]);
    assert.deepEqual([...CollectPrestigeRewardIds(undefined)], []);
});

// [2026-10-13 realms S3] The one HUNT_PASS exception: the claim-funded season-challenge coin grant.
test("a host may post CURRENCY_SEASONAL_COIN as the claim-funded grant: a whole 1..1000 stacked add", () => {
    // The two grants measured on a dedicated hunt were 400 each; 1000 is the most one claim funds.
    for (const quantity of [1, 400, 1000]) {
        const body = { addStackedItems: [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity }] };
        assert.equal(IsClaimFundedCoinGrant(body.addStackedItems[0]), true, String(quantity));
        assert.deepEqual(HostGrantViolations(body, CATALOG), [], String(quantity));
        assert.equal(HostGrantDenial({ guardCompletionMode: "END_OF_HUNT" }, body, CATALOG), undefined, String(quantity));
    }
    // Next to ordinary loot, in the same transaction.
    const withLoot = { addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }, { catalogId: "CURRENCY_SEASONAL_COIN", quantity: 400 }] };
    assert.deepEqual(HostGrantViolations(withLoot, CATALOG), []);
});

test("a seasonal coin grant that no claim could fund stays denied as HUNT_PASS", () => {
    for (const quantity of [0, -5, 1001, 100000, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "400", null, undefined]) {
        const body = { addStackedItems: [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity }] };
        assert.equal(IsClaimFundedCoinGrant(body.addStackedItems[0]), false, String(quantity));
        assert.deepEqual(HostGrantViolations(body, CATALOG),
            [{ catalogId: "CURRENCY_SEASONAL_COIN", deniedClass: "HUNT_PASS", field: "addStackedItems" }], String(quantity));
    }
    // Only the stacked add is exempt: an instanced add of the same id, or any other spelling of it, is still denied.
    assert.deepEqual(HostGrantViolations({ addInstancedItems: [{ catalogId: "CURRENCY_SEASONAL_COIN", instanceId: "i" }] }, CATALOG),
        [{ catalogId: "CURRENCY_SEASONAL_COIN", deniedClass: "HUNT_PASS", field: "addInstancedItems" }]);
    for (const catalogId of ["currency_seasonal_coin", "id_currency_seasonal_coin", "Currency_Seasonal_Coin", " CURRENCY_SEASONAL_COIN"]) {
        const body = { addStackedItems: [{ catalogId, quantity: 400 }] };
        assert.equal(IsClaimFundedCoinGrant(body.addStackedItems[0]), false, catalogId);
        assert.equal(HostGrantViolations(body, CATALOG).length, 1, catalogId);
    }
});

test("every other Hunt Pass item, cosmetic, premium currency and entitlement stays denied next to a claim-funded coin", () => {
    const body = {
        addStackedItems: [
            { catalogId: "CURRENCY_SEASONAL_COIN", quantity: 400 },
            { catalogId: "CURRENCY_REWARDCACHE", quantity: 400 },
            { catalogId: "CURRENCY_S19_COIN", quantity: 10 },
            { catalogId: "CURRENCY_PRESTIGE", quantity: 10 },
            { catalogId: "CURRENCY_PJM_PRESTIGE_FILLED", quantity: 1 },
            { catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", quantity: 1 },
            { catalogId: "CURRENCY_PLATINUM", quantity: 1000 },
            { catalogId: "DYE_BABYBLUE_DURABLE", quantity: 1 }
        ],
        addInstancedItems: [{ catalogId: "exchange_slot_2", instanceId: "i" }]
    };
    // CURRENCY_PRESTIGE and CURRENCY_PJM_PRESTIGE_FILLED are prestige-gated in this catalogue: they pass here, funded by the
    // wallet (see the prestige-gated tests below); every other Hunt Pass id in the list stays denied.
    assert.deepEqual(HostGrantViolations(body, CATALOG).map((entry) => `${entry.catalogId}:${entry.deniedClass}`), [
        "CURRENCY_REWARDCACHE:HUNT_PASS", "CURRENCY_S19_COIN:HUNT_PASS",
        "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM:HUNT_PASS",
        "CURRENCY_PLATINUM:PREMIUM_CURRENCY", "DYE_BABYBLUE_DURABLE:COSMETIC", "exchange_slot_2:ENTITLEMENT"
    ]);
});

// [2026-10-14 realms S4] The prestige-gated exception: a host may grant a reward the wallet's prestige gate pays, and the gate
// funds it or refuses the transaction (wallet.ts); this policy only lets that one shape through.
test("a host may grant a prestige-gated reward: a whole, positive stacked add of its HUNT_PASS-class id", () => {
    for (const catalogId of ["CURRENCY_PRESTIGE", "CURRENCY_PJM_PRESTIGE_FILLED"]) {
        for (const quantity of [1, 5, 100]) {
            const item = { catalogId, quantity };
            assert.equal(IsPrestigeFundedGrant(item, CATALOG), true, `${catalogId} x${quantity}`);
            const body = { addStackedItems: [item] };
            assert.deepEqual(HostGrantViolations(body, CATALOG), [], `${catalogId} x${quantity}`);
            assert.equal(HostGrantDenial({ guardCompletionMode: "END_OF_HUNT" }, body, CATALOG), undefined, `hunt ${catalogId} x${quantity}`);
        }
    }
    // Next to ordinary loot, in the same transaction.
    const withLoot = { addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }, { catalogId: "CURRENCY_PJM_PRESTIGE_FILLED", quantity: 1 }] };
    assert.equal(HostGrantDenial(RAMSGATE_HUB, withLoot, CATALOG), undefined);
});

test("a prestige-gated id that is not a whole positive stacked add stays denied, and so does any other spelling of it", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "1", null, undefined]) {
        const body = { addStackedItems: [{ catalogId: "CURRENCY_PRESTIGE", quantity }] };
        assert.equal(IsPrestigeFundedGrant(body.addStackedItems[0], CATALOG), false, String(quantity));
        assert.deepEqual(HostGrantViolations(body, CATALOG),
            [{ catalogId: "CURRENCY_PRESTIGE", deniedClass: "HUNT_PASS", field: "addStackedItems" }], String(quantity));
    }
    // An instanced add of the gated id is not the wallet's currency path at all.
    assert.deepEqual(HostGrantViolations({ addInstancedItems: [{ catalogId: "CURRENCY_PJM_PRESTIGE_FILLED", instanceId: "i" }] }, CATALOG),
        [{ catalogId: "CURRENCY_PJM_PRESTIGE_FILLED", deniedClass: "HUNT_PASS", field: "addInstancedItems" }]);
    // Only the exact catalogue id the wallet pays qualifies (AddCurrency and the gate match it exactly).
    for (const catalogId of ["currency_prestige", "id_currency_prestige", "CURRENCY_PRESTIGE "]) {
        assert.equal(IsPrestigeFundedGrant({ catalogId, quantity: 1 }, CATALOG), false, catalogId);
        assert.equal(HostGrantViolations({ addStackedItems: [{ catalogId, quantity: 1 }] }, CATALOG).length, 1, catalogId);
    }
});

test("a gated id is still denied when it is classed as Platinum, a cosmetic or an entitlement: the exception is HUNT_PASS only", () => {
    const odd = { ...CATALOG, isPrestigeGated: (catalogId: string) => ["CURRENCY_PLATINUM", "DYE_BABYBLUE_DURABLE", "season43_premium"].includes(catalogId) || CATALOG.isPrestigeGated(catalogId) };
    assert.deepEqual(HostGrantViolations({ addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 5 }] }, odd).map((entry) => entry.deniedClass), ["PREMIUM_CURRENCY"]);
    assert.deepEqual(HostGrantViolations({ addStackedItems: [{ catalogId: "DYE_BABYBLUE_DURABLE", quantity: 1 }] }, odd).map((entry) => entry.deniedClass), ["COSMETIC"]);
    assert.deepEqual(HostGrantViolations({ addStackedItems: [{ catalogId: "season43_premium", quantity: 1 }] }, odd).map((entry) => entry.deniedClass), ["ENTITLEMENT"]);
});

test("the prestige-gated exception never waives a removal; a hosted Training hunt still refuses the grant", () => {
    assert.deepEqual(HostGrantViolations({ removeStackedItems: [{ catalogId: "CURRENCY_PRESTIGE", quantity: 2 }] }, CATALOG), []);
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "NO_COMPLETION" }, { addStackedItems: [{ catalogId: "CURRENCY_PJM_PRESTIGE_FILLED", quantity: 1 }] }, CATALOG)?.classes,
        ["NO_REWARD_SESSION"]);
    // [2026-10-16] A realm's Training hub decides it as its Ramsgate does.
    assert.deepEqual(HostGrantDenial(TRAINING_HUB, { addStackedItems: [{ catalogId: "CURRENCY_PJM_PRESTIGE_FILLED", quantity: 1 }] }, CATALOG),
        HostGrantDenial(RAMSGATE_HUB, { addStackedItems: [{ catalogId: "CURRENCY_PJM_PRESTIGE_FILLED", quantity: 1 }] }, CATALOG));
});

test("a no-reward session (Training) still refuses the claim-funded coin like any grant", () => {
    const coin = { addStackedItems: [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity: 400 }] };
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "NO_COMPLETION" }, coin, CATALOG)?.classes, ["NO_REWARD_SESSION"]);
});

// [2026-10-14 realms S4] A realm's Ramsgate hub carries NO_COMPLETION but is not a no-reward session: it keeps the class deny
// list and the claim-funded coin rule exactly as a hunt (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md section 7.3).
const RAMSGATE_HUB = { guardCompletionMode: "NO_COMPLETION" as const, sessionKind: "REALM_HUB" as const, hubKind: "RAMSGATE" as const };
const TRAINING_HUB = { guardCompletionMode: "NO_COMPLETION" as const, sessionKind: "REALM_HUB" as const, hubKind: "TRAINING" as const };

test("a realm's Ramsgate hub is not a no-reward session: loot and spends pass, the deny classes still apply", () => {
    const loot = { addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }, { catalogId: "BREAK_LERAWR_HIDE", quantity: 4 }] };
    assert.equal(HostGrantDenial(RAMSGATE_HUB, loot, CATALOG), undefined);
    const spend = { removeStackedItems: [{ catalogId: "BREAK_LERAWR_HIDE", quantity: 3 }], addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 2 }] };
    assert.equal(HostGrantDenial(RAMSGATE_HUB, spend, CATALOG), undefined);
    assert.deepEqual(HostGrantDenial(RAMSGATE_HUB, { addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 1000 }] }, CATALOG)?.classes,
        ["PREMIUM_CURRENCY"]);
    assert.deepEqual(HostGrantDenial(RAMSGATE_HUB, { addInstancedItems: [{ catalogId: "DYE_BABYBLUE_DURABLE", instanceId: "d" }] }, CATALOG)?.classes,
        ["COSMETIC"]);
    assert.deepEqual(HostGrantDenial(RAMSGATE_HUB, { removeInstancedItems: [{ catalogId: "exchange_slot_2", instanceId: "j" }] }, CATALOG)?.classes,
        ["ENTITLEMENT"]);
});

test("a Ramsgate hub's claim-funded season coin is judged exactly as a hunt judges it", () => {
    const claimFunded = { addStackedItems: [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity: 400 }] };
    const beyondOneClaim = { addStackedItems: [{ catalogId: "CURRENCY_SEASONAL_COIN", quantity: 1001 }] };
    assert.equal(HostGrantDenial(RAMSGATE_HUB, claimFunded, CATALOG), undefined);
    assert.equal(HostGrantDenial({ guardCompletionMode: "FIRST_DEFEAT" }, claimFunded, CATALOG), undefined);
    assert.deepEqual(HostGrantDenial(RAMSGATE_HUB, beyondOneClaim, CATALOG)?.classes, ["HUNT_PASS"]);
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "FIRST_DEFEAT" }, beyondOneClaim, CATALOG)?.classes, ["HUNT_PASS"]);
});

// [2026-10-16] A realm's Training hub grants like its Ramsgate: the Training Grounds tutorial's quest reward (100 Rams) was
// refused there, so the quest step never completed. The class deny list still applies (Platinum stays refused).
test("a Training hub grants a quest reward and keeps the class deny list, as Ramsgate does; saves pass", () => {
    const loot = { addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }] };
    assert.equal(HostGrantDenial(TRAINING_HUB, loot, CATALOG), undefined);
    assert.deepEqual(HostGrantDenial(TRAINING_HUB, { addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 1 }] }, CATALOG)?.classes,
        HostGrantDenial(RAMSGATE_HUB, { addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 1 }] }, CATALOG)?.classes);
    assert.notDeepEqual(HostGrantDenial(TRAINING_HUB, { addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 1 }] }, CATALOG), undefined,
        "a Platinum grant is still refused by class");
    assert.equal(HostGrantDenial(TRAINING_HUB, { removeStackedItems: [{ catalogId: "QI_ATTACK_SPEED_POTION", quantity: 1 }] }, CATALOG),
        HostGrantDenial(RAMSGATE_HUB, { removeStackedItems: [{ catalogId: "QI_ATTACK_SPEED_POTION", quantity: 1 }] }, CATALOG));
    assert.equal(HostGrantDenial(TRAINING_HUB, { saveInstancedItems: [{ catalogId: "WP_AC_ARMSTRONG", instanceId: "w", itemData: "{}" }] }, CATALOG),
        undefined);
});

test("only a realm session of kind Ramsgate or Training escapes the no-reward refusal", () => {
    const loot = { addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }] };
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "NO_COMPLETION", sessionKind: "REALM_HUB" }, loot, CATALOG)?.classes,
        ["NO_REWARD_SESSION"], "a realm hub with no hub kind");
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "NO_COMPLETION", hubKind: "RAMSGATE" }, loot, CATALOG)?.classes,
        ["NO_REWARD_SESSION"], "a hub kind without the realm session kind");
});
// [2026-10-14 owner decision, coordinator scope] A host may spend Platinum in a hunt and in a realm's Ramsgate hub. The spend is a
// stacked removal of a Platinum id; the wallet refuses it past the balance, and the Training hub keeps its blanket refusal.
test("a stacked Platinum removal is a spend: allowed in a hunt and a realm hub, refused by a hosted Training hunt", () => {
    const spend = { removeStackedItems: [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 5 }, { catalogId: "CURRENCY_PLATINUM", quantity: 40 },
        { catalogId: "id_currency_platinum", quantity: 1 }] };
    assert.deepEqual(HostGrantViolations(spend, CATALOG), []);
    assert.equal(HostGrantDenial({ guardCompletionMode: "END_OF_HUNT" }, spend, CATALOG), undefined);
    assert.equal(HostGrantDenial({ guardCompletionMode: "FIRST_DEFEAT" }, spend, CATALOG), undefined);
    assert.equal(HostGrantDenial(RAMSGATE_HUB, spend, CATALOG), undefined);
    assert.equal(HostGrantDenial(TRAINING_HUB, spend, CATALOG), undefined, "[2026-10-16] a Training hub as its Ramsgate");
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "NO_COMPLETION" }, spend, CATALOG)?.classes, ["NO_REWARD_SESSION"], "a hosted Training hunt too");
});

test("a Platinum grant stays denied everywhere, and other premium or entitlement removals stay denied", () => {
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "END_OF_HUNT" },
        { addStackedItems: [{ catalogId: "CURRENCY_PLATINUM_EPIC", quantity: 5 }] }, CATALOG)?.classes, ["PREMIUM_CURRENCY"]);
    assert.deepEqual(HostGrantDenial(RAMSGATE_HUB, { addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 1 }] }, CATALOG)?.classes,
        ["PREMIUM_CURRENCY"]);
    assert.deepEqual(HostGrantDenial(RAMSGATE_HUB, { addStackedItems: [{ catalogId: "id_currency_platinum", quantity: 1 }] }, CATALOG)?.classes,
        ["PREMIUM_CURRENCY"]);
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "END_OF_HUNT" },
        { removeStackedItems: [{ catalogId: "DEBUG_CURRENCY_PLATINUM_10K", quantity: 1 }] }, CATALOG)?.classes, ["PREMIUM_CURRENCY"],
        "a debug grant is not Platinum: its removal stays denied");
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "END_OF_HUNT" },
        { removeInstancedItems: [{ catalogId: "CURRENCY_PLATINUM_EPIC", instanceId: "x" }] }, CATALOG)?.classes, ["PREMIUM_CURRENCY"],
        "only stacked currency is spent");
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "END_OF_HUNT" },
        { removeInstancedItems: [{ catalogId: "exchange_slot_2", instanceId: "j" }] }, CATALOG)?.classes, ["ENTITLEMENT"]);
});

// [2026-10-15] The daily premium draft token: the allowance the hostDraftPremium decision passes (draftPremium: true) lets exactly one
// whole token through; everything else about it, and every other Hunt Pass item, stays denied.
test("the daily premium draft token is exempt only as one whole stacked add, and only when the decision allowed it", () => {
    const token = { catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", quantity: 1 };
    const allowed = { draftPremium: true };
    assert.equal(HOST_DRAFT_PREMIUM_BALANCE_CAP, 1);
    assert.equal(IsHostDraftPremiumAdd(token), true);
    assert.equal(IsHostDraftPremiumAdd({ ...token, quantity: 2 }), false);
    assert.equal(IsHostDraftPremiumAdd({ ...token, quantity: 0 }), false);
    assert.equal(IsHostDraftPremiumAdd({ ...token, catalogId: "token_daily_challenge_draft_premium" }), false, "the id is matched exactly");

    // Without the decision, as before: a HUNT_PASS violation.
    assert.deepEqual(HostGrantViolations({ addStackedItems: [token] }, CATALOG), [
        { catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", deniedClass: "HUNT_PASS", field: "addStackedItems" }]);
    // With the decision: exempt.
    assert.deepEqual(HostGrantViolations({ addStackedItems: [token] }, CATALOG, allowed), []);
    assert.equal(HostGrantDenial({ guardCompletionMode: "END_OF_HUNT" }, { addStackedItems: [token] }, CATALOG, allowed), undefined);
    // Next to ordinary loot, in the same transaction.
    assert.deepEqual(HostGrantViolations({ addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 100 }, token] }, CATALOG, allowed), []);
});

test("the draft premium exemption never waives another Hunt Pass item, a second token, a bad quantity or any other operation", () => {
    const token = { catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", quantity: 1 };
    const allowed = { draftPremium: true };
    // Every other HUNT_PASS item in the same transaction stays denied.
    assert.deepEqual(HostGrantViolations({ addStackedItems: [token, { catalogId: "CURRENCY_REWARDCACHE", quantity: 10 }] }, CATALOG, allowed)
        .map((entry) => `${entry.catalogId}:${entry.deniedClass}`), ["CURRENCY_REWARDCACHE:HUNT_PASS"]);
    assert.deepEqual(HostGrantViolations({ addStackedItems: [token, { catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", quantity: 1 }] }, CATALOG, allowed)
        .map((entry) => entry.catalogId), ["TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM"], "two whole tokens: none exempt");
    // A quantity other than one.
    for (const quantity of [2, 0, -1, 1.5]) {
        assert.equal(HostGrantViolations({ addStackedItems: [{ catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", quantity }] }, CATALOG, allowed).length, 1, String(quantity));
    }
    // The token in any other operation: an instanced add, or a removal of the token (a removal is not a grant; the removal rule is unchanged).
    assert.deepEqual(HostGrantViolations({ addInstancedItems: [{ catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", instanceId: "i" }] }, CATALOG, allowed),
        [{ catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", deniedClass: "HUNT_PASS", field: "addInstancedItems" }]);
    assert.deepEqual(HostGrantViolations({ removeStackedItems: [token] }, CATALOG, allowed), []);
    // Other spellings of the id get no exemption.
    assert.equal(HostGrantViolations({ addStackedItems: [{ catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM ", quantity: 1 }] }, CATALOG, allowed).length, 1);
});

test("a Training hub, like a Ramsgate hub, takes the draft premium token with the decision; a hosted Training hunt refuses it", () => {
    const token = { addStackedItems: [{ catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM", quantity: 1 }] };
    const allowed = { draftPremium: true };
    assert.equal(HostGrantDenial(TRAINING_HUB, token, CATALOG, allowed), undefined);
    assert.deepEqual(HostGrantDenial({ guardCompletionMode: "NO_COMPLETION" }, token, CATALOG, allowed)?.classes, ["NO_REWARD_SESSION"]);
    assert.equal(HostGrantDenial(RAMSGATE_HUB, token, CATALOG, allowed), undefined);
    assert.deepEqual(HostGrantDenial(RAMSGATE_HUB, token, CATALOG)?.classes, ["HUNT_PASS"], "without the decision the hub refuses it as before");
});

// [2026-10-16] The hub's starter grant (runtime [GrantTrace] source="default"), exactly as it posts it on a hub arrival.
const STARTER_DEFAULT_GRANT = {
    addStackedItems: [
        ...[...HOST_STARTER_COSMETIC_IDS].map((catalogId) => ({ catalogId, quantity: 1 })),
        { catalogId: "TOKEN_OB_PROGRESSION", quantity: 1 },
        { catalogId: "TOKEN_DAILY_CHALLENGE_DRAFT", quantity: 4 },
        { catalogId: "TOKEN_WEEKLY_CHALLENGE_DRAFT", quantity: 4 }
    ]
};

test("[2026-10-16] the game's starter grant is not refused: its refusal sent a level-20 player back to the login screen", () => {
    assert.equal(HOST_STARTER_COSMETIC_IDS.size, 13);
    assert.deepEqual(HostGrantViolations(STARTER_DEFAULT_GRANT, CATALOG), []);
    assert.equal(HostGrantDenial({ guardCompletionMode: "NO_COMPLETION", sessionKind: "REALM_HUB", hubKind: "RAMSGATE" } as any,
        STARTER_DEFAULT_GRANT, CATALOG), undefined, "a realm's Ramsgate hub accepts it");
    assert.deepEqual(HostGrantViolations({ addInstancedItems: [{ catalogId: "EM_INTRO_GENERIC_001", instanceId: "EM_INTRO_GENERIC_001" }] }, CATALOG), []);
});

test("[2026-10-16] only the starter ids, one each, are exempt: other cosmetics and larger quantities stay refused", () => {
    const Refused = HostGrantViolations({ addStackedItems: [
        { catalogId: "EM_INTRO_GENERIC_001", quantity: 2 },
        { catalogId: "EM_INTRO_3POINT_00", quantity: 1 },
        { catalogId: "TITLE_PHOENIX_00", quantity: 1 },
        { catalogId: "em_intro_generic_001", quantity: 1 }
    ] }, CATALOG);
    assert.deepEqual(Refused.map((entry) => entry.catalogId), ["EM_INTRO_GENERIC_001", "EM_INTRO_3POINT_00", "TITLE_PHOENIX_00", "em_intro_generic_001"]);
    assert.equal(Refused.every((entry) => entry.deniedClass === "COSMETIC"), true);
});