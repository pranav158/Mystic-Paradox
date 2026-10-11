/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { CooldownStateRecord } from "./persistence/mapping/domainTypes";

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
 * The GET shape is from UCooldownComponent::OnQueryCooldownDataRequestComplete (0x01A2106A, disassembled): it walks the
 * payload as a TMap (FUN_1409f0220 is the map iterator) and parses each value with FDateTime::ParseIso8601
 * (FUN_142618830) into the component's { id, FDateTime } array. Serving the PUT's list shape instead was measured on
 * 10 Oct 14:22: the component reported its backend data loaded but held only the 2 entries set locally that session,
 * and every daily-bounty lookup missed (runtime [CooldownTrace]). Dates are stored and served exactly as the game wrote them. A PUT sets the listed cooldowns (the latest write for an
 * id wins) and never removes others. Writes need dedicated-server authority: a player rewinding a start date would be
 * able to collect a periodic reward again.
 */

export const MAX_COOLDOWNS_PER_SAVE = 256;
export const MAX_STORED_COOLDOWNS = 1024;
const MAX_ID_LENGTH = 200;
const MAX_DATE_LENGTH = 64;

export class CooldownSaveValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CooldownSaveValidationError";
    }
}

export function IsAuthorizedCooldownWriter(authData: any): boolean {
    return authData?.IsGameserver === true;
}

export function IsAuthorizedCooldownReader(authData: any, targetUserId: string): boolean {
    if (authData?.IsGameserver === true) return true;
    if (authData?.IsPlayerHostRuntime === true) return false;
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
    const Entries = new Map<string, { startedDate: string; updatedAt: string }>();
    for (const Entry of previous?.entries ?? []) Entries.set(Entry.id, { startedDate: Entry.startedDate, updatedAt: Entry.updatedAt });
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
