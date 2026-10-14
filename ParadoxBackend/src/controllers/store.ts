/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import { GetRepositories, GetSqliteDirectAccess, RepositoryProvider } from "../persistence";
import { GetMongoDb } from "../persistence/mongo/client";
import { Collections } from "../persistence/mongo/collections";
import { GetBalance, InsufficientBalanceError, IsPrestigeGatedReward } from "./wallet";
import { RunInventoryTransaction, InventoryTransactionConflictError, InventoryTransactionMismatchError } from "./inventory";
import { GrantEntitlementsInTransaction } from "./entitlements";
import { GetTrackCurve, ResolveProgressionTrackId } from "./progression";
import { ResolveProgressionGrant } from "../skuProgression";
import { GetInventoryStoragePolicy, InventoryStoragePolicyEntry } from "../inventoryStoragePolicy";
import { logger } from "../logger";
import { loadGameData, tryLoadGameData } from "../gameData/loader";

// [2026-07-24] Lady Luck's Store (the Trials/Arena reward shop). Confirmed real endpoint contract:
// GET /product/skus/public?requiredTags=ladyluckstore returns exactly this shape
// (DauntlessEndpointDocumentation/Store/Product/Skus/SearchPublic.md + ladyluckstore.json), captured
// from Dauntless 2.1.1 - NOT our 1.12.0 target. The base data is that capture filtered to catalog ids
// independently verified in the real 1.12 catalog (Items_Analysis/catalog_1_12.jsonl). The current
// 49-offer set also includes the verified 1.12 Discipline PlayerRole and 11 additional Trials cosmetics
// (two mantles and nine titles) that existed in 1.12 but were absent from the later capture. The five
// stat-specific gold-cell-core SKUs remain excluded because their catalog ids do not exist in 1.12.
// See Progress/29_LADY_LUCKS_STORE.md for the full provenance and validation.
//
// `instanced` preserves the captured/request construction hint so deterministic Lady Luck purchase
// transaction bodies remain replay-compatible with idempotency rows written by older builds. It is NOT
// the final persistence authority. RunInventoryTransaction applies the generated 1.12 catalog storage
// policy after hashing the original request: cosmetic/transmog WP_/AR_/LT_ unlocks with
// isStackable:true are persisted as stacked ownership, while functional gear such as LT_TRIALS_00 and
// PART_CB_PASSIVE_TRIALS_02 remains instanced. See inventoryStoragePolicy.ts.
export type StoreSkuItem = { catalogId: string; quantity: number; instanced: boolean };
export type StoreSkuEntitlement = { name: string; duration: number };
export type StoreSkuProgression = { progressionId: string; xp: number | null; ranks: number | null };
export type StoreSku = {
    id: string;
    displayName: string;
    displayDescription: string;
    displayPriority: number;
    prices: { currencyId: string; price: number }[];
    maxAllowed: number | null;
    images?: Record<string, string>;
    tags: string[];
    items: StoreSkuItem[];
    // [2026-07-30] The two non-inventory payload kinds a Dauntless SKU can carry, both optional and
    // both absent from the Lady Luck / Reward Cache data (those are purely item grants). See
    // Progress/33_PLATINUM_STORE.md for the FOnlineStorePhoenixOffer field mapping. `loadoutSlots`
    // is the third and is deliberately NOT modelled yet - loadout slot totals are derived
    // authoritatively from Slayer's Path state (Progress/08_LOADOUT.md), so an additive purchased
    // count needs a decision about that authority first, and no SKU here sells one.
    entitlements?: StoreSkuEntitlement[];
    skuProgression?: StoreSkuProgression | null;
    // [2026-07-24] Verbatim from the real 2.1.1 capture (ladyluckstore.json), keyed by SKU id - NOT
    // derived from our own `instanced` grant-classification above. The two do not line up: e.g. the
    // real client lists DYE_* catalogIds here (dyes are wallet-stacked, `instanced:false` for grant
    // purposes) but omits PART_CB_PASSIVE_TRIALS_02 and the functional LT_TRIALS_00 lantern (both
    // `instanced:true` for grant purposes). This field appears to drive which items the client
    // resolves a real preview icon/thumbnail for (cosmetic transmog skins, dyes, emojis, banners) as
    // opposed to plain functional/consumable items - populating it from our own `instanced` flag
    // instead (as an earlier version of this route did) is why dye tiles rendered with no icon.
    duplicateInstancedItems: string[];
};

const LADYLUCK_SKUS = loadGameData<StoreSku[]>("ladyluck_store.json");
const REWARD_CACHE_SKUS = loadGameData<StoreSku[]>("reward_cache_store.json");
const PLATINUM_SKUS = loadGameData<StoreSku[]>("platinum_store.json");

// [2026-07-30] The platinum data set spans FOUR store sections the client requests separately
// (`webstore`, `dyes`, `hp_level_skip_rank`, `huntpass_store` - all four confirmed in live capture
// traffic), so it is registered per tag and filtered by tag membership, which is also what the real
// service's `requiredTags` contract means. Lady Luck and the Reward Cache keep their existing
// whole-array registration: every SKU in those files already carries its own store tag, so the two
// forms agree, and not touching them keeps this change behaviour-neutral for both.
function PlatinumSection(sectionTag: string): StoreSku[] {
    return PLATINUM_SKUS.filter((Sku) => Sku.tags.includes(sectionTag));
}

// [1.14.7 2026-10-08] The Middleman's cell-fusion slots. Slot 1 is free; slots 2 and 3 are unlocked by the
// entitlements exchange_slot_2 / exchange_slot_3 (a live account carries exchange_slot_2 in
// Auth/GetEntitlements.md), sold under the store tags the Middleman requests (exchange_vendor_slot_2/3). The SKU
// ids are the client's own StoreItemsTable rows (single_exchange_slot_2/3, art Store_Art_512x512_cell_slot_middleman).
// No live SKU capture exists: price set by the operator, 1,000 Platinum each, permanent (duration 0).
function ExchangeSlotSku(Slot: 2 | 3): StoreSku {
    return {
        id: `single_exchange_slot_${Slot}`,
        displayName: `Cell Fusion Slot ${Slot}`,
        displayDescription: `Unlocks cell fusion slot ${Slot} at the Middleman permanently.`,
        displayPriority: Slot,
        prices: [{ currencyId: "id_currency_platinum", price: 1000 }],
        maxAllowed: 1,
        tags: [`exchange_vendor_slot_${Slot}`],
        items: [],
        entitlements: [{ name: `exchange_slot_${Slot}`, duration: 0 }],
        duplicateInstancedItems: [],
    };
}
const EXCHANGE_SLOT_SKUS = { slot2: [ExchangeSlotSku(2)], slot3: [ExchangeSlotSku(3)] };

// [1.14.7 2026-10-10] The Ramsgate fountain coin toss ("Daily Free Bundle"). On every Ramsgate arrival the client's
// UArchonActivitiesProgressionComponent asks GET /product/skus/public?requiredTags=fountain_daily_free_bundle.
// OnStoreQueryCompleted (0x14186DB30) opens the coin toss only for an offer inside its date window whose PlatPrice
// is 0 (IsDailyBonusAvailable 0x141868F20); ClaimDailyBonus (0x141852880) then buys it through the normal
// /token/<slug>/<sku> + /notification/<slug> flow. The client does not re-query after a claim (only at the next
// Ramsgate arrival) and ignores Remaining/MaxAllowed: the ONLY "already claimed" signal it honours is the offer being
// absent, so GetStoreSkusForPlayer leaves it out once this reset window's claim is in the inventory transaction
// ledger. No live capture of the offer exists (1.12 or 2.x): its contents are an operator choice in
// game-data/fountain_daily_bundle.json. The file is OPTIONAL - missing or rejected, the section is empty and the
// fountain simply stays unavailable, as before.
export const FOUNTAIN_DAILY_BUNDLE_TAG = "fountain_daily_free_bundle";
const FOUNTAIN_DAILY_BUNDLE_FILE = "fountain_daily_bundle.json";

// Sections claimable once per daily reset window. Their purchase transaction id carries the window key (see
// DailyClaimTransactionId), and they are reachable only by their exact SKU id - never by the bare-catalogId
// fallback in FindStoreSkuByIdOrCatalogId, so a free currency bundle cannot make another store's lookup ambiguous.
const DAILY_CLAIM_SECTIONS: ReadonlySet<string> = new Set([FOUNTAIN_DAILY_BUNDLE_TAG]);

export function IsDailyClaimSection(storeTag: string): boolean {
    return DAILY_CLAIM_SECTIONS.has(storeTag);
}

function StoragePolicyOf(CatalogId: string): InventoryStoragePolicyEntry | undefined {
    try {
        return GetInventoryStoragePolicy(CatalogId);
    } catch {
        return undefined;   // no policy file: nothing can be proven stacked, so every item is refused below
    }
}

// Validates the fountain file. Fail-closed: any problem refuses the whole offer. Stacked items only - a stacked grant
// carries no instance id, so a daily claim can never re-mint (and collide with) a previous day's instanced item - and
// no entitlement or progression payload (one-time grants have no place in a daily bundle).
export function ParseFountainDailyBundle(Raw: unknown): { skus: StoreSku[]; problems: string[] } {
    const List = Array.isArray(Raw) ? Raw : (Raw as any)?.skus;
    if (!Array.isArray(List)) {
        return { skus: [], problems: ["expected { \"skus\": [ <one offer> ] } or an array holding one offer"] };
    }
    if (List.length !== 1) {
        return { skus: [], problems: [`expected exactly one offer (the client only uses the first), found ${List.length}`] };
    }

    const Problems: string[] = [];
    const Sku: any = List[0];
    if (typeof Sku?.id !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(Sku.id)) {
        Problems.push(`invalid id ${JSON.stringify(Sku?.id)} (letters, digits, _ . - only: it is a URL segment of /token/<slug>/<sku>)`);
    }
    if (!Array.isArray(Sku?.tags) || !Sku.tags.includes(FOUNTAIN_DAILY_BUNDLE_TAG)) {
        Problems.push(`tags must include ${FOUNTAIN_DAILY_BUNDLE_TAG}`);
    }
    const Prices = Sku?.prices;
    if (!Array.isArray(Prices) || Prices.length !== 1 || Prices[0]?.currencyId !== "id_currency_platinum" || Prices[0]?.price !== 0) {
        Problems.push("prices must be exactly [{ \"currencyId\": \"id_currency_platinum\", \"price\": 0 }] (the client opens the coin toss only for PlatPrice 0)");
    }
    if (Array.isArray(Sku?.entitlements) ? Sku.entitlements.length > 0 : Sku?.entitlements != undefined) {
        Problems.push("entitlements are not allowed (stacked items only)");
    }
    if (Sku?.skuProgression != undefined) Problems.push("skuProgression is not allowed (stacked items only)");
    if (Sku?.loadoutSlots != undefined) Problems.push("loadoutSlots are not allowed (stacked items only)");

    const Items = Sku?.items;
    if (!Array.isArray(Items) || Items.length === 0) Problems.push("items must list at least one stacked item");
    for (const Item of Array.isArray(Items) ? Items : []) {
        const CatalogId = Item?.catalogId;
        if (typeof CatalogId !== "string" || CatalogId.length === 0) {
            Problems.push(`item with invalid catalogId ${JSON.stringify(CatalogId)}`);
            continue;
        }
        if (Item.instanced !== false) Problems.push(`${CatalogId}: instanced items are not allowed (set "instanced": false; stacked items only)`);
        if (!Number.isSafeInteger(Item.quantity) || Item.quantity <= 0) Problems.push(`${CatalogId}: quantity must be a positive integer`);

        // The grant path re-applies the storage policy (NormalizeInventoryGrantCollections), so the policy, not the
        // file's own flag, decides what is minted. Unknown ids are refused rather than guessed.
        const Policy = StoragePolicyOf(CatalogId);
        if (Policy?.storage !== "stacked") {
            Problems.push(`${CatalogId}: inventory_storage_policy.json says ${Policy?.storage ?? "nothing"}, not stacked (regenerate it after choosing a new item)`);
        } else if (Policy.maxQuantity > 0) {
            // A daily repeat cannot respect a cap: nothing on the grant path enforces maxQuantity, so a capped item
            // (an ownership unlock, a dye) would pass day 1 and exceed its cap from day 2 on.
            Problems.push(`${CatalogId}: capped at maxQuantity ${Policy.maxQuantity}; a daily offer may only grant uncapped stacked items`);
        }
        // ApplyCurrencyDeltas would demand banked season progress for these (wallet.ts SpendBankedPrestigeForReward)
        // and every claim would fail.
        if (IsPrestigeGatedReward(CatalogId)) Problems.push(`${CatalogId}: a prestige-gated reward currency cannot be granted by the store`);
    }

    if (Problems.length > 0) return { skus: [], problems: Problems };
    return {
        skus: [{
            id: Sku.id,
            displayName: typeof Sku.displayName === "string" ? Sku.displayName : "Daily Free Bundle",
            displayDescription: typeof Sku.displayDescription === "string" ? Sku.displayDescription : "",
            displayPriority: Number.isFinite(Sku.displayPriority) ? Sku.displayPriority : 0,
            prices: [{ currencyId: "id_currency_platinum", price: 0 }],
            maxAllowed: 1,
            images: Sku.images != undefined && typeof Sku.images === "object" && !Array.isArray(Sku.images) ? Sku.images : {},
            tags: Sku.tags.filter((Tag: unknown) => typeof Tag === "string"),
            items: Items.map((Item: any) => ({ catalogId: Item.catalogId, quantity: Item.quantity, instanced: false })),
            duplicateInstancedItems: [],
        }],
        problems: [],
    };
}

export function LoadFountainDailyBundleSkus(FileName = FOUNTAIN_DAILY_BUNDLE_FILE): StoreSku[] {
    let Raw: unknown;
    try {
        Raw = tryLoadGameData(FileName);
    } catch (Err) {
        logger.error(`[Store:${FOUNTAIN_DAILY_BUNDLE_TAG}] ${FileName} could not be read - the fountain stays unavailable: ${String(Err)}`);
        return [];
    }
    if (Raw === undefined) {
        logger.info(`[Store:${FOUNTAIN_DAILY_BUNDLE_TAG}] no ${FileName} - the fountain stays unavailable (optional, see game-data/README.md)`);
        return [];
    }

    const Parsed = ParseFountainDailyBundle(Raw);
    if (Parsed.problems.length > 0) {
        logger.error(`[Store:${FOUNTAIN_DAILY_BUNDLE_TAG}] ${FileName} rejected - the fountain stays unavailable: ${Parsed.problems.join("; ")}`);
        return [];
    }
    const Offer = Parsed.skus[0];
    logger.info(`[Store:${FOUNTAIN_DAILY_BUNDLE_TAG}] daily offer ${Offer.id}: ${Offer.items.map((Item) => `${Item.catalogId} x${Item.quantity}`).join(", ")}`);
    return Parsed.skus;
}

// A purchase token names only the SKU id, and FindStoreSkuByIdOrCatalogId returns the FIRST section holding it: an id
// shared with another store would let one store's token buy from the other. Refuse such an offer outright.
function WithoutSkuIdClashes(SectionTag: string, Candidates: StoreSku[], Others: StoreSku[][]): StoreSku[] {
    const OtherIds = new Set(Others.flat().map((Sku) => Sku.id));
    const Clashes = Candidates.filter((Sku) => OtherIds.has(Sku.id)).map((Sku) => Sku.id);
    if (Clashes.length === 0) return Candidates;
    logger.error(`[Store:${SectionTag}] SKU id ${Clashes.join(", ")} is already used by another store - section disabled`);
    return [];
}

const FOUNTAIN_DAILY_SKUS = WithoutSkuIdClashes(FOUNTAIN_DAILY_BUNDLE_TAG, LoadFountainDailyBundleSkus(),
    [EXCHANGE_SLOT_SKUS.slot2, EXCHANGE_SLOT_SKUS.slot3, LADYLUCK_SKUS, REWARD_CACHE_SKUS, PLATINUM_SKUS]);

const STORE_SKUS: Record<string, StoreSku[]> = {
    exchange_vendor_slot_2: EXCHANGE_SLOT_SKUS.slot2,
    exchange_vendor_slot_3: EXCHANGE_SLOT_SKUS.slot3,
    ladyluckstore: LADYLUCK_SKUS,
    season_store: REWARD_CACHE_SKUS,
    webstore: PlatinumSection("webstore"),
    dyes: PlatinumSection("dyes"),
    hp_level_skip_rank: PlatinumSection("hp_level_skip_rank"),
    huntpass_store: PlatinumSection("huntpass_store"),
    [FOUNTAIN_DAILY_BUNDLE_TAG]: FOUNTAIN_DAILY_SKUS,
};

// [1.14.7 2026-10-10] Daily claims reset at 17:00 UTC, the instant the client itself stores for its daily bounty
// cooldown (GET /cooldown serves bounty_daily@<day>T17:00Z). A window runs [17:00 UTC, next 17:00 UTC); its key is
// its start as an ISO string.
const DAILY_RESET_OFFSET_MS = 17 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function DailyResetWindow(NowMs: number): { key: string; startMs: number; endMs: number } {
    if (!Number.isFinite(NowMs)) throw new Error(`DailyResetWindow: invalid clock ${String(NowMs)}`);
    const StartMs = Math.floor((NowMs - DAILY_RESET_OFFSET_MS) / DAY_MS) * DAY_MS + DAILY_RESET_OFFSET_MS;
    return { key: new Date(StartMs).toISOString(), startMs: StartMs, endMs: StartMs + DAY_MS };
}

// The claim's inventory transaction id: deterministic in (store scope, userId, skuId, window), so a second claim in the
// same window hits the same idempotency-ledger row and only REPLAYS the stored result, and the listing can find
// this window's claim without any separate cooldown record (which would sit outside the grant's transaction).
export function DailyClaimTransactionId(storeTag: string, userId: string, skuId: string, windowKey: string): string {
    const { transaction: Scope } = TransactionScopeFor(storeTag);
    return crypto.createHash("sha256").update(`${Scope}:${userId}:${skuId}:${windowKey}`).digest("hex").slice(0, 32).toUpperCase();
}

// Ledger lookup used by the listing and the claim. Read-only. Any row counts: tryBegin and complete run in one Mongo
// transaction, so a committed row is always a completed claim. It returns the claiming character because the ledger
// keys its rows per (user, character, transaction) while the reward lands in the account-wide wallet: the same id
// under a second character would be a NEW row and a second grant, so the claim refuses that case itself.
export type DailyClaim = { characterId: string | undefined };
export type DailyClaimLookup = (userId: string, transactionId: string) => Promise<DailyClaim | undefined>;

async function FindClaimInInventoryLedger(userId: string, transactionId: string): Promise<DailyClaim | undefined> {
    const Sqlite = GetSqliteDirectAccess();
    const Row = Sqlite ? await Sqlite.findInventoryLedgerClaim(userId, transactionId)
        : await (await GetMongoDb()).collection(Collections.InventoryTransactions).findOne(
            { userId: { $eq: userId }, transactionId: { $eq: transactionId } },
            { projection: { _id: 1, characterId: 1 } }
        );
    if (Row == undefined) return undefined;
    return { characterId: typeof Row.characterId === "string" ? Row.characterId : undefined };
}

export type StoreListingOptions = { nowMs?: number; hasClaim?: DailyClaimLookup };

// The listing for one requesting player. Every section but the daily ones is served as is. A daily offer is left out
// once this window's claim exists - absence is the only "claimed" signal the client honours (see above) - and
// whenever the claim cannot be checked: fail closed, the fountain just looks used until the next arrival.
export async function GetStoreSkusForPlayer(storeTag: string, userId: string | undefined, Options: StoreListingOptions = {}): Promise<StoreSku[]> {
    const Skus = GetStoreSkus(storeTag);
    if (!IsDailyClaimSection(storeTag)) return Skus;
    if (Skus.length === 0) {
        logger.info(`[Store:${storeTag}] no daily offer loaded (${FOUNTAIN_DAILY_BUNDLE_FILE} missing or rejected at startup) - serving none`);
        return [];
    }

    if (typeof userId !== "string" || userId.length === 0 || userId === "INVALID") {
        logger.warn(`[Store:${storeTag}] daily offer requested without a player id - serving none`);
        return [];
    }

    const Window = DailyResetWindow(Options.nowMs ?? Date.now());
    const HasClaim = Options.hasClaim ?? FindClaimInInventoryLedger;
    const Open: StoreSku[] = [];
    for (const Sku of Skus) {
        try {
            if (await HasClaim(userId, DailyClaimTransactionId(storeTag, userId, Sku.id, Window.key)) !== undefined) continue;
        } catch (Err) {
            logger.warn(`[Store:${storeTag}] ${userId} claim lookup failed for ${Sku.id} - hiding the offer: ${String(Err)}`);
            continue;
        }
        Open.push(Sku);
    }

    logger.info(`[Store:${storeTag}] ${userId} window=${Window.key} -> ${Open.length > 0 ? `open (${Open.map((Sku) => Sku.id).join(", ")})` : "claimed or unavailable"}`);
    return Open;
}

// Store-service currency ids (id_currency_x) -> our wallet's catalog currency ids (CURRENCY_X).
// Verified: both CURRENCY_MARKS_GILDED/CURRENCY_MARKS_STEEL exist in our 1.12 catalog with real
// resolved display names ("Gilded Marks"/"Steel Marks"), and routes/store.ts's GET /balance already
// projects both naming forms for any wallet-persisted currency.
const CURRENCY_ID_MAP: Record<string, string> = {
    id_currency_marks_gilded: "CURRENCY_MARKS_GILDED",
    id_currency_marks_steel: "CURRENCY_MARKS_STEEL",
    id_currency_s19_coin: "CURRENCY_S19_COIN",
    // [1.14.7 2026-10-08] The Reward Cache is priced in the 1.14.7 seasonal coin (the HUD's blue-star "Cache Coins").
    id_currency_seasonal_coin: "CURRENCY_SEASONAL_COIN",
    id_currency_rewardcache: "CURRENCY_REWARDCACHE",
    // [2026-07-30] Platinum resolves to the AGGREGATE id; ApplyCurrencyDeltas splits the debit across
    // the real per-storefront buckets (platinumWallet.ts). Without this entry the fallback below
    // produced "ID_CURRENCY_PLATINUM", which fails the CURRENCY_ prefix test in ApplyCurrencyDeltas and
    // is then treated as a stacked ITEM removal - so a platinum SKU would have failed with a confusing
    // InsufficientStackedItemError (unmapped -> 500) instead of charging anything. It failed closed,
    // but it would have failed. See Progress/33_PLATINUM_STORE.md.
    id_currency_platinum: "CURRENCY_PLATINUM",
};

export function GetLadyLuckSkus(): StoreSku[] {
    return LADYLUCK_SKUS;
}

export function GetStoreSkus(storeTag: string): StoreSku[] {
    return STORE_SKUS[storeTag] ?? [];
}

// [2026-07-24] GET /token/platinum/{id} ("Generate purchase token for any catalogId from shop") is
// captured taking a single path segment with no other context about which id-space it lives in. Our
// own SKU listing only ever hands the client a SKU `id` (e.g. "ladyluck_headbling_normal"), never a
// bare inventory catalogId, so that's the primary match; falling back to a per-item catalogId match
// covers a client that instead echoes back one of the `items[].catalogId` values from that listing.
export function FindLadyLuckSkuByIdOrCatalogId(idOrCatalogId: string): StoreSku | undefined {
    return (
        LADYLUCK_SKUS.find((s) => s.id === idOrCatalogId) ??
        LADYLUCK_SKUS.find((s) => s.items.some((i) => i.catalogId === idOrCatalogId))
    );
}

export type LocatedStoreSku = { storeTag: string; sku: StoreSku };

export function FindStoreSkuByIdOrCatalogId(idOrCatalogId: string): LocatedStoreSku | undefined {
    const Entries = Object.entries(STORE_SKUS);

    for (const [StoreTag, Skus] of Entries) {
        const Exact = Skus.find((Sku) => Sku.id === idOrCatalogId);
        if (Exact) return { storeTag: StoreTag, sku: Exact };
    }

    // Daily sections are excluded: the fountain grants plain currency/consumables that other stores may sell too.
    const CatalogMatches = Entries.filter(([StoreTag]) => !IsDailyClaimSection(StoreTag)).flatMap(([StoreTag, Skus]) =>
        Skus
            .filter((Sku) => Sku.items.some((Item) => Item.catalogId === idOrCatalogId))
            .map((Sku) => ({ storeTag: StoreTag, sku: Sku }))
    );

    // One SKU registered under several section tags (a dye is in both `webstore` and `dyes`) is NOT
    // an ambiguous match - it is the same offer reachable from two sections. Collapse by SKU id
    // first, so only a genuine collision between different offers is refused.
    const DistinctSkuIds = new Set(CatalogMatches.map((Match) => Match.sku.id));

    // A bare catalogId has no store context in the token URL. Refuse a genuinely ambiguous match
    // rather than minting a token for whichever store happens to be first in the registry.
    return DistinctSkuIds.size === 1 ? CatalogMatches[0] : undefined;
}

// [2026-07-30] The deterministic transactionId for a one-time SKU must not depend on WHICH SECTION
// the player bought it from. The platinum data set is registered under four section tags, so a dye
// resolvable as both `webstore` and `dyes` would otherwise hash to two different transaction ids -
// and a one-time SKU whose ownership check IS its idempotency row could then be bought twice. Map
// every section of one store to a single stable scope. Lady Luck's and the Reward Cache's existing
// scope strings are preserved exactly so deployed idempotency rows keep matching.
const PLATINUM_SECTION_TAGS = ["webstore", "dyes", "hp_level_skip_rank", "huntpass_store"];

function TransactionScopeFor(storeTag: string): { transaction: string; instance: string } {
    if (storeTag === "ladyluckstore") {
        return { transaction: "ladyluck-purchase", instance: "ladyluck-purchase-instance" };
    }
    if (PLATINUM_SECTION_TAGS.includes(storeTag)) {
        return { transaction: "store-purchase:platinum", instance: "store-purchase-instance:platinum" };
    }
    return { transaction: `store-purchase:${storeTag}`, instance: `store-purchase-instance:${storeTag}` };
}

// Applies a SKU's `skuProgression` payload. Rank-skip SKUs name `selected_huntpass` and a rank
// count, which src/skuProgression.ts converts to an XP delta against the same rank curve
// controllers/progression.ts validates rank-confirm requests with. A no-op plan (unknown track,
// already at max rank, nothing to grant) is logged rather than silently ignored, because for a
// PAID SKU "granted nothing" is a fact worth having in the log next to the debit.
async function GrantSkuProgressionInTransaction(repos: RepositoryProvider, userId: string, sku: StoreSku, session: ClientSession): Promise<void> {
    if (sku.skuProgression == undefined) return;

    const RawTrackId = sku.skuProgression.progressionId;
    const TrackId = typeof RawTrackId === "string" ? ResolveProgressionTrackId(RawTrackId) : undefined;
    const Existing = TrackId ? await repos.progressionTracks.get(userId, TrackId, session) : undefined;

    const Plan = ResolveProgressionGrant(
        sku.skuProgression,
        Existing?.progress ?? 0,
        ResolveProgressionTrackId,
        GetTrackCurve
    );

    if (Plan.kind === "none") {
        logger.warn(`[StoreProgression] ${userId} sku=${sku.id} granted no progression (${Plan.reason}, requested track=${RawTrackId} xp=${sku.skuProgression.xp} ranks=${sku.skuProgression.ranks})`);
        return;
    }

    const After = await repos.progressionTracks.increment(userId, Plan.progressionId, Plan.xp, session);
    if (Plan.kind === "ranks") {
        logger.info(`[StoreProgression] ${userId} sku=${sku.id} track=${Plan.progressionId} rank ${Plan.fromRank}->${Plan.toRank} (+${Plan.xp} xp, total ${After.progress})`);
    } else {
        logger.info(`[StoreProgression] ${userId} sku=${sku.id} track=${Plan.progressionId} +${Plan.xp} xp (total ${After.progress})`);
    }
}

export type PurchaseResult =
    | { ok: true; result: any }
    | { ok: false; reason: "unknown_sku" | "insufficient_balance" | "conflict" | "already_purchased_different_request" | "transaction_failed" };

// [2026-07-24] Confirmed real purchase flow (see routes/store.ts's /token/platinum and
// /notification/platinum handlers): the client never calls a skuId-in-path/characterId-in-body
// purchase route directly (that was an earlier, wrong guess - removed). It mints a short-lived
// purchase token via GET /token/platinum/{id}, then redeems it via POST /notification/platinum?token=.
// This function is the actual purchase execution, called from the redeem step once the token's
// (userId, characterId, skuId) claims are decoded - built on the same atomic machinery as before
// (RunInventoryTransaction's idempotency ledger + the wallet's overspend guard).
// Clock, transaction runner and claim lookup, injectable for tests; production callers pass nothing.
export type StorePurchaseOptions = {
    nowMs?: number;
    runTransaction?: typeof RunInventoryTransaction;
    hasClaim?: DailyClaimLookup;
};

const ECONOMY_MONITOR_ENABLED = !/^(0|false|off|no)$/i.test(process.env.MYSTICPARADOX_ECONOMY_MONITOR ?? "");

export async function PurchaseStoreSku(userId: string, characterId: string, storeTag: string, skuId: string, characterBindingValidated = false,
    Options: StorePurchaseOptions = {}): Promise<PurchaseResult> {
    const Sku = GetStoreSkus(storeTag).find((s) => s.id === skuId);
    if (!Sku) {
        return { ok: false, reason: "unknown_sku" };
    }

    // One-time SKUs (maxAllowed===1, the overwhelming majority - cosmetics/weapons/champion gear) get
    // a DETERMINISTIC transactionId keyed on (userId, skuId). This reuses RunInventoryTransaction's
    // existing idempotency ledger as the ownership check itself: a genuine repeat purchase attempt
    // hits the same transactionId and replays the stored result (same body -> same hash) rather than
    // re-charging or re-granting - no separate "already owns this" query needed. Repeatable SKUs
    // (maxAllowed===null - Cell Cores, Tonic Packs) get a fresh id per call so each purchase applies
    // as its own transaction.
    // [1.14.7 2026-10-10] Daily sections (the fountain) are once per reset window: the same deterministic scheme with
    // the window key added (DailyClaimTransactionId), checked BEFORE maxAllowed so a daily offer never falls back to the
    // window-less one-time id or a random one.
    const DailyWindow = IsDailyClaimSection(storeTag) ? DailyResetWindow(Options.nowMs ?? Date.now()) : undefined;
    const IsOneTime = Sku.maxAllowed === 1;
    // Preserve Lady Luck's deployed transaction/instance identities exactly. Other stores include the
    // store scope so an identical SKU id in two stores cannot share an idempotency key, while every
    // section of the SAME store shares one scope - see TransactionScopeFor.
    const { transaction: TransactionScope, instance: InstanceScope } = TransactionScopeFor(storeTag);
    const TransactionId = DailyWindow
        ? DailyClaimTransactionId(storeTag, userId, skuId, DailyWindow.key)
        : IsOneTime
            ? crypto.createHash("sha256").update(`${TransactionScope}:${userId}:${skuId}`).digest("hex").slice(0, 32).toUpperCase()
            : crypto.randomBytes(16).toString("hex").toUpperCase();

    // [1.14.7 2026-10-10] Only a positive price is a debit. The fountain's offer is priced 0 Platinum (the client opens
    // the coin toss only for PlatPrice 0) and its removal must not reach the wallet at all: SpendPlatinum happens to
    // ignore 0 today, but any other currency would still run AddCurrency(-0) and report a touched balance. No other
    // store SKU has a price <= 0, so their request hashes (and replays of their ledger rows) are unchanged. A negative
    // or non-numeric price would be a credit through the debit path: refuse the purchase instead.
    if (Sku.prices.some((p) => typeof p.price !== "number" || !Number.isFinite(p.price) || p.price < 0)) {
        logger.error(`[Store:${storeTag}] ${skuId} has an invalid price ${JSON.stringify(Sku.prices)} - purchase refused`);
        return { ok: false, reason: "transaction_failed" };
    }
    const StackedItemsToRemove = Sku.prices.filter((p) => p.price > 0).map((p) => ({
        catalogId: CURRENCY_ID_MAP[p.currencyId] ?? p.currencyId.toUpperCase(),
        quantity: p.price,
    }));

    const InstancedItemsToAdd: any[] = [];
    const StackedItemsToAdd: any[] = [];
    for (const item of Sku.items) {
        if (item.instanced) {
            // Deterministic per (userId, skuId, catalogId, index) - a replayed purchase transaction
            // must construct the IDENTICAL instanced-item list, or RunInventoryTransaction's
            // requestHash binding would reject it as a mismatched replay instead of returning the
            // original result. A daily section adds its window, so day 2 can never rebuild day 1's
            // instance ids (its data is stacked-only anyway - ParseFountainDailyBundle).
            for (let i = 0; i < item.quantity; i++) {
                const InstanceId = crypto
                    .createHash("sha256")
                    .update(`${InstanceScope}:${userId}:${skuId}:${item.catalogId}:${i}${DailyWindow ? `:${DailyWindow.key}` : ""}`)
                    .digest("hex")
                    .slice(0, 26)
                    .toUpperCase();
                InstancedItemsToAdd.push({ catalogId: item.catalogId, instanceId: InstanceId, itemData: null, updateVersion: 0 });
            }
        } else {
            StackedItemsToAdd.push({ catalogId: item.catalogId, quantity: item.quantity });
        }
    }

    // [2026-07-30] Entitlement and progression payloads are applied inside the SAME Mongo
    // transaction as the currency debit, via RunInventoryTransaction's onGrant hook - so an
    // entitlement that fails to persist rolls the charge back with it, and a purchase can never
    // debit platinum while granting nothing (the exact failure mode a store built only on `items`
    // would have had for every rank skip and Elite track SKU).
    const HasNonInventoryGrants = (Sku.entitlements?.length ?? 0) > 0 || Sku.skuProgression != undefined;
    const OnGrant = HasNonInventoryGrants
        ? async (Repos: RepositoryProvider, Session: ClientSession) => {
            await GrantEntitlementsInTransaction(Repos, userId, Sku.entitlements ?? [], Sku.id, Session);
            await GrantSkuProgressionInTransaction(Repos, userId, Sku, Session);
        }
        : undefined;

    // The ledger inside RunInventoryTransaction stays the authority for a same-character replay; this lookup refuses a
    // claim this window already holds under ANOTHER character (see DailyClaimLookup), and names new vs replay for the
    // [GrantMon] line below. A failed lookup refuses the claim: fail closed.
    let ClaimState = "-";
    if (DailyWindow) {
        let Existing: DailyClaim | undefined;
        try {
            Existing = await (Options.hasClaim ?? FindClaimInInventoryLedger)(userId, TransactionId);
        } catch (Err) {
            logger.warn(`[Store:${storeTag}] ${userId} claim lookup failed for ${skuId} - claim refused: ${String(Err)}`);
            return { ok: false, reason: "transaction_failed" };
        }
        if (Existing !== undefined && Existing.characterId !== characterId) {
            logger.warn(`[Store:${storeTag}] ${userId} already claimed ${skuId} in window ${DailyWindow.key} under character `
                + `${Existing.characterId ?? "?"} - refused for character ${characterId}`);
            return { ok: false, reason: "already_purchased_different_request" };
        }
        ClaimState = Existing !== undefined ? "replay (no new grant)" : "new";
    }

    try {
        const Result = await (Options.runTransaction ?? RunInventoryTransaction)(
            userId,
            characterId,
            TransactionId,
            InstancedItemsToAdd,
            StackedItemsToAdd,
            [],
            StackedItemsToRemove,
            [],
            {
                ownershipAlreadyValidated: characterBindingValidated,
                diagnosticLabel: `store:${storeTag}:${skuId}`,
                onGrant: OnGrant,
                // [diagnostics 2026-10-14] The economy ledger logs a Platinum price as a spend for this SKU (for=<SKU id>).
                economy: { source: "STORE", storeSkuId: Sku.id },
            }
        );
        if (!Result) {
            return { ok: false, reason: "transaction_failed" };
        }
        logger.info(`[Store:${storeTag}] ${userId} purchased ${skuId} (transactionId=${TransactionId})`);
        // [1.14.7 2026-10-10] A daily claim is a free grant that no game server issues, so it never passes POST /inventory's
        // [GrantMon]; give it the same greppable line with the store as its source.
        if (DailyWindow && ECONOMY_MONITOR_ENABLED) {
            logger.info(`[GrantMon] txn=${TransactionId} user=${userId} src=store source="store:${storeTag}" sku=${skuId}`
                + ` window=${DailyWindow.key} add=[${StackedItemsToAdd.map((Item) => `${Item.catalogId} x${Item.quantity}`).join(", ")}]`
                + ` remove=[${StackedItemsToRemove.map((Item) => `${Item.catalogId} x${Item.quantity}`).join(", ")}] claim=${ClaimState}`);
        }
        return { ok: true, result: Result };
    } catch (Err) {
        if (Err instanceof InsufficientBalanceError) {
            return { ok: false, reason: "insufficient_balance" };
        }
        if (Err instanceof InventoryTransactionConflictError) {
            return { ok: false, reason: "conflict" };
        }
        if (Err instanceof InventoryTransactionMismatchError) {
            return { ok: false, reason: "already_purchased_different_request" };
        }
        throw Err;
    }
}

// Compatibility wrapper for existing imports/tests and any in-flight work based on the Lady Luck
// controller name. The generic implementation preserves Lady Luck's old transaction identities.
export async function PurchaseLadyLuckSku(userId: string, characterId: string, skuId: string): Promise<PurchaseResult> {
    return PurchaseStoreSku(userId, characterId, "ladyluckstore", skuId);
}

export async function GetNotesForUser(userId: string){
    if(userId === undefined || userId === "" || userId === "INVALID"){
        return 0;
    }

    // Ensure the account (users) row exists for the record.
    let UserFromDb = await GetRepositories().accounts.findByUserId(userId);

    if(UserFromDb === undefined){
        await GetRepositories().accounts.create({
            userId,
            name: userId,
            notes: 0
        });
    }

    // Rams (CURRENCY_NOTES) now lives in the wallet (single source of truth for all currency).
    return await GetBalance(userId, "CURRENCY_NOTES");
}
