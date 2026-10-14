/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { CooldownStateRecord } from "./persistence/mapping/domainTypes";
import { IsRuntimeRosterTarget } from "./security/runtimeRoster";
import { ActiveSeasonWindowMs } from "./seasonWindow";

/*
 * Per-account cooldowns for GET /cooldown/:userId and PUT /cooldown/batch/:userId (UCooldownComponent).
 *
 * Root cause of two "every arrival" bugs (38_ section 19.7): both routes were stubs - the GET always answered an empty
 * payload and the PUT discarded what the server sent. The game keeps its once-per-period gates there:
 *   - UBountyComponent_Daily::ServerInitializeBounties (FUN_1419da980) looks up its bounty cooldown, logs
 *     "bounty cooldown not found. player: %s. using hunt pass start: %s" when it is missing, and so treats every
 *     arrival as a new day: RemoveBountyTokens drains the draft tokens, the inventory loader's default-item top-up
 *     (AArchonInventory::GetUnownedItems grants the full 4 whenever fewer are owned) adds 4 back, and the daily bounty is
 *     re-drafted;
 *   - the PERIODIC_REWARD Blueprint that grants TOKEN_DAILY_PATROL_BONUS x2 writes its cooldown ~100 ms after the grant,
 *     and finds none on the next arrival.
 *
 * Wire shape - the two directions differ:
 *   PUT  <- { cooldowns: [{ cooldown_id, cooldown_started_date }] }       (serializer FUN_141a2ddef / FUN_141a2e220)
 *   GET  -> payload { "<cooldown_id>": "<ISO-8601 start date>", ... }     (a map)
 *   PUT /cooldown/:userId/:cooldownId (no body) starts one cooldown at the backend's now - controllers/cooldowns.ts.
 * The GET shape is from UCooldownComponent::OnQueryCooldownDataRequestComplete (0x01A2106A, disassembled): it walks the
 * payload as a TMap (FUN_1409f0220 is the map iterator) and parses each value with FDateTime::ParseIso8601
 * (FUN_142618830) into the component's { id, FDateTime } array. Serving the PUT's list shape instead was measured on
 * 10 Oct 14:22: the component reported its backend data loaded but held only the 2 entries set locally that session,
 * and every daily-bounty lookup missed (runtime [CooldownTrace]). Dates are stored and served exactly as the game wrote them. A PUT sets the listed cooldowns (the latest write for an
 * id wins) and removes no others, apart from gatherable ids past GATHERABLE_RETENTION_MS. Writes need dedicated-server authority: a player rewinding a start date would be
 * able to collect a periodic reward again.
 */

export const MAX_COOLDOWNS_PER_SAVE = 256;
export const MAX_STORED_COOLDOWNS = 1024;
const MAX_ID_LENGTH = 200;
const MAX_DATE_LENGTH = 64;

/*
 * Seasonal city gatherables ("sprouts") store one entry per harvested node, keyed by the node's 32-hex tracking GUID
 * (PUT /cooldown/:userId/:cooldownId, controllers/cooldowns.ts) - about ten new ids a day per account, which would
 * eventually push long-lived ids (season43, bounty_daily, GRANT_*) out of MAX_STORED_COOLDOWNS. The game decides
 * availability itself: OnQueryGatherableDataRequestComplete (0x141A71900) marks a node available when
 * GetLastRespawnGatherableTime (0x141A06950) is not earlier than its date, and an id missing from the map counts as
 * available too (IsGatherableAvailable 0x141A69A20). With the daily respawn ("Daily Collectibles"), an entry older than
 * the last respawn - at most 24 h ago - reads the same as a missing one, so dropping it after 48 h changes nothing the
 * game can see. Assumes RespawnGatherableTimerMinutes <= 48 h (not read from the GameMode yet).
 */
const GATHERABLE_ID_PATTERN = /^[0-9A-Fa-f]{32}$/;
export const GATHERABLE_RETENTION_MS = 48 * 60 * 60 * 1000;

export function IsExpiredGatherableCooldown(id: string, startedDate: string, now: string): boolean {
    if (!GATHERABLE_ID_PATTERN.test(id)) return false;
    const Started = Date.parse(startedDate);
    const Now = Date.parse(now);
    // An unparsable date keeps the entry: dropping it would report the node available.
    return Number.isFinite(Started) && Number.isFinite(Now) && Now - Started > GATHERABLE_RETENTION_MS;
}

export class CooldownSaveValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CooldownSaveValidationError";
    }
}

export function IsAuthorizedCooldownWriter(authData: any): boolean {
    return authData?.IsGameserver === true;
}

// [2026-10-13 realms S3] A player-host runtime (AuthData.IsPlayerHostRuntime, never IsGameserver) writes the cooldowns of
// its realm's members under the hostWrites hooks (route: authorize "COOLDOWN", MergeHostCooldownState, record). It is not
// an IsAuthorizedCooldownWriter, so every dedicated and player path stays as it was.
export function IsHostCooldownWriter(authData: any): boolean {
    return authData?.IsPlayerHostRuntime === true && authData?.IsGameserver !== true;
}

// [2026-10-11 P2P, plan 39_ §13.1 B8] A player-host runtime may read the cooldowns of its own hunt's roster: its
// UCooldownComponent loads them on every arrival like a dedicated server's, and the 403 left it without the daily
// bounty and patrol gates (the every-arrival re-draft of 38_ §19.7). Writes stay dedicated-only until host writes get
// per-hunt caps (decision 1 of 39_ §13).
export function IsAuthorizedCooldownReader(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    if (authData?.IsPlayerHostRuntime === true) return IsRuntimeRosterTarget(authData, targetUserId);
    return typeof authData?.userId === "string" && authData.userId === targetUserId;
}

export interface CooldownEntry {
    cooldown_id: string;
    cooldown_started_date: string;
}

/** Accepts `{ cooldowns: [...] }` (the serializer's shape) or a bare array; returns the validated entries. */
export function ValidateCooldownSave(body: unknown): CooldownEntry[] {
    const List = Array.isArray(body) ? body : (body != null && typeof body === "object" ? (body as any).cooldowns : undefined);
    if (!Array.isArray(List)) throw new CooldownSaveValidationError("cooldowns must be an array");
    if (List.length > MAX_COOLDOWNS_PER_SAVE) throw new CooldownSaveValidationError(`too many cooldowns (${List.length})`);
    return List.map((Entry: any) => {
        const Id = Entry?.cooldown_id;
        const Started = Entry?.cooldown_started_date;
        if (typeof Id !== "string" || Id.length === 0 || Id.length > MAX_ID_LENGTH) {
            throw new CooldownSaveValidationError("every cooldown needs a cooldown_id string");
        }
        if (typeof Started !== "string" || Started.length === 0 || Started.length > MAX_DATE_LENGTH || Number.isNaN(Date.parse(Started))) {
            throw new CooldownSaveValidationError(`cooldown ${Id} needs a cooldown_started_date date string`);
        }
        return { cooldown_id: Id, cooldown_started_date: Started };
    });
}

export function MergeCooldownState(
    userId: string,
    previous: CooldownStateRecord | undefined,
    body: unknown,
    now: string = new Date().toISOString()
): CooldownStateRecord {
    const Incoming = ValidateCooldownSave(body);
    const IncomingIds = new Set(Incoming.map((Entry) => Entry.cooldown_id));
    const Entries = new Map<string, { startedDate: string; updatedAt: string }>();
    for (const Entry of previous?.entries ?? []) {
        // Pruned at write time; the ids this save writes are never pruned (see GATHERABLE_RETENTION_MS).
        if (!IncomingIds.has(Entry.id) && IsExpiredGatherableCooldown(Entry.id, Entry.startedDate, now)) continue;
        Entries.set(Entry.id, { startedDate: Entry.startedDate, updatedAt: Entry.updatedAt });
    }
    for (const Entry of Incoming) Entries.set(Entry.cooldown_id, { startedDate: Entry.cooldown_started_date, updatedAt: now });

    let List = [...Entries.entries()].map(([Id, Value]) => ({ id: Id, startedDate: Value.startedDate, updatedAt: Value.updatedAt }));
    if (List.length > MAX_STORED_COOLDOWNS) {
        // Keep the most recently written ones.
        List = List.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_STORED_COOLDOWNS);
    }
    return {
        userId,
        entries: List,
        updateVersion: (previous?.updateVersion ?? 0) + 1,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// [2026-10-13 realms S3] Host writes: a cooldown may only move later.
//
// A cooldown start date is a once-per-period gate (the daily bounty draft, the patrol bonus, a harvested sprout): moving it
// earlier, or dropping it, re-opens the gate and pays the reward again. A dedicated server is trusted not to; a host runs on
// a player's PC (SteamDocs/PARADOX_REALMS_PLAN_2026_10_13.md section 4.1: "a cooldown may only move later - a host never
// resets a daily gate"). So for a host's save, per id:
//   - not stored yet            -> accepted ("added");
//   - date later or equal       -> accepted ("raised" / unchanged);
//   - date earlier than stored  -> the stored date is kept ("keptLater"), the rest of the save still applies - a stale
//                                  server that loaded the cooldowns before another session moved them must not lose its
//                                  other writes, and the attempt is tagged for behaviour analysis;
// a save never deletes an id (it did not before either). It also cannot evict: MAX_STORED_COOLDOWNS drops the longest-unwritten
// entries first, which is exactly the daily gates, so a host may add new ids only while the store has room ("droppedNew").
//
// [2026-10-13 realms S3 limits] A future start date is NOT free: "may only move later" would let a host set any far-future date
// and lock a friend's daily gate for good (the stored date can then never be moved earlier again by anyone but a dedicated
// server). The real dates the game writes are all near: `bounty_daily` is the next 17:00 UTC (<= 24 h ahead), GRANT_* ids are
// past day starts, sprouts are "now", and the season pass id (`season43`) is the pass window's end (<= the end of the current
// ActiveSeasonWindow, ~12 weeks at most). So a host's date is refused ("refusedFuture", the stored date kept, the rest of the
// save applies) when it is more than HOST_COOLDOWN_MAX_FUTURE_MS ahead of the backend's clock, or, for a season id, later than
// the end of the current window. Writing back the very date that is already stored is not a refusal (it changes nothing).

export const HOST_COOLDOWN_MAX_FUTURE_MS = 48 * 60 * 60 * 1000;
const SEASON_COOLDOWN_ID_PATTERN = /^season\d+[a-z]?$/i;

/** `season43`, `season10a`: the hunt-pass ids, whose cooldown is the pass window's end. */
export function IsSeasonCooldownId(id: string): boolean {
    return SEASON_COOLDOWN_ID_PATTERN.test(id);
}

/** The latest start date (instant) a host may write for cooldown `id` when the backend's clock reads `nowMs`. */
export function HostCooldownLatestMs(id: string, nowMs: number): number {
    return IsSeasonCooldownId(id) ? ActiveSeasonWindowMs(nowMs).endMs : nowMs + HOST_COOLDOWN_MAX_FUTURE_MS;
}

const MAX_RECORDED_COOLDOWN_CHANGES = 20;

export interface HostCooldownChanges {
    received: number;
    unchanged: number;
    /** New ids accepted (capped list; `addedCount` is the real number). */
    added: { id: string; to: string }[];
    addedCount: number;
    /** Existing ids moved later: from -> to (capped list; the previous value allows a reversal). */
    raised: { id: string; from: string; to: string }[];
    raisedCount: number;
    /** Existing ids the save tried to move earlier; the stored date was kept. */
    keptLater: { id: string; stored: string; attempted: string }[];
    keptLaterCount: number;
    /** New ids refused because the store was full. */
    droppedNew: number;
    /** [2026-10-13 realms S3 limits] Dates refused for lying too far ahead (capped list; the count is the real number);
     *  `latest` is the limit that applied, `stored` the date that was kept (absent for a new id, which was not stored). */
    refusedFuture: { id: string; attempted: string; latest: string; stored?: string }[];
    refusedFutureCount: number;
}

export function MergeHostCooldownState(
    userId: string,
    previous: CooldownStateRecord | undefined,
    body: unknown,
    now: string = new Date().toISOString()
): { record: CooldownStateRecord; changes: HostCooldownChanges } {
    const Incoming = ValidateCooldownSave(body);
    const Stored = new Map<string, string>();
    for (const Entry of previous?.entries ?? []) Stored.set(Entry.id, Entry.startedDate);
    let Room = MAX_STORED_COOLDOWNS - Stored.size;
    const ParsedNow = Date.parse(now);
    const NowMs = Number.isFinite(ParsedNow) ? ParsedNow : Date.now();

    const Accepted: CooldownEntry[] = [];
    const Changes: HostCooldownChanges = {
        received: Incoming.length, unchanged: 0, added: [], addedCount: 0, raised: [], raisedCount: 0, keptLater: [], keptLaterCount: 0, droppedNew: 0,
        refusedFuture: [], refusedFutureCount: 0,
    };
    for (const Entry of Incoming) {
        const Id = Entry.cooldown_id;
        const Current = Stored.get(Id);
        // [2026-10-13 realms S3 limits] Too far ahead: refused, the stored date (if any) stays. The very date already stored is
        // not a refusal. This runs before the room check so a refused new id costs no room.
        const Latest = HostCooldownLatestMs(Id, NowMs);
        if (Date.parse(Entry.cooldown_started_date) > Latest && !(Current !== undefined && Date.parse(Current) === Date.parse(Entry.cooldown_started_date))) {
            Changes.refusedFutureCount++;
            if (Changes.refusedFuture.length < MAX_RECORDED_COOLDOWN_CHANGES) {
                Changes.refusedFuture.push({ id: Id, attempted: Entry.cooldown_started_date, latest: new Date(Latest).toISOString(), ...(Current !== undefined ? { stored: Current } : {}) });
            }
            continue;
        }
        if (Current === undefined) {
            if (Room <= 0) { Changes.droppedNew++; continue; }
            Room--;
            Changes.addedCount++;
            if (Changes.added.length < MAX_RECORDED_COOLDOWN_CHANGES) Changes.added.push({ id: Id, to: Entry.cooldown_started_date });
        } else {
            const CurrentMs = Date.parse(Current);
            const NextMs = Date.parse(Entry.cooldown_started_date);
            if (Number.isFinite(CurrentMs) && NextMs < CurrentMs) {
                Changes.keptLaterCount++;
                if (Changes.keptLater.length < MAX_RECORDED_COOLDOWN_CHANGES) Changes.keptLater.push({ id: Id, stored: Current, attempted: Entry.cooldown_started_date });
                continue;
            }
            if (NextMs === CurrentMs) Changes.unchanged++;
            else {
                Changes.raisedCount++;
                if (Changes.raised.length < MAX_RECORDED_COOLDOWN_CHANGES) Changes.raised.push({ id: Id, from: Current, to: Entry.cooldown_started_date });
            }
        }
        Accepted.push(Entry);
        // A later duplicate of the same id in this save is judged against what was just accepted.
        Stored.set(Id, Entry.cooldown_started_date);
    }
    return { record: MergeCooldownState(userId, previous, { cooldowns: Accepted }, now), changes: Changes };
}

/** The stored cooldowns as a list (for logs and tests). */
export function CooldownList(record: CooldownStateRecord | undefined): CooldownEntry[] {
    return (record?.entries ?? []).map((Entry) => ({ cooldown_id: Entry.id, cooldown_started_date: Entry.startedDate }));
}

/** The GET payload: a map of cooldown id -> ISO start date, the shape OnQueryCooldownDataRequestComplete reads. */
export function CooldownStatePayload(record: CooldownStateRecord | undefined): Record<string, string> {
    const Payload: Record<string, string> = Object.create(null);
    for (const Entry of record?.entries ?? []) Payload[Entry.id] = Entry.startedDate;
    return { ...Payload };
}
