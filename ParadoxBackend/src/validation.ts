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

// [hardening] Request-body validation for the authoritative inventory/loadout write endpoints.
// Every validator is a pure function returning an error string (400-worthy) or null when valid.
// The goal is to reject malformed/hostile payloads BEFORE they reach the transaction/JSON-blob
// layer, so a client can never persist a garbage shape (missing IDs, non-array collections,
// non-numeric quantities, oversized blobs) that later corrupts reads or normalization.

const MAX_ID_LENGTH = 256;
const MAX_ITEMS_PER_ARRAY = 4096;
const MAX_QUANTITY = 1_000_000_000;
const MAX_ITEM_DATA_LENGTH = 262_144; // 256 KiB of per-item JSON is already far beyond anything real
const MAX_LOADOUT_DATA_LENGTH = 1_048_576; // 1 MiB
const MAX_UPDATE_VERSION = 1_000_000_000; // a monotonic per-item counter; bound it to a sane range

function IsNonEmptyString(value: unknown, max = MAX_ID_LENGTH): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= max;
}

// updateVersion is a monotonic counter, not an arbitrary number: require a bounded non-negative
// integer (rejects negatives, fractions, NaN/Infinity, and absurd values).
function IsBoundedNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_UPDATE_VERSION;
}

function ValidateInstancedItemArray(value: unknown, field: string): string | null {
    if (value == null) return null; // optional collection
    if (!Array.isArray(value)) return `${field} must be an array`;
    if (value.length > MAX_ITEMS_PER_ARRAY) return `${field} has too many items`;
    for (const item of value) {
        if (item == null || typeof item !== "object" || Array.isArray(item)) return `${field} contains a non-object entry`;
        if (!IsNonEmptyString((item as any).catalogId)) return `${field} entry has an invalid catalogId`;
        if (!IsNonEmptyString((item as any).instanceId)) return `${field} entry has an invalid instanceId`;
        const ItemData = (item as any).itemData;
        if (ItemData != null && (typeof ItemData !== "string" || ItemData.length > MAX_ITEM_DATA_LENGTH)) return `${field} entry has invalid itemData`;
        const UpdateVersion = (item as any).updateVersion;
        if (UpdateVersion != null && !IsBoundedNonNegativeInteger(UpdateVersion)) return `${field} entry has an invalid updateVersion`;
    }
    return null;
}

function ValidateStackedItemArray(value: unknown, field: string): string | null {
    if (value == null) return null; // optional collection
    if (!Array.isArray(value)) return `${field} must be an array`;
    if (value.length > MAX_ITEMS_PER_ARRAY) return `${field} has too many items`;
    for (const item of value) {
        if (item == null || typeof item !== "object" || Array.isArray(item)) return `${field} contains a non-object entry`;
        if (!IsNonEmptyString((item as any).catalogId)) return `${field} entry has an invalid catalogId`;
        const Quantity = (item as any).quantity;
        if (!Number.isInteger(Quantity) || Quantity < 0 || Quantity > MAX_QUANTITY) return `${field} entry has an invalid quantity`;
    }
    return null;
}

// Validates a POST /inventory transaction body. Returns an error message (400) or null if valid.
export function ValidateInventoryTransactionBody(body: any): string | null {
    if (body == null || typeof body !== "object") return "request body must be an object";
    if (!IsNonEmptyString(body.characterId)) return "characterId must be a non-empty string";
    if (!IsNonEmptyString(body.transactionId)) return "transactionId must be a non-empty string";

    for (const field of ["addInstancedItems", "removeInstancedItems", "saveInstancedItems"]) {
        const Error = ValidateInstancedItemArray(body[field], field);
        if (Error) return Error;
    }
    for (const field of ["addStackedItems", "removeStackedItems"]) {
        const Error = ValidateStackedItemArray(body[field], field);
        if (Error) return Error;
    }
    return null;
}

// True when the transaction actually grants or spends items/currency (as opposed to only saving
// data on already-owned items). Grants/spends are authoritative and must originate from the
// gameserver, never a raw player bearer token.
export function InventoryBodyHasGrantOrSpend(body: any): boolean {
    if (body == null || typeof body !== "object") return false;
    return ["addInstancedItems", "addStackedItems", "removeInstancedItems", "removeStackedItems"]
        .some((field) => Array.isArray(body[field]) && body[field].length > 0);
}

// Validates a POST /inventory/instanceditem single-item update body.
export function ValidateInstancedItemUpdateBody(body: any): string | null {
    if (body == null || typeof body !== "object") return "request body must be an object";
    if (!IsNonEmptyString(body.characterId)) return "characterId must be a non-empty string";
    if (!IsNonEmptyString(body.instanceId)) return "instanceId must be a non-empty string";
    if (!IsNonEmptyString(body.catalogId)) return "catalogId must be a non-empty string";
    if (body.itemData != null && (typeof body.itemData !== "string" || body.itemData.length > MAX_ITEM_DATA_LENGTH)) return "itemData must be a string";
    if (body.updateVersion != null && !IsBoundedNonNegativeInteger(body.updateVersion)) return "updateVersion must be a bounded non-negative integer";
    return null;
}

// Validates a POST /loadout/:userId/:characterId/:index body. 1.12 supports six total
// loadouts: the default slot (index 0) plus five slots unlocked through Slayer's Path
// (indices 1..5); on the wire all entitled slots are reported as character slots (account 0/0,
// see ResolveWireLoadoutSlotCounts). `persistent` remains the separate persistent-data write.
// Existence/unlock state for a numeric slot is checked by the loadout repository when saving.
export function ValidateLoadoutWriteData(index: string, data: unknown): string | null {
    const NumericIndex = Number(index);
    if (index !== "persistent" && (!Number.isSafeInteger(NumericIndex) || String(NumericIndex) !== index || NumericIndex < 0 || NumericIndex > 5)) {
        return `unsupported loadout index ${index}`;
    }
    if (typeof data !== "string" || data.length === 0) return "data must be a non-empty JSON string";
    if (data.length > MAX_LOADOUT_DATA_LENGTH) return "data is too large";
    let Parsed: any;
    try { Parsed = JSON.parse(data); } catch { return "data is not valid JSON"; }
    if (Parsed == null || typeof Parsed !== "object" || Array.isArray(Parsed)) return "data must be a JSON object";
    return null;
}
