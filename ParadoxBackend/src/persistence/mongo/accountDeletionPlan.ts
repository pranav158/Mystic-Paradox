/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession, Db, Document } from "mongodb";
import { Collections } from "./collections";
import { RealmsCollections } from "../../realms/persistence/mongo/collections";
import { GetP2PExtension } from "../../extensions/p2p";

// [2026-10-14] Everything one account keys, in every Mongo collection, as an ordered plan. Two callers run it: the operator's
// 30-day erasure (scripts/process_account_deletions.ts, which refuses an account with live activity) and the admin's immediate
// delete (MongoAdminRepository.deletePlayerData, which keeps its audit trail and does not check live activity, as before).
// The P2P and anti-cheat collections are described by their modules (extensions/p2p.ts server.accountDeletionSteps); the core
// coverage test (accountDeletionPlan.test.ts) fails when a collection is in neither list.

export interface AccountDeletionContext {
    userId: string;
    /** The account's character ids (the characterId field, or _id): resolved once when the plan starts. */
    characterIds: string[];
    /** The realms this account hosts: resolved once when the plan starts. */
    ownedRealmIds: string[];
    /** Replaces the account id where a record must stay (an audit or hunt record's actor). See security/apiKeyHash.ts. */
    pseudonymousId: string;
    /** When the plan runs (ISO text, compared as text like the rest of the stored times). */
    now: string;
}

interface AccountDeletionStepBase {
    /** The collection the step works on. */
    collection: string;
    /** Words for the operator's report. */
    description: string;
    /** The rows this step keys to the account (also the count of a dry run). */
    match(context: AccountDeletionContext): Document;
}

/** Deletes the matching rows. */
export interface AccountDeletionDeleteStep extends AccountDeletionStepBase {
    kind: "delete";
}

/** Keeps the matching rows and changes them: a pull from an array, or a pseudonym in place of the account id. */
export interface AccountDeletionUpdateStep extends AccountDeletionStepBase {
    kind: "update";
    update(context: AccountDeletionContext): Document | Document[];
}

/** Refuses the erasure while any row matches (live activity): nothing is changed. */
export interface AccountDeletionGuardStep extends AccountDeletionStepBase {
    kind: "guard";
}

export type AccountDeletionStep = AccountDeletionDeleteStep | AccountDeletionUpdateStep | AccountDeletionGuardStep;

/** A collection the plan leaves alone, with the reason (the coverage test requires one for every collection not in a step). */
export interface AccountDeletionExemption {
    collection: string;
    reason: string;
}

/** The erasure's own tombstone collection, and the collections that hold nothing keyed to an account. */
export const CORE_ACCOUNT_DELETION_EXEMPTIONS: AccountDeletionExemption[] = [
    { collection: Collections.SchemaMigrations, reason: "the migration ledger; no account data" },
    { collection: Collections.GameServerApiKeys, reason: "gameserver keys; no account data" },
    { collection: Collections.OperationsPolicy, reason: "the operator policy singleton; no account data" },
    // [2026-10-15] The launcher notices singleton: the operator's announcements and tags, no player data (the manager's audit record names the operator).
    { collection: Collections.LauncherNotices, reason: "the launcher notices singleton; no account data" },
    { collection: Collections.AccountDeletions, reason: "the pseudonymous tombstones written by the erasure itself" }
];

/** The launcher account document itself (the `accounts` collection), removed by the caller after the steps. */
export const ACCOUNT_RECORD_COLLECTION = Collections.Accounts;

/** The account's characters, and every row keyed to them as well as to the account. */
function CharacterOwned(context: AccountDeletionContext): Document {
    return {
        $or: [
            { userId: context.userId },
            { characterId: { $in: context.characterIds } },
            { _id: { $in: context.characterIds } }
        ]
    };
}

/** The core collections' steps, guards first. The order of the rest is the order they run in. */
export function CoreAccountDeletionSteps(): AccountDeletionStep[] {
    return [
        // Live activity first: an online realm hosted by the account is never erased under its players.
        {
            kind: "guard", collection: RealmsCollections.Realms, description: "online realm hosted by the account",
            match: (c) => ({ hostAccountId: c.userId, onlineUntil: { $gt: c.now } })
        },

        // Realms the account hosts go with it (their members and invites too); elsewhere the account is only a member or a ban.
        {
            kind: "delete", collection: RealmsCollections.RealmInvites, description: "invites of the realms it hosts, and invites it created",
            match: (c) => ({ $or: [{ realmId: { $in: c.ownedRealmIds } }, { createdBy: c.userId }] })
        },
        {
            kind: "delete", collection: RealmsCollections.RealmPresence, description: "realm presence of the account and of its realms",
            match: (c) => ({ $or: [{ _id: c.userId }, { accountId: c.userId }, { realmId: { $in: c.ownedRealmIds } }] })
        },
        {
            kind: "delete", collection: RealmsCollections.Realms, description: "realms the account hosts",
            match: (c) => ({ hostAccountId: c.userId })
        },
        {
            kind: "update", collection: RealmsCollections.Realms, description: "realm memberships of the account",
            match: (c) => ({ "members.accountId": c.userId }),
            update: (c) => ({ $pull: { members: { accountId: c.userId } } })
        },
        {
            kind: "update", collection: RealmsCollections.Realms, description: "realm bans of the account",
            match: (c) => ({ "bans.accountId": c.userId }),
            update: (c) => ({ $pull: { bans: { accountId: c.userId } } })
        },

        // Authentication and live sessions.
        { kind: "delete", collection: Collections.AuthIdentities, description: "linked sign-in identities", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.RefreshSessions, description: "launcher sign-in sessions", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.GameExchangeCodes, description: "game exchange codes", match: (c) => ({ userId: c.userId }) },
        // [2026-10-15] A link transaction carries linkUserId (the account it links to), not userId: both are the account's.
        {
            kind: "delete", collection: Collections.DiscordOAuthTransactions, description: "Discord sign-in and link transactions",
            match: (c) => ({ $or: [{ userId: c.userId }, { linkUserId: c.userId }] })
        },
        // [2026-10-15] The one-time email codes of the account (verification and reset): an HMAC each, removed with the account.
        { kind: "delete", collection: Collections.EmailCodes, description: "email verification and reset codes", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.AdminSessions, description: "operator sessions of the account", match: (c) => ({ userId: c.userId }) },
        {
            kind: "delete", collection: Collections.UserApiKeys, description: "user API keys",
            match: (c) => ({ $or: [{ userId: c.userId }, { _id: c.userId }] })
        },
        {
            kind: "delete", collection: Collections.Friendships, description: "friendships in either direction",
            match: (c) => ({ $or: [{ ownerId: c.userId }, { otherId: c.userId }] })
        },
        { kind: "delete", collection: Collections.LauncherGuardSessions, description: "launcher Guard integrity sessions", match: (c) => ({ accountId: c.userId }) },
        // [2026-10-14] Guard module findings name the accounts that reported them: the account leaves each one, and the count follows.
        {
            kind: "update", collection: Collections.GuardFindings, description: "Guard module findings that list the account",
            match: (c) => ({ accountIds: c.userId }),
            update: (c) => [
                { $set: { accountIds: { $filter: { input: "$accountIds", as: "guardAccount", cond: { $ne: ["$$guardAccount", c.userId] } } } } },
                { $set: { accountCount: { $size: "$accountIds" } } }
            ]
        },

        // Parties: a party of the account alone is removed; otherwise the account leaves it (a new leader when it led).
        { kind: "delete", collection: Collections.Parties, description: "parties of the account alone", match: (c) => ({ members: [c.userId] }) },
        {
            kind: "update", collection: Collections.Parties, description: "parties the account is in",
            match: (c) => ({ members: c.userId }),
            update: (c) => [
                { $set: { members: { $filter: { input: "$members", as: "member", cond: { $ne: ["$$member", c.userId] } } } } },
                { $set: { leaderPlayerId: { $cond: [{ $eq: ["$leaderPlayerId", c.userId] }, { $arrayElemAt: ["$members", 0] }, "$leaderPlayerId"] } } },
                { $set: { revision: { $add: ["$revision", 1] }, updatedAt: c.now } }
            ]
        },
        { kind: "delete", collection: Collections.PartyMemberships, description: "party memberships", match: (c) => ({ _id: c.userId }) },
        {
            kind: "delete", collection: Collections.PartyInvites, description: "party invites sent or received",
            match: (c) => ({ $or: [{ recipientPlayerId: c.userId }, { sendingPlayerId: c.userId }] })
        },
        {
            kind: "delete", collection: Collections.PartyOutbox, description: "party notifications about the account",
            match: (c) => ({ $or: [{ recipientAccountIds: c.userId }, { "payload.accountId": c.userId }, { "payload.actorAccountId": c.userId }] })
        },

        // Game data.
        { kind: "delete", collection: Collections.Wallets, description: "currency wallet", match: (c) => ({ $or: [{ _id: c.userId }, { userId: c.userId }] }) },
        { kind: "delete", collection: Collections.PlayerJourney, description: "player journey", match: (c) => ({ $or: [{ _id: c.userId }, { userId: c.userId }] }) },
        { kind: "delete", collection: Collections.ProgressionTracks, description: "progression tracks", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.ProgressionObjectives, description: "progression objectives", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.ProgressionObjectiveEvents, description: "progression objective events", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.ProgressionTransactions, description: "progression transactions", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.EscalationProgress, description: "escalation progress", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.BountyStates, description: "bounty board state", match: (c) => ({ $or: [{ _id: c.userId }, { userId: c.userId }] }) },
        { kind: "delete", collection: Collections.CooldownStates, description: "cooldowns", match: (c) => ({ $or: [{ _id: c.userId }, { userId: c.userId }] }) },
        { kind: "delete", collection: Collections.EconomyDaily, description: "daily economy totals", match: (c) => ({ userId: c.userId }) },
        // [2026-10-14] The activity monitor (src/activity): daily counters, hunt rows (the host row too), unlock history and flags.
        { kind: "delete", collection: Collections.PlayerActivityDaily, description: "daily activity counters", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.ActivityHunts, description: "hunt participation rows", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.SlayersPathUnlocks, description: "Slayer's Path unlock history", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.ActivityFlags, description: "activity review flags", match: (c) => ({ userId: c.userId }) },
        { kind: "delete", collection: Collections.Entitlements, description: "entitlements", match: (c) => ({ $or: [{ _id: c.userId }, { userId: c.userId }] }) },
        { kind: "delete", collection: Collections.InventoryTransactions, description: "inventory transaction ledger", match: CharacterOwned },
        { kind: "delete", collection: Collections.Inventories, description: "inventories", match: CharacterOwned },
        { kind: "delete", collection: Collections.Loadouts, description: "loadouts", match: CharacterOwned },
        { kind: "delete", collection: Collections.Breadcrumbs, description: "breadcrumbs", match: CharacterOwned },
        { kind: "delete", collection: Collections.EncounteredContent, description: "encountered content", match: CharacterOwned },
        { kind: "delete", collection: Collections.Characters, description: "characters", match: (c) => ({ userId: c.userId }) },

        // The operator's audit trail: the account's own admin actions name it as the actor (pseudonymised); records about the account
        // are removed. The admin delete (MongoAdminRepository) leaves this collection alone, as it always did.
        { kind: "delete", collection: Collections.AdminAudit, description: "operator audit records about the account", match: (c) => ({ targetUserId: c.userId }) },
        {
            kind: "update", collection: Collections.AdminAudit, description: "operator audit records the account made (pseudonymised)",
            match: (c) => ({ actorUserId: c.userId }),
            update: (c) => ({ $set: { actorUserId: c.pseudonymousId } })
        }
    ];
}

/** Every step of the plan: the core's, then the modules' (P2P, with anti-cheat), guards first. */
export function AccountDeletionSteps(): AccountDeletionStep[] {
    const All = [...CoreAccountDeletionSteps(), ...GetP2PExtension().server.accountDeletionSteps()];
    return [...All.filter((step) => step.kind === "guard"), ...All.filter((step) => step.kind !== "guard")];
}

/** Every collection of the plan's steps. */
export function CollectionsWithSteps(steps: AccountDeletionStep[]): string[] {
    return [...new Set(steps.map((step) => step.collection))];
}

/** The character ids of the account and the realms it hosts, read once for the plan. */
export async function BuildAccountDeletionContext(db: Db, userId: string, now: string, pseudonymousId: string,
    session?: ClientSession): Promise<AccountDeletionContext> {
    const Characters = await db.collection(Collections.Characters)
        .find({ userId }, { projection: { _id: 1, characterId: 1 }, session })
        .toArray();
    const Realms = await db.collection(RealmsCollections.Realms)
        .find({ hostAccountId: userId }, { projection: { _id: 1 }, session })
        .toArray();
    return {
        userId,
        characterIds: Characters.map((character) => String(character.characterId ?? character._id)),
        ownedRealmIds: Realms.map((realm) => String(realm._id)),
        pseudonymousId,
        now
    };
}

export interface AccountDeletionStepCount {
    collection: string;
    description: string;
    kind: AccountDeletionStep["kind"];
    /** Rows the step matched (a dry run) or changed (an erasure); a guard's rows are the live activity found. */
    rows: number;
}

/** Counts every step without changing anything. Guards with rows are returned as blockers. */
export async function CountAccountDeletion(db: Db, context: AccountDeletionContext, steps: AccountDeletionStep[]): Promise<{
    counts: AccountDeletionStepCount[];
    blockers: string[];
}> {
    const Counts: AccountDeletionStepCount[] = [];
    const Blockers: string[] = [];
    for (const step of steps) {
        const Rows = await db.collection(step.collection).countDocuments(step.match(context));
        Counts.push({ collection: step.collection, description: step.description, kind: step.kind, rows: Rows });
        if (step.kind === "guard" && Rows > 0) Blockers.push(`${step.description}: ${Rows}`);
    }
    return { counts: Counts, blockers: Blockers };
}

/**
 * Applies the delete and update steps inside `session`, in order, and returns the rows changed per collection. Guard steps are not
 * applied (the caller checks them first with CountAccountDeletion). The caller removes the account record itself.
 */
export async function ApplyAccountDeletionSteps(db: Db, session: ClientSession, context: AccountDeletionContext,
    steps: AccountDeletionStep[]): Promise<Record<string, number>> {
    const Changed: Record<string, number> = {};
    for (const step of steps) {
        if (step.kind === "guard") continue;
        const Collection = db.collection(step.collection);
        const Selector = step.match(context);
        if (step.kind === "delete") {
            const Result = await Collection.deleteMany(Selector, { session });
            Changed[step.collection] = (Changed[step.collection] ?? 0) + Result.deletedCount;
        } else {
            const Result = await Collection.updateMany(Selector, step.update(context), { session });
            Changed[step.collection] = (Changed[step.collection] ?? 0) + Result.modifiedCount;
        }
    }
    return Changed;
}
