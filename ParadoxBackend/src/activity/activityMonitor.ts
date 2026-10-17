/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "../logger";
import { GetRepositories } from "../persistence";
import type { ActivityHuntResult, ActivityRepository } from "../persistence/contracts/ActivityRepository";
import { LogToken } from "../diagnostics/economyLedgerMonitor";
import {
    ACTIVITY_HUNT_MAX_MS,
    ActivityTtlAt,
    AdvancePlaytime,
    ClassifyLauncherBuild,
    CurrentActivitySettings,
    DailyFlagCandidates,
    DayOf,
    HuntLootWindow,
    InventoryActivityInput,
    InventoryIncrements,
    IsIgnoredActivitySource,
    MinutesBetween,
    SafeKey
} from "./activityRules";
import type { LauncherBuildReport, LauncherBuildVerdict } from "./activityRules";

/*
 * [2026-10-14] Activity monitor (in-game activity for fairness and exploit review; the Privacy Policy describes it). Monitoring only:
 * nothing here refuses, limits or changes a grant, a hunt or a session, and a failure here never fails the request it observes: every
 * public recorder catches its own errors and logs one line. Daily counters are batched in memory and written every few seconds as
 * $inc upserts (one per account and day), so a request costs no database round trip. A batch that fails to write is kept for the
 * next flush. MYSTICPARADOX_ACTIVITY_MONITOR=off stops every write (the admin reads still answer with what exists).
 *
 *   [ActivityMon] FLAG <kind> user= day= severity= ...   a flag was raised (review them at /admin/v1/activity/flags)
 *   [ActivityMon] <label> not recorded user= ...          a write failed (the grant or request went on)
 *   [Activity] flushed accountDays=N counters=M           counts only, at most once a minute, for a flush that wrote something
 */

const FLUSH_INTERVAL_MS = 5000;
const NO_PLAYER_ID = "INVALID";
const MAX_RAISED_FLAG_KEYS = 20000;

let StoreOverride: ActivityRepository | undefined;

/** Tests: write to this store (undefined uses the configured persistence provider again). */
export function UseActivityStoreForTest(store: ActivityRepository | undefined): void {
    StoreOverride = store;
}

function Store(): ActivityRepository {
    return StoreOverride ?? GetRepositories().activity;
}

interface PendingDaily {
    userId: string;
    day: string;
    increments: Record<string, number>;
}

const Pending = new Map<string, PendingDaily>();
const PlaytimeLastTouch = new Map<string, number>();
// [2026-10-16] When each account's running game last touched the backend (the same touches as PlaytimeLastTouch), kept whether
// or not the monitor is on: matchmaking asks it whether a party member's game is running (IsGameRecentlyActive), because a game
// on a realm or player-hosted server holds no XMPP socket, and the release gate counts it as playing (RecentlyActiveAccountIds).
const GameLastSeen = new Map<string, number>();
const RaisedFlags = new Set<string>();
let FlushTimer: ReturnType<typeof setTimeout> | undefined;
let Flushing: Promise<void> | undefined;

function AddDaily(userId: string, day: string, increments: Record<string, number>): void {
    // The no-player sentinel of the progression and bounty routes is not an account.
    if (userId === NO_PLAYER_ID || userId.length === 0) return;
    const Key = `${userId}:${day}`;
    const Entry: PendingDaily = Pending.get(Key) ?? { userId, day, increments: {} };
    for (const [Path, Amount] of Object.entries(increments)) {
        if (Amount !== 0) Entry.increments[Path] = (Entry.increments[Path] ?? 0) + Amount;
    }
    Pending.set(Key, Entry);
    if (FlushTimer === undefined) {
        FlushTimer = setTimeout(() => {
            FlushTimer = undefined;
            void FlushActivity().catch(() => undefined);
        }, FLUSH_INTERVAL_MS);
        FlushTimer.unref?.();
    }
}

/**
 * [2026-10-15] The [Activity] flush line: counts only (account-days written, counter units added), never an account id. At most one
 * line a minute, and only for a pass that wrote something; the counts of the passes in between are added to the next line.
 */
const FLUSH_LOG_INTERVAL_MS = 60 * 1000;

export interface FlushLogState { lastLoggedAtMs: number; accountDays: number; counters: number }

/** What one flush pass wrote. */
export interface FlushWritten { accountDays: number; counters: number }

/** Pure: folds one pass's writes into the pending counts and returns the line to log when one is due. */
export function StepFlushLog(state: FlushLogState, written: FlushWritten, nowMs: number): { state: FlushLogState; line?: string } {
    if (written.accountDays <= 0) return { state };
    const accountDays = state.accountDays + written.accountDays;
    const counters = state.counters + written.counters;
    if (nowMs - state.lastLoggedAtMs < FLUSH_LOG_INTERVAL_MS) return { state: { ...state, accountDays, counters } };
    return {
        state: { lastLoggedAtMs: nowMs, accountDays: 0, counters: 0 },
        line: `[Activity] flushed accountDays=${accountDays} counters=${counters}`
    };
}

let FlushLog: FlushLogState = { lastLoggedAtMs: 0, accountDays: 0, counters: 0 };

/** Writes every pending daily batch, then evaluates the flags of each row it wrote. One failed key stops the pass and is kept. */
export async function FlushActivity(): Promise<void> {
    if (Flushing !== undefined) {
        await Flushing;
        return;
    }
    Flushing = (async () => {
        const Written: FlushWritten = { accountDays: 0, counters: 0 };
        while (Pending.size > 0) {
            const [Key, Entry] = Pending.entries().next().value as [string, PendingDaily];
            Pending.delete(Key);
            let After: Record<string, any>;
            try {
                After = await Store().addToDaily({ userId: Entry.userId, day: Entry.day }, Entry.increments, ActivityTtlAt(Entry.day));
                Written.accountDays += 1;
                Written.counters += Object.values(Entry.increments).reduce((Total, Amount) => Total + Amount, 0);
            } catch (Err) {
                // Keep the counts for the next flush (added to anything that arrived meanwhile), and stop this pass.
                const Kept = Pending.get(Key) ?? { ...Entry, increments: {} };
                for (const [Path, Amount] of Object.entries(Entry.increments)) {
                    Kept.increments[Path] = (Kept.increments[Path] ?? 0) + Amount;
                }
                Pending.set(Key, Kept);
                logger.warn(`[ActivityMon] daily counters not stored user=${LogToken(Entry.userId)} day=${Entry.day}: ${String(Err)}`);
                break;
            }
            // The counters are stored: a failed flag write is logged and not retried, so the counters are never counted twice.
            try {
                await RaiseDailyFlags(Entry.userId, Entry.day, After);
            } catch (Err) {
                logger.warn(`[ActivityMon] flags not raised user=${LogToken(Entry.userId)} day=${Entry.day}: ${String(Err)}`);
            }
        }
        const Step = StepFlushLog(FlushLog, Written, Date.now());
        FlushLog = Step.state;
        if (Step.line !== undefined) logger.info(Step.line);
        // Forget playtime touches older than the session gap: they can no longer extend a session.
        const Cutoff = Date.now() - 2 * 60 * 60 * 1000;
        for (const [UserId, Last] of PlaytimeLastTouch) {
            if (Last < Cutoff) PlaytimeLastTouch.delete(UserId);
        }
        for (const [UserId, Last] of GameLastSeen) {
            if (Last < Cutoff) GameLastSeen.delete(UserId);
        }
    })().finally(() => { Flushing = undefined; });
    await Flushing;
}

/** Tests and shutdown: writes everything pending (a few rounds, so a flush started meanwhile is awaited too). */
export async function WaitForActivityWrites(): Promise<void> {
    for (let Round = 0; Round < 3 && (Pending.size > 0 || Flushing !== undefined); Round++) {
        await FlushActivity();
    }
}

/** How many account-days are waiting for their write (tests). */
export function PendingActivityKeysForTest(): number {
    return Pending.size;
}

async function RaiseFlag(Flag: { kind: string; severity: "review" | "high"; userId: string; day: string; detail: string }): Promise<void> {
    const Id = `${Flag.kind}:${Flag.userId}:${Flag.day}`;
    if (RaisedFlags.has(Id)) return;
    const Inserted = await Store().insertFlagIfAbsent({
        _id: Id,
        kind: Flag.kind,
        severity: Flag.severity,
        userId: Flag.userId,
        day: Flag.day,
        detail: Flag.detail,
        status: "open",
        createdAt: new Date().toISOString(),
        ttlAt: ActivityTtlAt(Flag.day)
    });
    if (RaisedFlags.size < MAX_RAISED_FLAG_KEYS) RaisedFlags.add(Id);
    if (Inserted) {
        logger.warn(`[ActivityMon] FLAG ${Flag.kind} user=${LogToken(Flag.userId)} day=${Flag.day} severity=${Flag.severity} ${Flag.detail}`);
    }
}

async function RaiseDailyFlags(userId: string, day: string, row: Record<string, any>): Promise<void> {
    for (const Candidate of DailyFlagCandidates(row ?? {}, CurrentActivitySettings())) {
        await RaiseFlag({ kind: Candidate.kind, severity: Candidate.severity, userId, day, detail: Candidate.detail });
    }
}

function Quietly(label: string, userId: string, work: () => Promise<void>): Promise<void> {
    return work().catch((Err) => {
        logger.warn(`[ActivityMon] ${label} not recorded user=${LogToken(userId)}: ${String(Err)}`);
    });
}

// ---- playtime and sessions ----

/**
 * A presence touch of a running game: the game session's creation, the matchmaking heartbeat (`/candidate/player/alive`, about every
 * 5 s) and the realm presence heartbeat (every 30 s). Counts playtime for an interval up to the session gap and starts a session after
 * a longer one. In memory only: a restart restarts the count of the account's current session.
 */
export function TouchGameSession(userId: string, nowMs: number = Date.now()): void {
    try {
        if (typeof userId !== "string" || userId.length === 0) return;
        // [2026-10-16] Recorded first, monitor or not (GameLastSeen); only the playtime counting below is the monitor's.
        GameLastSeen.set(userId, Math.max(nowMs, GameLastSeen.get(userId) ?? nowMs));
        if (GameLastSeen.size > 100_000) PruneGameLastSeen(nowMs);
        if (!CurrentActivitySettings().enabled) return;
        const Step = AdvancePlaytime(PlaytimeLastTouch.get(userId), nowMs);
        PlaytimeLastTouch.set(userId, Math.max(nowMs, PlaytimeLastTouch.get(userId) ?? nowMs));
        if (Step.sessionStarted) AddDaily(userId, DayOf(nowMs), { sessions: 1 });
        for (const Segment of Step.segments) {
            if (Segment.minutes > 0) AddDaily(userId, Segment.day, { playtimeMinutes: Segment.minutes });
        }
    } catch (Err) {
        logger.warn(`[ActivityMon] playtime not recorded user=${LogToken(userId)}: ${String(Err)}`);
    }
}

/**
 * [2026-10-15] The accounts whose running game touched the backend within `withinMs` (the presence touches above: the
 * matchmaking heartbeat about every 5 s, the realm presence heartbeat every 30 s, a game session's start). The operator
 * dashboard counts them as online: a game on a realm or player-hosted server holds no XMPP socket. [2026-10-16] Read from
 * GameLastSeen, so it answers with the monitor off too (it was empty then).
 */
export function RecentlyActiveAccountIds(withinMs: number, nowMs: number = Date.now()): string[] {
    const Active: string[] = [];
    for (const [UserId, LastTouch] of GameLastSeen) {
        if (nowMs - LastTouch <= withinMs) Active.push(UserId);
    }
    return Active;
}

/**
 * [2026-10-16] Whether `userId`'s running game touched the backend within `withinMs` (TouchGameSession: a game session's start, the
 * matchmaking heartbeat, the realm presence heartbeat every 30 s). Matchmaking counts such a party member as online: on this backend
 * no game holds an XMPP socket, so the chat registry alone counted
 * every member but the leader as offline and left them out of an ISLAND hunt.
 */
export function IsGameRecentlyActive(userId: string, withinMs: number, nowMs: number = Date.now()): boolean {
    const Last = GameLastSeen.get(userId);
    return Last !== undefined && nowMs - Last <= withinMs;
}

function PruneGameLastSeen(nowMs: number): void {
    const Cutoff = nowMs - 2 * 60 * 60 * 1000;
    for (const [UserId, Last] of GameLastSeen) {
        if (Last < Cutoff) GameLastSeen.delete(UserId);
    }
}

// ---- inventory (loot, currency, Platinum) ----

export interface InventoryActivityEvent extends InventoryActivityInput {
    userId: string;
    atMs: number;
}

/**
 * One committed inventory transaction of one account (called after the commit, from controllers/inventory.ts). A kill grant from a
 * dedicated server is also checked against the account's dedicated hunts (LOOT_WITHOUT_HUNT, or the hunt's kill count).
 */
export function RecordInventoryActivity(event: InventoryActivityEvent): void {
    try {
        if (!CurrentActivitySettings().enabled || IsIgnoredActivitySource(event.source)) return;
        const Totals = InventoryIncrements(event);
        if (Object.keys(Totals.increments).length > 0) AddDaily(event.userId, DayOf(event.atMs), Totals.increments);
        if (event.source === "INVENTORY_GAMESERVER" && Totals.kills > 0) {
            void CheckKillGrantAgainstHunts(event.userId, event.atMs, Totals.kills);
        }
    } catch (Err) {
        logger.warn(`[ActivityMon] inventory not recorded user=${LogToken(event.userId)}: ${String(Err)}`);
    }
}

/** The dedicated-hunt check of a kill grant (exported for tests). Never throws. */
export async function CheckKillGrantAgainstHunts(userId: string, atMs: number, kills: number): Promise<void> {
    await Quietly("kill grant check", userId, async () => {
        const Window = HuntLootWindow(atMs);
        const Covering = await Store().findDedicatedHuntsCovering(userId, Window.atIso, Window.notBeforeIso, Window.graceFloorIso);
        if (Covering.length > 0) {
            await Store().addHuntKills(Covering[0]._id, kills);
            return;
        }
        await RaiseFlag({
            kind: "LOOT_WITHOUT_HUNT",
            severity: "high",
            userId,
            day: DayOf(atMs),
            detail: `${kills} kill grant(s) from a dedicated server; no dedicated hunt of this account covers ${Window.atIso} (window ${ACTIVITY_HUNT_MAX_MS / 3600000}h)`
        });
    });
}

// ---- progression, challenges, Slayer's Path, reforge ----

/** XP of an applied grant (not a replay), by track. */
export function RecordXpActivity(userId: string, progressionId: string, amount: number, atMs: number = Date.now()): void {
    try {
        if (!CurrentActivitySettings().enabled || !(amount > 0)) return;
        AddDaily(userId, DayOf(atMs), { [`xp.${SafeKey(progressionId)}`]: amount });
    } catch (Err) {
        logger.warn(`[ActivityMon] XP not recorded user=${LogToken(userId)}: ${String(Err)}`);
    }
}

/** Season challenges claimed by one bounty save. */
export function RecordChallengeClaimsActivity(userId: string, claimed: number, atMs: number = Date.now()): void {
    try {
        if (!CurrentActivitySettings().enabled || !(claimed > 0)) return;
        AddDaily(userId, DayOf(atMs), { challengesClaimed: claimed });
    } catch (Err) {
        logger.warn(`[ActivityMon] challenge claims not recorded user=${LogToken(userId)}: ${String(Err)}`);
    }
}

/** Slayer's Path nodes that one journey save newly unlocked. Each node gets one history row (once); the day gets the count. */
export async function RecordSlayersPathUnlocksActivity(userId: string, nodeIds: readonly string[], source: "host" | "gameserver",
    atMs: number = Date.now()): Promise<void> {
    if (!CurrentActivitySettings().enabled) return;
    await Quietly("Slayer's Path unlock", userId, async () => {
        const At = new Date(atMs).toISOString();
        for (const NodeId of new Set(nodeIds)) {
            if (typeof NodeId !== "string" || NodeId.length === 0) continue;
            const Inserted = await Store().insertUnlockIfAbsent({
                _id: `${userId}:${NodeId}`,
                userId,
                nodeId: NodeId,
                unlockedAt: At,
                source,
                ttlAt: ActivityTtlAt(DayOf(atMs))
            });
            if (Inserted) AddDaily(userId, DayOf(atMs), { slayersPathUnlocks: 1 });
        }
    });
}

/** A weapon reforge reset (controllers/reforge.ts). */
export function RecordReforgeActivity(userId: string, atMs: number = Date.now()): void {
    try {
        if (!CurrentActivitySettings().enabled) return;
        AddDaily(userId, DayOf(atMs), { reforges: 1 });
    } catch (Err) {
        logger.warn(`[ActivityMon] reforge not recorded user=${LogToken(userId)}: ${String(Err)}`);
    }
}

// ---- hunts ----

/**
 * A dedicated hunt's launch for its players (controllers/matchmaking.ts). One row per player and launch: the hunt's kind is dedicated,
 * and the row stays open until the player returns to a hub or leaves (RecordDedicatedHuntEnds).
 */
export async function RecordDedicatedHuntStarts(userIds: readonly string[], huntId: string, huntRef: string, atMs: number = Date.now()): Promise<void> {
    if (!CurrentActivitySettings().enabled) return;
    for (const UserId of new Set(userIds)) {
        if (typeof UserId !== "string" || UserId.length === 0) continue;
        await Quietly("dedicated hunt start", UserId, async () => {
            const Day = DayOf(atMs);
            const Inserted = await Store().insertHuntIfAbsent({
                _id: `dedicated:${UserId}:${huntRef}`,
                userId: UserId,
                role: "participant",
                kind: "dedicated",
                huntId,
                huntRef,
                startedAt: new Date(atMs).toISOString(),
                kills: 0,
                ttlAt: ActivityTtlAt(Day)
            });
            if (Inserted) AddDaily(UserId, Day, { "huntsStarted.dedicated": 1 });
        });
    }
}

/**
 * The players left their dedicated hunts (they travelled to a hub, or cancelled). Each open hunt of each player ends once: completed
 * when it produced a kill, abandoned otherwise. A hunt whose server was reaped with nobody returning stays open (not counted).
 */
export async function RecordDedicatedHuntEnds(userIds: readonly string[], endReason: string, atMs: number = Date.now()): Promise<void> {
    if (!CurrentActivitySettings().enabled) return;
    for (const UserId of new Set(userIds)) {
        if (typeof UserId !== "string" || UserId.length === 0) continue;
        await Quietly("dedicated hunt end", UserId, async () => {
            const Open = await Store().findOpenDedicatedHunts(UserId);
            for (const Hunt of Open) {
                const Result: ActivityHuntResult = Hunt.kills > 0 ? "completed" : "abandoned";
                const Closed = await Store().closeHuntIfOpen(Hunt._id, { endedAt: new Date(atMs).toISOString(), endReason, result: Result });
                if (Closed) AddDaily(UserId, DayOf(atMs), { [`${Result === "completed" ? "huntsCompleted" : "huntsAbandoned"}.dedicated`]: 1 });
            }
        });
    }
}

export interface P2PHuntActivityInput {
    sessionId: string;
    huntId: string;
    kind: "realm" | "playerHosted";
    hostAccountId: string;
    /** The accounts that joined the hunt (admitted, or lost while in it). */
    participants: readonly string[];
    /** The terminal state: COMPLETED is completed, anything else abandoned. */
    state: string;
    runningAtIso?: string;
    createdAtIso: string;
    endedAtIso: string;
}

/**
 * A player-hosted or realm hunt that reached a terminal state (called from the P2P module after the transition committed). Each
 * participant gets one row (once per session), the host gets one hosting row with the hunt's running minutes.
 */
export async function RecordP2PHuntActivity(input: P2PHuntActivityInput): Promise<void> {
    if (!CurrentActivitySettings().enabled) return;
    const StartedIso = input.runningAtIso ?? input.createdAtIso;
    const Result: ActivityHuntResult = input.state === "COMPLETED" ? "completed" : "abandoned";
    const StartDay = DayOf(Date.parse(StartedIso));
    const EndDay = DayOf(Date.parse(input.endedAtIso));
    for (const UserId of new Set(input.participants)) {
        if (typeof UserId !== "string" || UserId.length === 0) continue;
        await Quietly("P2P hunt", UserId, async () => {
            const Inserted = await Store().insertHuntIfAbsent({
                _id: `p2p:${input.sessionId}:${UserId}:participant`,
                userId: UserId,
                role: "participant",
                kind: input.kind,
                huntId: input.huntId,
                huntRef: input.sessionId,
                startedAt: StartedIso,
                endedAt: input.endedAtIso,
                endReason: input.state,
                result: Result,
                kills: 0,
                ttlAt: ActivityTtlAt(StartDay)
            });
            if (!Inserted) return;
            AddDaily(UserId, StartDay, { [`huntsStarted.${input.kind}`]: 1 });
            AddDaily(UserId, EndDay, { [`${Result === "completed" ? "huntsCompleted" : "huntsAbandoned"}.${input.kind}`]: 1 });
        });
    }
    if (input.hostAccountId) {
        await Quietly("P2P hosting", input.hostAccountId, async () => {
            const Inserted = await Store().insertHuntIfAbsent({
                _id: `p2p:${input.sessionId}:${input.hostAccountId}:host`,
                userId: input.hostAccountId,
                role: "host",
                kind: input.kind,
                huntId: input.huntId,
                huntRef: input.sessionId,
                startedAt: StartedIso,
                endedAt: input.endedAtIso,
                endReason: input.state,
                // [2026-10-15] The host's row carries the hunt's result too, as each participant's does (it was the only row without one).
                result: Result,
                kills: 0,
                ttlAt: ActivityTtlAt(StartDay)
            });
            if (!Inserted) return;
            AddDaily(input.hostAccountId, EndDay, { huntsHosted: 1, hostingMinutes: MinutesBetween(input.runningAtIso, input.endedAtIso) });
        });
    }
}

// ---- launcher builds ----

/** [2026-10-15] Where the official launcher build is read from (tests pass their own). */
export interface LauncherBuildSources {
    /** The SHA-256 the served Guard manifest of `channel` pins for the LAUNCHER role, or undefined without one. */
    pinnedLauncherSha256(channel: string): string | undefined;
    /** The launcher version this server offers, or undefined without a launcher feed. */
    servedLauncherVersion(): string | undefined;
}

// Loaded on first use (as p2pHostPolicy does): the feed layout belongs to the launcher update routes.
const UpdateFeed = () => require("../routes/launcherUpdates") as typeof import("../routes/launcherUpdates");
const DefaultLauncherBuildSources: LauncherBuildSources = {
    pinnedLauncherSha256: (channel) => UpdateFeed().ReadPublishedGuardArtifacts(channel)?.find((artifact) => artifact.role === "LAUNCHER")?.sha256,
    servedLauncherVersion: () => UpdateFeed().ReadServedLauncherVersion(),
};

/**
 * [2026-10-16] The verdict for a Play's launcher report on `channel`, against the served Guard pin and launcher version - the same one
 * RecordLauncherBuild flags with. Used by the MYSTICPARADOX_UNOFFICIAL_LAUNCHER refusal (security/unofficialLauncherPolicy.ts). Never
 * throws: a feed that cannot be read gives "unknown".
 */
export function ClassifyReportedLauncherBuild(channel: string, report: LauncherBuildReport | undefined,
    sources: LauncherBuildSources = DefaultLauncherBuildSources): LauncherBuildVerdict {
    if (report === undefined) return "unknown";
    try {
        return ClassifyLauncherBuild(report, sources.pinnedLauncherSha256(channel), sources.servedLauncherVersion());
    } catch (error) {
        logger.warn(`[UnofficialLauncher] launcher build check unavailable: ${String(error)}`);
        return "unknown";
    }
}

/**
 * The launcher build a Play reported (POST /launcher/v1/game-sessions). A build that is not the one Guard pins, on the served
 * version or newer, raises UNOFFICIAL_LAUNCHER (once per account and day); an older official build updates itself and is not
 * flagged. Self-reported, so a monitor only: nothing is refused here (MYSTICPARADOX_UNOFFICIAL_LAUNCHER=refuse refuses in the Play
 * handler, security/unofficialLauncherPolicy.ts). Returns the verdict; never throws.
 */
export async function RecordLauncherBuild(userId: string, channel: string, report: LauncherBuildReport | undefined,
    sources: LauncherBuildSources = DefaultLauncherBuildSources, nowMs: number = Date.now()): Promise<LauncherBuildVerdict> {
    if (!CurrentActivitySettings().enabled || report === undefined) return "unknown";
    let Verdict: LauncherBuildVerdict = "unknown";
    await Quietly("launcher build", userId, async () => {
        const Pinned = sources.pinnedLauncherSha256(channel);
        const Served = sources.servedLauncherVersion();
        Verdict = ClassifyLauncherBuild(report, Pinned, Served);
        if (Verdict !== "unofficial" || Pinned === undefined) return;
        await RaiseFlag({
            kind: "UNOFFICIAL_LAUNCHER",
            severity: "high",
            userId,
            day: DayOf(nowMs),
            detail: `launcher ${report.version} sha256 ${report.sha256.slice(0, 16)}... is not the official build `
                + `(Guard ${channel} pins ${Pinned.slice(0, 16)}...; served version ${Served ?? "none"})`
        });
    });
    return Verdict;
}
