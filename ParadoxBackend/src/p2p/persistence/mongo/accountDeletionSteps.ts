import type { AccountDeletionStep } from "../../../persistence/mongo/accountDeletionPlan";
import { P2PCollections } from "./collections";

// [2026-10-14] The account deletion plan's steps for the player-hosted hunt collections (persistence/mongo/accountDeletionPlan.ts). A
// hunt is shared by its players, so the account is taken out of the records that name it (its roster and frozen loadouts) and the
// host's id is replaced by its pseudonym; the records keyed by the account alone are deleted. Live hunts block the erasure.

/** The states after which a hunt is over (no player is in it any more). Any other state is live. */
export const TERMINAL_HUNT_STATES = ["COMPLETED", "ABORTED"] as const;

/** Collections of this module that hold nothing keyed to an account (the coverage test requires this list). */
export const P2P_ACCOUNT_DELETION_EXEMPTIONS: Array<{ collection: string; reason: string }> = [
    { collection: P2PCollections.GuardTrafficWindows, reason: "fixed request-counting windows keyed by a hash, expiring within minutes" },
    { collection: P2PCollections.RealmHubGates, reason: "seat gates per hub generation (no account), purged by TTL within a week" },
    { collection: P2PCollections.OperationsAlerts, reason: "operator alerts about economic invariants; no account field" }
];

function EscapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function P2PAccountDeletionSteps(): AccountDeletionStep[] {
    return [
        {
            kind: "guard", collection: P2PCollections.P2PHuntSessions, description: "live player-hosted hunt or hub of the account",
            match: (c) => ({ $or: [{ hostAccountId: c.userId }, { "roster.accountId": c.userId }], state: { $nin: [...TERMINAL_HUNT_STATES] } })
        },
        {
            kind: "delete", collection: P2PCollections.P2PHuntSessions, description: "hunts and hubs of the realms it hosts",
            match: (c) => ({ realmId: { $in: c.ownedRealmIds } })
        },
        {
            kind: "update", collection: P2PCollections.P2PHuntSessions, description: "hunts the account hosted (host pseudonymised)",
            match: (c) => ({ hostAccountId: c.userId }),
            update: (c) => ({ $set: { hostAccountId: c.pseudonymousId } })
        },
        {
            kind: "update", collection: P2PCollections.P2PHuntSessions, description: "roster entries of the account",
            match: (c) => ({ "roster.accountId": c.userId }),
            update: (c) => ({ $pull: { roster: { accountId: c.userId } } })
        },
        {
            kind: "update", collection: P2PCollections.P2PHuntSessions, description: "frozen loadouts of the account",
            match: (c) => ({ "frozenLoadouts.accountId": c.userId }),
            update: (c) => ({ $pull: { frozenLoadouts: { accountId: c.userId } } })
        },
        // [2026-10-14] Found by an erasure run on a scratch copy of a real account: the game server's expected-player list (a string
        // of account ids) and the hosts tried for a hunt still named the account after the roster steps above.
        {
            kind: "update", collection: P2PCollections.P2PHuntSessions, description: "expected-player lists naming the account (pseudonymised)",
            match: (c) => ({ expectedPlayerString: { $regex: EscapeRegex(c.userId) } }),
            update: (c) => [{
                $set: { expectedPlayerString: { $replaceAll: { input: "$expectedPlayerString", find: c.userId, replacement: c.pseudonymousId } } }
            }]
        },
        {
            kind: "update", collection: P2PCollections.P2PHuntSessions, description: "hosts tried for a hunt (the account removed)",
            match: (c) => ({ triedHostAccountIds: c.userId }),
            update: (c) => ({ $pull: { triedHostAccountIds: c.userId } })
        },
        // recoveryCandidateIds is keyed by account id (an account id holds no "." or "$", so it is a safe field path).
        {
            kind: "update", collection: P2PCollections.P2PHuntSessions, description: "recovery candidates of the account",
            match: (c) => ({ [`recoveryCandidateIds.${c.userId}`]: { $exists: true } }),
            update: (c) => ({ $unset: { [`recoveryCandidateIds.${c.userId}`]: "" } })
        },
        {
            kind: "delete", collection: P2PCollections.P2PHostWrites, description: "host write tags about the account or written by it",
            match: (c) => ({ $or: [{ targetUserId: c.userId }, { hostAccountId: c.userId }] })
        },
        { kind: "delete", collection: P2PCollections.P2PHuntXpSummaries, description: "per-hunt XP summaries", match: (c) => ({ member: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PSteamLinks, description: "transport identity links", match: (c) => ({ _id: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PHostCapabilities, description: "host capabilities", match: (c) => ({ hostAccountId: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PAdmissionTickets, description: "admission tickets", match: (c) => ({ accountId: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PPeerAdmissions, description: "peer admissions", match: (c) => ({ accountId: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PControlSequences, description: "control message sequence", match: (c) => ({ _id: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PControlMessages, description: "control messages", match: (c) => ({ accountId: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PHostPresences, description: "host presence", match: (c) => ({ _id: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PHostOffers, description: "host offers", match: (c) => ({ accountId: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PHostReliability, description: "host reliability record", match: (c) => ({ _id: c.userId }) },
        { kind: "delete", collection: P2PCollections.P2PParticipantObservations, description: "connection observations", match: (c) => ({ accountId: c.userId }) },
        {
            kind: "update", collection: P2PCollections.P2PHuntTransitions, description: "hunt transitions the account caused (pseudonymised)",
            match: (c) => ({ actorAccountId: c.userId }),
            update: (c) => ({ $set: { actorAccountId: c.pseudonymousId } })
        },
        {
            kind: "delete", collection: P2PCollections.RealmHubPresence, description: "presence in realm hubs",
            match: (c) => ({ $or: [{ accountId: c.userId }, { realmId: { $in: c.ownedRealmIds } }] })
        }
    ];
}
