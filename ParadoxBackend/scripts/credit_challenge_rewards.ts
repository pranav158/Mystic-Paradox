/*
 * One-off credit of season-challenge Cache Coins that the backend refused (2026-10-10).
 *
 * Before the challenge-reward rule (controllers/challengeRewards.ts), every +N CURRENCY_SEASONAL_COIN grant for a
 * completed season challenge was refused by the season43 prestige gate in wallet.ts (38_ section 19.5). This credits
 * named, already-claimed challenges once each and records the credit on the claim - exactly what the live rule
 * now does - so the same claim can never fund another grant. Each grant is checked against the stored bounty state:
 * the bounty must exist, be a season challenge, be claimed, and carry no reward credit yet.
 *
 * Dry-run is the default. Applying requires --apply and the confirmation token; everything commits in one transaction.
 *   tsx --env-file=.env scripts/credit_challenge_rewards.ts --user-id=<id> --grant=<bountyId>:<amount> [--grant=...]
 *   ... --apply --confirm=APPLY_CHALLENGE_REWARD_CREDIT
 */

import { CHALLENGE_REWARD_CURRENCIES, FindFundableSeasonClaim, InferBountyGroup, MAX_CHALLENGE_REWARD_PER_CLAIM, WithRewardCredit } from "../src/bountyState";
import { AddCurrency, GetBalance } from "../src/controllers/wallet";
import { GetPersistenceLifecycle, GetRepositories, GetUnitOfWork } from "../src/persistence";

const APPLY_CONFIRMATION = "APPLY_CHALLENGE_REWARD_CREDIT";
const CURRENCY = "CURRENCY_SEASONAL_COIN";

function GetArg(name: string): string | undefined {
    const Prefix = `--${name}=`;
    return process.argv.find((Arg) => Arg.startsWith(Prefix))?.slice(Prefix.length);
}

const Apply = process.argv.includes("--apply");
const UserId = GetArg("user-id");
const Grants = process.argv.filter((Arg) => Arg.startsWith("--grant=")).map((Arg) => {
    const Value = Arg.slice("--grant=".length);
    const Split = Value.lastIndexOf(":");
    return { bountyId: Value.slice(0, Split), amount: Number(Value.slice(Split + 1)) };
});

if (!UserId || Grants.length === 0) throw new Error("usage: --user-id=<id> --grant=<bountyId>:<amount> [--grant=...] [--apply --confirm=...]");
if (Apply && GetArg("confirm") !== APPLY_CONFIRMATION) throw new Error(`Refusing write: --apply requires --confirm=${APPLY_CONFIRMATION}`);
if (!CHALLENGE_REWARD_CURRENCIES.has(CURRENCY)) throw new Error(`${CURRENCY} is not a challenge-reward currency`);
for (const Grant of Grants) {
    if (!Grant.bountyId || !Number.isSafeInteger(Grant.amount) || Grant.amount <= 0 || Grant.amount > MAX_CHALLENGE_REWARD_PER_CLAIM) {
        throw new Error(`invalid grant ${Grant.bountyId}:${Grant.amount}`);
    }
}

async function Main(): Promise<void> {
    const Lifecycle = GetPersistenceLifecycle();
    try {
        const Record = await GetRepositories().bountyStates.get(UserId!);
        if (!Record) throw new Error(`no stored bounty state for ${UserId}`);
        for (const Grant of Grants) {
            const Entry = Record.bounties.find((Candidate) => Candidate.bounty.bounty_id === Grant.bountyId);
            const Group = Entry ? (Entry.group === "unassigned" ? InferBountyGroup(Grant.bountyId) : Entry.group) : undefined;
            const Problem = !Entry ? "not stored" : Group !== "weekly" ? `group ${Group}` : Entry.bounty.claimed !== true ? "not claimed"
                : Entry.rewardCredit ? `already credited by ${Entry.rewardCredit.transactionId}` : undefined;
            console.log(`${Grant.bountyId}: +${Grant.amount} ${CURRENCY} ${Problem ? `REFUSED (${Problem})` : "ok"}`);
            if (Problem) throw new Error(`refusing: ${Grant.bountyId} ${Problem}`);
        }
        const Before = await GetBalance(UserId!, CURRENCY);
        const Total = Grants.reduce((Sum, Grant) => Sum + Grant.amount, 0);
        console.log(`${CURRENCY} balance ${Before} -> ${Before + Total} (${Apply ? "apply" : "dry-run"})`);
        if (!Apply) return;

        const Stamp = new Date().toISOString();
        await GetUnitOfWork().withTransaction(async (Repos, Session) => {
            let Current = await Repos.bountyStates.get(UserId!, Session);
            if (!Current) throw new Error("bounty state vanished");
            const Version = Current.updateVersion;
            for (const Grant of Grants) {
                Current = WithRewardCredit(Current, Grant.bountyId, {
                    catalogId: CURRENCY, amount: Grant.amount, transactionId: `backfill-20261010-${Grant.bountyId}`, at: Stamp
                }, Stamp);
            }
            // One version step for the whole credit, like a single save.
            Current = { ...Current, updateVersion: Version + 1 };
            const Saved = await Repos.bountyStates.saveIfVersion(Current, Version, Session);
            if (!Saved) throw new Error("bounty state changed during the credit; re-run");
            await AddCurrency(UserId!, CURRENCY, Total, Session);
        });
        const After = await GetBalance(UserId!, CURRENCY);
        const Remaining = FindFundableSeasonClaim(await GetRepositories().bountyStates.get(UserId!));
        console.log(`applied: ${CURRENCY} ${Before} -> ${After}; next fundable claim: ${Remaining ? Remaining.bounty.bounty_id : "none"}`);
    } finally {
        await Lifecycle.stop();
    }
}

Main().catch((Err) => {
    console.error(Err);
    process.exitCode = 1;
});
