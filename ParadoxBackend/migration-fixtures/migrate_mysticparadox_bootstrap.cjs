
require("dotenv").config();
const { MongoClient } = require("mongodb");

const DEV_USER_ID = process.env.DEV_USER_ID ?? "mysticparadox";
const BOOTSTRAP_VERSION = "starter-1.12-v1";
const INSTANCE_ID = /^[A-Z0-9]{26}$/;
const STARTER_INSTANCED_CATALOG_IDS = [
    "WP_EB_BEGINNER", "WP_GA_BEGINNER", "WP_IH_BEGINNER", "WP_CB_BEGINNER",
    "WP_MS_BEGINNER", "WP_DP_BEGINNER", "WP_AC_BEGINNER", "PART_EB_SPECIAL_DEFAULT",
    "AR_UNEQUIPPED_HELM", "AR_BEGINNER_CHEST", "AR_BEGINNER_ARMS", "AR_BEGINNER_LEGS",
    "LT_BASIC", "FL_HEALING_DEFAULT", "GD_FRAME_STARTER_BASE", "BN_BEGINNER_00",
];
const EQUIPPED_CATALOG_IDS = [
    "WP_EB_BEGINNER", "AR_UNEQUIPPED_HELM", "AR_BEGINNER_CHEST",
    "AR_BEGINNER_ARMS", "AR_BEGINNER_LEGS", "LT_BASIC",
];

function fail(message) {
    throw new Error(`Baseline validation failed: ${message}`);
}

function parseArray(raw, field) {
    try {
        const value = JSON.parse(raw);
        if (!Array.isArray(value)) fail(`${field} is not a JSON array`);
        return value;
    } catch (error) {
        if (error.message?.startsWith("Baseline validation failed:")) throw error;
        fail(`${field} is not valid JSON`);
    }
}

function validateBaseline(inventory, loadout, wallet) {
    if (!inventory) fail("inventory document is missing");
    if (!loadout) fail("loadout document is missing");
    if (!wallet) fail("wallet document is missing");

    const instancedItems = parseArray(inventory.instancedItems, "inventory.instancedItems");
    const byCatalogId = new Map();
    const instanceIds = new Set();
    for (const item of instancedItems) {
        if (!item || typeof item.catalogId !== "string" || typeof item.instanceId !== "string") fail("inventory contains an invalid instanced item");
        if (!INSTANCE_ID.test(item.instanceId)) fail(`inventory ${item.catalogId} has invalid instance ID ${JSON.stringify(item.instanceId)}`);
        if (item.instanceId.startsWith("MYSTPAX_STARTER_")) fail(`inventory ${item.catalogId} has a shared starter ID`);
        if (instanceIds.has(item.instanceId)) fail(`inventory has duplicate instance ID ${item.instanceId}`);
        instanceIds.add(item.instanceId);
        if (byCatalogId.has(item.catalogId)) fail(`inventory has duplicate catalog ID ${item.catalogId}`);
        byCatalogId.set(item.catalogId, item);
    }
    for (const catalogId of STARTER_INSTANCED_CATALOG_IDS) {
        if (!byCatalogId.has(catalogId)) fail(`inventory is missing expected starter catalog ${catalogId}`);
    }

    const loadouts = parseArray(loadout.loadouts, "loadout.loadouts");
    const slot = loadouts[0];
    if (!slot || typeof slot !== "object") fail("loadout slot zero is missing");
    for (const catalogId of EQUIPPED_CATALOG_IDS) {
        const equipment = Object.values(slot).find((value) => value && typeof value === "object" && value.item_id === catalogId);
        if (!equipment) fail(`loadout slot zero is missing ${catalogId}`);
        if (!INSTANCE_ID.test(equipment.instance_id ?? "")) fail(`loadout ${catalogId} has an invalid instance ID`);
        if (equipment.instance_id.startsWith("MYSTPAX_STARTER_")) fail(`loadout ${catalogId} has a shared starter ID`);
        if (byCatalogId.get(catalogId).instanceId !== equipment.instance_id) fail(`loadout ${catalogId} does not reference its inventory instance`);
    }

    if (!wallet.balances || typeof wallet.balances !== "object" || Array.isArray(wallet.balances)) fail("wallet.balances is not an object");
    for (const [catalogId, balance] of Object.entries(wallet.balances)) {
        if (typeof balance !== "number" || !Number.isFinite(balance) || balance < 0) fail(`wallet ${catalogId} has invalid balance ${JSON.stringify(balance)}`);
    }

    return { instancedItems, byCatalogId };
}

(async () => {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "mysticparadox");
    const character = await db.collection("characters").findOne({ userId: DEV_USER_ID });
    if (!character) fail(`no character found for userId ${JSON.stringify(DEV_USER_ID)}`);
    const characterId = character.characterId;
    const session = client.startSession();

    try {
        await session.withTransaction(async () => {
            const [inventory, loadout, wallet] = await Promise.all([
                db.collection("inventories").findOne({ _id: characterId }, { session }),
                db.collection("loadouts").findOne({ _id: characterId }, { session }),
                db.collection("wallets").findOne({ _id: DEV_USER_ID }, { session }),
            ]);
            const { instancedItems } = validateBaseline(inventory, loadout, wallet);

            
            let itemDataCleaned = false;
            for (const item of instancedItems) {
                if (STARTER_INSTANCED_CATALOG_IDS.includes(item.catalogId) && item.itemData !== null) {
                    item.itemData = null;
                    itemDataCleaned = true;
                }
            }
            if (itemDataCleaned) {
                await db.collection("inventories").updateOne(
                    { _id: characterId },
                    { $set: { instancedItems: JSON.stringify(instancedItems) } },
                    { session }
                );
            }

            await Promise.all([
                db.collection("inventories").updateOne({ _id: characterId }, { $set: { bootstrapVersion: BOOTSTRAP_VERSION, userId: DEV_USER_ID } }, { session }),
                db.collection("loadouts").updateOne({ _id: characterId }, { $set: { bootstrapVersion: BOOTSTRAP_VERSION } }, { session }),
                db.collection("wallets").updateOne({ _id: DEV_USER_ID }, { $set: { bootstrapVersion: BOOTSTRAP_VERSION } }, { session }),
            ]);
        });
        console.log(`Validated and migrated ${DEV_USER_ID} (${characterId}) to ${BOOTSTRAP_VERSION}.`);
    } finally {
        await session.endSession();
        await client.close();
    }
})().catch((error) => { console.error("MIGRATION FAILED:", error.message); process.exit(1); });
