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
import { GetRepositories, RepositoryProvider } from "../persistence";
import { GetBalance, InsufficientBalanceError } from "./wallet";
import { RunInventoryTransaction, InventoryTransactionConflictError, InventoryTransactionMismatchError } from "./inventory";
import { GrantEntitlementsInTransaction } from "./entitlements";
import { GetTrackCurve, ResolveProgressionTrackId } from "./progression";
import { ResolveProgressionGrant } from "../skuProgression";
import { logger } from "../logger";
import { loadGameData } from "../gameData/loader";

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

const STORE_SKUS: Record<string, StoreSku[]> = {
    exchange_vendor_slot_2: EXCHANGE_SLOT_SKUS.slot2,
    exchange_vendor_slot_3: EXCHANGE_SLOT_SKUS.slot3,
    ladyluckstore: LADYLUCK_SKUS,
    season_store: REWARD_CACHE_SKUS,
    webstore: PlatinumSection("webstore"),
    dyes: PlatinumSection("dyes"),
    hp_level_skip_rank: PlatinumSection("hp_level_skip_rank"),
    huntpass_store: PlatinumSection("huntpass_store"),
};

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

    const CatalogMatches = Entries.flatMap(([StoreTag, Skus]) =>
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
export async function PurchaseStoreSku(userId: string, characterId: string, storeTag: string, skuId: string, characterBindingValidated = false): Promise<PurchaseResult> {
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
    const IsOneTime = Sku.maxAllowed === 1;
    // Preserve Lady Luck's deployed transaction/instance identities exactly. Other stores include the
    // store scope so an identical SKU id in two stores cannot share an idempotency key, while every
    // section of the SAME store shares one scope - see TransactionScopeFor.
    const { transaction: TransactionScope, instance: InstanceScope } = TransactionScopeFor(storeTag);
    const TransactionId = IsOneTime
        ? crypto.createHash("sha256").update(`${TransactionScope}:${userId}:${skuId}`).digest("hex").slice(0, 32).toUpperCase()
        : crypto.randomBytes(16).toString("hex").toUpperCase();

    const StackedItemsToRemove = Sku.prices.map((p) => ({
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
            // original result.
            for (let i = 0; i < item.quantity; i++) {
                const InstanceId = crypto
                    .createHash("sha256")
                    .update(`${InstanceScope}:${userId}:${skuId}:${item.catalogId}:${i}`)
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

    try {
        const Result = await RunInventoryTransaction(
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
            }
        );
        if (!Result) {
            return { ok: false, reason: "transaction_failed" };
        }
        logger.info(`[Store:${storeTag}] ${userId} purchased ${skuId} (transactionId=${TransactionId})`);
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
