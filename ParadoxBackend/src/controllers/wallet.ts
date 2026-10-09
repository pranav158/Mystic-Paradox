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

import { ClientSession } from "mongodb";
import { GetRepositories } from "../persistence";
import { IsValidBalanceCatalogId } from "../persistence/contracts/WalletRepository";
import { logger } from "../logger";
import { loadGameData } from "../gameData/loader";
import { PLATINUM_AGGREGATE_ID, ProjectBalances, ResolvePlatinumSpend, SumPlatinum } from "../platinumWallet";

const NO_PLAYER_SENTINEL = "INVALID";

// Starter grant seeded once, when a wallet is first created (first login / first balance query).
// Currency catalog IDs verified from the runtime catalog export (Items_Analysis/catalog_1_12.jsonl):
//   CURRENCY_NOTES      = "Rams" (main soft currency)
//   CURRENCY_PJM_WEAPON = Combat Merit (Slayer's Path weapon branch)  [icon ui_icon_merit_combat]
//   CURRENCY_PJM_*      = the other Slayer's Path merit branches
export const STARTER_WALLET: Record<string, number> = {
    CURRENCY_NOTES: 5000,
    CURRENCY_PJM_WEAPON: 50,
    CURRENCY_PJM_ARMOR: 50,
    CURRENCY_PJM_ALCHEMY: 50,
    CURRENCY_PJM_AIRSHIP: 50,
    CURRENCY_PJM_FISHING: 50,
};

// Returns the full balance map for a user, auto-creating the wallet with the starter grant on first access.
// Accepts an optional Mongo session so it can participate in a caller's transaction (see
// controllers/inventory.ts RunInventoryTransaction) instead of always writing outside one.
export async function GetWallet(userId: string, session?: ClientSession): Promise<Record<string, number>> {
    if (!userId || userId === NO_PLAYER_SENTINEL) return {};

    // A balance request may race character creation (or another first balance request). Use one
    // $setOnInsert upsert instead of find-then-insert so the starter wallet is created exactly
    // once and a pre-existing balance row is always adopted unchanged.
    const Wallet = await GetRepositories().wallets.createIfMissing(
        { userId, balances: { ...STARTER_WALLET } },
        session
    );
    return Wallet.balances;
}

export async function GetBalance(userId: string, catalogId: string, session?: ClientSession): Promise<number> {
    const Wallet = await GetWallet(userId, session);
    return Wallet[catalogId] ?? 0;
}

// [hardening] Thrown when a debit would drive a balance negative — the caller (controller/route)
// is expected to catch this and reject the request with an error response, never silently clamp.
export class InsufficientBalanceError extends Error {
    constructor(userId: string, catalogId: string, delta: number, currentBalance: number) {
        super(`Insufficient balance: user ${userId} has ${currentBalance} of ${catalogId}, cannot apply delta ${delta}`);
        this.name = "InsufficientBalanceError";
    }
}

// Applies a signed delta to one currency atomically ($inc, never read-modify-write) and persists.
// Debits that would drive the balance negative are REJECTED (throws InsufficientBalanceError),
// never clamped to zero. Returns the new balance. Accepts an optional session for transactional
// callers (same reasoning as GetWallet above).
export async function AddCurrency(userId: string, catalogId: string, delta: number, session?: ClientSession): Promise<number> {
    if (!userId || userId === NO_PLAYER_SENTINEL || !catalogId || !Number.isFinite(delta) || delta === 0) {
        return await GetBalance(userId, catalogId, session);
    }

    // Field-path safety: catalogId becomes a `balances.<catalogId>` Mongo field path in the repo.
    // Reject anything that isn't a strict identifier here too, so an unsafe id is caught before
    // any wallet auto-create/read happens (the repo enforces the same rule authoritatively).
    if (!IsValidBalanceCatalogId(catalogId)) {
        throw new Error(`Refusing currency change: unsafe balance catalogId ${JSON.stringify(catalogId)}`);
    }

    const Wallets = GetRepositories().wallets;

    // Fast path for the overwhelmingly common case: the wallet already exists. The old path always
    // performed createIfMissing/findOneAndUpdate before the guarded $inc, adding one full Mongo
    // round trip to every successful store purchase. `$inc` creates a missing balance field on an
    // existing wallet, so try the authoritative mutation first and only recover a truly absent
    // wallet on the slow path below.
    let Updated = await Wallets.incrementBalance(userId, catalogId, delta, session);
    if (Updated == undefined) {
        let Existing = await Wallets.findByUserId(userId, session);
        if (Existing == undefined) {
            await Wallets.createIfMissing({ userId, balances: { ...STARTER_WALLET } }, session);
            Updated = await Wallets.incrementBalance(userId, catalogId, delta, session);
            if (Updated != undefined) {
                const Next = Updated.balances[catalogId] ?? 0;
                logger.info(`[Wallet] ${userId} ${catalogId} ${delta >= 0 ? "+" : ""}${delta} -> ${Next}`);
                return Next;
            }
            Existing = await Wallets.findByUserId(userId, session);
        }

        // For a negative delta the guarded update normally reaches here because the current balance
        // is insufficient. Read only on this error path; successful existing-wallet mutations stay
        // at one database operation.
        const CurrentBalance = Existing?.balances[catalogId] ?? 0;
        throw new InsufficientBalanceError(userId, catalogId, delta, CurrentBalance);
    }

    const Next = Updated.balances[catalogId] ?? 0;
    logger.info(`[Wallet] ${userId} ${catalogId} ${delta >= 0 ? "+" : ""}${delta} -> ${Next}`);
    return Next;
}

// [hardening 2026-07-26] Some reward currencies are not ordinary earned-per-hunt grants — the
// vendored 1.12 `progression_config.json` (the same file GET /progression/config serves, already
// used for rank curves in controllers/progression.ts) models CURRENCY_PJM_PRESTIGE_FILLED
// ("Aether Hearts") explicitly as a PER-LEVEL claim reward on the PrestigeTrack_Weapon_* tracks:
// each track carries `prestige.xp_per_level` and `prestige.free_rewards.stacked_items`, i.e.
// "every N progress on this track banks one reforge level, each level pays out this reward."
// (CURRENCY_PJM_PRESTIGE_EMPTY / "Aether Shards" has no such entry anywhere in this file — it is
// an ordinary earned currency, confirmed granted alongside Rams/Merit in real hunt-completion
// [INV-CAP] captures with no cost attached, and is deliberately left ungated here.)
//
// Investigation (2026-07-26, reforge/cell-fuse duplication report): no reforge transaction has
// ever been implemented server-side (see Progress/20_REFORGE.md — "no complete reforge
// transaction exists", "Not implemented: Atomic cost + reset + prestige increment transaction").
// Every real [INV-CAP] capture of a CURRENCY_PJM_PRESTIGE_FILLED grant carries `removeStacked=[]`
// - there has never been a cost tied to it. Whatever client action requests this reward therefore
// succeeded unconditionally and unlimited times (10 activations -> 10x the grant, confirmed by
// the user). This closes that at the one choke point every such grant must pass through
// regardless of which upstream action/endpoint asks for it: crediting a gated reward currency now
// requires atomically consuming real banked progress on the track(s) configured to pay it out, in
// the SAME transaction as the credit. Once consumed, progress is gone — repeating the same action
// with no further hunts played correctly fails with InsufficientPrestigeProgressError.
//
// The request has no way to say which specific weapon was reforged (no reforge endpoint/contract
// has ever been captured from real traffic), so this cannot attribute consumption to one exact
// weapon. It instead enforces the account-wide invariant that actually matters for closing the
// dupe: you cannot receive more of a gated reward than you have collectively banked, draining
// whichever eligible tracks have progress, in a fixed order, until the requested amount is
// covered or rejected.
type PrestigeRewardSource = { progressionId: string; xpPerLevel: number; rewardQuantityPerLevel: number };

function BuildPrestigeRewardSources(): Map<string, PrestigeRewardSource[]> {
    const ByRewardCatalogId = new Map<string, PrestigeRewardSource[]>();
    const Paths: any[] = loadGameData<any>("progression_config.json")?.payload?.paths ?? [];

    for (const Path of Paths) {
        const ProgressionId = Path?.progression_id;
        const XpPerLevel = Number(Path?.prestige?.xp_per_level);
        const RewardItems: any[] = Path?.prestige?.free_rewards?.stacked_items ?? [];
        if (typeof ProgressionId !== "string" || !Number.isFinite(XpPerLevel) || XpPerLevel <= 0) continue;

        for (const Reward of RewardItems) {
            const RewardCatalogId = Reward?.catalog_id;
            const RewardQuantityPerLevel = Number(Reward?.quantity);
            if (typeof RewardCatalogId !== "string" || !Number.isFinite(RewardQuantityPerLevel) || RewardQuantityPerLevel <= 0) continue;

            const List = ByRewardCatalogId.get(RewardCatalogId) ?? [];
            List.push({ progressionId: ProgressionId, xpPerLevel: XpPerLevel, rewardQuantityPerLevel: RewardQuantityPerLevel });
            ByRewardCatalogId.set(RewardCatalogId, List);
        }
    }

    return ByRewardCatalogId;
}

// Built on first use, so importing the wallet does not need game data.
let PrestigeSourcesCache: Map<string, PrestigeRewardSource[]> | undefined;
function PrestigeSourcesByRewardCatalogId(): Map<string, PrestigeRewardSource[]> {
    return PrestigeSourcesCache ??= BuildPrestigeRewardSources();
}

export class InsufficientPrestigeProgressError extends Error {
    constructor(userId: string, catalogId: string, requestedQuantity: number, availableQuantity: number) {
        super(`Insufficient banked prestige: user ${userId} requested ${requestedQuantity} of ${catalogId} but only ${availableQuantity} banked across eligible tracks`);
        this.name = "InsufficientPrestigeProgressError";
    }
}

// Consumes real banked PrestigeTrack_Weapon_* progress to fund a grant of `catalogId`. A no-op
// for any catalogId that isn't a configured prestige-claim reward (i.e. every other currency,
// including Aether Shards, is unaffected). Throws InsufficientPrestigeProgressError — aborting
// the caller's whole transaction, same as InsufficientBalanceError does for an ordinary overspend
// - if the account has not banked enough progress to justify the requested quantity.
async function SpendBankedPrestigeForReward(userId: string, catalogId: string, quantity: number, session?: ClientSession): Promise<void> {
    const Sources = PrestigeSourcesByRewardCatalogId().get(catalogId);
    if (Sources == undefined || Sources.length === 0 || !Number.isFinite(quantity) || quantity <= 0) return;

    let Remaining = quantity;
    const Spends: { progressionId: string; amount: number }[] = [];
    let TotalAvailable = 0;

    for (const Source of Sources) {
        const Track = await GetRepositories().progressionTracks.get(userId, Source.progressionId, session);
        const BankedLevels = Math.floor((Track?.progress ?? 0) / Source.xpPerLevel);
        const AvailableFromSource = BankedLevels * Source.rewardQuantityPerLevel;
        TotalAvailable += AvailableFromSource;

        if (Remaining <= 0 || AvailableFromSource <= 0) continue;

        // Only ever spend in whole multiples of this source's payout rate, so its granularity is
        // respected exactly (every known PrestigeTrack_Weapon_* pays 1:1, so this is a plain
        // per-unit spend in practice; a hypothetical future source with a different rate that
        // can't cleanly cover the remainder is simply skipped rather than mis-accounted).
        const UnitsToTake = Math.min(Remaining, AvailableFromSource);
        const LevelsToSpend = UnitsToTake / Source.rewardQuantityPerLevel;
        if (!Number.isInteger(LevelsToSpend)) continue;

        Spends.push({ progressionId: Source.progressionId, amount: LevelsToSpend * Source.xpPerLevel });
        Remaining -= LevelsToSpend * Source.rewardQuantityPerLevel;
    }

    if (Remaining > 0) {
        logger.warn(`[Prestige] ${userId} rejected: requested ${quantity} of ${catalogId}, only ${TotalAvailable} banked across [${Sources.map((s) => s.progressionId).join(", ")}]`);
        throw new InsufficientPrestigeProgressError(userId, catalogId, quantity, TotalAvailable);
    }

    for (const Spend of Spends) {
        const Updated = await GetRepositories().progressionTracks.spend(userId, Spend.progressionId, Spend.amount, session);
        if (Updated == undefined) {
            // Another concurrent claim drained this track between our read above and this write.
            // Mongo will surface this as a write conflict on the session and retry the whole
            // transaction callback (see MongoUnitOfWork's doc comment) - but if it doesn't (e.g.
            // the track was read outside a fully consistent snapshot), fail loudly rather than
            // credit a reward whose backing progress was not actually, atomically consumed.
            logger.error(`[Prestige] ${userId} spend of ${Spend.amount} on ${Spend.progressionId} lost a race after being counted as available - rejecting rather than crediting an unbacked reward`);
            throw new InsufficientPrestigeProgressError(userId, catalogId, quantity, TotalAvailable);
        }
        logger.info(`[Prestige] ${userId} spent ${Spend.amount} progress on ${Spend.progressionId} to fund ${catalogId} reward`);
    }
}

// Applies CURRENCY_* stacked-item deltas from an inventory transaction to the wallet.
// Non-currency stacked items (TOKEN_*, cosmetics, etc.) are left to the inventory layer.
// Accepts an optional session so the currency mutation is part of the caller's transaction.
// Returns the post-transaction balance of every CURRENCY_* catalogId this call touched (added or
// removed), so the caller can report it back to the client immediately instead of the client only
// finding out on its next unrelated GET /inventory or GET /store/balance - the same "tell the
// client what actually happened, right now" fix already applied to non-currency stacked items in
// RunInventoryTransaction (see inventory.ts's BUG D fix comment).
export async function ApplyCurrencyDeltas(userId: string, adds: any[], removes: any[], session?: ClientSession): Promise<Record<string, number>> {
    const TouchedBalances: Record<string, number> = {};
    if (!userId || userId === NO_PLAYER_SENTINEL) return TouchedBalances;

    for (const Item of (adds ?? [])) {
        if (typeof Item?.catalogId === "string" && Item.catalogId.startsWith("CURRENCY_")) {
            const Quantity = Number(Item.quantity ?? 0);
            await SpendBankedPrestigeForReward(userId, Item.catalogId, Quantity, session);
            TouchedBalances[Item.catalogId] = await AddCurrency(userId, Item.catalogId, Quantity, session);
        }
    }
    for (const Item of (removes ?? [])) {
        if (typeof Item?.catalogId === "string" && Item.catalogId.startsWith("CURRENCY_")) {
            // A platinum debit names the AGGREGATE (`id_currency_platinum` -> CURRENCY_PLATINUM is
            // what a store SKU's price resolves to), but the balance lives spread across the
            // per-storefront buckets - see platinumWallet.ts. Resolve the debit into real per-bucket
            // deltas here rather than $inc'ing an aggregate field that no grant path ever fills.
            // Every other currency keeps the plain one-field path unchanged.
            if (Item.catalogId === PLATINUM_AGGREGATE_ID) {
                Object.assign(TouchedBalances, await SpendPlatinum(userId, Number(Item.quantity ?? 0), session));
                continue;
            }
            TouchedBalances[Item.catalogId] = await AddCurrency(userId, Item.catalogId, -Number(Item.quantity ?? 0), session);
        }
    }
    return TouchedBalances;
}

// Debits `amount` of platinum across the buckets that actually hold it, then reports the new
// aggregate (plus each touched bucket) so the client's next read and this response agree. Throws the
// same InsufficientBalanceError every other overspend raises - the store controller already maps it
// to a 402, so no caller needs a platinum-specific branch.
async function SpendPlatinum(userId: string, amount: number, session?: ClientSession): Promise<Record<string, number>> {
    const Touched: Record<string, number> = {};
    const Requested = Math.trunc(Number(amount) || 0);
    if (Requested <= 0) return Touched;

    const Wallet = await GetWallet(userId, session);
    const Plan = ResolvePlatinumSpend(Wallet, Requested);
    if (!Plan.ok) {
        logger.warn(`[Wallet] ${userId} platinum debit rejected: requested ${Plan.requested}, holds ${Plan.available} across all buckets`);
        throw new InsufficientBalanceError(userId, PLATINUM_AGGREGATE_ID, -Requested, Plan.available);
    }

    for (const Delta of Plan.deltas) {
        Touched[Delta.catalogId] = await AddCurrency(userId, Delta.catalogId, Delta.delta, session);
    }

    const Remaining = SumPlatinum({ ...Wallet, ...Touched });
    Touched[PLATINUM_AGGREGATE_ID] = Remaining;
    logger.info(`[Wallet] ${userId} platinum -${Requested} -> ${Remaining} (buckets: ${Plan.deltas.map((d) => `${d.catalogId}${d.delta}`).join(" ")})`);
    return Touched;
}

// Projects the wallet's CURRENCY_* balances into an inventory stackedItems array. The 1.12 client reads
// Slayer's Path merits (and other currencies) via AArchonInventory::GetInventoryCurrencyAmount — i.e. the
// INVENTORY representation, not /store/balance. Replaces the quantity of any existing CURRENCY_* entry with
// the same catalogId; appends the rest. The wallet stays the single persistent authority — this is a
// projected response only (we never write these back into the wallet from here).
export async function MergeWalletIntoStacked(userId: string, stackedItems: any[]): Promise<any[]> {
    const Wallet = await GetWallet(userId);
    const Out: any[] = Array.isArray(stackedItems) ? stackedItems.slice() : [];
    for (const [Cid, Amt] of Object.entries(Wallet)) {
        const Idx = Out.findIndex((it) => it && it.catalogId === Cid);
        if (Idx >= 0) Out[Idx] = { ...Out[Idx], catalogId: Cid, quantity: Amt };
        else Out.push({ catalogId: Cid, quantity: Amt });
    }
    return Out;
}

// Shared /store/balance-style currency dict builder from the wallet (both CURRENCY_X and id_currency_x forms).
// Used by both /store/balance and /store/reconcile so every path reports the same balances.
export async function BuildBalanceDict(userId: string, base: Record<string, number> = {}): Promise<Record<string, number>> {
    const Wallet = await GetWallet(userId);
    return ProjectBalances(Wallet, base);
}
