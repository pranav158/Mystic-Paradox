/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { EscalationProgressRecord } from "./persistence";

export interface EscalationSeasonProgressPayload {
    escalation_level: number;
    next_level_xp: number;
    talents_progress: unknown[];
    unlock_progress: unknown[];
    update_version: number;
}

export type EscalationSeasonProgressUpdate = Partial<EscalationSeasonProgressPayload>;

const MAX_INT32 = 2_147_483_647;

/**
 * Limits who may persist a season-progress update for a route target.
 *
 * A validated gameserver API-key request is the authoritative writer and may update any
 * admitted account. A player-host runtime is deliberately never a progression writer, even when
 * its forwarded bearer identifies the same account. A normal player bearer may only write its own
 * route target; this preserves the existing self-save contract while closing cross-account writes.
 */
export function IsAuthorizedEscalationWriter(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    if (authData?.IsPlayerHostRuntime === true) return false;
    return typeof authData?.userId === "string" && authData.userId === targetUserId;
}

/**
 * Reads may be served to the authoritative gameserver or to the account that owns the record.
 * Player-host runtimes do not gain cross-account access merely because they carry a forwarded
 * player bearer; same-account reads remain compatible with the existing client contract.
 */
export function IsAuthorizedEscalationReader(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    return typeof authData?.userId === "string" && authData.userId === targetUserId;
}

export function DefaultEscalationProgress(): EscalationSeasonProgressPayload {
    return {
        escalation_level: 0,
        next_level_xp: 0,
        talents_progress: [],
        unlock_progress: [],
        update_version: 0
    };
}

function IsNonNegativeInt32(Value: unknown): Value is number {
    return typeof Value === "number"
        && Number.isInteger(Value)
        && Value >= 0
        && Value <= MAX_INT32;
}

function CloneArray(Value: unknown[]): unknown[] {
    // Request bodies are JSON values. Cloning prevents later middleware/caller mutation from
    // changing the value selected for persistence while an async Mongo write is in flight.
    return structuredClone(Value);
}

export function RecordToEscalationPayload(
    Record: EscalationProgressRecord | undefined
): EscalationSeasonProgressPayload {
    if (Record === undefined) {
        return DefaultEscalationProgress();
    }

    return {
        escalation_level: Record.escalationLevel,
        next_level_xp: Record.nextLevelXp,
        talents_progress: CloneArray(Record.talentsProgress),
        unlock_progress: CloneArray(Record.unlockProgress),
        update_version: Record.updateVersion
    };
}

/**
 * Builds the next durable record from a game-server POST.
 *
 * Escalation level is monotonic in normal play, so a stale server or a newly-created hunt that
 * started from a zero baseline may never lower a level Mongo already knows. Talent arrays are
 * deliberately replaceable (including with []) because the in-game RESET button is legitimate.
 * Omitted fields retain their previous value, matching the endpoint's established partial-write
 * behavior. updateVersion is backend-authored and increments once per accepted write.
 */
export function MergeEscalationProgress(
    userId: string,
    seasonId: string,
    Previous: EscalationProgressRecord | undefined,
    Update: EscalationSeasonProgressUpdate,
    Now = new Date().toISOString()
): EscalationProgressRecord {
    const PreviousPayload = RecordToEscalationPayload(Previous);
    const RequestedLevel = IsNonNegativeInt32(Update.escalation_level)
        ? Update.escalation_level
        : PreviousPayload.escalation_level;

    return {
        userId,
        seasonId,
        escalationLevel: Math.max(PreviousPayload.escalation_level, RequestedLevel),
        nextLevelXp: IsNonNegativeInt32(Update.next_level_xp)
            ? Update.next_level_xp
            : PreviousPayload.next_level_xp,
        talentsProgress: Array.isArray(Update.talents_progress)
            ? CloneArray(Update.talents_progress)
            : PreviousPayload.talents_progress,
        unlockProgress: Array.isArray(Update.unlock_progress)
            ? CloneArray(Update.unlock_progress)
            : PreviousPayload.unlock_progress,
        updateVersion: PreviousPayload.update_version + 1,
        createdAt: Previous?.createdAt ?? Now,
        updatedAt: Now
    };
}
