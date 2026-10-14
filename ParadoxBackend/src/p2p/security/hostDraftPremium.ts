// [2026-10-15] The daily premium draft token a player-hosted runtime may grant (hostGrantPolicy.ts HOST_DRAFT_PREMIUM_ID). Why a host
// asks for it, and why the rule is narrow, is in hostGrantPolicy.ts. This module decides the one case the policy leaves open:
//   - the body adds the token once, as a whole token (quantity 1), and nothing else of its kind;
//   - the player holds the active season's premium pass (the season's premium_gating_entitlement in game-data/progression_config.json);
//   - the balance the player ends with, after this transaction's removals, stays at or below HOST_DRAFT_PREMIUM_BALANCE_CAP;
//   - the account has not had the token host-granted earlier on this UTC day (the game's daily reset is 00:00 UTC). The day is kept
//     on the account's bounty record (dailyPremiumDraftGrantedOn, bountyState.ts), per account and not per character, so a second
//     character cannot repeat it.
// The decision is taken twice: before the transaction from a read (for an early refusal), and again inside the inventory
// transaction from the session's own reads, which is the one that counts (p2pInventoryAuthorization.ts). An accepted grant writes
// today's day to the account record in that same transaction. Two racing grants for one account both read the old day; one commits,
// and the other's write to the same record conflicts, so Mongo retries it and the retry reads today and is refused.
// A replay of an accepted transaction (same id, same body) never reaches this decision: the ledger returns its stored result
// (RunInventoryTransaction), and the precheck skips the decision for it (p2pInventoryAuthorization.ts). Pure except for the reads and
// the one day write.

import type { EntitlementRecord, InventoryRecord } from "../../persistence/mapping/domainTypes";
import type { RepositoryProvider } from "../../persistence";
import { ACTIVE_HUNTPASS_PROGRESSION_ID } from "../../controllers/progression";
import { tryLoadGameData } from "../../gameData/loader";
import { UtcDay, WithDraftPremiumGrantDay } from "../../bountyState";
import { BodyAddsHostDraftPremium, HOST_DRAFT_PREMIUM_BALANCE_CAP, HOST_DRAFT_PREMIUM_ID, IsHostDraftPremiumAdd } from "./hostGrantPolicy";
import type { ClientSession } from "mongodb";

/** What the decision needs from the player's state. `balanceBefore` is undefined when the inventory could not be read. */
export interface HostDraftPremiumInputs {
    balanceBefore: number | undefined;
    /** The season's premium gating entitlement, from game-data (undefined when the data does not name one). */
    passEntitlement: string | undefined;
    /** Whether the player holds `passEntitlement`. */
    holdsPremiumPass: boolean;
    /** The UTC day a host last added this token for the account (dailyPremiumDraftGrantedOn), undefined when never. */
    grantedOnDay: string | undefined;
    /** The UTC day this decision is taken on (YYYY-MM-DD). */
    today: string;
}

export interface HostDraftPremiumDecision {
    allowed: boolean;
    /** NO_PREMIUM_PASS, ALREADY_GRANTED_TODAY, OVER_BALANCE_CAP, ONE_WHOLE_TOKEN_PER_TRANSACTION, BALANCE_UNREADABLE, NO_PASS_ENTITLEMENT_DATA
     *  or PREMIUM_PASS_HELD_WITHIN_CAP_ONCE_PER_DAY. */
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
    repos: Pick<RepositoryProvider, "inventories" | "entitlements" | "bountyStates">,
    userId: string,
    characterId: string,
    session?: ClientSession
): Promise<HostDraftPremiumInputs> {
    const inventory = await repos.inventories.findByCharacterId(characterId, session);
    const entitlements = await repos.entitlements.findByUserId(userId, session);
    const bounty = await repos.bountyStates.get(userId, session);
    const passEntitlement = ActivePremiumPassEntitlement();
    return {
        balanceBefore: StackedBalanceOf(inventory, HOST_DRAFT_PREMIUM_ID),
        passEntitlement,
        holdsPremiumPass: HoldsEntitlementNamed(entitlements, passEntitlement),
        grantedOnDay: bounty?.dailyPremiumDraftGrantedOn,
        today: UtcDay(),
    };
}

/**
 * Writes `day` as the day this account's premium draft token was host-granted. Called with the grant's own session, from the
 * inventory transaction's onGrant, so the day commits with the token or not at all. It is the versioned write FundChallengeReward
 * uses (controllers/challengeRewards.ts), and a missing account record is created. False when the record changed under the write;
 * the caller refuses the grant.
 */
export async function RecordHostDraftPremiumGrant(
    repos: Pick<RepositoryProvider, "bountyStates">,
    userId: string,
    day: string,
    session: ClientSession
): Promise<boolean> {
    const Previous = await repos.bountyStates.get(userId, session);
    const Saved = await repos.bountyStates.saveIfVersion(WithDraftPremiumGrantDay(Previous, userId, day), Previous?.updateVersion, session);
    return Saved !== undefined;
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

    if (inputs.passEntitlement === undefined) return { allowed: false, reason: "NO_PASS_ENTITLEMENT_DATA", ...Figures };
    if (!inputs.holdsPremiumPass) return { allowed: false, reason: "NO_PREMIUM_PASS", ...Figures };
    // [2026-10-15] Once per account per UTC day, counted on the day of the transaction and not on the balance: a token spent and
    // refilled in one transaction, or on a later one the same day, is refused here.
    if (inputs.grantedOnDay === inputs.today) return { allowed: false, reason: "ALREADY_GRANTED_TODAY", ...Figures };
    if (Figures.balanceAfter > HOST_DRAFT_PREMIUM_BALANCE_CAP) return { allowed: false, reason: "OVER_BALANCE_CAP", ...Figures };
    return { allowed: true, reason: "PREMIUM_PASS_HELD_WITHIN_CAP_ONCE_PER_DAY", ...Figures };
}
