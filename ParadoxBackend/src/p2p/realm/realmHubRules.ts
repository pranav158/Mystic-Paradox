/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import type { LauncherErrorCode } from "../../security/launcherErrors";
import type { P2PHuntSessionRecord, P2PHuntState } from "../persistence/contracts/P2PHuntRepository";
import type { RealmHubKind, RealmHubPresenceRecord, RealmHubPresenceState } from "../persistence/contracts/RealmHubRepository";
import { DEFAULT_HUB_MAX_PLAYERS, MAXIMUM_HUB_MAX_PLAYERS } from "./hubManifests";

// [2026-10-13 realms S1] The pure rules of a realm's hub (SteamDocs/PARADOX_REALMS_HUB_DESIGN_2026_10_13.md sections 3.1
// and 4): which session is a hub, its state machine and lease clock, the presence transitions, who may get an admission
// ticket, and the capacity decisions. No I/O and no clock: callers pass `now`, so every rule has a table test
// (realmHubRules.test.ts), and the MongoDB and in-memory repositories both apply the same transition tables.

export type { RealmHubKind } from "../persistence/contracts/RealmHubRepository";
export const REALM_HUB_KINDS: readonly RealmHubKind[] = ["RAMSGATE", "TRAINING"];

export function IsRealmHub(hunt: Pick<P2PHuntSessionRecord, "sessionKind"> | undefined): boolean {
    return hunt?.sessionKind === "REALM_HUB";
}

/** A session of a Paradox realm: its hub or (a later stage) one of its hunts. */
export function IsRealmSession(hunt: Pick<P2PHuntSessionRecord, "realmId"> | undefined): boolean {
    return hunt?.realmId != undefined;
}

/** The activePartyKey and partyId of a hub: unique while the hub lives, so a realm has one live hub per kind. */
export function HubPartyKey(realmId: string, hubKind: RealmHubKind): string {
    return `realmhub:${realmId}:${hubKind.toLowerCase()}`;
}

export function IsRealmHubKind(value: unknown): value is RealmHubKind {
    return value === "RAMSGATE" || value === "TRAINING";
}

// ---------------------------------------------------------------------------------------------------------------
// What a matchmaking request of a realm member asks for (section 3.1; used by the routing stage)
// ---------------------------------------------------------------------------------------------------------------

export type RealmRequestClass = RealmHubKind | "HUNT";

/**
 * `CITY`, or a hunt id containing `ReturnToRamsgate`, is the realm's Ramsgate. A hunt id containing `TrainingDojo` (the client
 * sends the Training Grounds as GameMode SHARED) is its Training hub. Anything else is a hunt. The hub tests are by hunt id
 * like the shared matchmaker's own hub rule (controllers/matchmaking.ts IsHubDestination), whatever the game mode.
 */
export function ClassifyRealmRequest(gameMode: string | undefined, huntId: string | undefined): RealmRequestClass {
    if (gameMode === "CITY") return "RAMSGATE";
    if (typeof huntId === "string") {
        if (huntId.includes("ReturnToRamsgate")) return "RAMSGATE";
        if (huntId.includes("TrainingDojo")) return "TRAINING";
    }
    return "HUNT";
}

// ---------------------------------------------------------------------------------------------------------------
// Start request
// ---------------------------------------------------------------------------------------------------------------

export type ParsedHubStart =
    | { ok: true; hubKind: RealmHubKind; maxPlayers: number }
    | { ok: false; message: string };

/** The body of POST /launcher/v1/realm-hosting/hubs/start: { hubKind, maxPlayers? (1..64, default 16) }. */
export function ParseHubStartBody(body: unknown): ParsedHubStart {
    const input = (body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "The request body must be an object." };
    if (!IsRealmHubKind(input.hubKind)) return { ok: false, message: "hubKind must be RAMSGATE or TRAINING." };
    let maxPlayers = DEFAULT_HUB_MAX_PLAYERS;
    if (input.maxPlayers !== undefined) {
        if (typeof input.maxPlayers !== "number" || !Number.isInteger(input.maxPlayers) ||
            input.maxPlayers < 1 || input.maxPlayers > MAXIMUM_HUB_MAX_PLAYERS) {
            return { ok: false, message: `maxPlayers must be a whole number from 1 to ${MAXIMUM_HUB_MAX_PLAYERS}.` };
        }
        maxPlayers = input.maxPlayers;
    }
    return { ok: true, hubKind: input.hubKind, maxPlayers };
}

/** The body of POST .../hubs/stop: { hubKind }. */
export function ParseHubStopBody(body: unknown): { ok: true; hubKind: RealmHubKind } | { ok: false; message: string } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "The request body must be an object." };
    const hubKind = (body as Record<string, unknown>).hubKind;
    return IsRealmHubKind(hubKind) ? { ok: true, hubKind } : { ok: false, message: "hubKind must be RAMSGATE or TRAINING." };
}

// ---------------------------------------------------------------------------------------------------------------
// Hub state machine (section 4.2)
//
//   HOST_OFFERED --host-bootstrap--> STARTING --host-ready--> HOST_READY --host route-ready--> ADMITTING
//        --host admitted locally--> RUNNING;  RUNNING --lease lapsed--> SUSPECT --lease back--> RUNNING
//   SUSPECT --suspect deadline--> ABORTED;  any live state --stop--> COMPLETED or ABORTED
// ---------------------------------------------------------------------------------------------------------------

export const HUB_LIVE_STATES: readonly P2PHuntState[] = ["HOST_OFFERED", "STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"];
export const HUB_TERMINAL_STATES: readonly P2PHuntState[] = ["COMPLETED", "ABORTED"];
/** States in which the host's runtime holds a live credential (the capability exists from STARTING on). */
export const HUB_RUNTIME_STATES: readonly P2PHuntState[] = ["STARTING", "HOST_READY", "ADMITTING", "RUNNING", "SUSPECT"];
/** States whose lease the host keeps renewing. */
export const HUB_LEASED_STATES: readonly P2PHuntState[] = ["HOST_READY", "ADMITTING", "RUNNING"];

export type HubEvent =
    | "HOST_BOOTSTRAP" | "HOST_READY" | "HOST_ROUTE_READY" | "HOST_ADMITTED"
    | "LEASE_LAPSED" | "LEASE_BACK" | "SUSPECT_TIMEOUT" | "STOP" | "ABORT";

const HUB_TRANSITIONS: Record<HubEvent, { from: readonly P2PHuntState[]; to: P2PHuntState | "PRE_SUSPECT" }> = {
    HOST_BOOTSTRAP: { from: ["HOST_OFFERED"], to: "STARTING" },
    HOST_READY: { from: ["STARTING", "HOST_READY"], to: "HOST_READY" },
    HOST_ROUTE_READY: { from: ["HOST_READY"], to: "ADMITTING" },
    HOST_ADMITTED: { from: ["ADMITTING"], to: "RUNNING" },
    LEASE_LAPSED: { from: HUB_LEASED_STATES, to: "SUSPECT" },
    LEASE_BACK: { from: ["SUSPECT"], to: "PRE_SUSPECT" },
    SUSPECT_TIMEOUT: { from: ["SUSPECT"], to: "ABORTED" },
    STOP: { from: HUB_LIVE_STATES, to: "COMPLETED" },
    ABORT: { from: HUB_LIVE_STATES, to: "ABORTED" }
};

/** The state `event` moves a hub in `state` to, or undefined when the event does not apply there. */
export function NextHubState(state: P2PHuntState, event: HubEvent, preSuspectState?: P2PHuntState): P2PHuntState | undefined {
    const rule = HUB_TRANSITIONS[event];
    if (!rule.from.includes(state)) return undefined;
    if (rule.to !== "PRE_SUSPECT") return rule.to;
    return preSuspectState != undefined && HUB_LEASED_STATES.includes(preSuspectState) ? preSuspectState : undefined;
}

export function IsHubTransitionAllowed(from: P2PHuntState, to: P2PHuntState): boolean {
    return (Object.keys(HUB_TRANSITIONS) as HubEvent[]).some((event) => {
        const rule = HUB_TRANSITIONS[event];
        if (!rule.from.includes(from)) return false;
        return rule.to === "PRE_SUSPECT" ? from === "SUSPECT" && HUB_LEASED_STATES.includes(to) : rule.to === to;
    });
}

export function IsHubLive(state: P2PHuntState): boolean {
    return HUB_LIVE_STATES.includes(state);
}

/** Hub liveness for writes and tickets: exactly RUNNING (a SUSPECT hub that was RUNNING is judged by the write rules). */
export function HubRan(hub: Pick<P2PHuntSessionRecord, "state" | "preSuspectState">): boolean {
    return hub.state === "RUNNING" || (hub.state === "SUSPECT" && hub.preSuspectState === "RUNNING");
}

export type HubTickAction =
    | { action: "NONE" }
    | { action: "SUSPECT"; reason: string }
    | { action: "RECOVER" }
    | { action: "END"; terminal: "ABORTED"; reason: string };

export interface HubTickInput {
    nowMs: number;
    emergencyStop: boolean;
    /** MYSTICPARADOX_REALMS_HOSTING and P2P_HUNTS_ENABLED are both on. */
    hostingEnabled: boolean;
}

function Lapsed(at: string | undefined, nowMs: number): boolean {
    return at != undefined && Date.parse(at) <= nowMs;
}

/**
 * What the lifecycle monitor does with one live hub on this tick (section 4.2). Hunt-only logic never runs for a hub: no
 * HostLossIsCleanEnd, no participant-observation quorum (with an empty roster `Math.min(2, roster.length)` is 0 and a hub
 * would be suspected at once), no recovery.
 */
export function DecideHubTick(
    hub: Pick<P2PHuntSessionRecord, "state" | "expiresAt" | "offerExpiresAt" | "startupDeadline" | "leaseExpiresAt" |
        "suspectDeadline" | "preSuspectState">,
    input: HubTickInput
): HubTickAction {
    if (!IsHubLive(hub.state)) return { action: "NONE" };
    if (input.emergencyStop) return { action: "END", terminal: "ABORTED", reason: "OPERATOR_P2P_STOP" };
    if (!input.hostingEnabled) return { action: "END", terminal: "ABORTED", reason: "REALM_HOSTING_DISABLED" };
    if (Lapsed(hub.expiresAt, input.nowMs)) return { action: "END", terminal: "ABORTED", reason: "HUB_SESSION_EXPIRED" };
    switch (hub.state) {
        case "HOST_OFFERED":
            return Lapsed(hub.offerExpiresAt, input.nowMs) ? { action: "END", terminal: "ABORTED", reason: "HUB_OFFER_EXPIRED" } : { action: "NONE" };
        case "STARTING":
            return Lapsed(hub.startupDeadline, input.nowMs) ? { action: "END", terminal: "ABORTED", reason: "HUB_STARTUP_TIMEOUT" } : { action: "NONE" };
        case "HOST_READY":
        case "ADMITTING":
            // The host reported ready but never published its own route: the startup deadline still applies.
            if (Lapsed(hub.startupDeadline, input.nowMs)) return { action: "END", terminal: "ABORTED", reason: "HUB_STARTUP_TIMEOUT" };
            return Lapsed(hub.leaseExpiresAt, input.nowMs) ? { action: "SUSPECT", reason: "HOST_LEASE_MISSED" } : { action: "NONE" };
        case "RUNNING":
            return Lapsed(hub.leaseExpiresAt, input.nowMs) ? { action: "SUSPECT", reason: "HOST_LEASE_MISSED" } : { action: "NONE" };
        case "SUSPECT":
            if (hub.leaseExpiresAt != undefined && !Lapsed(hub.leaseExpiresAt, input.nowMs) &&
                NextHubState("SUSPECT", "LEASE_BACK", hub.preSuspectState) != undefined) return { action: "RECOVER" };
            return Lapsed(hub.suspectDeadline, input.nowMs) ? { action: "END", terminal: "ABORTED", reason: "HOST_LEASE_LOST" } : { action: "NONE" };
        default:
            return { action: "NONE" };
    }
}

/** Ending reasons that count as a failure of the host (a lost lease, a dead process, a start that never finished). */
const HOST_FAILURE_REASONS: ReadonlySet<string> = new Set(["HOST_LEASE_LOST", "HOST_PROCESS_UNHEALTHY", "HUB_STARTUP_TIMEOUT"]);

export function HubEndCountsAsHostFailure(reason: string): boolean {
    return HOST_FAILURE_REASONS.has(reason);
}

// ---------------------------------------------------------------------------------------------------------------
// Presence transitions (section 4.3)
//
//   PENDING --join-bootstrap--> TICKETED --tickets/consume--> ADMITTED
//   PENDING / TICKETED past their expiry --> EXPIRED;  ADMITTED --peer disconnect--> LOST
//   ADMITTED --went to a hunt--> LEFT;  any live row --kick, ban, release--> REMOVED;  hub ended --> LOST
//   an ADMITTED, LOST, LEFT, EXPIRED or REMOVED row (or an expired one) starts over with a new entry
// ---------------------------------------------------------------------------------------------------------------

/** "Present" in the hub is exactly ADMITTED. */
export const PRESENCE_PRESENT_STATES: readonly RealmHubPresenceState[] = ["ADMITTED"];
/** Rows a hub still counts on: expected (PENDING, TICKETED) or connected (ADMITTED). */
export const PRESENCE_LIVE_STATES: readonly RealmHubPresenceState[] = ["PENDING", "TICKETED", "ADMITTED"];
/** Rows that wait for the member and expire. */
export const PRESENCE_EXPIRING_STATES: readonly RealmHubPresenceState[] = ["PENDING", "TICKETED"];
export const PRESENCE_ALL_STATES: readonly RealmHubPresenceState[] = ["PENDING", "TICKETED", "ADMITTED", "LOST", "LEFT", "REMOVED", "EXPIRED"];

export type HubPresenceEvent =
    | "ENTRY_STARTED" | "TICKET_ISSUED" | "ADMITTED" | "DISCONNECTED" | "TRAVELLED" | "EXPIRED" | "REMOVED" | "SESSION_ENDED";

export const PRESENCE_TRANSITIONS: Readonly<Record<HubPresenceEvent, { from: readonly RealmHubPresenceState[]; to: RealmHubPresenceState }>> = {
    ENTRY_STARTED: { from: PRESENCE_ALL_STATES, to: "PENDING" },
    TICKET_ISSUED: { from: ["PENDING", "TICKETED"], to: "TICKETED" },
    ADMITTED: { from: ["PENDING", "TICKETED", "ADMITTED"], to: "ADMITTED" },
    DISCONNECTED: { from: ["ADMITTED"], to: "LOST" },
    TRAVELLED: { from: ["ADMITTED"], to: "LEFT" },
    EXPIRED: { from: ["PENDING", "TICKETED"], to: "EXPIRED" },
    REMOVED: { from: PRESENCE_LIVE_STATES, to: "REMOVED" },
    SESSION_ENDED: { from: PRESENCE_LIVE_STATES, to: "LOST" }
};

export function NextPresenceState(from: RealmHubPresenceState, event: HubPresenceEvent): RealmHubPresenceState | undefined {
    const rule = PRESENCE_TRANSITIONS[event];
    return rule.from.includes(from) ? rule.to : undefined;
}

/** How long a PENDING row waits for the member (a new request refreshes it). */
export const ENTRY_LIFETIME_MS = 90_000;
/** How long a row stays after it stopped being live. */
export const PRESENCE_PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function EntryExpiresAt(nowMs: number): string {
    return new Date(nowMs + ENTRY_LIFETIME_MS).toISOString();
}

export function PresencePurgeAt(atMs: number): string {
    return new Date(atMs + PRESENCE_PURGE_AFTER_MS).toISOString();
}

/** A waiting row (PENDING or TICKETED) whose time ran out. Other states do not expire. */
export function IsPresenceExpired(row: Pick<RealmHubPresenceRecord, "state" | "expiresAt">, nowIso: string): boolean {
    return PRESENCE_EXPIRING_STATES.includes(row.state) && row.expiresAt <= nowIso;
}

/** True when the row counts as live at `nowIso`: connected, or waiting and not expired. */
export function IsPresenceLive(row: Pick<RealmHubPresenceRecord, "state" | "expiresAt">, nowIso: string): boolean {
    return PRESENCE_LIVE_STATES.includes(row.state) && !IsPresenceExpired(row, nowIso);
}

export type EntryRequestDecision = "CREATE" | "REUSE" | "REENTER";

/**
 * What an entry request does with the account's existing row (see RealmHubRepository.requestEntry): create one, reuse a
 * waiting one (so a repeated request of the same attempt neither churns the candidate nor invalidates a ticket in flight), or
 * start over (ADMITTED, LOST, LEFT, EXPIRED, REMOVED or an expired wait).
 */
export function DecideEntryRequest(existing: Pick<RealmHubPresenceRecord, "state" | "expiresAt"> | undefined, nowIso: string): EntryRequestDecision {
    if (existing == undefined) return "CREATE";
    return PRESENCE_EXPIRING_STATES.includes(existing.state) && !IsPresenceExpired(existing, nowIso) ? "REUSE" : "REENTER";
}

// ---------------------------------------------------------------------------------------------------------------
// Admission ticket eligibility (section 4.4)
// ---------------------------------------------------------------------------------------------------------------

export type HubTicketDenial =
    | "HUB_NOT_RUNNING"
    | "HUB_EXPIRED"
    | "GENERATION_MISMATCH"
    | "IS_HOST"
    | "NOT_EXPECTED"
    | "ENTRY_EXPIRED"
    | "BANNED"
    | "NOT_MEMBER"
    | "PEER_LINK_MISSING"
    | "PEER_ID_MISMATCH";

export interface HubTicketCheck {
    hub: Pick<P2PHuntSessionRecord, "state" | "generation" | "expiresAt" | "hostAccountId">;
    /** The generation the request names (the hub's, as the launcher knows it); omitted when the route has none. */
    generation?: number;
    accountId: string;
    presence: Pick<RealmHubPresenceRecord, "state" | "expiresAt" | "peerId"> | undefined;
    isMember: boolean;
    isBanned: boolean;
    /** The account's verified transport link, if any. */
    link: { status: string; steamId: string } | undefined;
    nowMs: number;
}

/**
 * Why the account may not be issued an admission ticket for the hub right now, or undefined. The hub must be RUNNING, the
 * account must have a PENDING or TICKETED entry that has not expired, still be a member and not banned, and have a VERIFIED
 * transport link whose peer id is the one the entry froze.
 */
export function HubTicketDenialReason(check: HubTicketCheck): HubTicketDenial | undefined {
    if (check.hub.state !== "RUNNING") return "HUB_NOT_RUNNING";
    if (Date.parse(check.hub.expiresAt) <= check.nowMs) return "HUB_EXPIRED";
    if (check.generation != undefined && check.generation !== check.hub.generation) return "GENERATION_MISMATCH";
    if (check.accountId === check.hub.hostAccountId) return "IS_HOST";
    const presence = check.presence;
    if (presence == undefined || !PRESENCE_EXPIRING_STATES.includes(presence.state)) return "NOT_EXPECTED";
    if (IsPresenceExpired(presence, new Date(check.nowMs).toISOString())) return "ENTRY_EXPIRED";
    if (check.isBanned) return "BANNED";
    if (!check.isMember) return "NOT_MEMBER";
    if (check.link == undefined || check.link.status !== "VERIFIED") return "PEER_LINK_MISSING";
    if (check.link.steamId !== presence.peerId) return "PEER_ID_MISMATCH";
    return undefined;
}

/** The launcher error code and message of a ticket denial. */
export function HubTicketDenialError(reason: HubTicketDenial): { code: LauncherErrorCode; message: string } {
    switch (reason) {
        case "HUB_NOT_RUNNING":
        case "HUB_EXPIRED":
            return { code: "P2P_SESSION_NOT_READY", message: "The realm's hub is not accepting players." };
        case "GENERATION_MISMATCH":
            return { code: "P2P_GENERATION_FENCED", message: "This request belongs to a stale hub generation." };
        case "IS_HOST":
        case "NOT_EXPECTED":
        case "ENTRY_EXPIRED":
            return { code: "P2P_NOT_ROSTERED", message: "This account has no open entry into the hub." };
        case "BANNED":
            return { code: "REALM_BANNED", message: "You cannot join this realm." };
        case "NOT_MEMBER":
            return { code: "REALM_NOT_MEMBER", message: "You are not a member of this realm." };
        case "PEER_LINK_MISSING":
        case "PEER_ID_MISMATCH":
            return { code: "P2P_STEAM_LINK_REQUIRED", message: "The current co-op transport no longer matches this hub entry." };
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------------------------------------------

export interface RealmCapacityInput {
    /** Live sessions the host runs for the realm (the hub, Training and hunts count). */
    activeServers: number;
    /** The realm's limit (the host's choice, 1..8). */
    maxServers: number;
    freePhysicalMemoryMiB: number;
    commitHeadroomMiB: number;
    minimumFreeMemoryMiB: number;
    minimumCommitHeadroomMiB: number;
}

export type RealmCapacityDecision =
    | { ok: true; lowFreeMemory?: true }
    | { ok: false; reason: "REALM_SERVER_LIMIT" | "HOST_COMMIT_LOW" };

/**
 * Whether the host can take one more server: under the realm's limit and with the commit headroom the policy asks for.
 * [2026-10-16] Realm servers start like a dedicated server's: low FREE physical memory no longer refuses, it is reported as
 * `lowFreeMemory` for the caller to log. A hub or hunt server uses about 1.4 GB (private commit ~1.4 GB); Windows pages to make
 * room, and what can actually end a server is running out of commit, which still refuses (HOST_COMMIT_LOW). The old 3 GB
 * free-memory floor refused every Training and island start on PCs with little free memory and plenty of commit headroom.
 */
export function DecideRealmCapacity(input: RealmCapacityInput): RealmCapacityDecision {
    if (input.activeServers >= input.maxServers) return { ok: false, reason: "REALM_SERVER_LIMIT" };
    if (input.commitHeadroomMiB < input.minimumCommitHeadroomMiB) return { ok: false, reason: "HOST_COMMIT_LOW" };
    if (input.freePhysicalMemoryMiB < input.minimumFreeMemoryMiB) return { ok: true, lowFreeMemory: true };
    return { ok: true };
}

/** [2026-10-16] The log line of a start that goes ahead on a host short of free physical memory (DecideRealmCapacity). */
export function RealmLowMemoryNote(realmId: string, what: string, input: Pick<RealmCapacityInput, "freePhysicalMemoryMiB" | "commitHeadroomMiB" | "minimumFreeMemoryMiB">): string {
    return `[RealmCapacity] realm ${realmId} ${what} starts on a host with ${input.freePhysicalMemoryMiB} MiB free physical memory ` +
        `(floor ${input.minimumFreeMemoryMiB} MiB, logged only) and ${input.commitHeadroomMiB} MiB commit headroom`;
}

/** A hub with `presentCount` members present is full when it holds `maxPeers`; a member already present is never refused. */
export function HubIsFull(presentCount: number, maxPeers: number, alreadyPresent = false): boolean {
    return !alreadyPresent && presentCount >= maxPeers;
}
