/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    FindStoreSkuByIdOrCatalogId,
    GetLadyLuckSkus,
    GetStoreSkus,
} from "./store";
import { MintInstanceId, NeedsMintedInstanceId } from "./inventory";

const EXPECTED_CATEGORY_COUNTS: Record<string, number> = {
    tab_season_armour: 48,
    tab_season_weapon: 34,
    tab_season_style: 23,
    season_store_event: 55,
    tab_season_limited: 10,
    season_store_general: 8,
};

const ALLOWED_PRICE_TIERS = new Set([700, 800, 1000, 2000, 2500, 3000]);

test("Reward Cache exposes the deterministic 178-item reconstructed rotation", () => {
    const Skus = GetStoreSkus("season_store");
    assert.equal(Skus.length, 178);
    assert.equal(new Set(Skus.map((Sku) => Sku.id)).size, 178);
    assert.equal(new Set(Skus.flatMap((Sku) => Sku.items.map((Item) => Item.catalogId))).size, 178);

    for (const Sku of Skus) {
        assert.equal(Sku.maxAllowed, 1);
        assert.equal(Sku.items.length, 1);
        assert.equal(Sku.prices.length, 1);
        assert.equal(Sku.prices[0].currencyId, "id_currency_seasonal_coin");
        assert(ALLOWED_PRICE_TIERS.has(Sku.prices[0].price), `unexpected price for ${Sku.id}`);
        assert(Sku.prices[0].price >= 700);
        assert(Sku.prices[0].price <= 3000);
        assert(Sku.tags.includes("season_store"));
        assert(Sku.tags.includes("season19"));
        assert(Sku.tags.includes("reward_cache_reconstructed"));
        assert(Sku.tags.some((Tag) => /^reward_cache_rarity_[3-6]$/.test(Tag)));
        assert.deepEqual(Sku.duplicateInstancedItems, [Sku.items[0].catalogId]);
        assert.match(Sku.images?.standard ?? "", /^Engine\.Texture2D'\/Game\/.+'$/);
    }

    for (const [CategoryTag, ExpectedCount] of Object.entries(EXPECTED_CATEGORY_COUNTS)) {
        assert.equal(Skus.filter((Sku) => Sku.tags.includes(CategoryTag)).length, ExpectedCount, CategoryTag);
    }
    assert.equal(Skus.filter((Sku) => Sku.tags.includes("season_store_feature")).length, 7);
});

test("Reward Cache pricing keeps marquee and entry offers at their intended tiers", () => {
    const Skus = GetStoreSkus("season_store");
    const ByCatalogId = new Map(Skus.map((Sku) => [Sku.items[0].catalogId, Sku]));

    const FirstSlayerHelm = ByCatalogId.get("AR_HP08A_HEROES_HELM_00_ULTRA");
    assert(FirstSlayerHelm);
    assert.equal(FirstSlayerHelm.prices[0].price, 3000);
    assert(FirstSlayerHelm.tags.includes("season_store_feature"));

    const IgneousPeak = ByCatalogId.get("AR_ARMSTRONG_HELM_ULTRA");
    assert(IgneousPeak);
    assert.equal(IgneousPeak.prices[0].price, 2000);
    assert(IgneousPeak.tags.includes("tab_season_armour"));

    const VoidRunner = ByCatalogId.get("TITLE_HP10A_CELESTIAL_01");
    assert(VoidRunner);
    assert.equal(VoidRunner.prices[0].price, 700);
    assert(VoidRunner.tags.includes("season_store_general"));

    const NullForces = ByCatalogId.get("WP_AC_HP10A_CELESTIAL_00");
    assert(NullForces);
    assert.equal(NullForces.displayName, "Null Forces");
    assert.equal(NullForces.prices[0].price, 2000);
    assert(NullForces.tags.includes("tab_season_weapon"));

    const TactileWaveform = ByCatalogId.get("AR_HP10A_CELESTIAL_ARMS_00_ULTRA");
    assert(TactileWaveform);
    assert.equal(TactileWaveform.prices[0].price, 2500);
    assert(TactileWaveform.tags.includes("tab_season_armour"));

    const StrikingMidnight = ByCatalogId.get("WP_GA_HP10A_CELESTIAL_00");
    assert(StrikingMidnight);
    assert.equal(StrikingMidnight.displayName, "Striking Midnight");
    assert.equal(StrikingMidnight.prices[0].price, 2000);
    assert(StrikingMidnight.tags.includes("tab_season_weapon"));

    const VoidmindInfinite = ByCatalogId.get("AR_HP10A_CELESTIAL_HELM_00_ULTRA");
    assert(VoidmindInfinite);
    assert.equal(VoidmindInfinite.prices[0].price, 2500);
    assert(VoidmindInfinite.tags.includes("tab_season_armour"));

    const Aetherpunk = ByCatalogId.get("TITLE_HP08B_01");
    assert(Aetherpunk);
    assert.equal(Aetherpunk.prices[0].price, 800);
    assert(Aetherpunk.tags.includes("season_store_general"));

    const VoidRunnerStandard = ByCatalogId.get("BNC_STANDARD_HP10A_CELESTIAL_00");
    assert(VoidRunnerStandard);
    assert.equal(VoidRunnerStandard.prices[0].price, 1000);
    assert(VoidRunnerStandard.tags.includes("season_store_event"));

    const Battlecry = ByCatalogId.get("EM_INTRO_HP12A_FROSTWARDEN_00");
    assert(Battlecry);
    assert.equal(Battlecry.prices[0].price, 2500);
    assert(Battlecry.tags.includes("tab_season_style"));

    const AlchemancerFlare = ByCatalogId.get("QI_FLARE_HP11A_ALCHEMIST_00");
    assert(AlchemancerFlare);
    assert.equal(AlchemancerFlare.prices[0].price, 1000);
    assert(AlchemancerFlare.tags.includes("tab_season_style"));

    const Riptalon = ByCatalogId.get("GD_FRAME_A_BASE");
    assert(Riptalon);
    assert.equal(Riptalon.prices[0].price, 2500);
    assert(Riptalon.tags.includes("tab_season_limited"));

    const Bluefeather = ByCatalogId.get("GD_FRAME_B_BLUEWING");
    assert(Bluefeather);
    assert(Bluefeather.tags.includes("reward_cache_rarity_3"));

    const ChoppingMaul = ByCatalogId.get("WP_GA_HP10B_RAIDERS_00");
    assert(ChoppingMaul);
    assert.equal(ChoppingMaul.displayName, "Chopping Maul");
    assert.equal(ChoppingMaul.prices[0].price, 2500);
    assert(ChoppingMaul.tags.includes("tab_season_weapon"));

    const MidnightSun = ByCatalogId.get("WP_GA_HP05_NINJA_00");
    assert(MidnightSun);
    assert.equal(MidnightSun.displayName, "Midnight Sun");
    assert.equal(MidnightSun.prices[0].price, 2000);
    assert(MidnightSun.tags.includes("reward_cache_rarity_3"));

    const WayfinderSuit = ByCatalogId.get("AR_HP10B_RAIDERS_CHEST_00_ULTRA");
    assert(WayfinderSuit);
    assert.equal(WayfinderSuit.displayName, "Wayfinder's Flight Suit");
    assert.equal(WayfinderSuit.prices[0].price, 2500);
    assert(WayfinderSuit.tags.includes("tab_season_armour"));

    const BurningSecrets = ByCatalogId.get("BNC_ANIMATION_HP05_FLAMES_00");
    assert(BurningSecrets);
    assert.equal(BurningSecrets.displayName, "Burning Secrets");
    assert.equal(BurningSecrets.prices[0].price, 2000);
    assert(BurningSecrets.tags.includes("season_store_event"));

    const AdmiralFlagstaff = ByCatalogId.get("BNC_STANDARD_OSTIA_00");
    assert(AdmiralFlagstaff);
    assert.equal(AdmiralFlagstaff.displayName, "Admiral's Flagstaff");
    assert.equal(AdmiralFlagstaff.prices[0].price, 2500);
    assert(AdmiralFlagstaff.tags.includes("season_store_event"));

    const BatsEntertainment = ByCatalogId.get("EM_INTRO_HP07B_COFFINDROP_BAT_00");
    assert(BatsEntertainment);
    assert.equal(BatsEntertainment.displayName, "Bat's Entertainment");
    assert.equal(BatsEntertainment.prices[0].price, 2500);
    assert(BatsEntertainment.tags.includes("tab_season_style"));

    const Clearsky = ByCatalogId.get("GD_FRAME_B_BASE");
    assert(Clearsky);
    assert.equal(Clearsky.displayName, "Clearsky");
    assert.equal(Clearsky.prices[0].price, 2000);
    assert(Clearsky.tags.includes("tab_season_limited"));

    const Lightsworn = ByCatalogId.get("WP_GA_ELVEN_00");
    assert(Lightsworn);
    assert.equal(Lightsworn.displayName, "Lightsworn Benediction");
    assert.equal(Lightsworn.prices[0].price, 3000);
    assert(Lightsworn.tags.includes("season_store_feature"));

    assert.equal(ByCatalogId.has("WP_GA_SPOOKY_01"), false, "Shadow Scythe is a Rumour-only reward");

    const HawkFabric = ByCatalogId.get("BNC_FABRIC_EVENT_HP09A_ASSASSINS_01");
    assert(HawkFabric);
    assert.equal(HawkFabric.displayName, "Hawk's Cry");
    assert.equal(HawkFabric.prices[0].price, 1000);

    const HawkSigil = ByCatalogId.get("BNC_SIGIL_EVENT_HP09A_ASSASSINS_00");
    assert(HawkSigil);
    assert.equal(HawkSigil.displayName, "Justice of the Blaze Hawk");
    assert.equal(HawkSigil.prices[0].price, 1000);
});

test("Reward Cache preserves the requested premium cosmetic-family counts", () => {
    const CatalogIds = GetStoreSkus("season_store").map((Sku) => Sku.items[0].catalogId);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("WP_GA_")).length, 22);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("AR_")).length, 48);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("BNC_ANIMATION_")).length, 9);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("BNC_FABRIC_")).length, 15);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("BNC_SIGIL_")).length, 13);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("BNC_")).length, 54);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("EM_")).length, 16);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("TITLE_")).length, 7);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("QI_FLARE_")).length, 4);
    assert.equal(CatalogIds.filter((CatalogId) => CatalogId.startsWith("GD_FRAME_")).length, 7);
});

test("Reward Cache groups complete armour and banner families in client display order", () => {
    const CatalogIds = GetStoreSkus("season_store").map((Sku) => Sku.items[0].catalogId);

    assert.deepEqual(
        CatalogIds.filter((CatalogId) => CatalogId.startsWith("AR_HP09A_ASSASSINS_") && CatalogId.endsWith("_ULTRA")),
        [
            "AR_HP09A_ASSASSINS_HELM_00_ULTRA",
            "AR_HP09A_ASSASSINS_CHEST_00_ULTRA",
            "AR_HP09A_ASSASSINS_ARMS_00_ULTRA",
            "AR_HP09A_ASSASSINS_LEGS_00_ULTRA",
        ]
    );

    const SeismicIds = new Set([
        "AR_HP09B_COMMANDO_HELM_00_ULTRA",
        "AR_HP09B_COMMANDO_CHEST_00_ULTRA",
        "AR_HP09B_COMMANDO_ARMS_00_ULTRA",
        "AR_HP09B_COMMANDO_LEGS_00_ULTRA",
        "AR_HP09B_COMMANDO_HELM_00",
        "AR_HP09B_COMMANDO_CHEST_00",
        "AR_HP09B_COMMANDO_ARMS_00",
        "AR_HP09B_COMMANDO_LEGS_00",
    ]);
    assert.deepEqual(
        CatalogIds.filter((CatalogId) => SeismicIds.has(CatalogId)),
        [
            "AR_HP09B_COMMANDO_HELM_00_ULTRA",
            "AR_HP09B_COMMANDO_CHEST_00_ULTRA",
            "AR_HP09B_COMMANDO_ARMS_00_ULTRA",
            "AR_HP09B_COMMANDO_LEGS_00_ULTRA",
            "AR_HP09B_COMMANDO_HELM_00",
            "AR_HP09B_COMMANDO_CHEST_00",
            "AR_HP09B_COMMANDO_ARMS_00",
            "AR_HP09B_COMMANDO_LEGS_00",
        ]
    );

    assert.deepEqual(
        CatalogIds.filter((CatalogId) => CatalogId.includes("HP09A_ASSASSINS") && CatalogId.startsWith("BNC_")),
        [
            "BNC_STANDARD_HP09A_ASSASSINS_00",
            "BNC_FABRIC_EVENT_HP09A_ASSASSINS_01",
            "BNC_SIGIL_EVENT_HP09A_ASSASSINS_00",
            "BNC_ANIMATION_HP09A_ASSASSINS_00",
        ]
    );
});

test("store lookup binds generated SKU ids and unique catalog ids to season_store", () => {
    assert.equal(
        FindStoreSkuByIdOrCatalogId("season19_rewardcache_armour_ar_armstrong_helm_ultra")?.storeTag,
        "season_store"
    );
    assert.equal(
        FindStoreSkuByIdOrCatalogId("AR_ARMSTRONG_HELM_ULTRA")?.storeTag,
        "season_store"
    );
    assert.equal(FindStoreSkuByIdOrCatalogId("NOT_A_REAL_SKU"), undefined);
});

test("Lady Luck matches the live 1.14.7 rotation with explicit catalog images", () => {
    // [1.14.7 2026-10-08] Built from the live capture (scripts/enrich_ladyluck_store.ts): 38 of its 43 SKUs -
    // the five per-attribute gold cell cores do not exist in the 1.14.7 catalogue.
    const LadyLuck = GetLadyLuckSkus();
    assert.equal(LadyLuck.length, 38);
    assert.equal(new Set(LadyLuck.map((Sku) => Sku.id)).size, 38);
    assert.equal(GetStoreSkus("ladyluckstore"), LadyLuck);

    const ById = new Map(LadyLuck.map((Sku) => [Sku.id, Sku]));
    assert.match(ById.get("trials_dye_hp08b_punk_02")?.images?.standard ?? "", /HP8B_Dyes_entropy/);
    assert.match(ById.get("trials_dye_hp11b_engineer_00")?.images?.standard ?? "", /DYE_HP11B_ENGINEER_00_DURABLE/);

    const Frank = ById.get("trials_pr_frank");
    assert.equal(Frank?.displayName, "Artificer");
    assert.deepEqual(Frank?.prices, [{ currencyId: "id_currency_marks_steel", price: 300 }]);
    assert.deepEqual(Frank?.items, [{ catalogId: "PR_FRANK", quantity: 1, instanced: true }]);
    assert.ok(Frank?.tags.includes("store_trials_tab_cells"));
    assert.match(Frank?.images?.standard ?? "", /icon_omnicell_frank/);

    // The 1.12-era additions are retired and the unavailable gold cores are not served.
    assert.equal(LadyLuck.filter((Sku) => Sku.tags.includes("mystic_trials_expansion")).length, 0);
    assert.equal(ById.get("ladyluck_omnicell_discipline_unlock"), undefined);
    assert.equal(LadyLuck.some((Sku) => Sku.items.some((Item) => /^CONTAINER_CORE_GOLD_.+_CELLCORE$/.test(Item.catalogId))), false);
});

test("Lady Luck prices follow the live capture (Trials gear in Gilded Marks)", () => {
    const ById = new Map(GetLadyLuckSkus().map((Sku) => [Sku.id, Sku]));
    const GildedIds = [
        "ladyluck_weapon_strikers_normal",
        "ladyluck_weapon_sword_normal",
        "ladyluck_weapon_banner_normal",
        "ladyluck_armor_chest",
        "ladyluck_armor_helm",
        "ladyluck_armor_legs",
        "ladyluck_armor_arms",
        "ladyluck_weapon_strikers_prestige",
        "ladyluck_headbling_prestige",
        "ladyluck_armor_chest_prestige",
        "ladyluck_lantern_01_cosmetic",
        "single_dye_black",
        "single_dye_white",
    ];
    for (const Id of GildedIds) {
        assert.equal(ById.get(Id)?.prices[0].currencyId, "id_currency_marks_gilded", Id);
    }
    assert.equal(ById.get("ladyluck_armor_arms")?.prices[0].price, 500);
    assert.equal(ById.get("trials_pr_frank")?.prices[0].currencyId, "id_currency_marks_steel");
});

test("Lady Luck and Reward Cache catalog lookup remains unambiguous", () => {
    const LadyLuck = GetLadyLuckSkus();
    const RewardCache = GetStoreSkus("season_store");
    const LadyLuckCatalogIds = new Set(LadyLuck.flatMap((Sku) => Sku.items.map((Item) => Item.catalogId)));
    const Overlap = RewardCache.flatMap((Sku) => Sku.items.map((Item) => Item.catalogId)).filter((CatalogId) => LadyLuckCatalogIds.has(CatalogId));
    assert.deepEqual(Overlap, []);
    assert.equal(FindStoreSkuByIdOrCatalogId("PR_FRANK")?.storeTag, "ladyluckstore");
    assert.equal(FindStoreSkuByIdOrCatalogId("trials_pr_frank")?.storeTag, "ladyluckstore");
    assert.deepEqual(GetStoreSkus("unimplemented_store"), []);
});
// ---------------------------------------------------------------------------------------------
// Platinum store (Progress/33_PLATINUM_STORE.md). Every SKU id here is an AUTHENTIC 1.12 id from the
// client's baked StoreItemsTable, so these assertions double as a regression guard on the generator
// silently drifting away from that source.
// ---------------------------------------------------------------------------------------------

const PLATINUM_SECTIONS = ["webstore", "dyes", "hp_level_skip_rank", "huntpass_store"] as const;

// Verbatim from Default__store_view_model_C. A tag outside this set renders in no tab at all - the
// confirmed capture-4 Reward Cache failure this store must not repeat.
const CLIENT_WEBSTORE_SUBTAGS = new Set([
    "feature", "event_frostfall", "tab_event", "your_offers", "tab_secret",
    "supplies_boost", "supplies_supplies", "hunting_gliders", "personality_flaresigil",
    "personality_fabric", "personality_standard", "cells_fusion", "cells_cells",
    "dye_armour", "personality_stylekit", "personality_character", "dye_tint",
    "skin_weapon_ac", "skin_weapon_eb", "skin_weapon_dp", "skin_weapon_ih",
    "skin_weapon_ga", "skin_weapon_ms", "skin_weapon_cb",
    "skin_armour", "skin_lantern",
    "social_emote", "social_emojis", "social_arrival",
    "tab_platstore_vault", "1stparty",
]);

test("every platinum section is registered and priced in platinum only", () => {
    for (const Section of PLATINUM_SECTIONS) {
        const Skus = GetStoreSkus(Section);
        assert(Skus.length > 0, `${Section} is empty`);
        for (const Sku of Skus) {
            assert.equal(Sku.prices.length, 1, Sku.id);
            assert.equal(Sku.prices[0].currencyId, "id_currency_platinum", Sku.id);
            assert(Sku.prices[0].price > 0, `${Sku.id} is free`);
            assert(Sku.tags.includes(Section), `${Sku.id} missing its section tag`);
        }
    }

    assert.equal(GetStoreSkus("hp_level_skip_rank").length, 100);
    assert.equal(GetStoreSkus("dyes").length, 81);
});

test("every platinum webstore offer lands in a real client category", () => {
    for (const Sku of GetStoreSkus("webstore")) {
        const Categories = Sku.tags.filter((Tag) => CLIENT_WEBSTORE_SUBTAGS.has(Tag));
        assert(Categories.length > 0, `${Sku.id} matches no store_view_model_C category and would be invisible`);
    }
});

test("platinum offers never overlap Lady Luck's Store or the Reward Cache", () => {
    const Sold = new Set([
        ...GetStoreSkus("season_store").flatMap((Sku) => Sku.items.map((Item) => Item.catalogId)),
        ...GetLadyLuckSkus().flatMap((Sku) => Sku.items.map((Item) => Item.catalogId)),
    ]);

    const PlatinumGrants = GetStoreSkus("webstore").flatMap((Sku) => Sku.items.map((Item) => Item.catalogId));
    const Collisions = PlatinumGrants.filter((CatalogId) => Sold.has(CatalogId));
    assert.deepEqual(Collisions, [], "the three stores must stay disjoint");

    // and no catalog id is sold twice within the platinum store itself
    assert.equal(new Set(PlatinumGrants).size, PlatinumGrants.length);
});

test("captured and reconstructed pricing stay distinguishable", () => {
    const All = GetStoreSkus("webstore");
    for (const Sku of All) {
        const IsCaptured = Sku.tags.includes("platinum_store_captured");
        const IsReconstructed = Sku.tags.includes("platinum_store_reconstructed");
        assert(IsCaptured !== IsReconstructed, `${Sku.id} must be exactly one of captured/reconstructed`);
    }
    assert(All.some((Sku) => Sku.tags.includes("platinum_store_captured")));
    assert(All.some((Sku) => Sku.tags.includes("platinum_store_reconstructed")));
});

test("rank skips carry a progression payload and no item grant", () => {
    const Skus = GetStoreSkus("hp_level_skip_rank");
    for (const Sku of Skus) {
        assert.equal(Sku.items.length, 0, Sku.id);
        assert(Sku.skuProgression, `${Sku.id} has no progression payload`);
        assert.equal(Sku.skuProgression?.progressionId, "selected_huntpass");
        assert(typeof Sku.skuProgression?.ranks === "number" && Sku.skuProgression.ranks > 0);
    }

    // The captured ladder: 1..100 ranks, each id baked in 1.12.
    const Ranks = Skus.map((Sku) => Sku.skuProgression!.ranks!).sort((Left, Right) => Left - Right);
    assert.deepEqual(Ranks, Array.from({ length: 100 }, (Unused, Index) => Index + 1));

    const Twenty = Skus.find((Sku) => Sku.id === "hp_level_skip_20_ranks");
    assert(Twenty);
    assert.equal(Twenty.prices[0].price, 3000);
});

test("entitlement offers grant an entitlement instead of an item", () => {
    const Entitlement = [
        ...GetStoreSkus("webstore").filter((Sku) => (Sku.entitlements ?? []).length > 0),
        ...GetStoreSkus("huntpass_store"),
    ];
    assert(Entitlement.length >= 13, `expected the captured entitlement unlocks, got ${Entitlement.length}`);

    for (const Sku of Entitlement) {
        assert.equal(Sku.items.length, 0, `${Sku.id} should have no inventory payload`);
        assert.equal(Sku.maxAllowed, 1, Sku.id);
        for (const Grant of Sku.entitlements ?? []) {
            assert.match(Grant.name, /^[A-Za-z0-9_.-]+$/, Sku.id);
        }
    }

    const Furious = Entitlement.find((Sku) => Sku.id === "single_character_facepaint_furious");
    assert(Furious);
    assert.equal(Furious.prices[0].price, 100);
    assert.deepEqual(Furious.entitlements, [{ name: "character_facepaint_furious", duration: 0 }]);
    assert(Furious.tags.includes("personality_character"));

    // Season/event passes are routed to the huntpass_store section, NOT onto a webstore cosmetic
    // shelf - an Elite Track Bundle must never appear among the face paints.
    const Passes = GetStoreSkus("huntpass_store");
    const Gilded = Passes.find((Sku) => Sku.id === "pass_rewardcache_season15a");
    assert(Gilded);
    assert.equal(Gilded.prices[0].price, 950);
    assert.deepEqual(Gilded.entitlements, [{ name: "pass_rewardcache_season15a", duration: 0 }]);
    for (const Pass of Passes) {
        assert.equal(Pass.tags.includes("personality_character"), false, `${Pass.id} is not a character cosmetic`);
    }
});

test("item offers always resolve artwork, natively or by injected catalog icon", () => {
    for (const Sku of GetStoreSkus("webstore")) {
        if (Sku.items.length === 0) continue;
        assert(Sku.images != undefined, `${Sku.id} has no images map`);
        if (Sku.images!.standard != undefined) {
            assert.match(Sku.images!.standard, /^Engine\.Texture2D'\/Game\/.+'$/, Sku.id);
        }
        // an empty map is the deliberate "the client's own baked StoreItemsTable row draws this" case
    }
});

test("a SKU reachable from two sections resolves to one offer, not an ambiguous match", () => {
    // Dyes are registered under both `webstore` and `dyes`.
    const Dye = GetStoreSkus("dyes").find((Sku) => Sku.items.length === 1);
    assert(Dye);

    const ById = FindStoreSkuByIdOrCatalogId(Dye.id);
    assert(ById, "a dye SKU must resolve by its own id");
    assert.equal(ById.sku.id, Dye.id);

    const ByCatalogId = FindStoreSkuByIdOrCatalogId(Dye.items[0].catalogId);
    assert(ByCatalogId, "a dye's catalogId must not be rejected as ambiguous just because it is in two sections");
    assert.equal(ByCatalogId.sku.id, Dye.id);
});

test("Middleman fusion slots 2 and 3 are sold for 1,000 Platinum as permanent entitlements", () => {
    for (const Slot of [2, 3]) {
        const Skus = GetStoreSkus(`exchange_vendor_slot_${Slot}`);
        assert.equal(Skus.length, 1);
        const Sku = Skus[0];
        assert.equal(Sku.id, `single_exchange_slot_${Slot}`);
        assert.deepEqual(Sku.prices, [{ currencyId: "id_currency_platinum", price: 1000 }]);
        assert.deepEqual(Sku.entitlements, [{ name: `exchange_slot_${Slot}`, duration: 0 }]);
        assert.equal(Sku.maxAllowed, 1);
        assert.deepEqual(Sku.items, []);
        assert.equal(FindStoreSkuByIdOrCatalogId(Sku.id)?.storeTag, `exchange_vendor_slot_${Slot}`);
    }
});

test("instanced items created with a placeholder id get a minted 26-character id", () => {
    const Ids = new Set(Array.from({ length: 500 }, () => MintInstanceId()));
    assert.equal(Ids.size, 500);
    for (const Id of Ids) assert.match(Id, /^[A-Z2-7]{26}$/);
    assert.equal(NeedsMintedInstanceId({ catalogId: "TOKEN_CELL_EXCHANGE", instanceId: "TOKEN_CELL_EXCHANGE" }), true);
    assert.equal(NeedsMintedInstanceId({ catalogId: "WP_EB_HOST" }), true);
    assert.equal(NeedsMintedInstanceId({ catalogId: "WP_EB_HOST", instanceId: "" }), true);
    assert.equal(NeedsMintedInstanceId({ catalogId: "WP_EB_FROSTFALL_L1", instanceId: "RHLDQHG6UNBG3KROD7MWHKZSKU" }), false);
});
