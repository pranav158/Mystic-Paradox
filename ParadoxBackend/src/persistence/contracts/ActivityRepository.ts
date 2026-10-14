/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [2026-10-14] Activity monitor (src/activity). Monitoring only: nothing here decides a grant, a hunt or a session. Every record
// is kept about 400 days (ttlAt, the storage-only mirror both providers purge on), and every collection is in the account
// deletion plan (persistence/mongo/accountDeletionPlan.ts).

/** The kinds of hunt the monitor counts. "dedicated": a DeployServer hunt; "realm": a realm's hunt; "playerHosted": a P2P hunt. */
export type ActivityHuntKind = "dedicated" | "realm" | "playerHosted";

/** A hunt's outcome for one participant: "completed" when it produced a kill (dedicated) or ended COMPLETED (P2P), else "abandoned". */
export type ActivityHuntResult = "completed" | "abandoned";

/**
 * One participant's hunt (a DeployServer launch, or a P2P session). A P2P host also gets a row (role "host"), which carries only the
 * hosting minutes. _id: `dedicated:${userId}:${huntRef}`, or `p2p:${sessionId}:${userId}:${role}`.
 */
export interface ActivityHuntRecord {
    _id: string;
    userId: string;
    role: "participant" | "host";
    kind: ActivityHuntKind;
    huntId: string;
    /** The launch's id (dedicated) or the P2P session id. */
    huntRef: string;
    startedAt: string;
    endedAt?: string;
    endReason?: string;
    result?: ActivityHuntResult;
    /** Kill-count grants that arrived while this hunt was open (dedicated hunts). */
    kills: number;
    ttlAt: Date;
}

/** One Slayer's Path node that became unlocked, and where the save came from. _id: `${userId}:${nodeId}`. */
export interface SlayersPathUnlockRecord {
    _id: string;
    userId: string;
    nodeId: string;
    unlockedAt: string;
    source: "host" | "gameserver";
    ttlAt: Date;
}

export type ActivityFlagStatus = "open" | "acknowledged";

/**
 * One flagged event for review. _id is `${kind}:${userId}:${day}`, so a flag is recorded once per account, kind and day. A
 * reviewer acknowledges it; nothing is changed or refused by a flag.
 */
export interface ActivityFlagRecord {
    _id: string;
    kind: string;
    severity: "review" | "high";
    userId: string;
    /** UTC day, YYYY-MM-DD. */
    day: string;
    detail: string;
    status: ActivityFlagStatus;
    createdAt: string;
    acknowledgedAt?: string;
    acknowledgedBy?: string;
    note?: string;
    ttlAt: Date;
}

export interface ActivityDailyKey {
    userId: string;
    /** UTC day, YYYY-MM-DD. */
    day: string;
}

/**
 * Activity repository. Daily rows are one document per (account, UTC day), `_id` = `${userId}:${day}`; counters are dotted paths
 * (see src/activity/activityRules.ts for the fields). Writes are atomic per document.
 */
export interface ActivityRepository {
    /**
     * Adds `increments` (dotted paths to numbers) to one day's row, creating it when absent, and returns the row as it is after
     * this write. The monitor calls it from a batch, never once per request.
     */
    addToDaily(key: ActivityDailyKey, increments: Record<string, number>, ttlAt: Date): Promise<Record<string, any>>;
    /** The account's rows from `fromDay` to `toDay` (both inclusive), oldest first. */
    findDailyRows(userId: string, fromDay: string, toDay: string, limit: number): Promise<Record<string, any>[]>;
    /** Every account's rows in the range, oldest first, at most `limit` (the admin overview). */
    findDailyRowsInRange(fromDay: string, toDay: string, limit: number): Promise<Record<string, any>[]>;

    /** Inserts a hunt participant row unless its `_id` exists. Returns whether it inserted. */
    insertHuntIfAbsent(record: ActivityHuntRecord): Promise<boolean>;
    findHunt(id: string): Promise<ActivityHuntRecord | undefined>;
    /** The account's dedicated hunts that have no end yet. */
    findOpenDedicatedHunts(userId: string): Promise<ActivityHuntRecord[]>;
    /**
     * The account's dedicated hunts that started between `notBeforeIso` and `atIso` and have no end or ended at or after
     * `graceFloorIso` (the window in which a kill grant is accepted for a hunt).
     */
    findDedicatedHuntsCovering(userId: string, atIso: string, notBeforeIso: string, graceFloorIso: string): Promise<ActivityHuntRecord[]>;
    /** Sets the end of a hunt that has none. Returns whether this call ended it (exactly once per hunt). */
    closeHuntIfOpen(id: string, close: { endedAt: string; endReason: string; result: ActivityHuntResult }): Promise<boolean>;
    /** Adds kill-count grants to a dedicated hunt. */
    addHuntKills(id: string, kills: number): Promise<void>;
    /** The account's hunt rows, newest first. */
    findHuntsForAccount(userId: string, limit: number): Promise<ActivityHuntRecord[]>;

    /** Inserts an unlock unless its `_id` exists. Returns whether it inserted. */
    insertUnlockIfAbsent(record: SlayersPathUnlockRecord): Promise<boolean>;
    /** The account's unlocks, newest first. */
    findUnlocksForAccount(userId: string, limit: number): Promise<SlayersPathUnlockRecord[]>;

    /** Inserts a flag unless its `_id` exists. Returns whether it inserted. */
    insertFlagIfAbsent(record: ActivityFlagRecord): Promise<boolean>;
    findFlag(id: string): Promise<ActivityFlagRecord | undefined>;
    /** Flags newest first. `status` "all" lists both states. */
    listFlags(status: ActivityFlagStatus | "all", skip: number, limit: number): Promise<{ records: ActivityFlagRecord[]; total: number }>;
    /** The account's flags, newest first. */
    findFlagsForAccount(userId: string, limit: number): Promise<ActivityFlagRecord[]>;
    /** Acknowledges an open flag. An acknowledged or missing flag is returned as it is (undefined when missing). */
    acknowledgeFlag(id: string, by: { actorUserId: string; at: string; note?: string }): Promise<ActivityFlagRecord | undefined>;
}
