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
import { GetNotesForUser, GetLadyLuckSkus, PurchaseLadyLuckSku, FindLadyLuckSkuByIdOrCatalogId } from "../controllers/store";
import { GetWallet, BuildBalanceDict } from "../controllers/wallet";
import { GetCharactersForUid } from "../controllers/character";
import { SignLadyLuckPurchaseToken, ValidateLadyLuckPurchaseToken } from "../controllers/auth";

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

    
    for (const [Cid, Amt] of Object.entries(Wallet)) {
        Balance[Cid] = Amt;
        Balance["id_currency_" + Cid.replace(/^CURRENCY_/, "").toLowerCase()] = Amt;
    }

    res.status(200).json(Balance);
});






storeRouter.get("/product/skus/public", HasParadoxBackendAuth, async (req: any, res) => {
    const RequiredTags = req.query.requiredTags;

    if (typeof RequiredTags !== "string" || RequiredTags.length === 0) {
        res.status(400);
        res.json({ code: "400", message: "missing requiredTags query parameter" });
        return;
    }

    if (RequiredTags !== "ladyluckstore") {
        logger.info(`Store SKUs requested for unimplemented tag '${RequiredTags}' - returning empty`);
        res.status(200);
        res.json([]);
        return;
    }

    
    
    
    
    const Skus = GetLadyLuckSkus().map((Sku) => ({
        id: Sku.id,
        displayName: Sku.displayName,
        displayDescription: Sku.displayDescription,
        displayPriority: Sku.displayPriority,
        prices: Sku.prices.map((p) => ({ currencyId: p.currencyId, price: p.price, salesPrice: null, multiPrice: null })),
        maxAllowed: Sku.maxAllowed,
        remaining: Sku.maxAllowed ?? 999,
        duplicateInstancedItems: Sku.duplicateInstancedItems,
        images: {},
        tags: Sku.tags,
        scheduledTags: null,
        items: Sku.items.map((i) => ({ catalogId: i.catalogId, quantity: i.quantity })),
        entitlements: [],
        skuProgression: null,
        loadoutSlots: null,
        availableFrom: null,
        availableTo: null,
        timeAvailabilityReason: null,
        platformOfferId: null,
        missingEntitlementNames: null,
    }));

    logger.info(`Store SKUs: ladyluckstore -> ${Skus.length} SKUs`);
    res.status(200);
    res.json(Skus);
});



















storeRouter.get("/token/:currency/:catalogId", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const Sku = FindLadyLuckSkuByIdOrCatalogId(req.params.catalogId);

    if (!Sku) {
        logger.warn(`[LadyLuckStore] GetPurchaseToken: unknown sku/catalogId '${req.params.catalogId}' (currency=${req.params.currency}) for ${UserId}`);
        res.status(404);
        res.json({ code: "404", message: "unknown_sku" });
        return;
    }

    
    
    
    const Characters = await GetCharactersForUid(UserId);
    const CharacterId = Characters[0]?.id;
    if (!CharacterId) {
        logger.error(`[LadyLuckStore] GetPurchaseToken: no character found for ${UserId}`);
        res.status(500);
        res.json({ code: "500", message: "no_character" });
        return;
    }

    const PurchaseToken = SignLadyLuckPurchaseToken({ userId: UserId, characterId: CharacterId, skuId: Sku.id });
    logger.info(`[LadyLuckStore] Minted purchase token for ${UserId} sku=${Sku.id}`);
    res.status(200);
    res.json({ purchaseToken: PurchaseToken });
});










storeRouter.post("/notification/:currency", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const Token = req.query.token;

    if (typeof Token !== "string" || Token.length === 0) {
        res.status(400);
        res.json({ code: "400", message: "missing token" });
        return;
    }

    let Payload: { userId: string; characterId: string; skuId: string };
    try {
        Payload = ValidateLadyLuckPurchaseToken(Token);
    } catch {
        logger.warn(`[LadyLuckStore] BuyFromPurchaseToken: invalid/expired token from ${UserId}`);
        res.status(401);
        res.json({ code: "401", message: "invalid_token" });
        return;
    }

    if (Payload.userId !== UserId) {
        logger.error(`[LadyLuckStore] BuyFromPurchaseToken: token userId ${Payload.userId} does not match authenticated ${UserId}`);
        res.status(403);
        res.json({ code: "403", message: "token_user_mismatch" });
        return;
    }

    const Result = await PurchaseLadyLuckSku(Payload.userId, Payload.characterId, Payload.skuId);

    if (!Result.ok) {
        const StatusByReason: Record<string, number> = {
            unknown_sku: 404,
            insufficient_balance: 402,
            conflict: 409,
            already_purchased_different_request: 409,
            transaction_failed: 500,
        };
        logger.warn(`[LadyLuckStore] purchase denied for ${UserId} sku=${Payload.skuId}: ${Result.reason}`);
        res.status(StatusByReason[Result.reason] ?? 400);
        res.json({ code: String(StatusByReason[Result.reason] ?? 400), message: Result.reason });
        return;
    }

    logger.info(`[LadyLuckStore] purchase completed for ${UserId} sku=${Payload.skuId}`);
    res.status(204);
    res.send();
});
