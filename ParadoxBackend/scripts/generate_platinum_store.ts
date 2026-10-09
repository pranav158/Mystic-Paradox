/*
 * Generates the reconstructed Dauntless 1.12 platinum store sections.
 *
 * Sources of truth, in descending authority:
 *   1. Items_Analysis/store_item_images_1_12.jsonl - the client's own baked `StoreItemsTable`.
 *      Its 2,888 row names are AUTHENTIC 1.12 SKU ids (proven in Progress/29_LADY_LUCKS_STORE.md,
 *      where the table knew `ladyluck_pr_discipline_token`, an id this project never authored), and
 *      its FeatureImage/StandardImage columns are the real store tile art.
 *   2. Items_Analysis/catalog_1_12.jsonl - item existence, display text, rarity, storage shape.
 *      NOTHING is emitted for a catalog id this file does not contain.
 *   3. Items_Analysis/store_view_models_1_12.jsonl (transcribed into CATEGORY_TAGS below) - the
 *      client-authored `store_view_model_C` category contract. A SKU whose tags match no category
 *      renders in NO tab, which is the confirmed capture-4 failure mode from
 *      Progress/30_REWARD_CACHE_STORE.md - so content type maps to a real SubTagId or is dropped.
 *   4. DauntlessEndpointDocumentation/Store/Product/Skus/*.json - real 2.1.1 captures, used ONLY
 *      where a captured SKU id is also a baked 1.12 row. Those keep their captured price, display
 *      text and payload verbatim; their 2.1.1-era tags are discarded and remapped to (3).
 *
 * Two clearly separated tiers, so no reconstructed number is ever mistaken for recovered data:
 *   TIER A ("captured")      - baked id AND captured price/payload. Real Phoenix Labs pricing.
 *   TIER B ("reconstructed") - baked id, catalog-verified content, but no captured price. Priced by
 *                              the explicit RECONSTRUCTED_PRICES ladder below, anchored on tier A's
 *                              real values for the same content types.
 *
 * Deliberately excluded, each for a stated reason:
 *   - `platformOfferId` SKUs (the `plat_1p_*` platinum packs): real-money first-party purchases this
 *     server cannot and should not simulate.
 *   - `loadoutSlots` SKUs: no grant path. Slot totals derive authoritatively from Slayer's Path
 *     state (Progress/08_LOADOUT.md); an additive purchased count needs that decision first.
 *   - `prestige_*` rows (208 of them): these are Vault store offers, not platinum. `CURRENCY_PRESTIGE`
 *     resolves to "Vault Coins" in the real catalog and the client has a separate
 *     `huntpass_prestige_store_view_model_C` (`prestige_store`, tabs `tab_prestige`/
 *     `tab_prestige_elite`). Selling them for platinum would be a content error. Own follow-up.
 *   - quest/Rumour-earned items (`quest_rumour_*` baked rows name them): same policy the Reward Cache
 *     generator applies to Shadow Scythe.
 *   - anything already granted by Lady Luck's Store or the Reward Cache: the three stores stay disjoint.
 *
 * Output is deterministic: stable ordering, no timestamps, no random selection. Re-running with an
 * unchanged catalog produces a byte-identical file.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
const MetagameRoot = path.resolve(ScriptDir, "..");
const ProjectRoot = path.resolve(MetagameRoot, "..");
// The 1.12 export where present (the store was first built from it), otherwise a 1.14.7 export.
function ExportFile(baseName: string): string {
    const Legacy = path.join(ProjectRoot, "Items_Analysis", `${baseName}_1_12.jsonl`);
    const Current = path.join(ProjectRoot, "Items_Analysis", `${baseName}_1_14_7.jsonl`);
    return fs.existsSync(Legacy) || !fs.existsSync(Current) ? Legacy : Current;
}
const CatalogOverride = process.env.MYSTICPARADOX_CATALOG_1_12_PATH ?? process.env.MYSTICPARADOX_CATALOG_PATH;
const CatalogPath = CatalogOverride ? path.resolve(CatalogOverride) : ExportFile("catalog");
const StoreImagesPath = process.env.MYSTICPARADOX_STORE_IMAGES_PATH
    ? path.resolve(process.env.MYSTICPARADOX_STORE_IMAGES_PATH)
    : ExportFile("store_item_images");
const CapturePath = path.join(ProjectRoot, "DauntlessEndpointDocumentation", "Store", "Product", "Skus");
const DataDir = path.join(MetagameRoot, "game-data");
const OutputPath = path.join(DataDir, "platinum_store.json");

const CURRENCY_ID = "id_currency_platinum";

// Store section tags the client actually requests (`requiredTags=`), all confirmed in live capture
// traffic - see Progress/33_PLATINUM_STORE.md's census.
const SECTION_WEBSTORE = "webstore";
const SECTION_DYES = "dyes";
const SECTION_RANK_SKIP = "hp_level_skip_rank";
const SECTION_HUNTPASS = "huntpass_store";

// Verbatim from `Default__store_view_model_C`'s categories. Only these values make a tile visible.
const CATEGORY_TAGS = {
    weapon_ac: "skin_weapon_ac",
    weapon_eb: "skin_weapon_eb",
    weapon_dp: "skin_weapon_dp",
    weapon_ih: "skin_weapon_ih",
    weapon_ga: "skin_weapon_ga",
    weapon_ms: "skin_weapon_ms",
    weapon_cb: "skin_weapon_cb",
    armour: "skin_armour",
    lantern: "skin_lantern",
    dye: "dye_armour",
    slayer: "personality_character",
    emote: "social_emote",
    emoji: "social_emojis",
    arrival: "social_arrival",
    fabric: "personality_fabric",
    standard: "personality_standard",
    flaresigil: "personality_flaresigil",
    glider: "hunting_gliders",
    tonics: "supplies_supplies",
    boosts: "supplies_boost",
} as const;

type Category = keyof typeof CATEGORY_TAGS;

// RECONSTRUCTED price ladder for tier B. Anchored on tier A's real captured platinum prices for the
// same content types (dye 100, face paint 100, arrival emote 1000) and kept on the same round
// 50/100 grid the captured data uses. This is an explicit product decision for this server, NOT a
// claim about original Phoenix Labs pricing.
const RECONSTRUCTED_PRICES: Record<Category, Partial<Record<number, number>> & { default: number }> = {
    weapon_ac: { default: 800, 3: 500, 4: 800, 5: 1200 },
    weapon_eb: { default: 800, 3: 500, 4: 800, 5: 1200 },
    weapon_dp: { default: 800, 3: 500, 4: 800, 5: 1200 },
    weapon_ih: { default: 800, 3: 500, 4: 800, 5: 1200 },
    weapon_ga: { default: 800, 3: 500, 4: 800, 5: 1200 },
    weapon_ms: { default: 800, 3: 500, 4: 800, 5: 1200 },
    weapon_cb: { default: 800, 3: 500, 4: 800, 5: 1200 },
    armour: { default: 600, 3: 400, 4: 600, 5: 800 },
    lantern: { default: 600, 4: 600, 5: 800 },
    dye: { default: 100 },
    slayer: { default: 100 },
    emote: { default: 500, 3: 300, 4: 500, 5: 700 },
    emoji: { default: 200 },
    arrival: { default: 1000 },
    fabric: { default: 300 },
    standard: { default: 400 },
    flaresigil: { default: 250 },
    glider: { default: 800 },
    tonics: { default: 100 },
    boosts: { default: 100 },
};

const EXCLUDED_CATALOG_TAGS = new Set(["deprecated", "hidden", "wip", "initial", "founder", "translator", "mastery", "partner"]);
const DECODABLE_ROW_PREFIXES = ["sku_", "single_", "contract_"] as const;
const TYPE_PREFIXES = ["AR_", "WP_", "DYE_", "EM_", "TITLE_", "BNC_", "GD_", "LT_", "AC_", "QI_", "EJ_", "FL_"] as const;

type CatalogRow = {
    itemId: string;
    displayName?: string;
    description?: string;
    tags?: string[];
    customData?: string;
    isStackable?: boolean;
};

type BakedRow = { rowName: string; featureImage?: string; standardImage?: string };

type CapturedSku = {
    id: string;
    displayName?: string;
    displayDescription?: string;
    displayPriority?: number;
    prices?: { currencyId: string; price: number; salesPrice?: number | null }[];
    maxAllowed?: number | null;
    items?: { catalogId: string; quantity: number }[];
    entitlements?: { name: string; duration: number }[];
    skuProgression?: { progressionId: string; xp: number | null; ranks: number | null } | null;
    loadoutSlots?: number | null;
    platformOfferId?: string | null;
    duplicateInstancedItems?: string[] | null;
};

type OutputSku = {
    id: string;
    displayName: string;
    displayDescription: string;
    displayPriority: number;
    prices: { currencyId: string; price: number }[];
    maxAllowed: number | null;
    images?: Record<string, string>;
    tags: string[];
    items: { catalogId: string; quantity: number; instanced: boolean }[];
    duplicateInstancedItems: string[];
    entitlements?: { name: string; duration: number }[];
    skuProgression?: { progressionId: string; xp: number | null; ranks: number | null };
};

function ReadJsonl<T>(FilePath: string): T[] {
    return fs
        .readFileSync(FilePath, "utf8")
        .split(/\r?\n/)
        .filter((Line) => Line.trim().length > 0)
        .map((Line) => JSON.parse(Line) as T);
}

function ReadCapture(FileName: string): CapturedSku[] {
    const Full = path.join(CapturePath, FileName);
    if (!fs.existsSync(Full)) return [];
    return JSON.parse(fs.readFileSync(Full, "utf8")) as CapturedSku[];
}

const Catalog = new Map<string, CatalogRow>(ReadJsonl<CatalogRow>(CatalogPath).map((Row) => [Row.itemId, Row]));
const BakedRows = new Map<string, BakedRow>(
    ReadJsonl<BakedRow>(StoreImagesPath)
        .filter((Row) => !Row.rowName.startsWith("NewRow"))
        .map((Row) => [Row.rowName, Row])
);

// Catalog ids already sold by our other two stores, so the three never overlap.
const AlreadySold = new Set<string>();
for (const FileName of ["reward_cache_store.json", "ladyluck_store.json"]) {
    const Skus = JSON.parse(fs.readFileSync(path.join(DataDir, FileName), "utf8")) as OutputSku[];
    for (const Sku of Skus) {
        for (const Item of Sku.items ?? []) AlreadySold.add(Item.catalogId);
    }
}

// Quest/Rumour-earned content, identified by the client's own baked `quest_rumour_<item>` rows.
const QuestEarned = new Set<string>();
for (const RowName of BakedRows.keys()) {
    const Match = /^quest_rumour_(.+?)(?:_\d+)?$/.exec(RowName);
    if (Match) QuestEarned.add(Match[1].toUpperCase());
}

function ParseItemData(Row: CatalogRow): any {
    try {
        const Custom = JSON.parse(Row.customData ?? "{}");
        return JSON.parse(Custom.ItemData ?? "{}");
    } catch {
        return {};
    }
}

function RarityOf(CatalogId: string): number {
    const Row = Catalog.get(CatalogId);
    return Row ? Number(ParseItemData(Row).RarityLevel ?? 0) || 0 : 0;
}

function CookedTextureRef(AssetPath: string): string {
    return `Engine.Texture2D'${AssetPath}'`;
}

/**
 * Store tile art.
 *
 * The baked table stores SHORT asset names (`Store_Dye_512x512_altitude.Store_Dye_512x512_altitude`),
 * not `/Game/...` paths - the row is a client-side lookup key, not a servable reference. So there is
 * nothing to forward for a row that already has art: the client resolves it from its own
 * StoreItemsTable, which is exactly what Progress/29_LADY_LUCKS_STORE.md observed ("native 1.12
 * StoreItemsTable rows hide that gap for SKUs whose ids exactly match a baked row"). Fabricating a
 * `/Game/` path from a short name would produce an invalid reference.
 *
 * So: a baked `standardImage` means send `{}` and let the client draw it. Only when the row has no
 * standard art do we inject a cooked catalog icon - the mechanism doc 30 had to add for Reward Cache,
 * whose generated ids match no row at all.
 *
 * Returns undefined when neither source has anything, so the caller can drop the offer rather than
 * ship a blank tile.
 */
function ResolveImages(RowName: string, CatalogIds: string[]): Record<string, string> | undefined {
    const Baked = BakedRows.get(RowName);
    const HasBakedStandard = typeof Baked?.standardImage === "string" && Baked.standardImage !== "None";
    const HasBakedFeature = typeof Baked?.featureImage === "string" && Baked.featureImage !== "None";

    if (HasBakedStandard) return {};

    for (const CatalogId of CatalogIds) {
        const Row = Catalog.get(CatalogId);
        if (!Row) continue;
        const Data = ParseItemData(Row);
        for (const Field of ["CustomIcon", "LargeIcon", "Icon"]) {
            const Asset = Data[Field];
            if (typeof Asset === "string" && Asset.startsWith("/Game/")) {
                return { standard: CookedTextureRef(Asset) };
            }
        }
    }

    // Feature-only rows still have real native art for the featured slot; the grid tile falls back to
    // the client's rarity treatment, the same presentation the Reward Cache repro proved acceptable.
    return HasBakedFeature ? {} : undefined;
}

function CategoryForCatalogId(CatalogId: string): Category | undefined {
    if (CatalogId.startsWith("WP_")) {
        const WeaponCode = CatalogId.split("_")[1]?.toLowerCase();
        const Key = `weapon_${WeaponCode}` as Category;
        return Key in CATEGORY_TAGS ? Key : undefined;
    }
    if (CatalogId.startsWith("AR_")) return "armour";
    if (CatalogId.startsWith("LT_")) return "lantern";
    if (CatalogId.startsWith("DYE_")) return "dye";
    if (CatalogId.startsWith("EM_INTRO")) return "arrival";
    if (CatalogId.startsWith("EM_")) return "emote";
    if (CatalogId.startsWith("EJ_")) return "emoji";
    if (CatalogId.startsWith("BNC_FABRIC")) return "fabric";
    if (CatalogId.startsWith("BNC_STANDARD")) return "standard";
    if (CatalogId.startsWith("BNC_SIGIL") || CatalogId.startsWith("BNC_ANIMATION") || CatalogId.startsWith("FL_")) return "flaresigil";
    if (CatalogId.startsWith("GD_")) return "glider";
    if (CatalogId.startsWith("QI_")) return "tonics";
    return undefined;
}

/** True when the item can actually be granted: present in 1.12 and not excluded content. */
function IsGrantable(CatalogId: string): boolean {
    const Row = Catalog.get(CatalogId);
    if (Row == undefined) return false;
    const Tags = new Set((Row.tags ?? []).map((Tag) => Tag.toLowerCase()));
    for (const Excluded of EXCLUDED_CATALOG_TAGS) {
        if (Tags.has(Excluded)) return false;
    }
    return true;
}

function HasResolvedName(CatalogId: string): boolean {
    const Name = Catalog.get(CatalogId)?.displayName ?? "";
    return Name.length > 0 && !Name.includes("MISSING STRING TABLE") && !Name.startsWith("~DNT~");
}

/**
 * `instanced` is the grant-construction hint, kept for replay compatibility with existing
 * idempotency rows; inventoryStoragePolicy.ts is the real persistence authority and corrects it
 * after the request hash is computed. Derive it from the catalog's own stackability rather than a
 * prefix heuristic - the exact correction Progress/29_LADY_LUCKS_STORE.md had to make.
 */
function IsInstanced(CatalogId: string): boolean {
    return Catalog.get(CatalogId)?.isStackable === false;
}

/** The client resolves preview art for cosmetic unlocks listed here; consumables are omitted. */
function DuplicateInstancedItemsFor(CatalogIds: string[]): string[] {
    return CatalogIds.filter((CatalogId) => !CatalogId.startsWith("QI_") && !CatalogId.startsWith("TOKEN_") && !CatalogId.startsWith("CURRENCY_"));
}

function DecodeRowNameToCatalogId(RowName: string): string | undefined {
    let Base = RowName;
    for (const Prefix of DECODABLE_ROW_PREFIXES) {
        if (Base.startsWith(Prefix)) {
            Base = Base.slice(Prefix.length);
            break;
        }
    }
    const Upper = Base.toUpperCase();
    if (Catalog.has(Upper)) return Upper;
    for (const TypePrefix of TYPE_PREFIXES) {
        if (Catalog.has(TypePrefix + Upper)) return TypePrefix + Upper;
    }
    return undefined;
}

const Output: OutputSku[] = [];
const ClaimedSkuIds = new Set<string>();
const ClaimedCatalogIds = new Set<string>();
const Skipped = new Map<string, number>();

function Skip(Reason: string): void {
    Skipped.set(Reason, (Skipped.get(Reason) ?? 0) + 1);
}

// ---------------------------------------------------------------------------------------------
// TIER A - captured price and payload, for SKU ids the 1.12 client bakes.
// ---------------------------------------------------------------------------------------------
function EmitCapturedItemSku(Sku: CapturedSku, SectionTags: string[]): boolean {
    if (ClaimedSkuIds.has(Sku.id)) return false;
    if (!BakedRows.has(Sku.id)) { Skip("tierA: sku id not baked into 1.12 StoreItemsTable"); return false; }
    if (Sku.platformOfferId) { Skip("tierA: real-money platform offer"); return false; }
    if (Sku.loadoutSlots) { Skip("tierA: loadoutSlots grant unimplemented"); return false; }

    const Price = (Sku.prices ?? []).find((Entry) => Entry.currencyId === CURRENCY_ID);
    if (Price == undefined) { Skip("tierA: not platinum-priced"); return false; }

    const Items = Sku.items ?? [];
    const Entitlements = Sku.entitlements ?? [];
    if (Items.length === 0 && Entitlements.length === 0 && Sku.skuProgression == undefined) {
        Skip("tierA: no payload of any kind");
        return false;
    }

    for (const Item of Items) {
        if (!IsGrantable(Item.catalogId)) { Skip("tierA: item absent from 1.12 or excluded content"); return false; }
        if (AlreadySold.has(Item.catalogId)) { Skip("tierA: overlaps Lady Luck / Reward Cache"); return false; }
        if (ClaimedCatalogIds.has(Item.catalogId)) { Skip("tierA: catalog id already sold by another platinum SKU"); return false; }
        if (QuestEarned.has(Item.catalogId)) { Skip("tierA: quest/Rumour-earned"); return false; }
    }

    const Categories = new Set<string>();
    for (const Item of Items) {
        const Category = CategoryForCatalogId(Item.catalogId);
        if (Category) Categories.add(CATEGORY_TAGS[Category]);
    }

    // An entitlement-payload SKU has no catalog item to classify, so it is classified by WHAT the
    // entitlement unlocks. Two distinct kinds hide behind the same empty `items`:
    //   - character customisation (`ccfp_`/`cchd_`/`cchs_`/`ccbd_`/`character_facepaint_`) - a
    //     cosmetic, belonging to the webstore's STYLE > SLAYER tab;
    //   - a season/event pass (`*_premium`, `pass_*`) - NOT a cosmetic. An earlier version of this
    //     generator swept these into STYLE > SLAYER too, which would have put "Elite Track Bundle"
    //     on the face-paint shelf. They belong to the `huntpass_store` section, which has its own
    //     requiredTags query and no webstore category at all.
    let ForcedSection: string | undefined;
    if (Items.length === 0 && Entitlements.length > 0) {
        const IsCharacterCustomisation = Entitlements.every((Entitlement) =>
            /^(ent_)?(ccfp|cchd|cchs|ccbd)_/.test(Entitlement.name) || Entitlement.name.startsWith("character_facepaint_")
        );
        if (IsCharacterCustomisation) {
            Categories.add(CATEGORY_TAGS.slayer);
        } else {
            ForcedSection = SECTION_HUNTPASS;
        }
    }
    if (Categories.size === 0 && ForcedSection == undefined) { Skip("tierA: content type has no 1.12 store tab"); return false; }

    const CatalogIds = Items.map((Item) => Item.catalogId);
    const Images = ResolveImages(Sku.id, CatalogIds);
    if (Images == undefined) { Skip("tierA: no baked or catalog artwork"); return false; }

    for (const CatalogId of CatalogIds) ClaimedCatalogIds.add(CatalogId);
    ClaimedSkuIds.add(Sku.id);

    Output.push({
        id: Sku.id,
        displayName: Sku.displayName ?? Sku.id,
        displayDescription: Sku.displayDescription ?? "",
        displayPriority: Number(Sku.displayPriority ?? 1000) || 1000,
        prices: [{ currencyId: CURRENCY_ID, price: Price.price }],
        // An entitlement is a permanent account unlock, so its SKU MUST be one-time regardless of what
        // the capture said (`season09b_premium_plus` carries maxAllowed:null). A repeatable
        // entitlement SKU would charge platinum for a second grant that the repository's
        // grant-if-missing rule correctly turns into a no-op - i.e. take the money and hand over
        // nothing. maxAllowed:1 makes the deterministic transactionId the ownership guard, so a repeat
        // attempt replays the original result instead of charging again (controllers/store.ts).
        maxAllowed: Entitlements.length > 0 ? 1 : Sku.maxAllowed ?? null,
        images: Images,
        tags: [...(ForcedSection ? [ForcedSection] : SectionTags), ...[...Categories].sort(), "platinum_store_captured"],
        items: Items.map((Item) => ({ catalogId: Item.catalogId, quantity: Item.quantity, instanced: IsInstanced(Item.catalogId) })),
        duplicateInstancedItems: DuplicateInstancedItemsFor(CatalogIds),
        ...(Entitlements.length > 0 ? { entitlements: Entitlements.map((E) => ({ name: E.name, duration: Number(E.duration ?? 0) || 0 })) } : {}),
        ...(Sku.skuProgression ? { skuProgression: Sku.skuProgression } : {}),
    });
    return true;
}

const WebstoreCapture = [...ReadCapture("awakening_webstore.json"), ...ReadCapture("dyes.json")];
for (const Sku of WebstoreCapture) {
    const IsDye = (Sku.items ?? []).some((Item) => Item.catalogId.startsWith("DYE_"));
    EmitCapturedItemSku(Sku, IsDye ? [SECTION_WEBSTORE, SECTION_DYES] : [SECTION_WEBSTORE]);
}

// Hunt Pass rank skips: 100 SKUs, every id baked, every price captured, and now grantable through
// the skuProgression path (src/skuProgression.ts). Their own store section, not a webstore tab.
for (const Sku of ReadCapture("hp_level_skip_rank.json")) {
    if (!BakedRows.has(Sku.id)) { Skip("rank skip: sku id not baked"); continue; }
    const Price = (Sku.prices ?? []).find((Entry) => Entry.currencyId === CURRENCY_ID);
    if (Price == undefined || Sku.skuProgression == undefined || !Sku.skuProgression) { Skip("rank skip: missing price or progression"); continue; }
    if (ClaimedSkuIds.has(Sku.id)) continue;
    ClaimedSkuIds.add(Sku.id);

    Output.push({
        id: Sku.id,
        displayName: Sku.displayName ?? "Hunt Pass Level Skip",
        displayDescription: Sku.displayDescription ?? "",
        displayPriority: Number(Sku.displayPriority ?? 1000) || 1000,
        prices: [{ currencyId: CURRENCY_ID, price: Price.price }],
        maxAllowed: Sku.maxAllowed ?? null,
        images: ResolveImages(Sku.id, []) ?? {},
        tags: [SECTION_RANK_SKIP, "event", "platinum_store_captured"],
        items: [],
        duplicateInstancedItems: [],
        skuProgression: Sku.skuProgression,
    });
}

// Hunt Pass premium passes: pure entitlement payloads. Only those the 1.12 client bakes.
for (const Sku of ReadCapture("huntpass_store.json")) {
    if (!BakedRows.has(Sku.id)) { Skip("huntpass pass: sku id not baked"); continue; }
    const Price = (Sku.prices ?? []).find((Entry) => Entry.currencyId === CURRENCY_ID);
    if (Price == undefined) { Skip("huntpass pass: no platinum price (already-owned capture)"); continue; }
    if ((Sku.entitlements ?? []).length === 0) { Skip("huntpass pass: no entitlement payload"); continue; }
    if (ClaimedSkuIds.has(Sku.id)) continue;
    ClaimedSkuIds.add(Sku.id);

    Output.push({
        id: Sku.id,
        displayName: Sku.displayName ?? Sku.id,
        displayDescription: Sku.displayDescription ?? "",
        displayPriority: Number(Sku.displayPriority ?? 1000) || 1000,
        prices: [{ currencyId: CURRENCY_ID, price: Price.price }],
        maxAllowed: Sku.maxAllowed ?? 1,
        images: ResolveImages(Sku.id, []) ?? {},
        tags: [SECTION_HUNTPASS, "event_pass", "platinum_store_captured"],
        items: [],
        duplicateInstancedItems: [],
        entitlements: (Sku.entitlements ?? []).map((E) => ({ name: E.name, duration: Number(E.duration ?? 0) || 0 })),
    });
}

// ---------------------------------------------------------------------------------------------
// TIER B - baked 1.12 SKU ids with catalog-verified content and a RECONSTRUCTED price.
// ---------------------------------------------------------------------------------------------
for (const RowName of [...BakedRows.keys()].sort()) {
    if (ClaimedSkuIds.has(RowName)) continue;
    if (!DECODABLE_ROW_PREFIXES.some((Prefix) => RowName.startsWith(Prefix))) { Skip("tierB: row family is a bundle/quest/pass, not a single decodable offer"); continue; }

    const Baked = BakedRows.get(RowName)!;
    if ((Baked.standardImage ?? "None") === "None" && (Baked.featureImage ?? "None") === "None") { Skip("tierB: baked row has no artwork"); continue; }

    const CatalogId = DecodeRowNameToCatalogId(RowName);
    if (CatalogId == undefined) { Skip("tierB: row name does not decode to a 1.12 catalog id"); continue; }
    if (AlreadySold.has(CatalogId)) { Skip("tierB: overlaps Lady Luck / Reward Cache"); continue; }
    if (ClaimedCatalogIds.has(CatalogId)) { Skip("tierB: catalog id already sold by another platinum SKU"); continue; }
    if (!IsGrantable(CatalogId)) { Skip("tierB: excluded catalog content"); continue; }
    if (QuestEarned.has(CatalogId)) { Skip("tierB: quest/Rumour-earned"); continue; }
    if (!HasResolvedName(CatalogId)) { Skip("tierB: unresolved display name"); continue; }

    const Category = CategoryForCatalogId(CatalogId);
    if (Category == undefined) { Skip("tierB: content type has no 1.12 store tab"); continue; }

    const Row = Catalog.get(CatalogId)!;
    const Rarity = RarityOf(CatalogId);
    const Ladder = RECONSTRUCTED_PRICES[Category];
    const Price = Ladder[Rarity] ?? Ladder.default;

    const Images = ResolveImages(RowName, [CatalogId]);
    if (Images == undefined) { Skip("tierB: no artwork resolved"); continue; }

    const SectionTags = Category === "dye" ? [SECTION_WEBSTORE, SECTION_DYES] : [SECTION_WEBSTORE];
    ClaimedSkuIds.add(RowName);
    ClaimedCatalogIds.add(CatalogId);

    Output.push({
        id: RowName,
        displayName: Row.displayName ?? CatalogId,
        displayDescription: Row.description ?? "",
        displayPriority: 1000,
        prices: [{ currencyId: CURRENCY_ID, price: Price }],
        // Cosmetic ownership unlocks are one-time; consumables restock.
        maxAllowed: Category === "tonics" || Category === "boosts" ? null : 1,
        images: Images,
        tags: [...SectionTags, CATEGORY_TAGS[Category], "platinum_store_reconstructed", `platinum_store_rarity_${Rarity}`],
        items: [{ catalogId: CatalogId, quantity: 1, instanced: IsInstanced(CatalogId) }],
        duplicateInstancedItems: DuplicateInstancedItemsFor([CatalogId]),
    });
}

// Deterministic ordering: section, then category tag, then price, then id.
function SortKey(Sku: OutputSku): string {
    const Section = Sku.tags.includes(SECTION_RANK_SKIP) ? "2" : Sku.tags.includes(SECTION_HUNTPASS) ? "3" : "1";
    const CategoryTag = Object.values(CATEGORY_TAGS).find((Tag) => Sku.tags.includes(Tag)) ?? "zzz";
    return `${Section}|${CategoryTag}|${String(Sku.prices[0].price).padStart(6, "0")}|${Sku.id}`;
}
Output.sort((Left, Right) => SortKey(Left).localeCompare(SortKey(Right)));

fs.writeFileSync(OutputPath, JSON.stringify(Output, null, 2) + "\n", "utf8");

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const Captured = Output.filter((Sku) => Sku.tags.includes("platinum_store_captured"));
const Reconstructed = Output.filter((Sku) => Sku.tags.includes("platinum_store_reconstructed"));
const BySection = new Map<string, number>();
for (const Section of [SECTION_WEBSTORE, SECTION_DYES, SECTION_RANK_SKIP, SECTION_HUNTPASS]) {
    BySection.set(Section, Output.filter((Sku) => Sku.tags.includes(Section)).length);
}

console.log(`platinum_store.json: ${Output.length} SKUs (${Captured.length} captured price, ${Reconstructed.length} reconstructed price)`);
console.log(`  sections: ${[...BySection].map(([Section, Count]) => `${Section}=${Count}`).join(" ")}`);
console.log(`  payloads: items=${Output.filter((S) => S.items.length > 0).length} entitlements=${Output.filter((S) => (S.entitlements ?? []).length > 0).length} progression=${Output.filter((S) => S.skuProgression).length}`);
for (const Tag of Object.values(CATEGORY_TAGS)) {
    const Count = Output.filter((Sku) => Sku.tags.includes(Tag)).length;
    if (Count > 0) console.log(`  ${Tag.padEnd(24)} ${Count}`);
}
console.log(`  distinct catalog grants: ${ClaimedCatalogIds.size}, overlap with other stores: ${[...ClaimedCatalogIds].filter((Id) => AlreadySold.has(Id)).length}`);
const ItemOffers = Output.filter((Sku) => Sku.items.length > 0);
console.log(`  item offers with art (native baked row or injected catalog icon): ${ItemOffers.filter((Sku) => Sku.images != undefined).length}/${ItemOffers.length}`);
console.log(`  of those, native baked art: ${ItemOffers.filter((Sku) => Sku.images && Object.keys(Sku.images).length === 0).length}, injected catalog icon: ${ItemOffers.filter((Sku) => Sku.images?.standard != undefined).length}`);
console.log("  skipped:");
for (const [Reason, Count] of [...Skipped].sort((Left, Right) => Right[1] - Left[1])) {
    console.log(`    ${String(Count).padStart(5)}  ${Reason}`);
}
