// [2026-10-11 P2P on 1.14.7, plan 39_ §13.1 B9 / decision 1 of 39_ §13] Item classes a player host may never grant.
//
// The P2P inventory exception (p2pInventoryAuthorization.ts) lets the host's game server post the native loot
// transaction of an admitted participant, and nothing limited what that transaction contained: a modified host could
// mint Platinum (ApplyCurrencyDeltas credits any CURRENCY_* add), seasonal coins or any cosmetic for its roster. These
// classes are refused outright, whatever the quantity; per-hunt caps for everything else and the behaviour risk meter
// come next (in shadow mode first).
//
// The classes were read from the 1.14.7 catalogue export (Items_Analysis/catalog_1_14_7.jsonl, 7,318 items, CL 647472):
//   PREMIUM_CURRENCY  CURRENCY_PLATINUM and its 12 storefront buckets (tags currency+platinum), the DEBUG_* grants
//                     ("Debug give yourself 10K Plat", "... 100K Notes").
//   HUNT_PASS         seasonal currencies (tag seasonal_currency: CURRENCY_S13..S20_COIN, CURRENCY_SEASONAL_COIN - the
//                     Reward Cache coin -, CURRENCY_REWARDCACHE, CURRENCY_S13_DAILY), CURRENCY_PRESTIGE (Vault Coins),
//                     GrantProgressItem_HuntPass, TOKEN_HUNTPASS_* / TOKEN_HUNT_PASS_*, the *_DRAFT_PREMIUM challenge
//                     tokens, CONTAINER_CORE_PRESTIGE_* (pass prestige cores), and every prestige reward currency of
//                     game-data/progression_config.json (prestige free/premium rewards, e.g. Aether Hearts).
//   COSMETIC          DYE_ (475), EM_ emotes (240), EJ_ emoji (102), TITLE_ (233), BNC_/BN_ banner customization (436),
//                     AC_ accessories (24), GD_ gliders (27), CC_ character customization (23), TY_ toys (33), MP_
//                     companions, CHANGE_APPEARANCE_TOKEN, the Transmog Stone (CURRENCY_TOKEN_TRANSMOG), and the promo /
//                     founder / style caches (CONTAINER_PROMO_*, CONTAINER_1P_*, CONTAINER_CORE_FOUNDER_*,
//                     CONTAINER_CORE_SLAYERPACK: tags stylehunter/founder). Also any id whose game-data storage policy
//                     tags name one of these classes.
//   ENTITLEMENT       entitlement names (lower case: ent_*, *_premium, pass_*, eventpass_*, minipass_*,
//                     exchange_slot_*, and every name game-data grants or gates on). An inventory transaction cannot
//                     grant an entitlement, but a host naming one must not even write it into the inventory blob.
// Not denied: Rams, materials (BREAK_*), Aether Shards, cells, weapon parts, equipment, consumables, tokens of the hunt
// itself (kill counts, daily draft tokens), event currencies - the loot a hunt legitimately produces ([GrantMon]).
// Removals: a host may not take other premium currency or an entitlement away. Platinum is the exception (owner decision,
// 14 Oct): a host may SPEND a player's Platinum in a hunt and in a realm's Ramsgate hub (a Platinum-priced purchase). The
// removal is a stacked removal of a Platinum id only (IsPlatinumSpendItem); the wallet refuses it past the balance, the
// transaction is logged as a spend (diagnostics/economyLedgerMonitor.ts), and a Training hub still refuses every spend
// (HostGrantDenial). Granting Platinum stays denied everywhere.
//
// [2026-10-13 realms S3] One exception to the HUNT_PASS class: CURRENCY_SEASONAL_COIN as the claim-funded season-challenge
// grant (IsClaimFundedCoinGrant below). A dedicated server pays a completed season challenge by claiming it (bounty save,
// claimed: true) and posting +N coins; the host does the same in a Paradox-account realm (SteamDocs/
// PARADOX_REALMS_PLAN_2026_10_13.md section 4.1). This policy only lets that one shape through - the wallet decides whether
// it is paid: ApplyCurrencyDeltas funds it from exactly one claimed, not-yet-credited weekly challenge (controllers/
// challengeRewards.ts, once per claim, recorded on the claim in the same transaction) and otherwise applies the prestige
// gate, which refuses it. Every other HUNT_PASS item, cosmetics, premium currency and entitlements stay denied.
// [2026-10-14 realms S4] A second exception: a prestige-gated reward (wallet.ts IsPrestigeGatedReward: the Aetherheart
// CURRENCY_PJM_PRESTIGE_FILLED, CURRENCY_PRESTIGE and the season coins of the prestige paths). The wallet pays one only from
// a banked prestige level, each level once, inside the same transaction, and refuses the whole transaction otherwise
// (SpendBankedPrestigeForReward). IsPrestigeFundedGrant lets exactly that shape through, in a hunt and in a realm's Ramsgate
// hub, and the wallet decides; a Training hub keeps its blanket refusal (HostGrantDenial).
//
// routes/inventory.ts turns the claim funding (and the 1.5 s wait for the claim) on for module-authorized transactions
// too (FundsChallengeRewards, 13 Oct), so such a grant is paid exactly as from a dedicated server.

import { IsPlatinumCatalogId } from "../../platinumWallet";
import { CHALLENGE_REWARD_CURRENCIES, MAX_CHALLENGE_REWARD_PER_CLAIM } from "../../bountyState";
import { IsPrestigeGatedReward } from "../../controllers/wallet";
import { tryLoadGameData } from "../../gameData/loader";
import { InventoryBodyHasGrantOrSpend } from "../../validation";
import type { P2PHuntSessionRecord } from "../persistence";
import { IsRealmHubSession } from "./hubAuthorization";

// [2026-10-15] One HUNT_PASS-class exception: the daily premium draft token (TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM). The game's bounty
// component grants one on the daily draft (UBountyComponent::ServerInitializeBounties, +1, and -1 when a premium draft is chosen), so a
// realm's Ramsgate hub asks for it on every daily reset. [2026-10-16] A host may grant it to every account (until then only to
// premium pass holders, which kicked new players ~120 s after Ramsgate), and only up to the balance cap below (no once-per-day rule
// any more: the game's own 17:00 UTC reset and its refund re-adds were refused by it)
// (hostDraftPremium.ts decides). The
// catalogue gives it no cap (maxQuantity 0 in catalog_1_14_7.jsonl and inventory_storage_policy.json) and the dedicated path enforces
// none beyond the 1e9 per-grant validation, so the cap is the owner's fallback of 1. Only this exact shape is exempt: the id, a
// stacked add, a quantity of 1, and one such add per transaction. Every other HUNT_PASS item, and the token in any other operation,
// stays refused.
export const HOST_DRAFT_PREMIUM_ID = "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM";
export const HOST_DRAFT_PREMIUM_BALANCE_CAP = 1;

// [2026-10-16] One COSMETIC-class exception: the game's own starter grant. On every hub arrival of an account that lacks them, the hub
// posts one transaction (runtime [GrantTrace] source="default") with these 13 cosmetics, TOKEN_OB_PROGRESSION and 4 daily + 4 weekly
// draft tokens; every account outside realms holds them. Refusing it (403 [HostGrantDeny] COSMETIC) was harmless at low level, but a
// player at the hidden ExperienceTrack_PlayerLevel rank 20 is sent back to the login screen by it: the hub's inventory failure handler
// (FUN_141CAF150, "Failed to retrieve player inventory attempting to return to main menu", reason InventoryQueryFail) is bound while that
// player's inventory load runs, and a failed transaction calls it (SteamDocs/RAMSGATE_KICK_AFTER_TESTER_MAX_2026_10_16.md; the hub's
// [ReturnToMenuTrace], runtime 0.2.143). Only these exact ids, one each, as an add; every other cosmetic stays refused.
export const HOST_STARTER_COSMETIC_IDS: ReadonlySet<string> = new Set([
    "EM_INTRO_GENERIC_001", "EM_INTRO_GENERIC_002", "EM_INTRO_GENERIC_003", "TITLE_BLANK", "EJ_SYSTEM_TYPING",
    "EJ_PLAYER_BOSUN_JOY", "EJ_PLAYER_KAT_PRAY", "EJ_PLAYER_MOYRA_MUSCLE", "EJ_PLAYER_GREGARIO_QUESTION", "EJ_PLAYER_MIDDLEMAN_HMM",
    "EJ_PLAYER_PRIYANI_WINK", "EJ_PLAYER_ZAI_ANGRY", "EJ_PLAYER_ZAI_SWEAT"
]);

/** An add of one starter cosmetic (the exact id, quantity 1, or no quantity on an instanced add). */
export function IsHostStarterCosmeticAdd(item: any): boolean {
    return typeof item?.catalogId === "string" && HOST_STARTER_COSMETIC_IDS.has(item.catalogId)
        && (item.quantity === undefined || item.quantity === 1);
}

/** A stacked add of exactly the draft premium token, one whole token (the id is matched exactly, case included). */
export function IsHostDraftPremiumAdd(item: any): boolean {
    return item?.catalogId === HOST_DRAFT_PREMIUM_ID && item.quantity === 1;
}

/** Whether a host-originated transaction body adds the draft premium token at all (any quantity, any list). */
export function BodyAddsHostDraftPremium(body: any): boolean {
    return Array.isArray(body?.addStackedItems) && body.addStackedItems.some((item: any) => item?.catalogId === HOST_DRAFT_PREMIUM_ID);
}

/**
 * What hostDraftPremium.ts has allowed for the body, before the static policy runs. `draftPremium: true` lets the body's one whole
 * draft premium add through (the balance and the pass were checked for this player). Absent or false keeps the class deny list as it was.
 */
export interface HostGrantAllowances {
    draftPremium?: boolean;
}

export type HostGrantDenyClass = "PREMIUM_CURRENCY" | "HUNT_PASS" | "COSMETIC" | "ENTITLEMENT";

export interface HostGrantCatalog {
    /** Catalogue tags of an id, from game-data/inventory_storage_policy.json. */
    tagsOf(catalogId: string): readonly string[] | undefined;
    /** Prestige reward currencies of game-data/progression_config.json (free and premium rewards). */
    prestigeRewardIds: ReadonlySet<string>;
    /**
     * Whether the wallet's prestige gate pays this id (wallet.ts IsPrestigeGatedReward). Only such an id may be granted by a
     * host, and only because that gate funds it in the same transaction.
     */
    isPrestigeGated(catalogId: string): boolean;
    /** Entitlement names game-data grants or gates on. */
    entitlementNames: ReadonlySet<string>;
}

export interface HostGrantViolation {
    catalogId: string;
    deniedClass: HostGrantDenyClass;
    field: "addStackedItems" | "addInstancedItems" | "removeStackedItems" | "removeInstancedItems";
}

const HUNT_PASS_IDS = new Set(["CURRENCY_SEASONAL_COIN", "CURRENCY_REWARDCACHE", "CURRENCY_PRESTIGE", "GRANTPROGRESSITEM_HUNTPASS"]);
const HUNT_PASS_PATTERNS = [/^CURRENCY_S\d+_(COIN|DAILY)$/, /^TOKEN_HUNT_?PASS/, /_DRAFT_PREMIUM$/, /^CONTAINER_CORE_PRESTIGE_/];
const COSMETIC_PREFIXES = ["DYE_", "EM_", "EJ_", "TITLE_", "BNC_", "BN_", "AC_", "GD_", "CC_", "TY_", "MP_",
    "CONTAINER_PROMO_", "CONTAINER_1P_", "CONTAINER_CORE_FOUNDER_"];
const COSMETIC_IDS = new Set(["CHANGE_APPEARANCE_TOKEN", "CURRENCY_TOKEN_TRANSMOG", "CONTAINER_CORE_SLAYERPACK"]);
const COSMETIC_TAGS = new Set(["dye", "emote", "emoji", "title", "bannercustomization", "banner", "accessory", "glider",
    "toy", "companion", "stylehunter", "founder", "transmogtoken"]);
const ENTITLEMENT_PATTERNS = [/^(ent|pass|eventpass|minipass|exchange_slot)_[a-z0-9_.-]+$/, /^[a-z0-9_.-]+_premium$/];

/** id_currency_platinum (the store/wallet spelling) and CURRENCY_PLATINUM are the same currency. */
function CanonicalId(catalogId: string): string {
    const trimmed = catalogId.trim();
    return /^id_currency_/i.test(trimmed) ? `CURRENCY_${trimmed.slice("id_currency_".length)}`.toUpperCase() : trimmed;
}

export function ClassifyHostGrant(catalogId: string, catalog: HostGrantCatalog = DefaultHostGrantCatalog()): HostGrantDenyClass | undefined {
    if (typeof catalogId !== "string" || catalogId.trim().length === 0) return undefined;
    const id = CanonicalId(catalogId);
    const upper = id.toUpperCase();
    const tags = new Set((catalog.tagsOf(id) ?? []).map((tag) => tag.toLowerCase()));
    if (upper.startsWith("CURRENCY_PLATINUM") || upper.startsWith("DEBUG_") || IsPlatinumCatalogId(id) || tags.has("platinum")) {
        return "PREMIUM_CURRENCY";
    }
    if (HUNT_PASS_IDS.has(upper) || HUNT_PASS_PATTERNS.some((pattern) => pattern.test(upper)) ||
        catalog.prestigeRewardIds.has(id) || tags.has("seasonal_currency")) {
        return "HUNT_PASS";
    }
    if (COSMETIC_IDS.has(upper) || COSMETIC_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
        [...tags].some((tag) => COSMETIC_TAGS.has(tag))) {
        return "COSMETIC";
    }
    if (catalog.entitlementNames.has(id.toLowerCase()) || ENTITLEMENT_PATTERNS.some((pattern) => pattern.test(id))) {
        return "ENTITLEMENT";
    }
    return undefined;
}

/**
 * [2026-10-13 realms S3] A stacked add the wallet can fund from a season-challenge claim: the exact catalog id of
 * CHALLENGE_REWARD_CURRENCIES (case-sensitive, as ApplyCurrencyDeltas matches it; any other spelling stays HUNT_PASS) and a
 * whole quantity of 1..MAX_CHALLENGE_REWARD_PER_CLAIM, the most one claim may fund (a bigger one could never be funded).
 */
export function IsClaimFundedCoinGrant(item: any): boolean {
    return typeof item?.catalogId === "string" && CHALLENGE_REWARD_CURRENCIES.has(item.catalogId)
        && typeof item.quantity === "number" && Number.isSafeInteger(item.quantity)
        && item.quantity > 0 && item.quantity <= MAX_CHALLENGE_REWARD_PER_CLAIM;
}

/**
 * [2026-10-14 realms S4] A stacked add of a prestige-gated reward the wallet's prestige gate can fund: a whole, positive
 * quantity of an id the gate pays (catalog.isPrestigeGated), and a HUNT_PASS-class id only - a gated id classed otherwise
 * (PREMIUM_CURRENCY, COSMETIC, ENTITLEMENT) stays denied. Whether banked prestige covers the quantity is the wallet's call,
 * made in the same transaction; an unfunded one aborts the whole transaction there (InsufficientPrestigeProgressError).
 */
export function IsPrestigeFundedGrant(item: any, catalog: HostGrantCatalog = DefaultHostGrantCatalog()): boolean {
    return typeof item?.catalogId === "string" && catalog.isPrestigeGated(item.catalogId)
        && typeof item.quantity === "number" && Number.isSafeInteger(item.quantity) && item.quantity > 0
        && ClassifyHostGrant(item.catalogId, catalog) === "HUNT_PASS";
}

/** Every forbidden entry of a host-originated inventory transaction body (empty when it may proceed). */
/** A stacked removal of Platinum (any bucket, or the aggregate id a store price names): a spend, not a deny-listed removal. */
export function IsPlatinumSpendItem(catalogId: string): boolean {
    if (typeof catalogId !== "string") return false;
    const id = CanonicalId(catalogId);
    return id === "CURRENCY_PLATINUM" || IsPlatinumCatalogId(id);
}

export function HostGrantViolations(body: any, catalog: HostGrantCatalog = DefaultHostGrantCatalog(), allowances: HostGrantAllowances = {}): HostGrantViolation[] {
    const violations: HostGrantViolation[] = [];
    // One whole draft premium token per transaction: a body that names it twice gets no exemption at all.
    const DraftPremiumAddCount = Array.isArray(body?.addStackedItems)
        ? body.addStackedItems.filter((item: any) => item?.catalogId === HOST_DRAFT_PREMIUM_ID).length : 0;
    const scan = (field: HostGrantViolation["field"], classes: ReadonlySet<HostGrantDenyClass> | undefined) => {
        const items = body?.[field];
        if (!Array.isArray(items)) return;
        for (const item of items) {
            const catalogId = item?.catalogId;
            if (typeof catalogId !== "string") continue;
            if (field === "addStackedItems" && (IsClaimFundedCoinGrant(item) || IsPrestigeFundedGrant(item, catalog))) continue;
            if (field === "addStackedItems" && allowances.draftPremium === true && DraftPremiumAddCount === 1 && IsHostDraftPremiumAdd(item)) continue;
            if (field === "removeStackedItems" && IsPlatinumSpendItem(catalogId)) continue;
            if ((field === "addStackedItems" || field === "addInstancedItems") && IsHostStarterCosmeticAdd(item)) continue;
            const deniedClass = ClassifyHostGrant(catalogId, catalog);
            if (deniedClass != undefined && (classes == undefined || classes.has(deniedClass))) {
                violations.push({ catalogId, deniedClass, field });
            }
        }
    };
    scan("addStackedItems", undefined);
    scan("addInstancedItems", undefined);
    const removalClasses = new Set<HostGrantDenyClass>(["PREMIUM_CURRENCY", "ENTITLEMENT"]);
    scan("removeStackedItems", removalClasses);
    scan("removeInstancedItems", removalClasses);
    return violations;
}

/**
 * Why a host-originated inventory transaction is refused, or undefined: any forbidden-class entry, and - in a no-reward
 * session (guardCompletionMode NO_COMPLETION, the Training Grounds) - any grant or spend at all (saves stay allowed).
 *
 * [2026-10-14 realms S4] A realm hub carries NO_COMPLETION too (it produces no hunt evidence and never completes), but the
 * realm's Ramsgate is not a no-reward session: crafting, the reforge cost, store spends and claim-funded coins happen there
 * (hub design section 7.3). It keeps the class deny list above and the claim-funded coin rule, exactly as a hunt.
 * [2026-10-16] So does the realm's Training hub: the Training Grounds tutorial pays its quest rewards there (the trainer's
 * "reach me" step, 100 Rams) and the step does not complete while the reward is refused. Only a session that is not a realm hub - a
 * hosted Training hunt - keeps the blanket refusal.
 */
export function HostGrantDenial(
    hunt: Pick<P2PHuntSessionRecord, "guardCompletionMode" | "sessionKind" | "hubKind"> | undefined,
    body: any,
    catalog: HostGrantCatalog = DefaultHostGrantCatalog(),
    allowances: HostGrantAllowances = {}
): { classes: string[]; violations: HostGrantViolation[]; summary: string } | undefined {
    const RealmHubOfKnownKind = IsRealmHubSession(hunt) && (hunt?.hubKind === "RAMSGATE" || hunt?.hubKind === "TRAINING");
    if (hunt?.guardCompletionMode === "NO_COMPLETION" && !RealmHubOfKnownKind && InventoryBodyHasGrantOrSpend(body)) {
        return { classes: ["NO_REWARD_SESSION"], violations: [], summary: "any grant or spend" };
    }
    const violations = HostGrantViolations(body, catalog, allowances);
    if (violations.length === 0) return undefined;
    const summary = violations.slice(0, 16).map((entry) => `${entry.catalogId}(${entry.deniedClass},${entry.field})`).join(",") +
        (violations.length > 16 ? `,+${violations.length - 16}` : "");
    return { classes: [...new Set(violations.map((entry) => entry.deniedClass))], violations, summary };
}

/** Collects entitlement names from any game-data document: `entitlements` lists and `*_gating_entitlement` fields. */
export function CollectEntitlementNames(document: unknown, into: Set<string> = new Set()): Set<string> {
    const visit = (value: unknown, depth: number) => {
        if (depth > 64 || value == null || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const entry of value) visit(entry, depth + 1);
            return;
        }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (key === "entitlements" && Array.isArray(child)) {
                for (const entry of child) {
                    const name = typeof entry === "string" ? entry
                        : (entry as any)?.name ?? (entry as any)?.entitlement;
                    if (typeof name === "string" && name.length > 0) into.add(name.toLowerCase());
                }
            } else if (/gating_entitlement$/i.test(key) && typeof child === "string" && child.length > 0) {
                into.add(child.toLowerCase());
            }
            visit(child, depth + 1);
        }
    };
    visit(document, 0);
    return into;
}

/** Prestige reward currencies (prestige.free_rewards / premium_rewards stacked items of every progression path). */
export function CollectPrestigeRewardIds(progressionConfig: any): Set<string> {
    const ids = new Set<string>();
    for (const path of progressionConfig?.payload?.paths ?? []) {
        for (const rewards of [path?.prestige?.free_rewards, path?.prestige?.premium_rewards]) {
            for (const item of rewards?.stacked_items ?? []) {
                if (typeof item?.catalog_id === "string" && item.catalog_id.length > 0) ids.add(item.catalog_id);
            }
        }
    }
    return ids;
}

let CachedCatalog: HostGrantCatalog | undefined;

function TryLoad(fileName: string): any {
    try { return tryLoadGameData<any>(fileName); } catch { return undefined; }
}

/** The catalogue view built from game-data on first use; missing files leave only the id rules above. */
export function DefaultHostGrantCatalog(): HostGrantCatalog {
    if (CachedCatalog != undefined) return CachedCatalog;
    const storage = TryLoad("inventory_storage_policy.json");
    const progression = TryLoad("progression_config.json");
    const entitlementNames = new Set<string>();
    for (const fileName of ["progression_config.json", "platinum_store.json", "reward_cache_store.json", "ladyluck_store.json"]) {
        CollectEntitlementNames(fileName === "progression_config.json" ? progression : TryLoad(fileName), entitlementNames);
    }
    const entries: Record<string, { tags?: unknown }> = storage?.entries ?? {};
    CachedCatalog = {
        tagsOf: (catalogId) => {
            const tags = entries[catalogId]?.tags;
            return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : undefined;
        },
        prestigeRewardIds: CollectPrestigeRewardIds(progression),
        // The wallet's own definition (never a copy): what the prestige gate pays is what a host may be granted.
        isPrestigeGated: (catalogId) => IsPrestigeGatedReward(catalogId),
        entitlementNames
    };
    return CachedCatalog;
}
