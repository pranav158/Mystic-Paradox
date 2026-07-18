/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

export const DEFAULT_ACCOUNT_LOADOUT_SLOTS = 1;
export const MAX_CHARACTER_LOADOUT_SLOTS = 5;
export const MAX_TOTAL_LOADOUT_SLOTS = DEFAULT_ACCOUNT_LOADOUT_SLOTS + MAX_CHARACTER_LOADOUT_SLOTS;

function ValidateTotalSlots(Value: number, Label: string): void {
    if (!Number.isSafeInteger(Value) || Value < DEFAULT_ACCOUNT_LOADOUT_SLOTS || Value > MAX_TOTAL_LOADOUT_SLOTS) {
        throw new RangeError(`${Label} must be between ${DEFAULT_ACCOUNT_LOADOUT_SLOTS} and ${MAX_TOTAL_LOADOUT_SLOTS}`);
    }
}


export function ResolveVisibleTotalLoadoutSlots(StoredTotalSlots: number, PersistedUnlockedTotalSlots?: number): number {
    ValidateTotalSlots(StoredTotalSlots, "Stored loadout slot count");

    if (PersistedUnlockedTotalSlots == undefined) {
        return Math.max(DEFAULT_ACCOUNT_LOADOUT_SLOTS, StoredTotalSlots - DEFAULT_ACCOUNT_LOADOUT_SLOTS);
    }

    ValidateTotalSlots(PersistedUnlockedTotalSlots, "Persisted unlocked loadout slot count");
    if (PersistedUnlockedTotalSlots > StoredTotalSlots) {
        throw new RangeError(`Persisted unlocked loadout slot count ${PersistedUnlockedTotalSlots} exceeds stored count ${StoredTotalSlots}`);
    }
    return PersistedUnlockedTotalSlots;
}


export function ResolveRequestedTotalLoadoutSlots(PersistedUnlockedTotalSlots: number | undefined, RequestedTotalSlots: number): number {
    ValidateTotalSlots(RequestedTotalSlots, "Requested total loadout slot count");
    if (PersistedUnlockedTotalSlots == undefined) return RequestedTotalSlots;

    ValidateTotalSlots(PersistedUnlockedTotalSlots, "Persisted unlocked loadout slot count");
    return Math.max(PersistedUnlockedTotalSlots, RequestedTotalSlots);
}
