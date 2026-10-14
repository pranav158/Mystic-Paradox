/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { Request, Response } from "express";
import { ACTIVITY_RETENTION_DAYS, CurrentActivitySettings, DayOf, DayStartMs } from "../activity/activityRules";
import { GetRepositories } from "../persistence";
import type { ActivityFlagRecord, ActivityFlagStatus, ActivityHuntRecord, SlayersPathUnlockRecord } from "../persistence/contracts/ActivityRepository";
import { logger } from "../logger";

// [2026-10-14] Read endpoints of the activity monitor for the admin dashboard (mounted behind HasAdminAuth in routes/admin.ts), plus
// the one write: acknowledging a review flag (audited). The reads answer with what exists even when MYSTICPARADOX_ACTIVITY_MONITOR is
// off (monitorEnabled says which). Ranges are UTC days, inclusive, at most ACTIVITY_RETENTION_DAYS long.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const OVERVIEW_ROW_LIMIT = 50000;
const PLAYER_DAY_LIMIT = 400;
const TIMELINE_LIMIT = 100;
const LEDGER_LIMIT = 50;
const HUNT_LIMIT = 50;
const UNLOCK_LIMIT = 200;
const FLAG_LIMIT = 50;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const HUNT_KINDS = ["dedicated", "realm", "playerHosted"] as const;
const COUNTER_FIELDS = ["playtimeMinutes", "sessions", "hostingMinutes", "huntsHosted", "challengesClaimed", "slayersPathUnlocks", "reforges"] as const;

type Totals = Record<string, any>;

function IsValidDay(text: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    return !Number.isNaN(Date.parse(`${text}T00:00:00.000Z`)) && DayOf(DayStartMs(text)) === text;
}

function BadQuery(res: Response, code: string, message: string): void {
    res.status(400).json({ error: { code, message } });
}

/** The requested UTC range (inclusive). Defaults to the last 30 days, ending today. Undefined after a 400 has been sent. */
function ReadRange(req: Request, res: Response): { from: string; to: string } | undefined {
    const ToText = typeof req.query.to === "string" ? req.query.to.trim() : "";
    const FromText = typeof req.query.from === "string" ? req.query.from.trim() : "";
    const To = ToText === "" ? DayOf(Date.now()) : ToText;
    const From = FromText === "" ? DayOf(DayStartMs(To) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS) : FromText;
    if (!IsValidDay(To) || !IsValidDay(From)) {
        BadQuery(res, "ACTIVITY_RANGE_INVALID", "from and to must be UTC days, YYYY-MM-DD.");
        return undefined;
    }
    if (From > To) {
        BadQuery(res, "ACTIVITY_RANGE_INVALID", "from must not be after to.");
        return undefined;
    }
    const Span = (DayStartMs(To) - DayStartMs(From)) / DAY_MS + 1;
    if (Span > ACTIVITY_RETENTION_DAYS) {
        BadQuery(res, "ACTIVITY_RANGE_TOO_LONG", `The range may be at most ${ACTIVITY_RETENTION_DAYS} days (the retention).`);
        return undefined;
    }
    return { from: From, to: To };
}

function PageOf(raw: unknown): number {
    return Math.max(1, Number.parseInt(String(raw ?? "1"), 10) || 1);
}

function LimitOf(raw: unknown): number {
    return Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(String(raw ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
}

// ---- pure summaries (exported for tests) ----

/** Adds one daily row's counters to `into` (plain numbers; nested per-kind and per-currency objects are summed). */
export function AddDailyCounters(into: Totals, row: Record<string, any>): Totals {
    for (const Field of COUNTER_FIELDS) into[Field] = (Number(into[Field]) || 0) + (Number(row[Field]) || 0);
    for (const Group of ["huntsStarted", "huntsCompleted", "huntsAbandoned"]) {
        const Target: Totals = into[Group] ?? (into[Group] = { dedicated: 0, realm: 0, playerHosted: 0 });
        for (const Kind of HUNT_KINDS) Target[Kind] = (Target[Kind] ?? 0) + (Number(row[Group]?.[Kind]) || 0);
    }
    for (const Group of ["kills", "xp", "itemsGained", "platinumSpendsByItem"]) {
        const Target: Totals = into[Group] ?? (into[Group] = {});
        for (const [Key, Value] of Object.entries(row[Group] ?? {})) Target[Key] = (Target[Key] ?? 0) + (Number(Value) || 0);
    }
    const Currency: Totals = into.currency ?? (into.currency = {});
    for (const [Id, Entry] of Object.entries(row.currency ?? {})) {
        const Target: Totals = Currency[Id] ?? (Currency[Id] = { credited: 0, debited: 0 });
        Target.credited += Number((Entry as any)?.credited) || 0;
        Target.debited += Number((Entry as any)?.debited) || 0;
    }
    return into;
}

function EmptyTotals(): Totals {
    const Empty: Totals = {};
    AddDailyCounters(Empty, {});
    return Empty;
}

/** An account's activity is "active" on a day when it had playtime or a session. */
export function IsActiveRow(row: Record<string, any>): boolean {
    return (Number(row.playtimeMinutes) || 0) > 0 || (Number(row.sessions) || 0) > 0;
}

/**
 * The server totals per UTC day for the overview (pure). Every day of the range appears, with zeros where nothing was recorded.
 * `activePlayers` counts the accounts with playtime or a session that day.
 */
export function OverviewDays(from: string, to: string, rows: ReadonlyArray<Record<string, any>>): Array<Record<string, any>> {
    const ByDay = new Map<string, Totals>();
    const Active = new Map<string, number>();
    for (let Day = DayStartMs(from); Day <= DayStartMs(to); Day += DAY_MS) {
        const Key = DayOf(Day);
        ByDay.set(Key, EmptyTotals());
        Active.set(Key, 0);
    }
    for (const Row of rows) {
        const Key = String(Row.day ?? "");
        const Totals = ByDay.get(Key);
        if (Totals === undefined) continue;
        AddDailyCounters(Totals, Row);
        if (IsActiveRow(Row)) Active.set(Key, (Active.get(Key) ?? 0) + 1);
    }
    return [...ByDay.entries()].map(([Day, Totals]) => ({ day: Day, activePlayers: Active.get(Day) ?? 0, ...Totals }));
}

/** An account's counters over the rows it has in the range (pure). */
export function PlayerTotals(rows: ReadonlyArray<Record<string, any>>): Totals {
    const Totals = EmptyTotals();
    for (const Row of rows) AddDailyCounters(Totals, Row);
    return Totals;
}

function SafeDayRow(row: Record<string, any>): Record<string, any> {
    const { _id, userId, ttlAt, ...Rest } = row;
    return Rest;
}

function PublicFlag(record: ActivityFlagRecord): Record<string, unknown> {
    return {
        id: record._id,
        kind: record.kind,
        severity: record.severity,
        userId: record.userId,
        day: record.day,
        detail: record.detail,
        status: record.status,
        createdAt: record.createdAt,
        acknowledgedAt: record.acknowledgedAt ?? null,
        acknowledgedBy: record.acknowledgedBy ?? null,
        note: record.note ?? null
    };
}

function HuntOfTimeline(hunt: ActivityHuntRecord): Record<string, unknown> {
    return {
        role: hunt.role ?? "participant",
        kind: hunt.kind,
        huntId: hunt.huntId,
        huntRef: hunt.huntRef,
        startedAt: hunt.startedAt,
        endedAt: hunt.endedAt ?? null,
        endReason: hunt.endReason ?? null,
        result: hunt.result ?? null,
        kills: hunt.kills ?? 0
    };
}

function UnlockOf(unlock: SlayersPathUnlockRecord): Record<string, unknown> {
    return { nodeId: unlock.nodeId, unlockedAt: unlock.unlockedAt, source: unlock.source };
}

/**
 * The account's timeline, newest first (pure): hunts, unlocks, flags, inventory ledger rows and XP grants merged by time.
 */
export function PlayerTimeline(input: {
    hunts: ReadonlyArray<ActivityHuntRecord>;
    unlocks: ReadonlyArray<SlayersPathUnlockRecord>;
    flags: ReadonlyArray<ActivityFlagRecord>;
    ledger: ReadonlyArray<Record<string, any>>;
    grants: ReadonlyArray<{ grantId: string; progressionId: string; amount: number; createdAt: string }>;
}): Array<{ at: string; type: string; detail: Record<string, unknown> }> {
    const Entries: Array<{ at: string; type: string; detail: Record<string, unknown> }> = [];
    for (const Hunt of input.hunts) {
        Entries.push({ at: Hunt.startedAt, type: "hunt", detail: HuntOfTimeline(Hunt) });
    }
    for (const Unlock of input.unlocks) {
        Entries.push({ at: Unlock.unlockedAt, type: "slayersPathUnlock", detail: UnlockOf(Unlock) });
    }
    for (const Flag of input.flags) {
        Entries.push({ at: Flag.createdAt, type: "flag", detail: { id: Flag._id, kind: Flag.kind, severity: Flag.severity, status: Flag.status } });
    }
    for (const Row of input.ledger) {
        const At = String(Row.completedAt ?? Row.createdAt ?? "");
        if (At === "") continue;
        Entries.push({ at: At, type: "inventory", detail: { status: Row.status ?? null, economySource: Row.economySource ?? null,
            economySessionId: Row.economySessionId ?? null, characterId: Row.characterId ?? null } });
    }
    for (const Grant of input.grants) {
        Entries.push({ at: Grant.createdAt, type: "xp", detail: { progressionId: Grant.progressionId, amount: Grant.amount, grantId: Grant.grantId } });
    }
    return Entries.filter((Entry) => Entry.at !== "").sort((A, B) => (A.at < B.at ? 1 : A.at > B.at ? -1 : 0)).slice(0, TIMELINE_LIMIT);
}

// ---- handlers ----

/** GET /admin/v1/activity/players/:userId?from=&to= : the account's daily counters, totals, unlocks, hunts, flags and timeline. */
export async function GetActivityPlayer(req: Request, res: Response): Promise<void> {
    const UserId = String(req.params.userId ?? "").trim();
    if (UserId === "" || UserId.length > 200) {
        BadQuery(res, "ACTIVITY_USER_INVALID", "The account id is missing or too long.");
        return;
    }
    const Range = ReadRange(req, res);
    if (Range === undefined) return;
    try {
        const Repos = GetRepositories();
        const [Rows, Hunts, Unlocks, Flags, Ledger, Grants] = await Promise.all([
            Repos.activity.findDailyRows(UserId, Range.from, Range.to, PLAYER_DAY_LIMIT),
            Repos.activity.findHuntsForAccount(UserId, HUNT_LIMIT),
            Repos.activity.findUnlocksForAccount(UserId, UNLOCK_LIMIT),
            Repos.activity.findFlagsForAccount(UserId, FLAG_LIMIT),
            Repos.inventoryTransactions.listRecentForUser(UserId, LEDGER_LIMIT),
            Repos.progressionGrants.listRecentForUser(UserId, LEDGER_LIMIT)
        ]);
        res.json({
            userId: UserId,
            from: Range.from,
            to: Range.to,
            monitorEnabled: CurrentActivitySettings().enabled,
            days: Rows.map(SafeDayRow),
            totals: PlayerTotals(Rows),
            unlocks: Unlocks.map(UnlockOf),
            hunts: Hunts.map(HuntOfTimeline),
            flags: Flags.map(PublicFlag),
            timeline: PlayerTimeline({ hunts: Hunts, unlocks: Unlocks, flags: Flags, ledger: Ledger, grants: Grants })
        });
    } catch (Err) {
        logger.error(`[ActivityMon] player read failed: ${String(Err)}`);
        res.status(500).json({ error: { code: "ACTIVITY_READ_FAILED", message: "The activity record could not be read." } });
    }
}

/** GET /admin/v1/activity/overview?from=&to= : server totals per UTC day (every day of the range). */
export async function GetActivityOverview(req: Request, res: Response): Promise<void> {
    const Range = ReadRange(req, res);
    if (Range === undefined) return;
    try {
        const Rows = await GetRepositories().activity.findDailyRowsInRange(Range.from, Range.to, OVERVIEW_ROW_LIMIT);
        res.json({
            from: Range.from,
            to: Range.to,
            monitorEnabled: CurrentActivitySettings().enabled,
            truncated: Rows.length >= OVERVIEW_ROW_LIMIT,
            days: OverviewDays(Range.from, Range.to, Rows)
        });
    } catch (Err) {
        logger.error(`[ActivityMon] overview read failed: ${String(Err)}`);
        res.status(500).json({ error: { code: "ACTIVITY_READ_FAILED", message: "The activity overview could not be read." } });
    }
}

const FLAG_STATUSES: readonly string[] = ["open", "acknowledged", "all"];

/** GET /admin/v1/activity/flags?status=open|acknowledged|all&page=&limit= : flags newest first (open by default). */
export async function ListActivityFlags(req: Request, res: Response): Promise<void> {
    const StatusText = typeof req.query.status === "string" && req.query.status.trim() !== "" ? req.query.status.trim() : "open";
    if (!FLAG_STATUSES.includes(StatusText)) {
        BadQuery(res, "ACTIVITY_FLAG_QUERY_INVALID", "status must be open, acknowledged or all.");
        return;
    }
    const Page = PageOf(req.query.page);
    const Limit = LimitOf(req.query.limit);
    try {
        const Result = await GetRepositories().activity.listFlags(StatusText as ActivityFlagStatus | "all", (Page - 1) * Limit, Limit);
        res.json({ flags: Result.records.map(PublicFlag), total: Result.total, page: Page, limit: Limit, status: StatusText });
    } catch (Err) {
        logger.error(`[ActivityMon] flag list failed: ${String(Err)}`);
        res.status(500).json({ error: { code: "ACTIVITY_READ_FAILED", message: "The flags could not be read." } });
    }
}

/** PATCH /admin/v1/activity/flags/:id  {acknowledged: true, note?} : marks a flag reviewed (audited). Nothing else changes. */
export async function AcknowledgeActivityFlag(req: Request, res: Response): Promise<void> {
    const Id = String(req.params.id ?? "");
    if (Id === "" || Id.length > 300) {
        BadQuery(res, "ACTIVITY_FLAG_INVALID", "The flag id is missing.");
        return;
    }
    if (req.body?.acknowledged !== true) {
        BadQuery(res, "ACTIVITY_FLAG_INVALID", "Send {\"acknowledged\": true} (an optional note of up to 500 characters).");
        return;
    }
    const Note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";
    try {
        const Repos = GetRepositories();
        const Before = await Repos.activity.findFlag(Id);
        if (Before === undefined) {
            res.status(404).json({ error: { code: "ACTIVITY_FLAG_NOT_FOUND", message: "No activity flag has that id." } });
            return;
        }
        const Actor = (req as any).AdminAuth.account as { userId: string };
        const At = new Date().toISOString();
        const After = await Repos.activity.acknowledgeFlag(Id, { actorUserId: Actor.userId, at: At, note: Note === "" ? undefined : Note });
        if (Before.status === "open" && After?.status === "acknowledged") {
            await Repos.admin.appendAudit({
                id: crypto.randomUUID(),
                actorUserId: Actor.userId,
                targetUserId: Before.userId,
                action: "activity.flag.acknowledge",
                oldState: { status: "open" },
                newState: { status: "acknowledged" },
                reason: Note === "" ? undefined : Note,
                ip: req.ip ?? "unknown",
                requestId: crypto.randomUUID(),
                createdAt: At
            });
        }
        res.json({ flag: PublicFlag(After ?? Before) });
    } catch (Err) {
        logger.error(`[ActivityMon] flag acknowledge failed: ${String(Err)}`);
        res.status(500).json({ error: { code: "ACTIVITY_WRITE_FAILED", message: "The flag could not be acknowledged." } });
    }
}
