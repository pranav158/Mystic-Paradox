import assert from "node:assert/strict";
import test from "node:test";
import { loadGameData } from "../../gameData/loader";
import { ClassifyHostGrant, DefaultHostGrantCatalog, HostGrantViolations } from "./hostGrantPolicy";

// Checks the host grant deny list against the real 1.14.7 game data (skipped without it, scripts/run-tests.cjs).

test("the real storage policy's premium, seasonal and cosmetic entries are all denied to hosts", () => {
    const catalog = DefaultHostGrantCatalog();
    const entries = loadGameData<any>("inventory_storage_policy.json").entries as Record<string, { tags?: string[] }>;
    const expected: Array<[string, string]> = [
        ["platinum", "PREMIUM_CURRENCY"], ["seasonal_currency", "HUNT_PASS"], ["Dye", "COSMETIC"], ["EMOTE", "COSMETIC"],
        ["EMOJI", "COSMETIC"], ["TITLE", "COSMETIC"], ["BannerCustomization", "COSMETIC"], ["GLIDER", "COSMETIC"], ["ACCESSORY", "COSMETIC"]
    ];
    for (const [tag, deniedClass] of expected) {
        const ids = Object.keys(entries).filter((id) => entries[id].tags?.includes(tag));
        assert.ok(ids.length > 0, `no ${tag} entries in the storage policy`);
        for (const id of ids) assert.equal(ClassifyHostGrant(id, catalog), deniedClass, `${id} (${tag})`);
    }
});

// [2026-10-14 realms S4] The prestige-gated exception follows the wallet's own gate on the real progression paths.
test("the real game data: the Aetherheart and Vault Coins are prestige-gated, Reward Cache and daily coins are not", () => {
    const catalog = DefaultHostGrantCatalog();
    for (const id of ["CURRENCY_PJM_PRESTIGE_FILLED", "CURRENCY_PRESTIGE", "CURRENCY_S19_COIN", "CURRENCY_SEASONAL_COIN"]) {
        assert.equal(catalog.isPrestigeGated(id), true, id);
    }
    for (const id of ["CURRENCY_REWARDCACHE", "CURRENCY_S13_DAILY", "CURRENCY_PLATINUM", "CURRENCY_NOTES", "TOKEN_HUNTPASS_PRESTIGE_S08A"]) {
        assert.equal(catalog.isPrestigeGated(id), false, id);
    }
    const aetherheart = { addStackedItems: [{ catalogId: "CURRENCY_PJM_PRESTIGE_FILLED", quantity: 1 }] };
    assert.deepEqual(HostGrantViolations(aetherheart, catalog), []);
    assert.deepEqual(HostGrantViolations({ addStackedItems: [{ catalogId: "CURRENCY_REWARDCACHE", quantity: 1 }] }, catalog).map((entry) => entry.deniedClass),
        ["HUNT_PASS"]);
});

test("the real game data keeps hunt loot allowed and names the pass entitlement", () => {
    const catalog = DefaultHostGrantCatalog();
    assert.ok(catalog.prestigeRewardIds.has("CURRENCY_SEASONAL_COIN"));
    assert.ok(catalog.entitlementNames.has("season43_premium"));
    for (const id of ["CURRENCY_NOTES", "CURRENCY_PJM_PRESTIGE_EMPTY", "CURRENCY_PJM_WEAPON", "CURRENCY_CELLDUST", "TOKEN_DAILY_CHALLENGE_DRAFT"]) {
        assert.equal(ClassifyHostGrant(id, catalog), undefined, id);
    }
});
