import test from "node:test";
import assert from "node:assert/strict";
import { PlanFlaskInstanceMigration, PlanGliderInstanceMigration } from "./starterInstanceMigration";
import { BuildStarterManifest, STARTER_FLASK_CATALOG_ID, STARTER_GLIDER_CATALOG_ID } from "./controllers/starterManifest";

const FLASK_ID = "HD1JCCD73054ZFJILXA2KYO3WC";
const GLIDER_ID = "T5J7VAUP25BK5E42NXECR3ZEJ4";
const Inventory = [
    { catalogId: "WP_EB_BEGINNER", instanceId: "AAAAAAAAAAAAAAAAAAAAAAAAAA" },
    { catalogId: "FL_HEALING_DEFAULT", instanceId: FLASK_ID },
    { catalogId: "GD_FRAME_STARTER_BASE", instanceId: GLIDER_ID },
];

test("a catalog-id flask becomes the owned instance id, other slot fields untouched", () => {
    const Slots = [{ slot_index: 0, flask: "FL_HEALING_DEFAULT", quick_items: [], weapon: { item_id: "WP_EB_BEGINNER" } }];
    const Plan = PlanFlaskInstanceMigration(Inventory, Slots);
    assert.equal(Plan.status, "migrate");
    assert.deepEqual(Plan.changes, [{ field: "slot 0 flask", from: "FL_HEALING_DEFAULT", to: FLASK_ID }]);
    assert.deepEqual(Plan.loadouts, [{ ...Slots[0], flask: FLASK_ID }]);
    assert.equal(Slots[0].flask, "FL_HEALING_DEFAULT", "input not mutated");
});

test("every slot holding the catalog id is repaired", () => {
    const Plan = PlanFlaskInstanceMigration(Inventory, [
        { slot_index: 0, flask: "FL_HEALING_DEFAULT" },
        { slot_index: 1, flask: FLASK_ID },
        { slot_index: 2, flask: "FL_HEALING_DEFAULT" },
    ]);
    assert.equal(Plan.status, "migrate");
    assert.deepEqual(Plan.changes?.map((Change) => Change.field), ["slot 0 flask", "slot 2 flask"]);
    assert.deepEqual((Plan.loadouts as any[]).map((Slot) => Slot.flask), [FLASK_ID, FLASK_ID, FLASK_ID]);
});

test("a valid flask is left alone and slots without one are absent", () => {
    assert.equal(PlanFlaskInstanceMigration(Inventory, [{ slot_index: 0, flask: FLASK_ID }]).status, "already-valid");
    assert.equal(PlanFlaskInstanceMigration(Inventory, [{ slot_index: 0, flask: "" }, { slot_index: 1 }]).status, "absent");
});

test("ambiguous or unknown flask shapes are reported, never rewritten", () => {
    assert.equal(PlanFlaskInstanceMigration(Inventory.slice(0, 1), [{ flask: "FL_HEALING_DEFAULT" }]).status, "missing-owned-instance");
    const TwoFlasks = [...Inventory, { catalogId: "FL_HEALING_DEFAULT", instanceId: "BBBBBBBBBBBBBBBBBBBBBBBBBB" }];
    assert.equal(PlanFlaskInstanceMigration(TwoFlasks, [{ flask: "FL_HEALING_DEFAULT" }]).status, "duplicate-owned-instances");
    assert.equal(PlanFlaskInstanceMigration(Inventory, [{ flask: "AAAAAAAAAAAAAAAAAAAAAAAAAA" }]).status, "unrecognized-reference");
    assert.equal(PlanFlaskInstanceMigration(Inventory, [{ flask: "SOMETHING_ELSE" }]).status, "unrecognized-reference");
    // One slot needing review blocks the row, even when another slot could be repaired.
    assert.equal(PlanFlaskInstanceMigration(Inventory, [{ flask: "FL_HEALING_DEFAULT" }, { flask: 7 }]).status, "unrecognized-reference");
    assert.equal(PlanFlaskInstanceMigration("[]", []).status, "invalid-inventory");
    assert.equal(PlanFlaskInstanceMigration(Inventory, {}).status, "invalid-loadouts");
});

test("a catalog-id glider becomes the owned instance id; valid, empty and odd gliders are left alone", () => {
    const Persistent = { banner: "X", glider: "GD_FRAME_STARTER_BASE", flare: "QI_BASIC_FLARE_DURABLE" };
    const Plan = PlanGliderInstanceMigration(Inventory, Persistent);
    assert.equal(Plan.status, "migrate");
    assert.deepEqual(Plan.persistent, { ...Persistent, glider: GLIDER_ID });
    assert.deepEqual(Plan.change, { field: "persistent glider", from: "GD_FRAME_STARTER_BASE", to: GLIDER_ID });
    assert.equal(Persistent.glider, "GD_FRAME_STARTER_BASE", "input not mutated");
    assert.equal(PlanGliderInstanceMigration(Inventory, { glider: GLIDER_ID }).status, "already-valid");
    assert.equal(PlanGliderInstanceMigration(Inventory, { glider: "" }).status, "absent");
    assert.equal(PlanGliderInstanceMigration(Inventory, { glider: FLASK_ID }).status, "unrecognized-reference");
    assert.equal(PlanGliderInstanceMigration(Inventory.slice(0, 2), { glider: "GD_FRAME_STARTER_BASE" }).status, "missing-owned-instance");
    assert.equal(PlanGliderInstanceMigration(Inventory, "{}").status, "invalid-persistent");
});

test("a new account's starter rows hold its own flask and glider instance ids", () => {
    const Manifest = BuildStarterManifest();
    const FlaskInstance = Manifest.instanceIdsByCatalogId[STARTER_FLASK_CATALOG_ID];
    const GliderInstance = Manifest.instanceIdsByCatalogId[STARTER_GLIDER_CATALOG_ID];
    assert.match(FlaskInstance, /^[A-Z0-9]{26}$/);
    assert.match(GliderInstance, /^[A-Z0-9]{26}$/);
    assert.equal(Manifest.loadoutSlot.flask, FlaskInstance);
    assert.equal(Manifest.persistent.glider, GliderInstance);
    assert.equal(Manifest.loadoutSlot.persistent.glider, GliderInstance);
    assert.equal(PlanFlaskInstanceMigration(Manifest.instancedItems, [Manifest.loadoutSlot]).status, "already-valid");
    assert.equal(PlanGliderInstanceMigration(Manifest.instancedItems, Manifest.persistent).status, "already-valid");
});
