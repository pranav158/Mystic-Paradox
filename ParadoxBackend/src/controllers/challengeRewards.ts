/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession } from "mongodb";
import { CHALLENGE_REWARD_CURRENCIES, FindFundableSeasonClaim, MAX_CHALLENGE_REWARD_PER_CLAIM, WithRewardCredit } from "../bountyState";
import { GetRepositories } from "../persistence";

// Season-challenge reward funding (see the block comment in bountyState.ts).

export function IsChallengeRewardGrant(catalogId: unknown, quantity: unknown): boolean {
    const Amount = Number(quantity);
    return typeof catalogId === "string" && CHALLENGE_REWARD_CURRENCIES.has(catalogId)
        && Number.isFinite(Amount) && Amount > 0 && Amount <= MAX_CHALLENGE_REWARD_PER_CLAIM;
}

/**
 * Charges a challenge-reward grant to one claimed, uncredited season challenge and records the credit on it - inside the
 * caller's inventory transaction, so the credit and the coins commit together or not at all. Returns the funding bounty
 * id, or undefined when nothing can fund it (the caller then applies the prestige gate, which refuses it).
 */
export async function FundChallengeReward(
    userId: string,
    catalogId: string,
    quantity: number,
    transactionId: string | undefined,
    session?: ClientSession
): Promise<{ bountyId: string; claimedAt?: string } | undefined> {
    if (!IsChallengeRewardGrant(catalogId, quantity)) return undefined;
    const Repository = GetRepositories().bountyStates;
    const Record = await Repository.get(userId, session);
    const Claim = FindFundableSeasonClaim(Record);
    if (!Record || !Claim) return undefined;
    const BountyId = String(Claim.bounty.bounty_id);
    const Next = WithRewardCredit(Record, BountyId, {
        catalogId,
        amount: quantity,
        transactionId: transactionId ?? "unknown",
        at: new Date().toISOString()
    });
    // A concurrent bounty save inside this window surfaces as a transient write conflict and Mongo retries the whole
    // inventory transaction; a plain version mismatch means the claim is no longer ours to charge.
    const Saved = await Repository.saveIfVersion(Next, Record.updateVersion, session);
    return Saved ? { bountyId: BountyId, claimedAt: Claim.claimedAt } : undefined;
}

/**
 * The game server posts a challenge's coins about 50 ms BEFORE or after the claim save that marks it claimed. Wait
 * (outside any transaction, so each poll sees fresh data) up to `timeoutMs` for a fundable claim to exist.
 */
export async function WaitForFundableSeasonClaim(userId: string, timeoutMs = 1500, pollMs = 100): Promise<boolean> {
    const Deadline = Date.now() + timeoutMs;
    for (;;) {
        if (FindFundableSeasonClaim(await GetRepositories().bountyStates.get(userId))) return true;
        if (Date.now() >= Deadline) return false;
        await new Promise((Resolve) => setTimeout(Resolve, pollMs));
    }
}
