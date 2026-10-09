/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { loadGameData } from "./gameData/loader";

export type InventoryStorageKind = "instanced" | "stacked";

export type InventoryStoragePolicyEntry = {
    storage: InventoryStorageKind;
    maxQuantity: number;
    tags: string[];
};

type InventoryStoragePolicyDocument = {
    schema: number;
    targetVersion: string;
    catalogSha256: string;
    generatedAt: string;
    referencedCatalogIds: number;
    entries: Record<string, InventoryStoragePolicyEntry>;
};

// Loaded on first use, so importing inventory code does not need game data.
let PolicyCache: InventoryStoragePolicyDocument | undefined;
function Policy(): InventoryStoragePolicyDocument {
    return PolicyCache ??= loadGameData<InventoryStoragePolicyDocument>("inventory_storage_policy.json");
}

export type InventoryStorageCorrection = {
    catalogId: string;
    from: InventoryStorageKind;
    to: InventoryStorageKind;
    quantity: number;
};

export type InventoryStorageMigrationChange = {
    catalogId: string;
    source: "instancedItems";
    destination: "stackedItems";
    migratedInstances: number;
    existingQuantity: number;
    finalQuantity: number;
    result: "moved" | "deduplicated-to-one";
};

export type InventoryStorageMigrationIssue = {
    catalogId: string;
    source: "stackedItems";
    expected: "instancedItems";
    quantity: number;
    result: "manual-review";
};

export function GetInventoryStoragePolicyMetadata() {
    return {
        schema: Policy().schema,
        targetVersion: Policy().targetVersion,
        catalogSha256: Policy().catalogSha256,
        generatedAt: Policy().generatedAt,
        referencedCatalogIds: Policy().referencedCatalogIds,
    };
}

export function GetInventoryStoragePolicy(catalogId: string): InventoryStoragePolicyEntry | undefined {
    return typeof catalogId === "string" ? Policy().entries[catalogId] : undefined;
}

export function IsOwnershipUnlock(entry: InventoryStoragePolicyEntry | undefined): boolean {
    if (entry == undefined || entry.storage !== "stacked") return false;
    const Tags = new Set(entry.tags.map((Tag) => Tag.toLowerCase()));
    return entry.maxQuantity === 1
        || Tags.has("transmog")
        || Tags.has("owned")
        || Tags.has("accessory")
        || Tags.has("dye")
        || Tags.has("bannercustomization")
        || Tags.has("emoji")
        || Tags.has("emote");
}

function RequireGrantQuantity(value: unknown, catalogId: string): number {
    const Quantity = Number(value);
    if (!Number.isSafeInteger(Quantity) || Quantity <= 0 || Quantity > 1000) {
        throw new Error(`Invalid quantity ${String(value)} for non-stackable catalog item ${catalogId}`);
    }
    return Quantity;
}

function AddStackedGrant(StackedItems: any[], catalogId: string, quantity: number): void {
    const Existing = StackedItems.find((Item) => Item?.catalogId === catalogId);
    if (Existing != undefined) {
        Existing.quantity = (Number(Existing.quantity) || 0) + quantity;
        return;
    }
    StackedItems.push({ catalogId, quantity });
}

function MakeDeterministicInstanceId(transactionId: string, catalogId: string, ordinal: number): string {
    return crypto
        .createHash("sha256")
        .update(`inventory-storage-normalize:${transactionId}:${catalogId}:${ordinal}`)
        .digest("hex")
        .slice(0, 26)
        .toUpperCase();
}

/**
 * Corrects only ADD collections at the authoritative transaction boundary. The request hash must be
 * computed from the original wire body before this runs, preserving replay compatibility with old
 * idempotency-ledger rows. Unknown catalog ids retain their incoming representation and are never
 * guessed.
 */
export function NormalizeInventoryGrantCollections(
    transactionId: string,
    instancedItemsToAdd: any[],
    stackedItemsToAdd: any[]
): {
    instancedItemsToAdd: any[];
    stackedItemsToAdd: any[];
    corrections: InventoryStorageCorrection[];
} {
    const EffectiveInstanced: any[] = [];
    const EffectiveStacked: any[] = [];
    const Corrections: InventoryStorageCorrection[] = [];
    let SyntheticOrdinal = 0;

    for (const Item of stackedItemsToAdd ?? []) {
        const CatalogId = Item?.catalogId;
        const Entry = GetInventoryStoragePolicy(CatalogId);
        if (Entry?.storage !== "instanced") {
            EffectiveStacked.push(Item && typeof Item === "object" ? { ...Item } : Item);
            continue;
        }

        const Quantity = RequireGrantQuantity(Item?.quantity, CatalogId);
        for (let i = 0; i < Quantity; i++) {
            EffectiveInstanced.push({
                catalogId: CatalogId,
                instanceId: MakeDeterministicInstanceId(transactionId, CatalogId, SyntheticOrdinal++),
                itemData: null,
                updateVersion: 0,
            });
        }
        Corrections.push({ catalogId: CatalogId, from: "stacked", to: "instanced", quantity: Quantity });
    }

    for (const Item of instancedItemsToAdd ?? []) {
        const CatalogId = Item?.catalogId;
        const Entry = GetInventoryStoragePolicy(CatalogId);
        if (Entry?.storage !== "stacked") {
            EffectiveInstanced.push(Item);
            continue;
        }

        AddStackedGrant(EffectiveStacked, CatalogId, 1);
        Corrections.push({ catalogId: CatalogId, from: "instanced", to: "stacked", quantity: 1 });
    }

    return {
        instancedItemsToAdd: EffectiveInstanced,
        stackedItemsToAdd: EffectiveStacked,
        corrections: Corrections,
    };
}

/** Pure transformation used by the explicit migration script and unit tests. */
export function MigrateInventoryStorageArrays(instancedItems: any[], stackedItems: any[]): {
    instancedItems: any[];
    stackedItems: any[];
    changes: InventoryStorageMigrationChange[];
    issues: InventoryStorageMigrationIssue[];
} {
    const KeptInstanced: any[] = [];
    const MovedCounts = new Map<string, number>();

    for (const Item of instancedItems ?? []) {
        const CatalogId = Item?.catalogId;
        const Entry = GetInventoryStoragePolicy(CatalogId);
        if (Entry?.storage === "stacked") {
            MovedCounts.set(CatalogId, (MovedCounts.get(CatalogId) ?? 0) + 1);
        } else {
            KeptInstanced.push(Item);
        }
    }

    let NextStacked = (stackedItems ?? []).map((Item) => Item && typeof Item === "object" ? { ...Item } : Item);
    const Changes: InventoryStorageMigrationChange[] = [];

    for (const [CatalogId, MigratedInstances] of MovedCounts) {
        const Entry = GetInventoryStoragePolicy(CatalogId)!;
        const Matches = NextStacked.filter((Item) => Item?.catalogId === CatalogId);
        const ExistingQuantity = Matches.reduce((Total, Item) => Total + Math.max(0, Number(Item?.quantity) || 0), 0);
        NextStacked = NextStacked.filter((Item) => Item?.catalogId !== CatalogId);

        const OwnershipUnlock = IsOwnershipUnlock(Entry);
        const FinalQuantity = OwnershipUnlock ? 1 : ExistingQuantity + MigratedInstances;
        NextStacked.push({ catalogId: CatalogId, quantity: FinalQuantity });
        Changes.push({
            catalogId: CatalogId,
            source: "instancedItems",
            destination: "stackedItems",
            migratedInstances: MigratedInstances,
            existingQuantity: ExistingQuantity,
            finalQuantity: FinalQuantity,
            result: OwnershipUnlock && ExistingQuantity + MigratedInstances > 1
                ? "deduplicated-to-one"
                : "moved",
        });
    }

    const Issues: InventoryStorageMigrationIssue[] = [];
    for (const Item of NextStacked) {
        const CatalogId = Item?.catalogId;
        const Entry = GetInventoryStoragePolicy(CatalogId);
        if (Entry?.storage === "instanced") {
            Issues.push({
                catalogId: CatalogId,
                source: "stackedItems",
                expected: "instancedItems",
                quantity: Number(Item?.quantity) || 0,
                result: "manual-review",
            });
        }
    }

    return { instancedItems: KeptInstanced, stackedItems: NextStacked, changes: Changes, issues: Issues };
}