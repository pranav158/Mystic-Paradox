/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { logger } from "../logger";
import { IsRateLimited } from "../security/rateLimit";
import { DEFAULT_REALM_LIMITS, RealmLimits } from "./realmsConfig";
import { LauncherApiError, RealmEntryError, RealmEntryErrorCode } from "./realmErrors";
import { CreateInviteInput, CreateRealmInput, EntryRealmInput, HeartbeatInput, RealmSettingsInput } from "./realmInput";
import {
    ApplyHeartbeat,
    BuildInvite,
    DecideJoin,
    DetectOwnershipChange,
    GenerateInviteCode,
    GetInviteState,
    HEARTBEAT_ONLINE_MS,
    HubRoomIdsOf,
    InviteState,
    IsRealmHubReady,
    IsRealmNameReleasable,
    IsRealmOnline,
    IsRealmServing,
    JoinDecision,
    NormalizeHubRoomId,
    PRESENCE_CACHE_MS,
    PRESENCE_TTL_MS,
    PresenceTouchNeedsWrite,
    RealmNameForUsername,
    RealmNameReleaseAt,
    SortJoinRequestsNewestFirst,
    ValidateHostingPatch
} from "./realmRules";
import { DisplayNameResolver, RealmPresenceRepository, RealmsRepository } from "./persistence/RealmsRepository";
import {
    RealmEvent,
    RealmHostingPatch,
    RealmInviteRecord,
    RealmJoinPolicy,
    RealmMemberRole,
    RealmPresence,
    RealmPresenceRecord,
    RealmRecord
} from "./realmTypes";

// [2026-10-13 realms S2] The realms directory's use cases (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md section 3.3,
// HOSTING_TIERS_AND_REALMS_PLAN section 5.6). Everything here takes the repository, the clock, the limiter and the display-name
// lookup as dependencies, so the route tests and the service tests run with an in-memory repository and no MongoDB.
// [2026-10-13 realms hub design section 2] Entry authorization, presence, host hosting state and the event sink are added here.
//
// Nothing in a response carries an IP address or any other network address: the directory never holds one.

/** What anyone signed in may learn about a realm. */
export interface RealmPublicInfo {
    realmId: string;
    name: string;
    host: { displayName: string | null };
    /** Not a secret: the launcher keeps the key the player agreed to and compares it later (ownership change). */
    hostPublicKey: string;
    joinPolicy: RealmJoinPolicy;
    listed: boolean;
    /** The host's launcher is reporting in (heartbeat within 90 s). */
    online: boolean;
    /** The host is online AND its Ramsgate hub is running: the realm can be entered. */
    serving: boolean;
    /** The realm's Ramsgate hub is running (whatever the host's online state). */
    hubReady: boolean;
    /** Members whose realm presence is active right now (in the realm's game or about to be). */
    playerCount: number;
    version: string | null;
    memberCount: number;
    /** The caller's own standing in this realm. */
    membership: RealmMemberRole | null;
    /** [2026-10-16] The caller asked to join and waits for the host (an invite-only realm). */
    requested: boolean;
    /** [2026-10-16] The host invited the caller by username and the caller has not answered yet. */
    invited: boolean;
    /** Only present when the caller sent the host key it knew: true when this name now belongs to a different host key. */
    ownershipChanged?: boolean;
}

/** The host's view of their own realm: public info plus the people and the dates the host manages. */
export interface RealmHostView extends RealmPublicInfo {
    createdAt: string;
    lastOnlineAt: string | null;
    onlineUntil: string | null;
    /** When the name would be freed for someone else if the host stays away. */
    nameReleaseAt: string | null;
    members: Array<{ accountId: string; displayName: string | null; role: RealmMemberRole; joinedAt: string }>;
    bans: Array<{ accountId: string; displayName: string | null; reason: string | null; at: string }>;
    /** [2026-10-15] Players waiting for the host's approval (GET .../mine/requests lists them). */
    joinRequestCount: number;
    /** [2026-10-16] Players the host invited by username who have not answered yet, newest first. */
    playerInvites: Array<{ accountId: string; displayName: string | null; at: string }>;
}

/** [2026-10-16] One invite the caller received, as the player's launcher lists it. */
export interface PlayerInviteView {
    realm: RealmPublicInfo;
    at: string;
}

/** [2026-10-15] One waiting player, as the host's request list shows it. */
export interface JoinRequestView {
    accountId: string;
    displayName: string | null;
    at: string;
}

export interface InviteView {
    code: string;
    createdAt: string;
    expiresAt: string;
    maxUses: number;
    uses: number;
    revokedAt: string | null;
    state: InviteState;
}

/** The answer of the launcher's presence routes (hub design section 2.2). */
export interface PresenceView {
    realm: { name: string; serving: boolean; hubReady: boolean; hostOnline: boolean } | null;
    expiresAt: string | null;
}

/** The answer of authorizeEntry (hub design section 2.4). A rate-limited caller gets a thrown AUTH_RATE_LIMITED instead. */
export type EntryAuthorization =
    | { ok: true; realmId: string; isHost: boolean }
    | { ok: false; code: RealmEntryErrorCode };

interface RateBudget {
    max: number;
    windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const RATE_BUDGETS = {
    read: { max: 240, windowMs: MINUTE },
    write: { max: 60, windowMs: MINUTE },
    heartbeat: { max: 30, windowMs: MINUTE },
    create: { max: 5, windowMs: HOUR },
    invite: { max: 30, windowMs: HOUR },
    // Joining by code (and previewing a code) is also the only way to guess a code.
    join: { max: 30, windowMs: 10 * MINUTE },
    // Play with a realm (RequestGameExchangeCode already allows 10 launches per 5 minutes; an invite code can be tried here too).
    entry: { max: 30, windowMs: 10 * MINUTE }
} satisfies Record<string, RateBudget>;

const MEMBER_LIST_LIMIT = 100;
const INVITE_LIST_LIMIT = 100;

/** A realm whose online state lapsed longer ago than this is not "just lapsed": the sweeper leaves it alone. */
export const SWEEP_LOOKBACK_MS = 10 * MINUTE;
const SWEEP_BATCH = 100;
const PRESENCE_CACHE_LIMIT = 10_000;

/** [2026-10-15] What a join request answered: the account is already in (a race with the host), or it is refused with this code. */
type JoinRequestOutcome = { member: true } | { member: false; code: "REALM_JOIN_REQUESTED" | "REALM_BANNED" | "REALM_REQUESTS_FULL" | "REALM_NOT_FOUND" };

/** Why DecideJoin refused, as the launcher error code (shared by join and authorizeEntry). */
const JOIN_DENIAL_CODES = {
    BANNED: "REALM_BANNED",
    SOLO: "REALM_SOLO",
    INVITE_REQUIRED: "REALM_INVITE_REQUIRED",
    INVITE_INVALID: "REALM_INVITE_INVALID",
    INVITE_EXPIRED: "REALM_INVITE_EXPIRED"
} as const satisfies Record<Extract<JoinDecision, { allow: false }>["reason"], RealmEntryErrorCode>;

export interface RealmsServiceDeps {
    repository: RealmsRepository;
    presence: RealmPresenceRepository;
    displayNames: DisplayNameResolver;
    now?: () => number;
    limits?: RealmLimits;
    isRateLimited?: (key: string, maxAttempts: number, windowMs: number) => boolean;
    generateInviteCode?: () => string;
    generateRealmId?: () => string;
    /**
     * [hub design section 2.4] Receives what happens to a realm (a member removed, the realm released, the host gone offline). An
     * error (or a hang is the sink's own problem) is logged and never fails the request that caused the event.
     */
    events?: (event: RealmEvent) => Promise<void>;
    /**
     * [2026-10-15] The account whose launcher username is `username` (the caller's text, trimmed; the match is case-insensitive and
     * exact), or undefined when no account has it. Used only by the host's "add player" route. Absent = no username is found.
     */
    resolveUsername?: (username: string) => Promise<string | undefined>;
}

export type RealmsService = ReturnType<typeof CreateRealmsService>;

export function CreateRealmsService(deps: RealmsServiceDeps) {
    const repo = deps.repository;
    const presenceRepo = deps.presence;
    const Now = deps.now ?? (() => Date.now());
    const Limits = deps.limits ?? DEFAULT_REALM_LIMITS;
    const RateLimited = deps.isRateLimited ?? IsRateLimited;
    const NewInviteCode = deps.generateInviteCode ?? (() => GenerateInviteCode());
    const NewRealmId = deps.generateRealmId ?? (() => crypto.randomUUID());
    const Iso = (ms: number) => new Date(ms).toISOString();

    function Throttle(bucket: keyof typeof RATE_BUDGETS, accountId: string): void {
        const budget = RATE_BUDGETS[bucket];
        if (RateLimited(`realms:${bucket}:${accountId}`, budget.max, budget.windowMs)) {
            throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many realm requests. Please wait a moment and try again.");
        }
    }

    async function RequireHostedRealm(accountId: string): Promise<RealmRecord> {
        const realm = await repo.findByHost(accountId);
        if (realm === undefined) throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
        return realm;
    }

    async function NamesFor(accountIds: string[]): Promise<Map<string, string>> {
        try {
            return await deps.displayNames(accountIds);
        } catch (error) {
            // Labels are best effort: a failed name lookup must not fail the directory call.
            logger.warn(`[Realms] display-name lookup failed: ${error}`);
            return new Map();
        }
    }

    async function PlayerCounts(realmIds: string[]): Promise<Map<string, number>> {
        try {
            return await presenceRepo.countActiveByRealm(realmIds, Iso(Now()));
        } catch (error) {
            // Also best effort: the directory does not depend on the player count.
            logger.warn(`[Realms] player-count lookup failed: ${error}`);
            return new Map();
        }
    }

    function MembershipOf(realm: RealmRecord, accountId: string): RealmMemberRole | null {
        return realm.members.find((member) => member.accountId === accountId)?.role ?? null;
    }

    function ToPublicInfo(
        realm: RealmRecord,
        viewerId: string,
        names: Map<string, string>,
        counts: Map<string, number>,
        knownHostKey?: string
    ): RealmPublicInfo {
        const nowMs = Now();
        const info: RealmPublicInfo = {
            realmId: realm.realmId,
            name: realm.name,
            host: { displayName: names.get(realm.hostAccountId) ?? null },
            hostPublicKey: realm.hostPublicKey,
            joinPolicy: realm.joinPolicy,
            listed: realm.listed,
            online: IsRealmOnline(realm, nowMs),
            // [2026-10-16] A SOLO realm cannot be entered by anyone but its host, so to everyone else it is not serving (launchers
            // up to 0.1.71 then show it offline; 0.1.72 reads joinPolicy SOLO and says "solo mode").
            serving: IsRealmServing(realm, nowMs) && (realm.joinPolicy !== "SOLO" || viewerId === realm.hostAccountId),
            hubReady: IsRealmHubReady(realm),
            playerCount: counts.get(realm.realmId) ?? 0,
            version: realm.version ?? null,
            memberCount: realm.members.length,
            membership: MembershipOf(realm, viewerId),
            requested: (realm.joinRequests ?? []).some((request) => request.accountId === viewerId),
            invited: (realm.playerInvites ?? []).some((invite) => invite.accountId === viewerId)
        };
        if (knownHostKey !== undefined) {
            info.ownershipChanged = DetectOwnershipChange({ name: realm.name, hostPublicKey: knownHostKey }, realm);
        }
        return info;
    }

    async function PublicInfos(realms: RealmRecord[], viewerId: string, knownHostKey?: string): Promise<RealmPublicInfo[]> {
        const [names, counts] = await Promise.all([
            NamesFor(realms.map((realm) => realm.hostAccountId)),
            PlayerCounts(realms.map((realm) => realm.realmId))
        ]);
        return realms.map((realm) => ToPublicInfo(realm, viewerId, names, counts, knownHostKey));
    }

    async function ToHostView(realm: RealmRecord, viewerId: string): Promise<RealmHostView> {
        const invites = [...(realm.playerInvites ?? [])].sort((a, b) => b.at.localeCompare(a.at));
        const ids = [
            realm.hostAccountId,
            ...realm.members.map((member) => member.accountId),
            ...realm.bans.map((ban) => ban.accountId),
            ...invites.map((invite) => invite.accountId)
        ];
        const [names, counts] = await Promise.all([NamesFor(ids), PlayerCounts([realm.realmId])]);
        const releaseAt = RealmNameReleaseAt(realm);
        return {
            ...ToPublicInfo(realm, viewerId, names, counts),
            createdAt: realm.createdAt,
            lastOnlineAt: realm.lastOnlineAt ?? null,
            onlineUntil: realm.onlineUntil ?? null,
            nameReleaseAt: releaseAt === undefined ? null : new Date(releaseAt).toISOString(),
            members: realm.members.map((member) => ({
                accountId: member.accountId,
                displayName: names.get(member.accountId) ?? null,
                role: member.role,
                joinedAt: member.joinedAt
            })),
            bans: realm.bans.map((ban) => ({
                accountId: ban.accountId,
                displayName: names.get(ban.accountId) ?? null,
                reason: ban.reason ?? null,
                at: ban.at
            })),
            joinRequestCount: realm.joinRequests?.length ?? 0,
            playerInvites: invites.map((invite) => ({
                accountId: invite.accountId,
                displayName: names.get(invite.accountId) ?? null,
                at: invite.at
            }))
        };
    }

    function ToInviteView(invite: RealmInviteRecord): InviteView {
        return {
            code: invite.code,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            maxUses: invite.maxUses,
            uses: invite.uses,
            revokedAt: invite.revokedAt ?? null,
            state: GetInviteState(invite, Now())
        };
    }

    // -----------------------------------------------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------------------------------------------

    /** Hands an event to the sink; whatever the sink does, the request that caused the event is not affected. */
    async function Emit(event: RealmEvent): Promise<void> {
        if (deps.events === undefined) return;
        try {
            await deps.events(event);
        } catch (error) {
            logger.warn(`[Realms] event sink failed type=${event.type} realmId=${event.realmId}: ${error}`);
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Presence (a member's current realm context; hub design section 2.2)
    // -----------------------------------------------------------------------------------------------------------

    // presenceOf is on the matchmaking hot path (every CITY and hunt request asks, for every player), so answers, "none" included,
    // are kept for 2 s in this process. Every write this process makes drops the account's entry and moves the account's epoch, so a
    // read that began before the write cannot put its old answer back (it compares the epoch it saw with the epoch after its read).
    interface CachedPresence {
        at: number;
        value: RealmPresence | undefined;
    }
    const presenceCache = new Map<string, CachedPresence>();
    const accountEpochs = new Map<string, number>();
    let clearEpoch = 0; // moves when every account's epoch is dropped at once
    const EpochOf = (accountId: string): string => `${clearEpoch}.${accountEpochs.get(accountId) ?? 0}`;

    function ToPresence(row: RealmPresenceRecord): RealmPresence {
        return { realmId: row.realmId, boundAt: row.boundAt, lastSeenAt: row.lastSeenAt, expiresAt: row.expiresAt };
    }

    function CachePut(accountId: string, value: RealmPresence | undefined): void {
        if (presenceCache.size >= PRESENCE_CACHE_LIMIT) {
            const nowMs = Now();
            for (const [key, entry] of presenceCache) if (nowMs - entry.at >= PRESENCE_CACHE_MS) presenceCache.delete(key);
            if (presenceCache.size >= PRESENCE_CACHE_LIMIT) presenceCache.clear();
        }
        presenceCache.set(accountId, { at: Now(), value });
    }

    function InvalidatePresence(accountId: string): void {
        accountEpochs.set(accountId, (accountEpochs.get(accountId) ?? 0) + 1);
        if (accountEpochs.size > PRESENCE_CACHE_LIMIT * 5) {
            accountEpochs.clear();
            clearEpoch += 1;
        }
        presenceCache.delete(accountId);
    }

    async function PresenceOf(accountId: string): Promise<RealmPresence | undefined> {
        const nowMs = Now();
        const cached = presenceCache.get(accountId);
        if (cached !== undefined && nowMs - cached.at >= 0 && nowMs - cached.at < PRESENCE_CACHE_MS) {
            if (cached.value === undefined) return undefined;
            // A cached row that has lapsed since is no longer active.
            return Date.parse(cached.value.expiresAt) > nowMs ? { ...cached.value } : undefined;
        }
        const epoch = EpochOf(accountId);
        const row = await presenceRepo.findActive(accountId, Iso(nowMs));
        const value = row === undefined ? undefined : ToPresence(row);
        if (EpochOf(accountId) === epoch) CachePut(accountId, value);
        return value === undefined ? undefined : { ...value };
    }

    /** The authoritative bind: a login's realm (or none) replaces whatever context the account had. */
    async function BindPresence(accountId: string, realmId: string | null): Promise<void> {
        if (realmId === null) {
            await presenceRepo.remove(accountId);
        } else {
            const nowMs = Now();
            await presenceRepo.bind({
                accountId,
                realmId,
                boundAt: Iso(nowMs),
                lastSeenAt: Iso(nowMs),
                expiresAt: Iso(nowMs + PRESENCE_TTL_MS)
            });
        }
        InvalidatePresence(accountId);
    }

    /**
     * Keeps an active presence alive for another 120 s; an expired or absent one stays so (it is never resurrected).
     * [realms wave 2, coalescing] The decision comes from presenceOf (the cache when fresh, else one read): the row is written only
     * when PresenceTouchNeedsWrite says so (lastSeenAt older than 30 s, or less than 60 s of life left). Otherwise the answer is
     * the row as it is. The returned lastSeenAt/expiresAt are therefore the last write's, not the touch's.
     */
    async function TouchPresence(accountId: string): Promise<RealmPresence | undefined> {
        const nowMs = Now();
        const current = await PresenceOf(accountId);
        if (current === undefined) return undefined;
        if (!PresenceTouchNeedsWrite(current, nowMs)) return current;
        const epoch = EpochOf(accountId);
        const row = await presenceRepo.touch(accountId, Iso(nowMs), Iso(nowMs + PRESENCE_TTL_MS));
        const value = row === undefined ? undefined : ToPresence(row);
        // A touch changes what a read that began earlier saw, so it counts as a write for those readers; unless another write got
        // in between, its own result is what the cache then holds (the matchmaker's next presenceOf costs nothing).
        const unchanged = EpochOf(accountId) === epoch;
        InvalidatePresence(accountId);
        if (unchanged) CachePut(accountId, value);
        return value === undefined ? undefined : { ...value };
    }

    async function LeavePresence(accountId: string): Promise<void> {
        await presenceRepo.remove(accountId);
        InvalidatePresence(accountId);
    }

    /** After a kick, ban or leave: the account's presence goes if it belongs to this realm. A failure here does not undo the removal. */
    async function DropPresenceInRealm(accountId: string, realmId: string): Promise<void> {
        try {
            await presenceRepo.remove(accountId, realmId);
        } catch (error) {
            logger.warn(`[Realms] could not remove presence realmId=${realmId}: ${error}`);
        }
        InvalidatePresence(accountId);
    }

    /** After a release: every row of the realm goes. */
    async function DropPresenceOfRealm(realmId: string): Promise<void> {
        try {
            await presenceRepo.removeForRealm(realmId);
        } catch (error) {
            logger.warn(`[Realms] could not remove presence of realmId=${realmId}: ${error}`);
        }
        // The accounts are unknown, so the whole cache goes (and every read still in flight is outdated).
        clearEpoch += 1;
        accountEpochs.clear();
        presenceCache.clear();
    }

    async function ToPresenceView(presence: RealmPresence | undefined): Promise<PresenceView> {
        if (presence === undefined) return { realm: null, expiresAt: null };
        const realm = await repo.findById(presence.realmId);
        if (realm === undefined) return { realm: null, expiresAt: null };
        const nowMs = Now();
        return {
            realm: {
                name: realm.name,
                serving: IsRealmServing(realm, nowMs),
                hubReady: IsRealmHubReady(realm),
                hostOnline: IsRealmOnline(realm, nowMs)
            },
            expiresAt: presence.expiresAt
        };
    }

    // -----------------------------------------------------------------------------------------------------------
    // Joining (shared by join and authorizeEntry)
    // -----------------------------------------------------------------------------------------------------------

    /**
     * The side effects of an allowed join: an invite is consumed first (the atomic step that stops two joins sharing its last
     * use) and given back if the membership then cannot be added.
     */
    async function AdmitMember(
        realm: RealmRecord,
        accountId: string,
        via: "PUBLIC" | "INVITE",
        invite: RealmInviteRecord | undefined
    ): Promise<{ ok: true; added: boolean } | { ok: false; code: Extract<RealmEntryErrorCode, "REALM_INVITE_EXPIRED" | "REALM_BANNED" | "REALM_FULL" | "REALM_NOT_FOUND"> }> {
        let consumedCode: string | undefined;
        if (via === "INVITE") {
            const consumed = await repo.consumeInvite(invite!.code, Iso(Now()));
            if (consumed === undefined) return { ok: false, code: "REALM_INVITE_EXPIRED" };
            consumedCode = consumed.code;
        }
        const added = await repo.addMember(realm.realmId, { accountId, role: "MEMBER", joinedAt: Iso(Now()) }, Limits.maxMembers);
        if (added !== "ADDED" && consumedCode !== undefined) await repo.refundInvite(consumedCode);
        switch (added) {
            case "BANNED": return { ok: false, code: "REALM_BANNED" };
            case "FULL": return { ok: false, code: "REALM_FULL" };
            case "NOT_FOUND": return { ok: false, code: "REALM_NOT_FOUND" };
        }
        if (added === "ADDED") logger.info(`[Realms] member joined realmId=${realm.realmId} via=${via}`);
        return { ok: true, added: added === "ADDED" };
    }

    /**
     * [2026-10-15] An invite-only realm refused this account without an invite (DecideJoin INVITE_REQUIRED): the request is recorded
     * (once; asking again changes nothing) and the caller is told to wait. A ban or a full list is refused instead; a member who asks
     * after all (a race with the host's approval) is simply in.
     */
    async function RequestJoin(realmId: string, accountId: string): Promise<JoinRequestOutcome> {
        const result = await repo.addJoinRequest(realmId, { accountId, at: Iso(Now()) }, Limits.maxJoinRequests);
        switch (result) {
            case "ADDED":
                logger.info(`[Realms] join requested realmId=${realmId}`);
                return { member: false, code: "REALM_JOIN_REQUESTED" };
            case "ALREADY_REQUESTED": return { member: false, code: "REALM_JOIN_REQUESTED" };
            case "ALREADY_MEMBER": return { member: true };
            case "BANNED": return { member: false, code: "REALM_BANNED" };
            case "FULL": return { member: false, code: "REALM_REQUESTS_FULL" };
            case "NOT_FOUND": return { member: false, code: "REALM_NOT_FOUND" };
        }
    }

    /**
     * [2026-10-16] The account holds a player invite to this invite-only realm: the join (or Play) answers it, as Accept would. The
     * membership goes through addMember (a ban and the member cap apply), which removes the invite in the same update.
     */
    async function AcceptPlayerInvite(
        realm: RealmRecord,
        accountId: string
    ): Promise<{ member: true } | { member: false; code: "REALM_BANNED" | "REALM_FULL" | "REALM_NOT_FOUND" }> {
        const added = await repo.addMember(realm.realmId, { accountId, role: "MEMBER", joinedAt: Iso(Now()) }, Limits.maxMembers);
        switch (added) {
            case "BANNED": return { member: false, code: "REALM_BANNED" };
            case "FULL": return { member: false, code: "REALM_FULL" };
            case "NOT_FOUND": return { member: false, code: "REALM_NOT_FOUND" };
        }
        // Already a member: addMember changed nothing, so the invite it would have removed is removed here.
        if (added === "ALREADY_MEMBER") await repo.removePlayerInvite(realm.realmId, accountId);
        await repo.removeJoinRequest(realm.realmId, accountId);
        if (added === "ADDED") logger.info(`[Realms] player invite accepted realmId=${realm.realmId}`);
        return { member: true };
    }

    function HasPlayerInvite(realm: RealmRecord, accountId: string): boolean {
        return (realm.playerInvites ?? []).some((invite) => invite.accountId === accountId);
    }

    /**
     * [2026-10-16, owner] The name a claim takes. Without one (the launcher), the host's username (RealmNameForUsername); an account
     * with no username yet cannot claim. A name that is sent (the API) must not be another player's username, so nobody holds the
     * realm name a player would be found by.
     */
    async function RealmNameToClaim(accountId: string, requested: string | undefined): Promise<string> {
        const own = RealmNameForUsername((await NamesFor([accountId])).get(accountId));
        if (requested === undefined) {
            if (own === undefined) {
                throw new LauncherApiError("REALM_USERNAME_REQUIRED", "Set a username before you host a realm: your realm is named after it.");
            }
            return own;
        }
        if (requested !== own && deps.resolveUsername !== undefined) {
            const holder = await deps.resolveUsername(requested);
            if (holder !== undefined && holder !== accountId) {
                throw new LauncherApiError("REALM_NAME_IS_USERNAME", "That name is another player's username. A realm is named after its host.");
            }
        }
        return requested;
    }

    return {
        /** Claims a realm name for the caller's account (one realm per host account). */
        async createRealm(accountId: string, input: CreateRealmInput): Promise<{ realm: RealmHostView }> {
            Throttle("create", accountId);
            // Check the host first: releasing a dormant name only to find the host cannot use it would cost someone their name.
            if ((await repo.findByHost(accountId)) !== undefined) {
                throw new LauncherApiError("REALM_ALREADY_EXISTS", "You already host a realm. Release it before claiming another name.");
            }
            const name = await RealmNameToClaim(accountId, input.name);
            const nowMs = Now();
            const realmId = NewRealmId();
            const realm: RealmRecord = {
                realmId,
                name,
                hostAccountId: accountId,
                hostPublicKey: input.hostPublicKey,
                joinPolicy: input.joinPolicy,
                listed: input.listed,
                members: [{ accountId, role: "HOST", joinedAt: Iso(nowMs) }],
                bans: [],
                createdAt: Iso(nowMs),
                hubRoomIds: HubRoomIdsOf(realmId)
            };
            if (input.version !== undefined) realm.version = input.version;

            let result = await repo.insertRealm(realm);
            if (result === "NAME_TAKEN") {
                // A dormant realm frees its name for a new claim (3 days never online, 30 days after it was last online).
                const holder = await repo.findByName(realm.name);
                if (holder !== undefined && IsRealmNameReleasable(holder, nowMs)) {
                    if (await repo.deleteRealmIfLastOnline(holder.realmId, holder.lastOnlineAt)) {
                        logger.info(`[Realms] name released realmId=${holder.realmId} name=${holder.name}`);
                        await DropPresenceOfRealm(holder.realmId);
                        result = await repo.insertRealm(realm);
                    }
                }
            }
            if (result === "HOST_HAS_REALM") {
                throw new LauncherApiError("REALM_ALREADY_EXISTS", "You already host a realm. Release it before claiming another name.");
            }
            if (result === "NAME_TAKEN") {
                throw new LauncherApiError("REALM_NAME_TAKEN", "That realm name is taken.");
            }
            logger.info(`[Realms] realm created realmId=${realm.realmId} name=${realm.name} policy=${realm.joinPolicy} listed=${realm.listed}`);
            return { realm: await ToHostView(realm, accountId) };
        },

        /** The realm the caller hosts (full view) and the realms they have joined. */
        async getMine(accountId: string): Promise<{ hosted: RealmHostView | null; memberOf: RealmPublicInfo[] }> {
            Throttle("read", accountId);
            const [hosted, memberships] = await Promise.all([repo.findByHost(accountId), repo.findByMember(accountId, MEMBER_LIST_LIMIT)]);
            return {
                hosted: hosted === undefined ? null : await ToHostView(hosted, accountId),
                memberOf: await PublicInfos(memberships.filter((realm) => realm.hostAccountId !== accountId), accountId)
            };
        },

        async getByName(accountId: string, name: string, knownHostKey?: string): Promise<{ realm: RealmPublicInfo }> {
            Throttle("read", accountId);
            const realm = await repo.findByName(name);
            if (realm === undefined) throw new LauncherApiError("REALM_NOT_FOUND", "There is no realm with that name.");
            return { realm: (await PublicInfos([realm], accountId, knownHostKey))[0] };
        },

        /** What an invite code opens, without using it (the launcher's join popup). */
        async previewInvite(accountId: string, code: string): Promise<{ realm: RealmPublicInfo }> {
            Throttle("join", accountId);
            const invite = await repo.findInvite(code);
            if (invite === undefined) throw new LauncherApiError("REALM_INVITE_INVALID", "That invite code is not valid.");
            if (GetInviteState(invite, Now()) !== "USABLE") {
                throw new LauncherApiError("REALM_INVITE_EXPIRED", "That invite has expired, was revoked or has been used up.");
            }
            const realm = await repo.findById(invite.realmId);
            if (realm === undefined) throw new LauncherApiError("REALM_INVITE_INVALID", "That invite code is not valid.");
            if (realm.bans.some((ban) => ban.accountId === accountId)) {
                throw new LauncherApiError("REALM_BANNED", "You cannot join this realm.");
            }
            return { realm: (await PublicInfos([realm], accountId))[0] };
        },

        async listListed(accountId: string, page: { limit: number; offset: number }): Promise<{ realms: RealmPublicInfo[] }> {
            Throttle("read", accountId);
            // [2026-10-16] A SOLO realm is not offered to others in the directory (it cannot be joined); its host still sees it.
            const listed = (await repo.listListed(page.limit, page.offset))
                .filter((realm) => realm.joinPolicy !== "SOLO" || realm.hostAccountId === accountId);
            return { realms: await PublicInfos(listed, accountId) };
        },

        async updateSettings(accountId: string, settings: RealmSettingsInput): Promise<{ realm: RealmHostView }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            if (!(await repo.setSettings(realm.realmId, accountId, settings))) {
                throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
            }
            const updated = await repo.findById(realm.realmId);
            if (updated === undefined) throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
            logger.info(`[Realms] settings changed realmId=${realm.realmId} policy=${updated.joinPolicy} listed=${updated.listed}`);
            return { realm: await ToHostView(updated, accountId) };
        },

        async createInvite(accountId: string, input: CreateInviteInput): Promise<{ invite: InviteView }> {
            Throttle("invite", accountId);
            const realm = await RequireHostedRealm(accountId);
            const nowMs = Now();
            if ((await repo.countActiveInvites(realm.realmId, Iso(nowMs))) >= Limits.maxActiveInvites) {
                throw new LauncherApiError("REALM_INVITE_LIMIT", `You can have at most ${Limits.maxActiveInvites} open invites; revoke one first.`);
            }
            // 50 random bits make a clash vanishingly rare; the retry is for the unique key, not for guessing luck.
            for (let attempt = 0; attempt < 5; attempt++) {
                const invite = BuildInvite({
                    code: NewInviteCode(),
                    realmId: realm.realmId,
                    createdBy: accountId,
                    nowMs,
                    maxUses: input.maxUses,
                    ttlHours: input.ttlHours
                });
                if ((await repo.insertInvite(invite)) === "INSERTED") {
                    logger.info(`[Realms] invite created realmId=${realm.realmId} maxUses=${invite.maxUses} expiresAt=${invite.expiresAt}`);
                    return { invite: ToInviteView(invite) };
                }
            }
            throw new Error("Could not generate a unique invite code.");
        },

        async listInvites(accountId: string): Promise<{ invites: InviteView[] }> {
            Throttle("read", accountId);
            const realm = await RequireHostedRealm(accountId);
            return { invites: (await repo.listInvites(realm.realmId, INVITE_LIST_LIMIT)).map(ToInviteView) };
        },

        async revokeInvite(accountId: string, code: string): Promise<{ invite: InviteView }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            const invite = await repo.revokeInvite(realm.realmId, code, Iso(Now()));
            if (invite === undefined) throw new LauncherApiError("REALM_INVITE_INVALID", "That invite code is not valid.");
            logger.info(`[Realms] invite revoked realmId=${realm.realmId}`);
            return { invite: ToInviteView(invite) };
        },

        /**
         * Joins a realm by name (a PUBLIC realm, or an invite-only one the caller already belongs to or holds an invite
         * for), by invite code alone, or both. Ownership is checked first, so a launcher that remembers the old host key
         * hears about a new owner before anything else.
         */
        async join(
            accountId: string,
            input: { name?: string; inviteCode?: string; knownHostKey?: string }
        ): Promise<{ realm: RealmPublicInfo; joined: boolean }> {
            Throttle("join", accountId);
            let invite: RealmInviteRecord | undefined;
            if (input.inviteCode !== undefined) {
                invite = await repo.findInvite(input.inviteCode);
                if (invite === undefined) throw new LauncherApiError("REALM_INVITE_INVALID", "That invite code is not valid.");
            }
            let realm: RealmRecord | undefined;
            if (input.name !== undefined) realm = await repo.findByName(input.name);
            else if (invite !== undefined) realm = await repo.findById(invite.realmId);
            if (realm === undefined) throw RealmEntryError("REALM_NOT_FOUND");
            if (invite !== undefined && invite.realmId !== realm.realmId) throw RealmEntryError("REALM_INVITE_INVALID");
            if (input.knownHostKey !== undefined && DetectOwnershipChange({ name: realm.name, hostPublicKey: input.knownHostKey }, realm)) {
                throw RealmEntryError("REALM_OWNER_CHANGED");
            }

            let decision = DecideJoin(realm, accountId, invite, Now());
            if (!decision.allow && decision.reason === "INVITE_REQUIRED" && HasPlayerInvite(realm, accountId)) {
                // [2026-10-16] The host invited this player by name: joining accepts the invite.
                const accepted = await AcceptPlayerInvite(realm, accountId);
                if (!accepted.member) throw RealmEntryError(accepted.code);
                const fresh = (await repo.findById(realm.realmId)) ?? realm;
                return { realm: (await PublicInfos([fresh], accountId))[0], joined: true };
            }
            if (!decision.allow && decision.reason === "INVITE_REQUIRED") {
                // [2026-10-15] No invite on an invite-only realm: ask the host. Approved in the meantime counts as a member's join.
                const requested = await RequestJoin(realm.realmId, accountId);
                if (!requested.member) throw RealmEntryError(requested.code);
                realm = (await repo.findById(realm.realmId)) ?? realm;
                decision = { allow: true, via: "MEMBER" };
            }
            if (!decision.allow) throw RealmEntryError(JOIN_DENIAL_CODES[decision.reason]);
            if (decision.via === "MEMBER") return { realm: (await PublicInfos([realm], accountId))[0], joined: false };

            const admitted = await AdmitMember(realm, accountId, decision.via, invite);
            if (!admitted.ok) throw RealmEntryError(admitted.code);
            const fresh = (await repo.findById(realm.realmId)) ?? realm;
            return { realm: (await PublicInfos([fresh], accountId))[0], joined: admitted.added };
        },

        /**
         * [hub design section 2.1] The realm part of Play (POST /launcher/v1/game-sessions): may this account enter the realm named
         * `name` now? Banned, a new owner (knownHostKey), not a member without a PUBLIC policy or a valid invite, and the host not
         * serving are refused; otherwise the account joins as join() would (an invite is used, the member added) and the answer
         * names the realm. The host itself enters its own realm even when it is not serving: that is how it starts it. The offline
         * check comes before any invite use or membership, so a refused Play costs nothing.
         */
        async authorizeEntry(accountId: string, input: EntryRealmInput): Promise<EntryAuthorization> {
            Throttle("entry", accountId);
            let invite: RealmInviteRecord | undefined;
            if (input.inviteCode !== undefined) {
                invite = await repo.findInvite(input.inviteCode);
                if (invite === undefined) return { ok: false, code: "REALM_INVITE_INVALID" };
            }
            const realm = await repo.findByName(input.name);
            if (realm === undefined) return { ok: false, code: "REALM_NOT_FOUND" };
            if (invite !== undefined && invite.realmId !== realm.realmId) return { ok: false, code: "REALM_INVITE_INVALID" };
            if (input.knownHostKey !== undefined && DetectOwnershipChange({ name: realm.name, hostPublicKey: input.knownHostKey }, realm)) {
                return { ok: false, code: "REALM_OWNER_CHANGED" };
            }
            let decision = DecideJoin(realm, accountId, invite, Now());
            if (!decision.allow && decision.reason === "INVITE_REQUIRED" && HasPlayerInvite(realm, accountId)) {
                // [2026-10-16] Play with a pending player invite accepts it (the offline check below still applies to the game).
                const accepted = await AcceptPlayerInvite(realm, accountId);
                if (!accepted.member) return { ok: false, code: accepted.code };
                decision = { allow: true, via: "MEMBER" };
            }
            if (!decision.allow && decision.reason === "INVITE_REQUIRED") {
                // [2026-10-15] Play on an invite-only realm without an invite: the request is recorded and Play says so.
                const requested = await RequestJoin(realm.realmId, accountId);
                if (!requested.member) return { ok: false, code: requested.code };
                decision = { allow: true, via: "MEMBER" };
            }
            if (!decision.allow) return { ok: false, code: JOIN_DENIAL_CODES[decision.reason] };

            const isHost = realm.hostAccountId === accountId;
            if (!isHost && !IsRealmServing(realm, Now())) return { ok: false, code: "REALM_OFFLINE" };

            if (decision.via !== "MEMBER") {
                const admitted = await AdmitMember(realm, accountId, decision.via, invite);
                if (!admitted.ok) return { ok: false, code: admitted.code };
            }
            return { ok: true, realmId: realm.realmId, isHost };
        },

        async leave(accountId: string, name: string): Promise<{ left: true }> {
            Throttle("write", accountId);
            const realm = await repo.findByName(name);
            if (realm === undefined) throw new LauncherApiError("REALM_NOT_FOUND", "There is no realm with that name.");
            if (realm.hostAccountId === accountId) {
                throw new LauncherApiError("REALM_HOST_CANNOT_LEAVE", "You host this realm. Release it instead of leaving it.");
            }
            if (!(await repo.removeMember(realm.realmId, accountId))) {
                throw new LauncherApiError("REALM_NOT_MEMBER", "You are not a member of this realm.");
            }
            logger.info(`[Realms] member left realmId=${realm.realmId}`);
            await DropPresenceInRealm(accountId, realm.realmId);
            await Emit({ type: "MEMBER_REMOVED", realmId: realm.realmId, accountId, reason: "LEAVE" });
            return { left: true };
        },

        async kick(accountId: string, targetAccountId: string): Promise<{ accountId: string; status: "KICKED" }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            if (targetAccountId === accountId) throw new LauncherApiError("REALM_INVALID_TARGET", "You cannot remove yourself from your own realm.");
            if (!(await repo.removeMember(realm.realmId, targetAccountId))) {
                throw new LauncherApiError("REALM_NOT_MEMBER", "That account is not a member of your realm.");
            }
            logger.info(`[Realms] member kicked realmId=${realm.realmId}`);
            await DropPresenceInRealm(targetAccountId, realm.realmId);
            await Emit({ type: "MEMBER_REMOVED", realmId: realm.realmId, accountId: targetAccountId, reason: "KICK" });
            return { accountId: targetAccountId, status: "KICKED" };
        },

        /** Bans an account (a member or not) and removes it from the members. Repeating a ban changes nothing. */
        async ban(accountId: string, targetAccountId: string, reason?: string): Promise<{ accountId: string; status: "BANNED"; changed: boolean }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            if (targetAccountId === accountId) throw new LauncherApiError("REALM_INVALID_TARGET", "You cannot ban yourself from your own realm.");
            const result = await repo.addBan(
                realm.realmId,
                reason === undefined ? { accountId: targetAccountId, at: Iso(Now()) } : { accountId: targetAccountId, reason, at: Iso(Now()) },
                Limits.maxBans
            );
            if (result === "NOT_FOUND") throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
            if (result === "FULL") throw new LauncherApiError("REALM_FULL", "The ban list is full; lift a ban first.");
            if (result === "BANNED") {
                logger.info(`[Realms] account banned realmId=${realm.realmId}`);
                await DropPresenceInRealm(targetAccountId, realm.realmId);
                await Emit({ type: "MEMBER_REMOVED", realmId: realm.realmId, accountId: targetAccountId, reason: "BAN" });
            }
            return { accountId: targetAccountId, status: "BANNED", changed: result === "BANNED" };
        },

        async unban(accountId: string, targetAccountId: string): Promise<{ accountId: string; status: "UNBANNED"; changed: boolean }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            const changed = await repo.removeBan(realm.realmId, targetAccountId);
            if (changed) logger.info(`[Realms] ban lifted realmId=${realm.realmId}`);
            return { accountId: targetAccountId, status: "UNBANNED", changed };
        },

        // -------------------------------------------------------------------------------------------------------
        // Join requests and adding players, the host's side [2026-10-15]
        // -------------------------------------------------------------------------------------------------------

        /** The players waiting for the host, newest request first. */
        async listJoinRequests(accountId: string): Promise<{ requests: JoinRequestView[] }> {
            Throttle("read", accountId);
            const realm = await RequireHostedRealm(accountId);
            const requests = SortJoinRequestsNewestFirst(realm.joinRequests ?? []);
            const names = await NamesFor(requests.map((request) => request.accountId));
            return {
                requests: requests.map((request) => ({
                    accountId: request.accountId,
                    displayName: names.get(request.accountId) ?? null,
                    at: request.at
                }))
            };
        },

        /**
         * Approves a waiting player: the membership goes through the same addMember as an invite join (a ban or the member cap still
         * apply, and the request stays when the cap refuses it), then the request is removed. REALM_REQUEST_NOT_FOUND when that
         * account has no request.
         */
        async approveJoinRequest(accountId: string, targetAccountId: string): Promise<{ accountId: string; status: "APPROVED" }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            if (!(realm.joinRequests ?? []).some((request) => request.accountId === targetAccountId)) {
                throw new LauncherApiError("REALM_REQUEST_NOT_FOUND", "That player has not asked to join your realm.");
            }
            const added = await repo.addMember(realm.realmId, { accountId: targetAccountId, role: "MEMBER", joinedAt: Iso(Now()) }, Limits.maxMembers);
            switch (added) {
                case "NOT_FOUND": throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
                case "BANNED":
                    await repo.removeJoinRequest(realm.realmId, targetAccountId);
                    throw new LauncherApiError("REALM_BANNED", "That player is banned from your realm.");
                case "FULL": throw new LauncherApiError("REALM_FULL", "This realm cannot take more members.");
            }
            await repo.removeJoinRequest(realm.realmId, targetAccountId);
            logger.info(`[Realms] join request approved realmId=${realm.realmId}`);
            return { accountId: targetAccountId, status: "APPROVED" };
        },

        /** Denies a waiting player: the request is removed (the player may ask again). REALM_REQUEST_NOT_FOUND when there is none. */
        async denyJoinRequest(accountId: string, targetAccountId: string): Promise<{ accountId: string; status: "DENIED" }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            if (!(await repo.removeJoinRequest(realm.realmId, targetAccountId))) {
                throw new LauncherApiError("REALM_REQUEST_NOT_FOUND", "That player has not asked to join your realm.");
            }
            logger.info(`[Realms] join request denied realmId=${realm.realmId}`);
            return { accountId: targetAccountId, status: "DENIED" };
        },

        /**
         * [2026-10-16] Legacy: launchers up to 0.1.68 call this; newer ones invite (invitePlayerByUsername) and the player accepts.
         * The host lets a player in by their launcher username (resolveUsername; case-insensitive). The membership goes through addMember
         * (a ban and the member cap apply); any request the player had is removed. A player already in is answered with added:false.
         */
        async addMemberByUsername(accountId: string, username: string): Promise<{ accountId: string; displayName: string; added: boolean }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            const trimmed = username.trim();
            const target = deps.resolveUsername === undefined ? undefined : await deps.resolveUsername(trimmed);
            if (target === undefined) throw new LauncherApiError("REALM_PLAYER_NOT_FOUND", "No player has that username.");
            const added = await repo.addMember(realm.realmId, { accountId: target, role: "MEMBER", joinedAt: Iso(Now()) }, Limits.maxMembers);
            switch (added) {
                case "NOT_FOUND": throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
                case "BANNED": throw new LauncherApiError("REALM_BANNED", "That player is banned from your realm. Lift the ban first.");
                case "FULL": throw new LauncherApiError("REALM_FULL", "This realm cannot take more members.");
            }
            await repo.removeJoinRequest(realm.realmId, target);
            if (added === "ADDED") logger.info(`[Realms] player added by the host realmId=${realm.realmId}`);
            const displayName = (await NamesFor([target])).get(target) ?? trimmed;
            return { accountId: target, displayName, added: added === "ADDED" };
        },

        // -------------------------------------------------------------------------------------------------------
        // Player invites [2026-10-16]: the host invites by username, the player accepts or declines
        // -------------------------------------------------------------------------------------------------------

        /**
         * The host invites a player by launcher username (resolveUsername; case-insensitive). The player is not a member until they
         * accept. A player who already asked to join (a waiting request) is let in at once: both sides want it. Answers INVITED (an
         * invite is waiting, newly or already) or MEMBER (already in, or let in now).
         */
        async invitePlayerByUsername(
            accountId: string,
            username: string
        ): Promise<{ accountId: string; displayName: string; status: "INVITED" | "MEMBER" }> {
            Throttle("invite", accountId);
            const realm = await RequireHostedRealm(accountId);
            const trimmed = username.trim();
            const target = deps.resolveUsername === undefined ? undefined : await deps.resolveUsername(trimmed);
            if (target === undefined) throw new LauncherApiError("REALM_PLAYER_NOT_FOUND", "No player has that username.");
            if (target === accountId) throw new LauncherApiError("REALM_INVALID_TARGET", "You are the host of this realm.");
            const displayName = (await NamesFor([target])).get(target) ?? trimmed;

            if ((realm.joinRequests ?? []).some((request) => request.accountId === target)) {
                const accepted = await AcceptPlayerInvite(realm, target);
                if (!accepted.member) {
                    if (accepted.code === "REALM_BANNED") throw new LauncherApiError("REALM_BANNED", "That player is banned from your realm. Lift the ban first.");
                    if (accepted.code === "REALM_FULL") throw new LauncherApiError("REALM_FULL", "This realm cannot take more members.");
                    throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
                }
                logger.info(`[Realms] invited player had asked to join; let in realmId=${realm.realmId}`);
                return { accountId: target, displayName, status: "MEMBER" };
            }

            const result = await repo.addPlayerInvite(realm.realmId, { accountId: target, at: Iso(Now()) }, Limits.maxPlayerInvites);
            switch (result) {
                case "NOT_FOUND": throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
                case "BANNED": throw new LauncherApiError("REALM_BANNED", "That player is banned from your realm. Lift the ban first.");
                case "FULL": throw new LauncherApiError("REALM_PLAYER_INVITES_FULL", "Too many invites are waiting for an answer. Cancel one first.");
                case "ALREADY_MEMBER": return { accountId: target, displayName, status: "MEMBER" };
            }
            if (result === "ADDED") logger.info(`[Realms] player invited realmId=${realm.realmId}`);
            return { accountId: target, displayName, status: "INVITED" };
        },

        /** The host withdraws an unanswered invite. REALM_PLAYER_INVITE_NOT_FOUND when that account has none. */
        async cancelPlayerInvite(accountId: string, targetAccountId: string): Promise<{ accountId: string; status: "CANCELLED" }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            if (!(await repo.removePlayerInvite(realm.realmId, targetAccountId))) {
                throw new LauncherApiError("REALM_PLAYER_INVITE_NOT_FOUND", "That player has no invite waiting.");
            }
            logger.info(`[Realms] player invite cancelled realmId=${realm.realmId}`);
            return { accountId: targetAccountId, status: "CANCELLED" };
        },

        /** The invites the caller received and has not answered, newest first. */
        async listMyPlayerInvites(accountId: string): Promise<{ invites: PlayerInviteView[] }> {
            Throttle("read", accountId);
            const realms = await repo.findByPlayerInvite(accountId, MEMBER_LIST_LIMIT);
            const infos = await PublicInfos(realms, accountId);
            const invites = realms.map((realm, index) => ({
                realm: infos[index],
                at: (realm.playerInvites ?? []).find((invite) => invite.accountId === accountId)?.at ?? realm.createdAt
            }));
            invites.sort((a, b) => b.at.localeCompare(a.at));
            return { invites };
        },

        /** The caller accepts an invite to the realm `name`: they become a member (a ban or the member cap still refuse). */
        async acceptPlayerInvite(accountId: string, name: string): Promise<{ realm: RealmPublicInfo; joined: true }> {
            Throttle("write", accountId);
            const realm = await repo.findByName(name);
            if (realm === undefined) throw new LauncherApiError("REALM_NOT_FOUND", "There is no realm with that name.");
            if (!HasPlayerInvite(realm, accountId)) throw new LauncherApiError("REALM_PLAYER_INVITE_NOT_FOUND", "You have no invite to this realm.");
            const accepted = await AcceptPlayerInvite(realm, accountId);
            if (!accepted.member) {
                if (accepted.code === "REALM_BANNED") await repo.removePlayerInvite(realm.realmId, accountId);
                throw RealmEntryError(accepted.code);
            }
            const fresh = (await repo.findById(realm.realmId)) ?? realm;
            return { realm: (await PublicInfos([fresh], accountId))[0], joined: true };
        },

        /** The caller declines an invite: it is removed (the host may invite again). */
        async declinePlayerInvite(accountId: string, name: string): Promise<{ declined: true }> {
            Throttle("write", accountId);
            const realm = await repo.findByName(name);
            if (realm === undefined) throw new LauncherApiError("REALM_NOT_FOUND", "There is no realm with that name.");
            if (!(await repo.removePlayerInvite(realm.realmId, accountId))) {
                throw new LauncherApiError("REALM_PLAYER_INVITE_NOT_FOUND", "You have no invite to this realm.");
            }
            logger.info(`[Realms] player invite declined realmId=${realm.realmId}`);
            return { declined: true };
        },

        /**
         * The host reports in: online for the next 90 s, the name held, the version recorded. `online: false` closes the realm now.
         * `hosting` (what the host's PC will run) replaces the host-chosen limits; an omitted `hosting` leaves them alone.
         */
        async heartbeat(accountId: string, input: HeartbeatInput) {
            Throttle("heartbeat", accountId);
            const realm = await RequireHostedRealm(accountId);
            const update = ApplyHeartbeat(Now(), input);
            if (!(await repo.recordHeartbeat(realm.realmId, accountId, update))) {
                throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
            }
            if (input.hosting !== undefined) {
                // Only the three host-chosen fields: the hub fields belong to the p2p module and are never self-reported.
                await repo.patchHosting(
                    realm.realmId,
                    { maxServers: input.hosting.maxServers, maxPlayers: input.hosting.maxPlayers, afkSeconds: input.hosting.afkSeconds ?? null },
                    Iso(Now())
                );
            }
            return {
                online: input.online !== false,
                lastOnlineAt: update.lastOnlineAt,
                onlineUntil: update.onlineUntil,
                ttlSeconds: HEARTBEAT_ONLINE_MS / 1000,
                version: update.version ?? realm.version ?? null
            };
        },

        /** The host gives the realm up: its name is free at once and its members and invites are gone. */
        async release(accountId: string): Promise<{ released: true }> {
            Throttle("write", accountId);
            const realm = await RequireHostedRealm(accountId);
            if (!(await repo.deleteRealmOfHost(realm.realmId, accountId))) {
                throw new LauncherApiError("REALM_NOT_FOUND", "You do not host a realm.");
            }
            logger.info(`[Realms] realm released realmId=${realm.realmId} name=${realm.name}`);
            await DropPresenceOfRealm(realm.realmId);
            await Emit({ type: "REALM_RELEASED", realmId: realm.realmId, hostAccountId: realm.hostAccountId });
            return { released: true };
        },

        // -------------------------------------------------------------------------------------------------------
        // Presence for the launcher (throttled, answers the section 2.2 shape)
        // -------------------------------------------------------------------------------------------------------

        /** POST /launcher/v1/realms/presence/heartbeat: keeps the caller's presence alive and says where the realm stands. */
        async presenceHeartbeat(accountId: string): Promise<PresenceView> {
            Throttle("heartbeat", accountId);
            return ToPresenceView(await TouchPresence(accountId));
        },

        /** POST /launcher/v1/realms/presence/leave: the game exited. Idempotent. */
        async presenceLeave(accountId: string): Promise<{ left: true }> {
            Throttle("heartbeat", accountId);
            await LeavePresence(accountId);
            return { left: true };
        },

        /** GET /launcher/v1/realms/presence. */
        async presenceStatus(accountId: string): Promise<PresenceView> {
            Throttle("read", accountId);
            return ToPresenceView(await PresenceOf(accountId));
        },

        // -------------------------------------------------------------------------------------------------------
        // For the p2p module (hub design section 2.4): no throttle, no launcher shapes
        // -------------------------------------------------------------------------------------------------------

        /** The account's active realm presence, cached 2 s in this process; undefined when it has none or it has lapsed. */
        presenceOf: PresenceOf,
        /** Replaces the account's presence with this realm, or deletes it with null (what a login does). */
        bindPresence: BindPresence,
        /** Another 120 s for an active presence (never resurrects an expired one); returns it, undefined when there is none. */
        touchPresence: TouchPresence,
        leavePresence: LeavePresence,

        /**
         * Merges what the p2p module knows (hub and Training state, session id, active servers) into the realm's hosting record.
         * Fields the patch does not name keep their value; null removes hubSessionId or afkSeconds. False when the realm is gone.
         */
        async setHosting(realmId: string, patch: RealmHostingPatch): Promise<boolean> {
            const problem = ValidateHostingPatch(patch);
            if (problem !== undefined) throw new Error(`setHosting: invalid ${problem}`);
            return repo.patchHosting(realmId, patch, Iso(Now()));
        },

        /**
         * Ends the realm's online state now (the p2p module ended the hub and does not wait up to 90 s for the heartbeat to lapse).
         * Emits nothing: the caller is the one who knows. False when the realm is gone or was not online.
         */
        async markOffline(realmId: string): Promise<boolean> {
            return repo.markOffline(realmId, Iso(Now()));
        },

        /** The realm one of whose hub room ids this is (HubRoomId); undefined when it is not a hub room id of any realm. */
        async findByHubRoomId(hubRoomId: string): Promise<RealmRecord | undefined> {
            const id = NormalizeHubRoomId(hubRoomId);
            return id === undefined ? undefined : repo.findByHubRoomId(id);
        },

        async getRealm(realmId: string): Promise<RealmRecord | undefined> {
            return repo.findById(realmId);
        },

        async getRealmByHost(hostAccountId: string): Promise<RealmRecord | undefined> {
            return repo.findByHost(hostAccountId);
        },

        async isMember(realmId: string, accountId: string): Promise<boolean> {
            const realm = await repo.findById(realmId);
            return realm !== undefined && realm.members.some((member) => member.accountId === accountId);
        },

        async isBanned(realmId: string, accountId: string): Promise<boolean> {
            const realm = await repo.findById(realmId);
            return realm !== undefined && realm.bans.some((ban) => ban.accountId === accountId);
        },

        /**
         * One sweep: every realm whose online state lapsed within the last 10 minutes and was not noticed yet is claimed (so a lapse
         * is noticed once, even by two backends) and a HOST_OFFLINE event is emitted for it. Returns how many.
         */
        async sweepLapsedHosts(): Promise<number> {
            const nowMs = Now();
            const lapsed = await repo.claimLapsedHosts(Iso(nowMs), Iso(nowMs - SWEEP_LOOKBACK_MS), SWEEP_BATCH);
            for (const realm of lapsed) {
                logger.info(`[Realms] host offline realmId=${realm.realmId}`);
                await Emit({ type: "HOST_OFFLINE", realmId: realm.realmId, hostAccountId: realm.hostAccountId });
            }
            return lapsed.length;
        }
    };
}
