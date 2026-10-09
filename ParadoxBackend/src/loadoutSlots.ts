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

// ENTITLEMENT model only (1 default slot + up to 5 Slayer's Path unlocks). These are NOT wire fields:
// responses report account 0/0 and character (1+U)/MAX_TOTAL_LOADOUT_SLOTS via ResolveWireLoadoutSlotCounts.
export const DEFAULT_ACCOUNT_LOADOUT_SLOTS = 1;
export const MAX_CHARACTER_LOADOUT_SLOTS = 5;
export const MAX_TOTAL_LOADOUT_SLOTS = DEFAULT_ACCOUNT_LOADOUT_SLOTS + MAX_CHARACTER_LOADOUT_SLOTS;
export const PLAYER_JOURNEY_LOADOUT_NODE_IDS = [
    "LoadoutSlot_01",
    "LoadoutSlot_02",
    "LoadoutSlot_03",
    "LoadoutSlot_04",
    "LoadoutSlot_05"
] as const;

function ValidateTotalSlots(Value: number, Label: string): void {
    if (!Number.isSafeInteger(Value) || Value < DEFAULT_ACCOUNT_LOADOUT_SLOTS || Value > MAX_TOTAL_LOADOUT_SLOTS) {
        throw new RangeError(`${Label} must be between ${DEFAULT_ACCOUNT_LOADOUT_SLOTS} and ${MAX_TOTAL_LOADOUT_SLOTS}`);
    }
}

/**
 * Resolves how many stored slots may be returned to or written by the player.
 *
 * Rows without `unlockedTotalSlots` either predate multi-slot support (one stored slot) or were
 * touched by the short-lived 2026-07-22 implementation that interpreted `/unlock/N` as N
 * character slots and added the default slot a second time. Multi-slot legacy rows therefore have
 * exactly one excess stored slot, so expose `stored - 1` until the next authoritative unlock
 * request records the corrected total. The excess content remains dormant.
 */
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

/**
 * Loadout unlocks are monotonic. The first request migrates a legacy row to the corrected
 * total-slot contract; subsequent lower requests are stale travel replays and cannot relock slots.
 */
export function ResolveRequestedTotalLoadoutSlots(PersistedUnlockedTotalSlots: number | undefined, RequestedTotalSlots: number): number {
    ValidateTotalSlots(RequestedTotalSlots, "Requested total loadout slot count");
    if (PersistedUnlockedTotalSlots == undefined) return RequestedTotalSlots;

    ValidateTotalSlots(PersistedUnlockedTotalSlots, "Persisted unlocked loadout slot count");
    return Math.max(PersistedUnlockedTotalSlots, RequestedTotalSlots);
}

/**
 * Resolves the authoritative 1.12 entitlement from the five Slayer's Path loadout nodes.
 *
 * `LockedButClaimable` (1) is not an owned unlock. Only `Unlocked` (2) contributes a character
 * slot. The account/default slot always exists, producing a total range of one through six.
 */
export function ResolvePlayerJourneyTotalLoadoutSlots(Nodes: unknown): number {
    const NodeMap = Nodes != null && typeof Nodes === "object"
        ? Nodes as Record<string, { node_status?: unknown }>
        : {};
    const UnlockedCharacterSlots = PLAYER_JOURNEY_LOADOUT_NODE_IDS
        .filter((NodeId) => NodeMap[NodeId]?.node_status === 2)
        .length;
    return DEFAULT_ACCOUNT_LOADOUT_SLOTS + UnlockedCharacterSlots;
}

/** Resolves the persisted active slot for a response. Missing/invalid legacy values safely fall
 * back to slot zero; selection writes are separately rejected unless the requested slot exists. */
export function ResolveActiveLoadoutIndex(StoredActiveIndex: number | undefined, VisibleTotalSlots: number): number {
    ValidateTotalSlots(VisibleTotalSlots, "Visible loadout slot count");
    if (!Number.isSafeInteger(StoredActiveIndex)
        || StoredActiveIndex == undefined
        || StoredActiveIndex < 0
        || StoredActiveIndex >= VisibleTotalSlots) {
        return 0;
    }
    return StoredActiveIndex;
}

/** Wire-format slot counts for EVERY loadout response (1.14.7 and 1.12 share this contract).
 *  AArchonLoadout::ResolveProgressionLoadoutSlotUnlocks (1.14.7 RVA 0x01BB2E20; 1.12 0x01A6D4F0) calls
 *  UnlockLoadoutSlots((1 + unlocked LoadoutSlotUnlockConditions) - NumCharacterLoadoutSlots) whenever > 0, and the
 *  unlock completion (0x01B8DA80) copies num_character_slots into NumCharacterLoadoutSlots and re-runs it.
 *  So the always-available default slot is a CHARACTER slot on the wire. ACCOUNT slots are store-purchased
 *  extras (LoadoutViewModelNative's 'More Slots' tile = MaxNumAccount - NumAccount, leaf 0x01BA3FE0).
 *  Reporting the default slot as an account slot (1 account + U character) made the delta 1 for every account,
 *  so every 200 to /unlock immediately triggered the next one: ~4.5 requests per second for as long as the
 *  player stayed on a server (937 on 8 Oct; 1266 on 24 Sep under 1.12 - not a 1.14.7 regression).
 *  Totals are unchanged: NumLoadoutSlots = num_acc + num_char, MaxNumLoadoutSlots = max_acc + max_char = 6.
 *  The native unlock payload is an uninitialised stack local, so all four fields are mandatory.
 *  Entitlement (1 + unlocked LoadoutSlot_01..05) is untouched; only the wire split changes. Never throws. */
export interface WireLoadoutSlotCounts {
    num_account_slots: number;
    max_account_slots: number;
    num_character_slots: number;
    max_character_slots: number;
}

export function ResolveWireLoadoutSlotCounts(EntitledTotalSlots: number): WireLoadoutSlotCounts {
    const Requested = Number.isFinite(EntitledTotalSlots) ? Math.trunc(EntitledTotalSlots) : 0;
    const Total = Math.min(MAX_TOTAL_LOADOUT_SLOTS, Math.max(DEFAULT_ACCOUNT_LOADOUT_SLOTS, Requested));
    return {
        num_account_slots: 0,
        max_account_slots: 0,
        num_character_slots: Total,
        max_character_slots: MAX_TOTAL_LOADOUT_SLOTS
    };
}
