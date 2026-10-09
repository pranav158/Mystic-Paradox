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

import { Router } from "express";
import { logger } from "../logger";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { GetNotesForUser, GetStoreSkus, PurchaseStoreSku, FindStoreSkuByIdOrCatalogId } from "../controllers/store";
import { GetWallet, BuildBalanceDict } from "../controllers/wallet";
import { ProjectBalances } from "../platinumWallet";
import { GetCharactersForUid } from "../controllers/character";
import { SignStorePurchaseToken, ValidateStorePurchaseToken, StorePurchaseTokenPayload } from "../controllers/auth";

export const storeRouter = Router();

storeRouter.post("/reconcile", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId ?? "INVALID";
    const Balances = await BuildBalanceDict(UserId);

    logger.info(`Reconcile for ${UserId}: Rams=${Balances.CURRENCY_NOTES ?? 0} CombatMerit=${Balances.CURRENCY_PJM_WEAPON ?? 0}`);

    res.status(200).json({
        balances: Balances,
        refreshInventory: true
    });
});

storeRouter.get("/creator", HasParadoxBackendAuth, async (req: any, res) => {
    logger.info("SupportACreator (stubbed)");

    res.status(200);
    res.json({
        "expirationDate": "2099-01-01T01:00:00.041Z",
        "slug": "MROWMROW",
        "success": true
    });
})

storeRouter.get("/balance", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId ?? "INVALID";

    const Wallet = await GetWallet(UserId);
    const NotesBalance = Wallet.CURRENCY_NOTES ?? await GetNotesForUser(UserId);

    logger.info(`Fetched balance for userId ${UserId}: Rams(NOTES)=${NotesBalance} CombatMerit(PJM_WEAPON)=${Wallet.CURRENCY_PJM_WEAPON ?? 0}`);

    const Balance: Record<string, number> = {
        id_currency_s20_coin: 0,
        CURRENCY_GAUNTLET_COIN_FADED: 0,
        CURRENCY_S20_COIN: 0,
        CURRENCY_S18_COIN: 0,
        id_currency_seasonal_coin: 0,
        id_currency_s18_coin: 0,
        id_currency_weapon_token: 25,
        id_currency_celldust: 0,
        id_currency_event_ramsgiving: 0,
        CURRENCY_NOTES: NotesBalance,
        id_currency_event_frostfall: 0,
        CURRENCY_EVENT_DARKHARVEST: 0,
        CURRENCY_S19_COIN: 0,
        id_currency_s16_coin: 0,
        CURRENCY_S16_COIN: 0,
        id_currency_gauntlet_coin: 0,
        id_currency_s13_coin: 0,
        CURRENCY_MARKS_STEEL: 0,
        CURRENCY_S13_COIN: 0,
        CURRENCY_EVENT_FROSTFALL: 0,
        CURRENCY_GAUNTLET_COIN: 0,
        id_currency_marks_steel: 0,
        id_currency_rewardcache: 0,
        CURRENCY_PRESTIGE: 0,
        CURRENCY_SEASONAL_COIN: 0,
        CURRENCY_REWARDCACHE: 0,
        id_currency_token_exchange_speed_up: 0,
        id_currency_event_springtide: 0,
        CURRENCY_TOKEN_EXCHANGE_SPEED_UP: 0,
        id_currency_gauntlet_coin_faded: 0,
        CURRENCY_S15_COIN: 0,
        CURRENCY_PLATINUM: 0,
        id_currency_platinum: 0,
        id_currency_s15_coin: 0,
        id_currency_marks_gilded: 0,
        id_currency_event_darkharvest: 0,
        id_currency_event_saintsbond: 0,
        CURRENCY_EVENT_SPRINGTIDE: 0,
        id_currency_s19_coin: 0,
        id_currency_notes: NotesBalance,
        id_currency_prestige: 0,
        id_currency_s13_daily: 0,
        CURRENCY_WEAPON_TOKEN: 25,
        CURRENCY_MARKS_GILDED: 0,
        CURRENCY_S13_DAILY: 0,
        CURRENCY_CELLDUST: 0,
        CURRENCY_S14_COIN: 0,
        CURRENCY_EVENT_SAINTSBOND: 0,
        CURRENCY_S17_COIN: 0,
        id_currency_s14_coin: 0,
        CURRENCY_EVENT_RAMSGIVING: 0,
        id_currency_s17_coin: 0
    };

    // Overlay persisted wallet balances (both CURRENCY_X and id_currency_x forms); adds PJM merit keys
    // too, and collapses the 13 platinum buckets into the single CURRENCY_PLATINUM key the client
    // actually reads (platinumWallet.ts). Uses the wallet already fetched above rather than
    // BuildBalanceDict, which would re-read it - this endpoint is polled constantly.
    res.status(200).json(ProjectBalances(Wallet, Balance));
});

// [2026-07-24] Confirmed real endpoint contract (DauntlessEndpointDocumentation/Store/Product/Skus/
// SearchPublic.md, captured 2.1.1): GET /product/skus/public?requiredTags={tag} - one tag value per
// store section (ladyluckstore/huntpass_store/gauntlet_store/dyes/loadout_slots/mailbox/webstore/...).
// `ladyluckstore` is backed by its verified/cross-checked data set. `season_store` serves the
// deterministic reconstructed Season 19 cosmetic rotation generated from the verified 1.12 catalog;
// every other tag remains an empty section.
storeRouter.get("/product/skus/public", HasParadoxBackendAuth, async (req: any, res) => {
    const RequiredTags = req.query.requiredTags;

    if (typeof RequiredTags !== "string" || RequiredTags.length === 0) {
        res.status(400);
        res.json({ code: "400", message: "missing requiredTags query parameter" });
        return;
    }

    const StoreSkus = GetStoreSkus(RequiredTags);

    if (StoreSkus.length === 0) {
        logger.info(`Store SKUs requested for unimplemented tag '${RequiredTags}' - returning empty`);
        res.status(200);
        res.json([]);
        return;
    }

    // [not yet confirmed by a live capture] `remaining` here does not reflect real per-player
    // ownership of one-time SKUs - the purchase endpoint below is the actual gate (a repeat purchase
    // of an already-owned one-time SKU is idempotently safe, not double-charged), this listing just
    // doesn't grey it out yet. See controllers/store.ts's header comment for the full provenance.
    const Skus = StoreSkus.map((Sku) => ({
        id: Sku.id,
        displayName: Sku.displayName,
        displayDescription: Sku.displayDescription,
        displayPriority: Sku.displayPriority,
        prices: Sku.prices.map((p) => ({ currencyId: p.currencyId, price: p.price, salesPrice: null, multiPrice: null })),
        maxAllowed: Sku.maxAllowed,
        remaining: Sku.maxAllowed ?? 999,
        duplicateInstancedItems: Sku.duplicateInstancedItems,
        images: Sku.images ?? {},
        tags: Sku.tags,
        scheduledTags: null,
        items: Sku.items.map((i) => ({ catalogId: i.catalogId, quantity: i.quantity })),
        // [2026-07-30] Previously hardcoded empty/null. The client needs the real values: an
        // entitlement-payload SKU has `items: null` in the captures and is described entirely by
        // `entitlements`, and the Hunt Pass screens read `skuProgression` to label a rank skip. Both
        // are served in the captured shape - `entitlements` as {name, duration}, skuProgression as
        // {progressionId, ranks, xp}.
        entitlements: (Sku.entitlements ?? []).map((e) => ({ name: e.name, duration: e.duration })),
        skuProgression: Sku.skuProgression
            ? { progressionId: Sku.skuProgression.progressionId, ranks: Sku.skuProgression.ranks, xp: Sku.skuProgression.xp }
            : null,
        loadoutSlots: null,
        availableFrom: null,
        availableTo: null,
        timeAvailabilityReason: null,
        platformOfferId: null,
        missingEntitlementNames: null,
    }));

    logger.info(`Store SKUs: ${RequiredTags} -> ${Skus.length} SKUs`);
    res.status(200);
    res.json(Skus);
});

// [2026-07-24, revised same day after a live capture] DauntlessEndpointDocumentation/Store/Token/
// Platinum/GetPurchaseToken.md only ever captured the real-money case, so its "platinum" path segment
// was first assumed to be a naming holdover covering every currency - WRONG, disproven by a live
// capture. The actual client calls GET /token/{currencySlug}/{skuId}, where currencySlug varies per
// SKU's priced currency (`markssteel` for `ladyluck_bundle_consumables_00`/`trials_dye_hp08b_punk_02`,
// `marksgilded` for `ladyluck_headbling_normal` - i.e. the SKU's `prices[].currencyId` with the
// `id_currency_` prefix and underscores stripped). Hardcoding `platinum` 404'd every single Marks
// purchase attempt (confirmed via metagame.log once file logging was fixed - three attempts, three
// `Unstubbed route GET /token/.../...` 404s, zero of them reaching the transaction ledger). The
// currency segment is client-side routing/display only - the actual price and currency charged still
// come from the SKU's own `prices` server-side in PurchaseStoreSku, so it doesn't need validating
// against `:currency` here.
//
// This also replaced an earlier, wrong guess at the purchase contract entirely (a skuId-in-path/
// characterId-in-body POST route) that the real client never called at all - a first live purchase
// attempt against THAT route left no trace anywhere (no matching entry ever appeared in the
// inventoryTransactions ledger), which is what led to these two real captured endpoints in the first
// place.
storeRouter.get("/token/:currency/:catalogId", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const Located = FindStoreSkuByIdOrCatalogId(req.params.catalogId);

    if (!Located) {
        logger.warn(`[Store] GetPurchaseToken: unknown or ambiguous sku/catalogId '${req.params.catalogId}' (currency=${req.params.currency}) for ${UserId}`);
        res.status(404);
        res.json({ code: "404", message: "unknown_sku" });
        return;
    }

    // Dauntless (this era) is single-slayer-per-account; there is no characterId in this flow's
    // request at all (neither the GetPurchaseToken GET nor the BuyFromPurchaseToken POST carries one),
    // so it's resolved here, once, at mint time and carried inside the token's own claims.
    const Characters = await GetCharactersForUid(UserId);
    const CharacterId = Characters[0]?.id;
    if (!CharacterId) {
        logger.error(`[Store:${Located.storeTag}] GetPurchaseToken: no character found for ${UserId}`);
        res.status(500);
        res.json({ code: "500", message: "no_character" });
        return;
    }

    const PurchaseToken = SignStorePurchaseToken({
        userId: UserId,
        characterId: CharacterId,
        storeTag: Located.storeTag,
        skuId: Located.sku.id,
    });
    logger.info(`[Store:${Located.storeTag}] Minted purchase token for ${UserId} sku=${Located.sku.id}`);
    res.status(200);
    res.json({ purchaseToken: PurchaseToken });
});

// [2026-07-24] DauntlessEndpointDocumentation/Store/Notification/BuyFromPurchaseToken.md only
// captured the real-money case (POST /notification/platinum?token=...). No live capture yet shows the
// redeem step for a Marks purchase (every attempt so far 404'd at the GET-token step above, before the
// client ever reached redeem) - but given the mint step is confirmed currency-segmented
// (/token/{currency}/{skuId}), the redeem step is very likely symmetric. Accepting any :currency
// segment here costs nothing (the token itself, not the URL, carries what's actually being bought) and
// avoids repeating the same hardcoded-"platinum" mistake if the client turns out to call
// /notification/markssteel or /notification/marksgilded specifically. Success is still 204 No Content,
// no body (the doc calls this out explicitly as the confirmed real shape).
storeRouter.post("/notification/:currency", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const Token = req.query.token;

    if (typeof Token !== "string" || Token.length === 0) {
        res.status(400);
        res.json({ code: "400", message: "missing token" });
        return;
    }

    let Payload: StorePurchaseTokenPayload;
    try {
        Payload = ValidateStorePurchaseToken(Token);
    } catch {
        logger.warn(`[Store] BuyFromPurchaseToken: invalid/expired token from ${UserId}`);
        res.status(401);
        res.json({ code: "401", message: "invalid_token" });
        return;
    }

    if (Payload.userId !== UserId) {
        logger.error(`[Store] BuyFromPurchaseToken: token userId ${Payload.userId} does not match authenticated ${UserId}`);
        res.status(403);
        res.json({ code: "403", message: "token_user_mismatch" });
        return;
    }

    // Tokens minted before the store registry did not carry storeTag. Accept those only when the SKU
    // still resolves unambiguously; every new token is explicitly store-bound.
    const StoreTag = Payload.storeTag ?? FindStoreSkuByIdOrCatalogId(Payload.skuId)?.storeTag;
    if (!StoreTag) {
        logger.warn(`[Store] BuyFromPurchaseToken: unknown or ambiguous sku=${Payload.skuId} for ${UserId}`);
        res.status(404);
        res.json({ code: "404", message: "unknown_sku" });
        return;
    }

    // ValidateStorePurchaseToken verified the signature and this route already checked userId. The
    // characterId was resolved server-side when the token was minted, so the purchase transaction
    // can skip a redundant ownership round trip while retaining the signed binding.
    const Result = await PurchaseStoreSku(Payload.userId, Payload.characterId, StoreTag, Payload.skuId, true);

    if (!Result.ok) {
        const StatusByReason: Record<string, number> = {
            unknown_sku: 404,
            insufficient_balance: 402,
            conflict: 409,
            already_purchased_different_request: 409,
            transaction_failed: 500,
        };
        logger.warn(`[Store:${StoreTag}] purchase denied for ${UserId} sku=${Payload.skuId}: ${Result.reason}`);
        res.status(StatusByReason[Result.reason] ?? 400);
        res.json({ code: String(StatusByReason[Result.reason] ?? 400), message: Result.reason });
        return;
    }

    logger.info(`[Store:${StoreTag}] purchase completed for ${UserId} sku=${Payload.skuId}`);
    res.status(204);
    res.send();
});
