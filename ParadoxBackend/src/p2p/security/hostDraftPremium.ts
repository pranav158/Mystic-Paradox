// [2026-10-15] The daily premium draft token a player-hosted runtime may grant (hostGrantPolicy.ts HOST_DRAFT_PREMIUM_ID). Why a host
// asks for it, and why the rule is narrow, is in hostGrantPolicy.ts. This module decides the one case the policy leaves open:
//   - the body adds the token once, as a whole token (quantity 1), and nothing else of its kind;
//   - [2026-10-16] for EVERY account. Until then only holders of the season's premium pass were granted it (NO_PREMIUM_PASS),
//     but the game's bounty component grants it to every player on the daily draft (the dedicated path does too), and the refusal
//     left a new player's bounty load unfinished: the hub's player-data timeout sent new players back to the menu
//     ~120 s after Ramsgate ([HostGrantDeny] HUNT_PASS draftPremium=NO_PREMIUM_PASS). The pass is still read
//     (`holdsPremiumPass`, for the log) but no longer required;
//   - the balance the player ends with, after this transaction's removals, stays at or below HOST_DRAFT_PREMIUM_BALANCE_CAP.
// [2026-10-16] There is no once-per-day rule any more. It counted UTC days from 00:00, but the game's daily
// period ends at 17:00 UTC (every bounty_daily cooldown is T17:00:00Z), and the game also re-adds the token itself when a drafted daily
// bounty is lost (UBountyComponent RefundBounties, "Refund premium tokens") and drafts again. Both legitimate second grants were refused
// (ALREADY_GRANTED_TODAY), and a refused hub transaction during a player's inventory load is the known return-to-menu trigger. The cap
// alone bounds it: the token is hidden and the automatic draft spends it within a second, and the daily challenge's reward is still
// paid once per game day ([2026-10-17] from 17:00 UTC) by the bounty record (dailyRewardCreditedOn, bountyState.ts). The day is no longer written, so the grant
// no longer touches the account's bounty record (one versioned write less beside the hub's own bounty saves).
// The decision is taken twice: before the transaction from a read (for an early refusal), and again inside the inventory
// transaction from the session's own reads, which is the one that counts (p2pInventoryAuthorization.ts).
// A replay of an accepted transaction (same id, same body) never reaches this decision: the ledger returns its stored result
// (RunInventoryTransaction), and the precheck skips the decision for it (p2pInventoryAuthorization.ts). Pure except for the reads.

import type { EntitlementRecord, InventoryRecord } from "../../persistence/mapping/domainTypes";
import type { RepositoryProvider } from "../../persistence";
import { ACTIVE_HUNTPASS_PROGRESSION_ID } from "../../controllers/progression";
import { tryLoadGameData } from "../../gameData/loader";
import { BodyAddsHostDraftPremium, HOST_DRAFT_PREMIUM_BALANCE_CAP, HOST_DRAFT_PREMIUM_ID, IsHostDraftPremiumAdd } from "./hostGrantPolicy";
import type { ClientSession } from "mongodb";

/** What the decision needs from the player's state. `balanceBefore` is undefined when the inventory could not be read. */
export interface HostDraftPremiumInputs {
    balanceBefore: number | undefined;
    /** The season's premium gating entitlement, from game-data (undefined when the data does not name one). */
    passEntitlement: string | undefined;
    /** Whether the player holds `passEntitlement`. */
    holdsPremiumPass: boolean;
}

export interface HostDraftPremiumDecision {
    allowed: boolean;
    /** OVER_BALANCE_CAP, ONE_WHOLE_TOKEN_PER_TRANSACTION, BALANCE_UNREADABLE or WITHIN_BALANCE_CAP ([2026-10-16] NO_PREMIUM_PASS,
     *  NO_PASS_ENTITLEMENT_DATA and ALREADY_GRANTED_TODAY are gone: every account may have the token, whenever its balance allows). */
    reason: string;
    balanceBefore?: number;
    balanceAfter?: number;
}

function PassEntitlementIn(progression: any): string | undefined {
    const Path = (progression?.payload?.paths ?? []).find((entry: any) => entry?.progression_id === ACTIVE_HUNTPASS_PROGRESSION_ID);
    const Name = Path?.premium_gating_entitlement;
    return typeof Name === "string" && Name.length > 0 ? Name : undefined;
}

let CachedPassEntitlement: { value: string | undefined } | undefined;

/**
 * The premium gating entitlement of the active Hunt Pass season (undefined when game-data does not name one). Without an argument the
 * game data is read once and kept; an argument (tests) is read as given, and null names no pass.
 */
export function ActivePremiumPassEntitlement(progression?: any): string | undefined {
    if (progression !== undefined) return PassEntitlementIn(progression);
    CachedPassEntitlement ??= { value: PassEntitlementIn(tryLoadGameData<any>("progression_config.json")) };
    return CachedPassEntitlement.value;
}

/** The stacked quantity of `catalogId` in an inventory record; undefined when the stored blob cannot be read as a stack list. */
export function StackedBalanceOf(inventory: Pick<InventoryRecord, "stackedItems"> | undefined, catalogId: string): number | undefined {
    if (inventory == undefined) return 0;
    let Items: unknown;
    try {
        Items = JSON.parse(inventory.stackedItems);
    } catch {
        return undefined;
    }
    if (!Array.isArray(Items)) return undefined;
    let Total = 0;
    for (const Item of Items) {
        if (Item?.catalogId !== catalogId) continue;
        if (!Number.isSafeInteger(Item.quantity) || Item.quantity < 0) return undefined;
        Total += Item.quantity;
    }
    return Total;
}

/** Whether the entitlements record holds `name`. */
export function HoldsEntitlementNamed(entitlements: Pick<EntitlementRecord, "entitlements"> | undefined, name: string | undefined): boolean {
    if (name == undefined) return false;
    return (entitlements?.entitlements ?? []).some((entry) => entry.name === name);
}

/**
 * The inputs for one player's transaction. `session` makes the reads part of the inventory transaction; without it they are read
 * as the repositories read them outside one.
 */
export async function ReadHostDraftPremiumInputs(
    repos: Pick<RepositoryProvider, "inventories" | "entitlements">,
    userId: string,
    characterId: string,
    session?: ClientSession
): Promise<HostDraftPremiumInputs> {
    const inventory = await repos.inventories.findByCharacterId(characterId, session);
    const entitlements = await repos.entitlements.findByUserId(userId, session);
    const passEntitlement = ActivePremiumPassEntitlement();
    return {
        balanceBefore: StackedBalanceOf(inventory, HOST_DRAFT_PREMIUM_ID),
        passEntitlement,
        holdsPremiumPass: HoldsEntitlementNamed(entitlements, passEntitlement),
    };
}

/**
 * The decision for a host-originated body. Undefined when the body does not add the token at all (nothing to decide). Otherwise
 * allowed only when every condition in the header holds; the balance after the transaction is the balance before, plus the one
 * token, minus any removal of the same token in the body.
 */
export function DecideHostDraftPremium(body: any, inputs: HostDraftPremiumInputs): HostDraftPremiumDecision | undefined {
    if (!BodyAddsHostDraftPremium(body)) return undefined;
    const Adds = (body.addStackedItems as any[]).filter((item) => item?.catalogId === HOST_DRAFT_PREMIUM_ID);
    if (Adds.length !== 1 || !IsHostDraftPremiumAdd(Adds[0])) return { allowed: false, reason: "ONE_WHOLE_TOKEN_PER_TRANSACTION" };
    if (inputs.balanceBefore === undefined) return { allowed: false, reason: "BALANCE_UNREADABLE" };

    const Removed = (Array.isArray(body?.removeStackedItems) ? body.removeStackedItems : [])
        .filter((item: any) => item?.catalogId === HOST_DRAFT_PREMIUM_ID)
        .reduce((total: number, item: any) => total + (Number.isSafeInteger(item?.quantity) && item.quantity > 0 ? item.quantity : 0), 0);
    const Figures = { balanceBefore: inputs.balanceBefore, balanceAfter: inputs.balanceBefore - Removed + 1 };

    // [2026-10-16] No premium-pass condition and no once-per-day rule any more (see the header): only the balance cap. A token
    // spent and refilled in one transaction (the game's refund and re-draft) ends at the cap and is allowed.
    if (Figures.balanceAfter > HOST_DRAFT_PREMIUM_BALANCE_CAP) return { allowed: false, reason: "OVER_BALANCE_CAP", ...Figures };
    return { allowed: true, reason: "WITHIN_BALANCE_CAP", ...Figures };
}
