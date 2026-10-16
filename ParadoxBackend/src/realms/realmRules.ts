/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { RealmHosting, RealmHostingPatch, RealmHubKind, RealmHubState, RealmInviteRecord, RealmRecord } from "./realmTypes";

// [2026-10-13 realms S2] The realm rules as pure functions (no database, no clock of their own: callers pass `nowMs`),
// so every decision the routes make is unit-tested without MongoDB. Names, name release, ownership change, invite codes
// and validity, the join decision and online state follow HOSTING_TIERS_AND_REALMS_PLAN section 5.6 and section 7.

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ---------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------

export const REALM_NAME_PATTERN = /^[a-z0-9-]{3,24}$/;

/**
 * Names nobody may claim: they would read as the official server, a staff account or the service itself. Matched
 * against the name with its hyphens removed, so "o-fficial" and "mystic-paradox" are refused as well.
 */
export const RESERVED_REALM_NAMES: readonly string[] = Object.freeze([
    "official", "paradox", "mysticparadox", "mystic", "mysticfox", "admin", "administrator", "support", "mod", "moderator",
    "staff", "system", "root", "dauntless", "phoenixlabs", "launcher", "backend", "directory", "realm", "realms", "api", "www",
    "help", "security", "owner", "team", "local", "dedicated", "default"
]);
const ReservedSet = new Set(RESERVED_REALM_NAMES);

export type RealmNameCheck = { ok: true; name: string } | { ok: false; reason: "INVALID" | "RESERVED" };

/** Trims and lower-cases a name the player typed; undefined when it is not a string. Does not validate. */
export function NormalizeRealmName(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.length > 256) return undefined;
    return raw.trim().toLowerCase();
}

export function IsReservedRealmName(name: string): boolean {
    return ReservedSet.has(name.replace(/-/g, ""));
}

/** Format first (3-24 of a-z, 0-9 and hyphen; no leading or trailing hyphen), then the reserved list. */
export function ValidateRealmName(raw: unknown): RealmNameCheck {
    const name = NormalizeRealmName(raw);
    if (name === undefined || !REALM_NAME_PATTERN.test(name) || name.startsWith("-") || name.endsWith("-")) {
        return { ok: false, reason: "INVALID" };
    }
    if (IsReservedRealmName(name)) return { ok: false, reason: "RESERVED" };
    return { ok: true, name };
}

/**
 * [2026-10-16, owner] A realm is named after its host's username: MysticFox hosts "mysticfox" (the launcher shows "MysticFox's
 * Realm"), and other players add it by typing that username. Lower case; any other character (a legacy underscore or dot) becomes a
 * hyphen, runs of them collapse and none is kept at either end. Undefined when the result is not a realm name, for example an
 * account with no username yet (its placeholder is the 36-character account id). The reserved list does not apply: the name is the
 * host's own username, which the username policy already checked.
 */
export function RealmNameForUsername(username: unknown): string | undefined {
    if (typeof username !== "string" || username.length > 256) return undefined;
    const name = username.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return REALM_NAME_PATTERN.test(name) ? name : undefined;
}

/** A realm that was never online frees its name this long after it was created. */
export const NEVER_ONLINE_RELEASE_MS = 3 * MS_PER_DAY;
/** A realm that was online at least once frees its name this long after it was last online. */
export const LAST_ONLINE_RELEASE_MS = 30 * MS_PER_DAY;

/** When the realm's name becomes free for someone else (epoch ms); undefined when the record's dates are unreadable. */
export function RealmNameReleaseAt(realm: Pick<RealmRecord, "createdAt" | "lastOnlineAt">): number | undefined {
    const base = realm.lastOnlineAt !== undefined
        ? Date.parse(realm.lastOnlineAt) + LAST_ONLINE_RELEASE_MS
        : Date.parse(realm.createdAt) + NEVER_ONLINE_RELEASE_MS;
    return Number.isFinite(base) ? base : undefined;
}

/**
 * Whether someone else may claim this realm's name now. A record with unreadable dates is never released automatically
 * (an operator has to look at it).
 */
export function IsRealmNameReleasable(realm: Pick<RealmRecord, "createdAt" | "lastOnlineAt">, nowMs: number): boolean {
    const releaseAt = RealmNameReleaseAt(realm);
    return releaseAt !== undefined && nowMs >= releaseAt;
}

/** True when a name the launcher knew (with the host key it showed the player then) is now held by a different host key. */
export function DetectOwnershipChange(
    previous: Pick<RealmRecord, "name" | "hostPublicKey">,
    current: Pick<RealmRecord, "name" | "hostPublicKey">
): boolean {
    return previous.name.toLowerCase() === current.name.toLowerCase() && previous.hostPublicKey !== current.hostPublicKey;
}

// ---------------------------------------------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------------------------------------------

/** 32 symbols with no I, O, 0 or 1: easy to read out loud and to type. 32 divides 256, so a masked random byte is unbiased. */
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 10;
const InviteCodePattern = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

export const INVITE_DEFAULT_MAX_USES = 10;
export const INVITE_MAX_USES_LIMIT = 100;
export const INVITE_DEFAULT_TTL_HOURS = 168;
export const INVITE_MAX_TTL_HOURS = 720;

export function GenerateInviteCode(randomBytes: (size: number) => Uint8Array = crypto.randomBytes): string {
    const bytes = randomBytes(INVITE_CODE_LENGTH);
    let code = "";
    for (let index = 0; index < INVITE_CODE_LENGTH; index++) code += INVITE_ALPHABET[bytes[index] & 31];
    return code;
}

/** The code as the host shares it ("abcde-fghjk", spaces) down to its stored form; undefined when it cannot be a code. */
export function NormalizeInviteCode(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.length > 40) return undefined;
    const code = raw.replace(/[\s-]/g, "").toUpperCase();
    return InviteCodePattern.test(code) ? code : undefined;
}

export type InviteState = "USABLE" | "REVOKED" | "EXPIRED" | "EXHAUSTED";

export function GetInviteState(
    invite: Pick<RealmInviteRecord, "expiresAt" | "maxUses" | "uses" | "revokedAt">,
    nowMs: number
): InviteState {
    if (invite.revokedAt !== undefined) return "REVOKED";
    const expiresAt = Date.parse(invite.expiresAt);
    if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) return "EXPIRED";
    if (invite.uses >= invite.maxUses) return "EXHAUSTED";
    return "USABLE";
}

export function IsInviteUsable(invite: Pick<RealmInviteRecord, "expiresAt" | "maxUses" | "uses" | "revokedAt">, nowMs: number): boolean {
    return GetInviteState(invite, nowMs) === "USABLE";
}

export function BuildInvite(input: {
    code: string;
    realmId: string;
    createdBy: string;
    nowMs: number;
    maxUses: number;
    ttlHours: number;
}): RealmInviteRecord {
    return {
        code: input.code,
        realmId: input.realmId,
        createdBy: input.createdBy,
        createdAt: new Date(input.nowMs).toISOString(),
        expiresAt: new Date(input.nowMs + input.ttlHours * MS_PER_HOUR).toISOString(),
        maxUses: input.maxUses,
        uses: 0
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------------------------------------------

export type JoinDecision =
    | { allow: true; via: "MEMBER" | "PUBLIC" | "INVITE" }
    | { allow: false; reason: "BANNED" | "SOLO" | "INVITE_REQUIRED" | "INVITE_INVALID" | "INVITE_EXPIRED" };

/**
 * Who may join (plan section 5.6): a banned account never, whatever else is true (so the host's ban also beats an old
 * invite); [2026-10-16] in a SOLO realm nobody but the host, members included (no invite is used, no request is stored); a member
 * or the host already is in; a PUBLIC realm lets anyone in; an INVITE_ONLY realm needs a valid invite of this realm.
 * `via: "INVITE"` tells the caller to consume one use of that invite.
 */
export function DecideJoin(
    realm: Pick<RealmRecord, "realmId" | "joinPolicy" | "members" | "bans"> & Partial<Pick<RealmRecord, "hostAccountId">>,
    accountId: string,
    invite: RealmInviteRecord | undefined,
    nowMs: number
): JoinDecision {
    if (realm.bans.some((ban) => ban.accountId === accountId)) return { allow: false, reason: "BANNED" };
    if (realm.joinPolicy === "SOLO" && accountId !== realm.hostAccountId) return { allow: false, reason: "SOLO" };
    if (realm.members.some((member) => member.accountId === accountId)) return { allow: true, via: "MEMBER" };
    if (realm.joinPolicy === "PUBLIC") return { allow: true, via: "PUBLIC" };
    if (invite === undefined) return { allow: false, reason: "INVITE_REQUIRED" };
    if (invite.realmId !== realm.realmId) return { allow: false, reason: "INVITE_INVALID" };
    if (!IsInviteUsable(invite, nowMs)) return { allow: false, reason: "INVITE_EXPIRED" };
    return { allow: true, via: "INVITE" };
}

// ---------------------------------------------------------------------------------------------------------------
// Join requests [2026-10-15]
// ---------------------------------------------------------------------------------------------------------------

/**
 * The host's list of join requests: newest first. ISO strings of one shape compare correctly as text; requests with the same time
 * keep the order they were stored in (the sort is stable).
 */
export function SortJoinRequestsNewestFirst<T extends { at: string }>(requests: readonly T[]): T[] {
    return [...requests].sort((a, b) => b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------------------------------------------------------
// Online state
// ---------------------------------------------------------------------------------------------------------------

/** Each host heartbeat keeps the realm online for this long; the launcher is expected to report every 30 s or so. */
export const HEARTBEAT_ONLINE_MS = 90_000;

export function IsRealmOnline(realm: Pick<RealmRecord, "onlineUntil">, nowMs: number): boolean {
    if (realm.onlineUntil === undefined) return false;
    const until = Date.parse(realm.onlineUntil);
    return Number.isFinite(until) && until > nowMs;
}

/**
 * [2026-10-13 realms hub design section 2.3] Serving = the host is online AND its Ramsgate hub is running. Entry and routing use
 * this; a host that is online with no hub (starting, stopped, crashed) is not serving.
 */
export function IsRealmServing(realm: Pick<RealmRecord, "onlineUntil" | "hosting">, nowMs: number): boolean {
    return IsRealmOnline(realm, nowMs) && realm.hosting?.hubState === "RUNNING";
}

/** The hub itself is running (whatever the host's online state). */
export function IsRealmHubReady(realm: Pick<RealmRecord, "hosting">): boolean {
    return realm.hosting?.hubState === "RUNNING";
}

export interface HeartbeatUpdate {
    lastOnlineAt: string;
    onlineUntil: string;
    version?: string;
}

/**
 * The fields one host heartbeat writes. A normal heartbeat keeps the realm online for 90 s; `online: false` is the
 * host closing its realm on purpose (online state ends now, and it still counts as online-at-least-once, so the name
 * is held for 30 days). The version is only included when the host reported one.
 */
export function ApplyHeartbeat(nowMs: number, input: { online?: boolean; version?: string } = {}): HeartbeatUpdate {
    const now = new Date(nowMs).toISOString();
    const update: HeartbeatUpdate = {
        lastOnlineAt: now,
        onlineUntil: input.online === false ? now : new Date(nowMs + HEARTBEAT_ONLINE_MS).toISOString()
    };
    if (input.version !== undefined) update.version = input.version;
    return update;
}

// ---------------------------------------------------------------------------------------------------------------
// Hosting (what the host's PC runs; section 2.3 of the hub design)
// ---------------------------------------------------------------------------------------------------------------

export const HOSTING_MAX_SERVERS_LIMIT = 8;
export const HOSTING_MAX_PLAYERS_LIMIT = 64;
export const HOSTING_MAX_AFK_SECONDS = 7200;
export const HOSTING_ACTIVE_SERVERS_LIMIT = 64;
const HOSTING_SESSION_ID_MAX_LENGTH = 128;

/** What a realm that never reported `hosting` is taken to have: one server, the hub's default player count, nothing running. */
export const DEFAULT_HOSTING: Readonly<Omit<RealmHosting, "updatedAt">> = Object.freeze({
    maxServers: 1,
    maxPlayers: 16,
    hubState: "NONE" as RealmHubState,
    trainingState: "NONE" as RealmHubState,
    activeServers: 0
});

const HUB_STATES: readonly string[] = ["NONE", "STARTING", "RUNNING", "STOPPING"];

function IsIntInRange(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Fills the gaps of a stored hosting record (a partial one is what a patch onto a realm without hosting leaves behind); undefined
 * when the realm has none.
 */
export function NormalizeHosting(raw: Partial<RealmHosting> | null | undefined, fallbackUpdatedAt: string): RealmHosting | undefined {
    if (raw === undefined || raw === null) return undefined;
    const hosting: RealmHosting = {
        maxServers: raw.maxServers ?? DEFAULT_HOSTING.maxServers,
        maxPlayers: raw.maxPlayers ?? DEFAULT_HOSTING.maxPlayers,
        hubState: raw.hubState ?? DEFAULT_HOSTING.hubState,
        trainingState: raw.trainingState ?? DEFAULT_HOSTING.trainingState,
        activeServers: raw.activeServers ?? DEFAULT_HOSTING.activeServers,
        updatedAt: raw.updatedAt ?? fallbackUpdatedAt
    };
    if (raw.afkSeconds !== undefined && raw.afkSeconds !== null) hosting.afkSeconds = raw.afkSeconds;
    if (raw.hubSessionId !== undefined && raw.hubSessionId !== null) hosting.hubSessionId = raw.hubSessionId;
    return hosting;
}

/** The keys of RealmHostingPatch a repository may write (everything else in a patch is dropped). */
export const HOSTING_PATCH_KEYS = [
    "maxServers", "maxPlayers", "afkSeconds", "hubSessionId", "hubState", "trainingState", "activeServers"
] as const;

/**
 * The hosting record after a patch: defaults fill a realm that had none, named fields change, null removes an optional field,
 * undefined and unknown keys are ignored, and updatedAt is stamped from the caller's clock. Pure (the in-memory repository's rule;
 * the MongoDB one does the same with dotted $set / $unset).
 */
export function ApplyHostingPatch(current: Partial<RealmHosting> | undefined, patch: RealmHostingPatch, updatedAtIso: string): RealmHosting {
    const next: Record<string, unknown> = { ...(NormalizeHosting(current ?? { ...DEFAULT_HOSTING, updatedAt: updatedAtIso }, updatedAtIso)) };
    for (const key of HOSTING_PATCH_KEYS) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else next[key] = value;
    }
    next.updatedAt = updatedAtIso;
    return next as unknown as RealmHosting;
}

/** The first problem with a hosting patch from the p2p module (trusted code, but a typo must not corrupt a realm), or undefined. */
export function ValidateHostingPatch(patch: RealmHostingPatch): string | undefined {
    if (patch.maxServers !== undefined && !IsIntInRange(patch.maxServers, 1, HOSTING_MAX_SERVERS_LIMIT)) return "maxServers";
    if (patch.maxPlayers !== undefined && !IsIntInRange(patch.maxPlayers, 1, HOSTING_MAX_PLAYERS_LIMIT)) return "maxPlayers";
    if (patch.afkSeconds !== undefined && patch.afkSeconds !== null && !IsIntInRange(patch.afkSeconds, 0, HOSTING_MAX_AFK_SECONDS)) return "afkSeconds";
    if (patch.activeServers !== undefined && !IsIntInRange(patch.activeServers, 0, HOSTING_ACTIVE_SERVERS_LIMIT)) return "activeServers";
    if (patch.hubState !== undefined && !HUB_STATES.includes(patch.hubState)) return "hubState";
    if (patch.trainingState !== undefined && !HUB_STATES.includes(patch.trainingState)) return "trainingState";
    if (patch.hubSessionId !== undefined && patch.hubSessionId !== null
        && (typeof patch.hubSessionId !== "string" || patch.hubSessionId.length < 1 || patch.hubSessionId.length > HOSTING_SESSION_ID_MAX_LENGTH)) {
        return "hubSessionId";
    }
    return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Hub room ids
// ---------------------------------------------------------------------------------------------------------------

const HUB_KINDS: readonly string[] = ["RAMSGATE", "TRAINING"];
const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The stable id of a realm's hub as the game and the chat see it (the matchmaker's GameSessionId and the City-<id> room): the first
 * 16 bytes of SHA-256 over a fixed label, the realm id and the hub kind, laid out as a UUID (version 5 and RFC 4122 variant bits
 * set, lower case). The same realm and kind always give the same id, so the room survives hub restarts.
 */
export function HubRoomId(realmId: string, hubKind: RealmHubKind): string {
    if (typeof realmId !== "string" || realmId.length === 0) throw new Error("HubRoomId needs a realm id.");
    if (!HUB_KINDS.includes(hubKind)) throw new Error(`HubRoomId: unknown hub kind ${String(hubKind)}.`);
    const bytes = Buffer.from(crypto.createHash("sha256").update(`paradox-realm-hub:v1:${realmId}:${hubKind}`).digest().subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Both hub room ids of a realm, in the order stored on the record. */
export function HubRoomIdsOf(realmId: string): string[] {
    return [HubRoomId(realmId, "RAMSGATE"), HubRoomId(realmId, "TRAINING")];
}

/** The canonical (lower-case) form of a UUID-shaped string a caller sent as a hub room id; undefined when it is not one. */
export function NormalizeHubRoomId(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.length !== 36) return undefined;
    const id = raw.toLowerCase();
    return UuidPattern.test(id) ? id : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Presence (a member's current realm context; section 2.2 of the hub design)
// ---------------------------------------------------------------------------------------------------------------

/** Each bind and touch keeps the presence active for this long. */
export const PRESENCE_TTL_MS = 120_000;
/** How long a process trusts its own answer to presenceOf before it asks the database again. */
export const PRESENCE_CACHE_MS = 2_000;
// [2026-10-14 realms wave 2, presence coalescing] A touch writes only when the row needs it. The launcher and the game touch every
// few seconds per player, so an unconditional write per touch was almost all of the realms store's write load.
/** A touch writes once the row's lastSeenAt is older than this. */
export const PRESENCE_TOUCH_WRITE_AFTER_MS = 30_000;
/** A touch also writes when the row expires in less than this. */
export const PRESENCE_TOUCH_MIN_LEFT_MS = 60_000;

/**
 * True when a touch at `nowMs` must write the row (extend it), false when the row can be answered as it is. Touches at most 60 s
 * apart never let a row lapse: a write sets lastSeenAt to its time, so the next write comes by the first touch after 30 s, at most
 * 60 s after the touch before it, which is at most 90 s after the write, while the row lives 120 s.
 */
export function PresenceTouchNeedsWrite(row: { lastSeenAt: string; expiresAt: string }, nowMs: number): boolean {
    return nowMs - Date.parse(row.lastSeenAt) > PRESENCE_TOUCH_WRITE_AFTER_MS || Date.parse(row.expiresAt) - nowMs < PRESENCE_TOUCH_MIN_LEFT_MS;
}
