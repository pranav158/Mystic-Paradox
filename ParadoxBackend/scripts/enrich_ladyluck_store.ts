/*
 * Builds Lady Luck's Store from the live 1.14.7 rotation.
 *
 * Source of truth (2026-10-08): DauntlessEndpointDocumentation/Store/Product/Skus/ladyluckstore.json, a capture
 * of the live service on the same client build (rel-1.14.7, CL 647472). Every live SKU whose items exist in the
 * 1.14.7 catalogue is served with its live prices, names, tags, priority and purchase limit; a SKU whose items
 * the catalogue lacks (the five per-attribute CONTAINER_CORE_GOLD_*_CELLCORE cores) is reported and skipped.
 * The 1.12-era changes are retired: the Steel-tier price split, the Trials mantle/title additions and the
 * Discipline unlock.
 *
 * SKUs this store already serves keep their item storage flags and duplicateInstancedItems (the inventory
 * storage work depends on them); new SKUs take instanced/stacked from the catalogue. Every SKU gets an explicit
 * catalogue-backed image, as before.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
const MetagameRoot = path.resolve(ScriptDir, "..");
const ProjectRoot = path.resolve(MetagameRoot, "..");
const CatalogOverride = process.env.MYSTICPARADOX_CATALOG_PATH ?? process.env.MYSTICPARADOX_CATALOG_1_12_PATH;
const CatalogPath = CatalogOverride
    ? path.resolve(CatalogOverride)
    : path.join(ProjectRoot, "Items_Analysis", "catalog_1_14_7.jsonl");
const LivePath = path.join(ProjectRoot, "DauntlessEndpointDocumentation", "Store", "Product", "Skus", "ladyluckstore.json");
const StorePath = path.join(MetagameRoot, "game-data", "ladyluck_store.json");

const STEEL = "id_currency_marks_steel";
const GILDED = "id_currency_marks_gilded";

type CatalogRow = {
    itemId: string;
    displayName?: string;
    description?: string;
    customData?: string;
    isStackable?: boolean;
};

type StoreSku = {
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
};

type LiveSku = {
    id: string;
    displayName: string;
    displayDescription: string;
    displayPriority: number;
    prices: { currencyId: string; price: number }[];
    maxAllowed: number | null;
    tags: string[];
    items: { catalogId: string; quantity: number }[];
    duplicateInstancedItems?: string[];
};

function Assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function ParseCatalogImage(Row: CatalogRow): string {
    try {
        const CustomData = JSON.parse(Row.customData ?? "{}") as { ItemData?: string };
        const ItemData = JSON.parse(CustomData.ItemData ?? "{}") as {
            Icon?: string;
            LargeIcon?: string;
            CustomIcon?: string;
        };
        return [ItemData.CustomIcon, ItemData.LargeIcon, ItemData.Icon]
            .find((Value): Value is string => typeof Value === "string" && Value.length > 0) ?? "";
    } catch {
        return "";
    }
}

function TextureReference(AssetPath: string): string {
    Assert(/^\/Game\/[A-Za-z0-9_./-]+$/.test(AssetPath), `Invalid cooked texture path: ${AssetPath}`);
    return `Engine.Texture2D'${AssetPath}'`;
}

Assert(fs.existsSync(CatalogPath), `Catalog dump not found: ${CatalogPath}`);
Assert(fs.existsSync(LivePath), `Live Lady Luck capture not found: ${LivePath}`);
Assert(fs.existsSync(StorePath), `Lady Luck store data not found: ${StorePath}`);

const Catalog = new Map<string, CatalogRow>();
for (const Line of fs.readFileSync(CatalogPath, "utf8").split(/\r?\n/)) {
    if (!Line.trim()) continue;
    const Row = JSON.parse(Line) as CatalogRow;
    if (typeof Row.itemId === "string" && Row.itemId.length > 0) Catalog.set(Row.itemId, Row);
}

const Live = JSON.parse(fs.readFileSync(LivePath, "utf8").replace(/^﻿/, "")) as LiveSku[];
Assert(Array.isArray(Live) && Live.length > 0, "Live Lady Luck capture is not a SKU list");
const Existing = new Map((JSON.parse(fs.readFileSync(StorePath, "utf8")) as StoreSku[]).map((Sku) => [Sku.id, Sku]));

const SameItems = (A: { catalogId: string; quantity: number }[], B: { catalogId: string; quantity: number }[]) =>
    A.length === B.length && A.every((Item, Index) => Item.catalogId === B[Index].catalogId && Item.quantity === B[Index].quantity);

const Store: StoreSku[] = [];
const Skipped: string[] = [];
for (const LiveOffer of Live) {
    const Missing = LiveOffer.items.map((Item) => Item.catalogId).filter((CatalogId) => !Catalog.has(CatalogId));
    if (Missing.length > 0) {
        Skipped.push(`${LiveOffer.id} (${Missing.join(", ")} not in the catalogue)`);
        continue;
    }
    const Previous = Existing.get(LiveOffer.id);
    const KeepPrevious = Previous !== undefined && SameItems(Previous.items, LiveOffer.items);
    Store.push({
        id: LiveOffer.id,
        displayName: LiveOffer.displayName,
        displayDescription: LiveOffer.displayDescription,
        displayPriority: LiveOffer.displayPriority,
        prices: LiveOffer.prices.map((Price) => ({ currencyId: Price.currencyId, price: Price.price })),
        maxAllowed: LiveOffer.maxAllowed,
        images: Previous?.images,
        tags: [...LiveOffer.tags],
        items: KeepPrevious
            ? Previous!.items.map((Item) => ({ ...Item }))
            : LiveOffer.items.map((Item) => ({ catalogId: Item.catalogId, quantity: Item.quantity, instanced: Catalog.get(Item.catalogId)!.isStackable !== true })),
        duplicateInstancedItems: KeepPrevious ? [...Previous!.duplicateInstancedItems] : [...(LiveOffer.duplicateInstancedItems ?? [])],
    });
}

// Explicit server-authored images: applying the catalogue image to every resolvable offer removes reliance on
// local StoreItemsTable row naming (this is what fixed Entropy and Sundown on 1.12).
let ImageCount = 0;
for (const Sku of Store) {
    const Row = Catalog.get(Sku.items[0]?.catalogId);
    const ImagePath = Row ? ParseCatalogImage(Row) : "";
    if (!ImagePath) continue;
    Sku.images = { ...(Sku.images ?? {}), standard: TextureReference(ImagePath) };
    ImageCount++;
}

const SeenSkuIds = new Set<string>();
for (const Sku of Store) {
    Assert(!SeenSkuIds.has(Sku.id), `Duplicate Lady Luck SKU id: ${Sku.id}`);
    SeenSkuIds.add(Sku.id);
    Assert(Sku.prices.length === 1, `Expected exactly one price for ${Sku.id}`);
    Assert(Sku.prices[0].currencyId === STEEL || Sku.prices[0].currencyId === GILDED, `Unsupported Lady Luck currency for ${Sku.id}`);
    Assert(Sku.tags.includes("ladyluckstore"), `Missing ladyluckstore tag on ${Sku.id}`);
}

const Retired = [...Existing.keys()].filter((Id) => !SeenSkuIds.has(Id)).sort();
fs.writeFileSync(StorePath, JSON.stringify(Store, null, 2) + "\n", "utf8");
console.log(`Wrote ${StorePath}`);
console.log(`SKUs: ${Store.length} of ${Live.length} live; explicit catalog images: ${ImageCount}`);
console.log(`Steel offers: ${Store.filter((Sku) => Sku.prices[0].currencyId === STEEL).length}; Gilded offers: ${Store.filter((Sku) => Sku.prices[0].currencyId === GILDED).length}`);
console.log(`Skipped live SKUs: ${Skipped.length ? Skipped.join("; ") : "none"}`);
console.log(`Retired SKUs: ${Retired.length ? Retired.join(", ") : "none"}`);
