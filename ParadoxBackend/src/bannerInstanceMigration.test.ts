import assert from "node:assert/strict";
import test from "node:test";
import { PlanBannerInstanceMigration } from "./bannerInstanceMigration";

const BANNER = {
    catalogId: "BN_BEGINNER_00",
    instanceId: "YQBTCFFMVVDHRL54PIKAAKFID4",
    itemData: null,
    updateVersion: 0
};

test("catalog banner reference migrates to the unique owned instance and preserves customization", () => {
    const Persistent = {
        banner: "BN_BEGINNER_00",
        bannerCustomization: "{\"AnimationItemID\":\"BNC_ANIMATION_EVENT_FROST17_00\"}",
        manual_emotes: ["EM_PLAYER_BEGINNER_01"]
    };

    const Plan = PlanBannerInstanceMigration([BANNER], Persistent);

    assert.equal(Plan.status, "migrate");
    assert.equal(Plan.targetBanner, BANNER.instanceId);
    assert.deepEqual(Plan.persistent, {
        ...Persistent,
        banner: BANNER.instanceId
    });
    assert.equal(Persistent.banner, "BN_BEGINNER_00", "planner must not mutate its input");
});

test("owned instance reference is already valid and produces no write", () => {
    const Plan = PlanBannerInstanceMigration([BANNER], { banner: BANNER.instanceId });

    assert.equal(Plan.status, "already-valid");
    assert.equal(Plan.persistent, undefined);
});

test("an owned non-banner instance is not accepted as a valid banner", () => {
    const Weapon = {
        catalogId: "WP_SWORD_BEGINNER",
        instanceId: "AAAAAAAAAAAAAAAAAAAAAAAAAA"
    };
    const Plan = PlanBannerInstanceMigration([BANNER, Weapon], { banner: Weapon.instanceId });

    assert.equal(Plan.status, "unrecognized-reference");
    assert.match(Plan.detail ?? "", /non-banner inventory item/);
    assert.equal(Plan.persistent, undefined);
});

test("missing and duplicate catalog matches are reported without choosing a target", () => {
    const Missing = PlanBannerInstanceMigration([], { banner: "BN_BEGINNER_00" });
    const Duplicate = PlanBannerInstanceMigration(
        [BANNER, { ...BANNER, instanceId: "AAAAAAAAAAAAAAAAAAAAAAAAAA" }],
        { banner: "BN_BEGINNER_00" }
    );

    assert.equal(Missing.status, "missing-owned-instance");
    assert.equal(Duplicate.status, "duplicate-owned-instances");
    assert.equal(Missing.persistent, undefined);
    assert.equal(Duplicate.persistent, undefined);
});

test("unknown references and malformed documents are never rewritten", () => {
    assert.equal(
        PlanBannerInstanceMigration([BANNER], { banner: "unexpected" }).status,
        "unrecognized-reference"
    );
    assert.equal(PlanBannerInstanceMigration({}, { banner: "BN_BEGINNER_00" }).status, "invalid-inventory");
    assert.equal(PlanBannerInstanceMigration([BANNER], []).status, "invalid-persistent");
});
