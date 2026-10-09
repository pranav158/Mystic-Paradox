export const BANNER_INSTANCE_MIGRATION_VERSION = "banner-instance-v1";

export type BannerInstanceMigrationStatus =
    | "migrate"
    | "already-valid"
    | "no-banner"
    | "invalid-persistent"
    | "invalid-inventory"
    | "missing-owned-instance"
    | "duplicate-owned-instances"
    | "unrecognized-reference";

export interface BannerInstanceMigrationPlan {
    status: BannerInstanceMigrationStatus;
    currentBanner: string | null;
    targetBanner?: string;
    persistent?: Record<string, unknown>;
    detail?: string;
}

interface InstancedInventoryItem {
    catalogId: string;
    instanceId: string;
}

function IsRecord(Value: unknown): Value is Record<string, unknown> {
    return Value != null && typeof Value === "object" && !Array.isArray(Value);
}

function IsInstancedInventoryItem(Value: unknown): Value is InstancedInventoryItem {
    return IsRecord(Value)
        && typeof Value.catalogId === "string"
        && Value.catalogId.length > 0
        && typeof Value.instanceId === "string"
        && Value.instanceId.length > 0;
}

/**
 * Plans the narrow legacy repair without mutating either input.
 *
 * The broken rows store a non-stackable banner's catalog ID (BN_*) in persistent.banner. The
 * runtime field is FItemInstanceIdRepl, so it must contain the corresponding owned inventory
 * instance ID. A migration is safe only when exactly one inventory item matches that catalog ID.
 * Already-valid instance references and every ambiguous/unknown shape are preserved.
 */
export function PlanBannerInstanceMigration(
    InstancedItemsValue: unknown,
    PersistentValue: unknown
): BannerInstanceMigrationPlan {
    if (!Array.isArray(InstancedItemsValue) || !InstancedItemsValue.every(IsInstancedInventoryItem)) {
        return {
            status: "invalid-inventory",
            currentBanner: null,
            detail: "instancedItems is not an array of catalogId/instanceId records"
        };
    }
    if (!IsRecord(PersistentValue)) {
        return {
            status: "invalid-persistent",
            currentBanner: null,
            detail: "persistent is not an object"
        };
    }

    const CurrentBanner = PersistentValue.banner;
    if (CurrentBanner == null || CurrentBanner === "") {
        return { status: "no-banner", currentBanner: null };
    }
    if (typeof CurrentBanner !== "string") {
        return {
            status: "invalid-persistent",
            currentBanner: null,
            detail: "persistent.banner is not a string"
        };
    }

    const ReferencedItem = InstancedItemsValue.find((Item) => Item.instanceId === CurrentBanner);
    if (ReferencedItem != null) {
        if (ReferencedItem.catalogId.startsWith("BN_")) {
            return { status: "already-valid", currentBanner: CurrentBanner };
        }
        return {
            status: "unrecognized-reference",
            currentBanner: CurrentBanner,
            detail: `banner points to non-banner inventory item ${ReferencedItem.catalogId}`
        };
    }
    if (!CurrentBanner.startsWith("BN_")) {
        return {
            status: "unrecognized-reference",
            currentBanner: CurrentBanner,
            detail: "banner is neither an owned instance ID nor a BN_* catalog ID"
        };
    }

    const Matches = InstancedItemsValue.filter((Item) => Item.catalogId === CurrentBanner);
    if (Matches.length === 0) {
        return {
            status: "missing-owned-instance",
            currentBanner: CurrentBanner,
            detail: `inventory has no owned instance for ${CurrentBanner}`
        };
    }
    if (Matches.length > 1) {
        return {
            status: "duplicate-owned-instances",
            currentBanner: CurrentBanner,
            detail: `inventory has ${Matches.length} instances for ${CurrentBanner}`
        };
    }

    const TargetBanner = Matches[0].instanceId;
    return {
        status: "migrate",
        currentBanner: CurrentBanner,
        targetBanner: TargetBanner,
        persistent: { ...PersistentValue, banner: TargetBanner }
    };
}
