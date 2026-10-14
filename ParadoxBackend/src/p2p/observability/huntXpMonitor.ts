/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { RecordP2PHuntActivity } from "../../activity/activityMonitor";
import { logger } from "../../logger";
import { GetMongoDb } from "../../persistence/mongo/client";
import { IsHuntPassXpTrack } from "../../controllers/progression";
import {
    CurrentEconomyMonitorSettings,
    ECONOMY_ROLLUP_TTL_MS,
    EconomyMonitorSettings,
    LogToken
} from "../../diagnostics/economyLedgerMonitor";
import { GetP2PRepositories, P2PHuntSessionRecord } from "../persistence";
import { P2PCollections } from "../persistence/mongo/collections";

/*
 * [diagnostics 2026-10-14] Per-hunt XP monitor ([XpMon]). When a player-hosted hunt reaches a terminal state, the XP the host
 * wrote for its members (p2pHostWrites rows of kind XP, tagged by controllers/progression.ts TagHostWrite) is summed per member
 * and track family. One line per member; a FLAG when weapon + player XP per minute of the hunt exceeds
 * MYSTICPARADOX_XP_PER_MINUTE_FLAG; one summary row per member (p2pHuntXpSummaries). Monitoring only: per-hunt XP has no limit
 * (owner decision, 14 Oct: re-killing respawning Behemoths is intended play), so a flag is for review, never a refusal.
 * It runs after the terminal transition has committed (ScheduleHuntXpMonitor) and never blocks the hunt's end.
 * Realm hubs have no XP and are skipped. MYSTICPARADOX_ECONOMY_MONITOR=off disables it with the other economy monitors.
 */

export type XpFamily = "weapon" | "player" | "huntPass" | "prestige" | "other";

/** The family of a progression track: weapon (ExperienceTrack_Weapon_*), player level, the Hunt Pass, a weapon prestige track. */
export function XpFamilyOf(track: unknown): XpFamily {
    const Track = String(track ?? "");
    if (Track === "ExperienceTrack_PlayerLevel") return "player";
    if (Track.startsWith("ExperienceTrack_Weapon_")) return "weapon";
    if (Track.startsWith("PrestigeTrack_")) return "prestige";
    if (IsHuntPassXpTrack(Track)) return "huntPass";
    return "other";
}

/** One stored host XP write (p2pHostWrites), as far as the monitor reads it. */
export interface HostXpRow {
    targetUserId: string;
    summary?: { track?: unknown; amount?: unknown } | null;
}

export interface MemberXp {
    member: string;
    weapon: number;
    player: number;
    huntPass: number;
    prestige: number;
    other: number;
    grants: number;
}

/** Sums the rows per member and family (pure). A row without a usable amount still counts as a grant. */
export function AggregateHuntXp(rows: ReadonlyArray<HostXpRow>): Map<string, MemberXp> {
    const Totals = new Map<string, MemberXp>();
    for (const Row of rows) {
        if (typeof Row?.targetUserId !== "string") continue;
        const Entry = Totals.get(Row.targetUserId) ?? ZeroXp(Row.targetUserId);
        const Amount = Number(Row.summary?.amount);
        Entry[XpFamilyOf(Row.summary?.track)] += Number.isFinite(Amount) && Amount > 0 ? Amount : 0;
        Entry.grants += 1;
        Totals.set(Row.targetUserId, Entry);
    }
    return Totals;
}

function ZeroXp(member: string): MemberXp {
    return { member, weapon: 0, player: 0, huntPass: 0, prestige: 0, other: 0, grants: 0 };
}

/** The hunt's length in minutes from its first RUNNING transition to its end (0 when it never ran). */
export function HuntMinutes(runningAt: string | undefined, endedAt: string): number {
    const Start = runningAt == undefined ? Number.NaN : Date.parse(runningAt);
    const End = Date.parse(endedAt);
    if (!Number.isFinite(Start) || !Number.isFinite(End) || End <= Start) return 0;
    return (End - Start) / 60_000;
}

/** Weapon + player XP per minute. A hunt shorter than a minute counts as one minute, so a short burst cannot read as a rate. */
export function XpPerMinute(entry: Pick<MemberXp, "weapon" | "player">, minutes: number): number {
    return (entry.weapon + entry.player) / Math.max(minutes, 1);
}

export interface HuntXpSummary {
    _id: string;
    sessionId: string;
    member: string;
    host: string;
    realmId: string | null;
    state: string;
    reason: string | null;
    runningAt: string | null;
    endedAt: string;
    minutes: number;
    weapon: number;
    player: number;
    huntPass: number;
    prestige: number;
    other: number;
    grants: number;
    perMinute: number;
    flagged: boolean;
    createdAt: string;
    ttlAt: Date;
}

export interface HuntXpInput {
    hunt: Pick<P2PHuntSessionRecord, "sessionId" | "state" | "hostAccountId" | "roster" | "realmId" | "completionReason" | "failureReason">;
    rows: ReadonlyArray<HostXpRow>;
    runningAt?: string;
    endedAt: string;
    now: Date;
    limitPerMinute: number;
}

/**
 * One summary per member: everyone on the roster plus anyone the rows name (pure). `flagged` when weapon + player XP per minute
 * is above the limit.
 */
export function BuildHuntXpSummaries(input: HuntXpInput): HuntXpSummary[] {
    const Totals = AggregateHuntXp(input.rows);
    const Members = new Set<string>([...input.hunt.roster.map((Entry) => Entry.accountId), ...Totals.keys()]);
    const Minutes = HuntMinutes(input.runningAt, input.endedAt);
    const Summaries: HuntXpSummary[] = [];
    for (const Member of Members) {
        const Entry = Totals.get(Member) ?? ZeroXp(Member);
        const Rate = XpPerMinute(Entry, Minutes);
        Summaries.push({
            _id: `${input.hunt.sessionId}:${Member}`,
            sessionId: input.hunt.sessionId,
            member: Member,
            host: input.hunt.hostAccountId || "-",
            realmId: input.hunt.realmId ?? null,
            state: input.hunt.state,
            reason: input.hunt.completionReason ?? input.hunt.failureReason ?? null,
            runningAt: input.runningAt ?? null,
            endedAt: input.endedAt,
            minutes: Math.round(Minutes * 100) / 100,
            weapon: Entry.weapon,
            player: Entry.player,
            huntPass: Entry.huntPass,
            prestige: Entry.prestige,
            other: Entry.other,
            grants: Entry.grants,
            perMinute: Math.round(Rate),
            flagged: Rate > input.limitPerMinute,
            createdAt: input.now.toISOString(),
            ttlAt: new Date(input.now.getTime() + ECONOMY_ROLLUP_TTL_MS),
        });
    }
    return Summaries;
}

/** The per-member line (pure). */
export function XpLine(summary: HuntXpSummary): string {
    return `[XpMon] hunt=${LogToken(summary.sessionId)} realm=${LogToken(summary.realmId ?? "-")} host=${LogToken(summary.host)}`
        + ` member=${LogToken(summary.member)} minutes=${summary.minutes.toFixed(1)} weapon=${summary.weapon} player=${summary.player}`
        + ` huntPass=${summary.huntPass} prestige=${summary.prestige} grants=${summary.grants} perMinute=${summary.perMinute} state=${summary.state}`;
}

/** The FLAG line for a member whose weapon + player XP per minute is above the limit (pure). */
export function XpFlagLine(summary: HuntXpSummary, limitPerMinute: number): string {
    return `[XpMon] FLAG hunt=${LogToken(summary.sessionId)} realm=${LogToken(summary.realmId ?? "-")} host=${LogToken(summary.host)}`
        + ` member=${LogToken(summary.member)} perMinute=${summary.perMinute} limit=${limitPerMinute}`
        + ` minutes=${summary.minutes.toFixed(1)} weapon=${summary.weapon} player=${summary.player} grants=${summary.grants}`;
}

// ---- storage (the defaults read the P2P collections; tests inject their own) ----

export interface HuntXpSource {
    findHunt(sessionId: string): Promise<P2PHuntSessionRecord | undefined>;
    listXpRows(sessionId: string): Promise<HostXpRow[]>;
    /** When the hunt first reached RUNNING (its transition row), if it did. */
    runningAt(sessionId: string): Promise<string | undefined>;
}

export interface HuntXpSink {
    write(summary: HuntXpSummary): Promise<void>;
}

const MongoHuntXpSource: HuntXpSource = {
    findHunt: (sessionId) => GetP2PRepositories().p2pHunts.findHunt(sessionId),
    listXpRows: async (sessionId) => {
        const Db = await GetMongoDb();
        return (await Db.collection(P2PCollections.P2PHostWrites)
            .find({ sessionId, kind: "XP" }, { projection: { _id: 0, targetUserId: 1, summary: 1 } })
            .toArray()) as unknown as HostXpRow[];
    },
    runningAt: async (sessionId) => {
        const Db = await GetMongoDb();
        const Row = await Db.collection(P2PCollections.P2PHuntTransitions)
            .findOne({ sessionId, toState: "RUNNING" }, { sort: { at: 1 } });
        return typeof (Row as any)?.at === "string" ? (Row as any).at : undefined;
    },
};

const MongoHuntXpSink: HuntXpSink = {
    write: async (summary) => {
        const Db = await GetMongoDb();
        await Db.collection(P2PCollections.P2PHuntXpSummaries).replaceOne({ _id: summary._id as any }, summary as any, { upsert: true });
    },
};

let SourceOverride: HuntXpSource | undefined;
let SinkOverride: HuntXpSink | undefined;

/** Hunts this process has already reported: a terminal state is final, but several paths may ask again. */
const Reported = new Set<string>();
const REPORTED_LIMIT = 4096;

function MarkReported(sessionId: string): void {
    if (Reported.size >= REPORTED_LIMIT) Reported.delete(Reported.values().next().value as string);
    Reported.add(sessionId);
}

/** Tests: read and write through these instead of MongoDB (undefined restores MongoDB). Clears what was reported. */
export function UseHuntXpMonitorForTest(options: { source?: HuntXpSource; sink?: HuntXpSink } | undefined): void {
    SourceOverride = options?.source;
    SinkOverride = options?.sink;
    Reported.clear();
}

/**
 * Reports one hunt if it is terminal (COMPLETED or ABORTED) and was not reported yet: the per-member lines and FLAGs, then the
 * summary rows. Returns the summaries (empty when nothing was reported). Rejects only when reading the hunt fails.
 */
export async function MonitorHuntXp(sessionId: string, now: Date = new Date(),
    settings: EconomyMonitorSettings = CurrentEconomyMonitorSettings()): Promise<HuntXpSummary[]> {
    if (!settings.enabled) return [];
    const Source = SourceOverride ?? MongoHuntXpSource;
    const Hunt = await Source.findHunt(sessionId);
    if (Hunt == undefined || (Hunt.state !== "COMPLETED" && Hunt.state !== "ABORTED") || Hunt.sessionKind === "REALM_HUB") return [];
    if (Reported.has(sessionId)) return [];

    const Rows = await Source.listXpRows(sessionId);
    const RunningAt = await Source.runningAt(sessionId);
    MarkReported(sessionId);
    const Summaries = BuildHuntXpSummaries({
        hunt: Hunt, rows: Rows, runningAt: RunningAt, endedAt: Hunt.terminalAt ?? now.toISOString(), now,
        limitPerMinute: settings.xpPerMinuteFlag,
    });
    for (const Summary of Summaries) {
        logger.info(XpLine(Summary));
        if (Summary.flagged) logger.warn(XpFlagLine(Summary, settings.xpPerMinuteFlag));
    }
    const Sink = SinkOverride ?? MongoHuntXpSink;
    for (const Summary of Summaries) {
        try {
            await Sink.write(Summary);
        } catch (Err) {
            logger.warn(`[XpMon] summary not stored hunt=${LogToken(sessionId)} member=${LogToken(Summary.member)}: ${String(Err)}`);
        }
    }
    return Summaries;
}

/**
 * Starts the report for a hunt that has just reached a terminal state. Call it after the transaction that wrote the state has
 * returned. Fire-and-forget: it never throws and never delays the caller.
 */
export function ScheduleHuntXpMonitor(sessionId: string): void {
    void MonitorHuntXp(sessionId).catch((Err) => {
        logger.warn(`[XpMon] hunt=${LogToken(sessionId)} not monitored: ${String(Err)}`);
    });
    // [2026-10-14] The activity monitor's hunt rows (src/activity), read separately so the XP monitor's own switch does not stop them.
    void RecordHuntEndActivity(sessionId).catch((Err) => {
        logger.warn(`[ActivityMon] hunt=${LogToken(sessionId)} not recorded: ${String(Err)}`);
    });
}

/**
 * [2026-10-14] The activity monitor's participation rows for a session that reached a terminal state (src/activity/activityMonitor.ts).
 * Reads the hunt once, like the report does, and writes once per session (the rows are keyed by session and player).
 */
export async function RecordHuntEndActivity(sessionId: string, now: Date = new Date()): Promise<void> {
    const Source = SourceOverride ?? MongoHuntXpSource;
    const Hunt = await Source.findHunt(sessionId);
    if (Hunt == undefined || (Hunt.state !== "COMPLETED" && Hunt.state !== "ABORTED") || Hunt.sessionKind === "REALM_HUB") return;
    await RecordP2PHuntActivity({
        sessionId,
        huntId: Hunt.huntDefinitionId,
        kind: Hunt.realmId !== undefined ? "realm" : "playerHosted",
        hostAccountId: Hunt.hostAccountId,
        participants: (Hunt.roster ?? []).filter((Member) => Member.admissionState === "ADMITTED" || Member.admissionState === "LOST")
            .map((Member) => Member.accountId),
        state: Hunt.state,
        runningAtIso: (await Source.runningAt(sessionId)) ?? undefined,
        createdAtIso: Hunt.createdAt,
        endedAtIso: Hunt.terminalAt ?? now.toISOString()
    });
}
