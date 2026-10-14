export const STARTER_INSTANCE_MIGRATION_VERSION = "starter-instance-v1";

// [2026-10-14] Rows seeded before this date store two owned items by CATALOG id where the game resolves an owned inventory
// INSTANCE id: a loadout slot's `flask` (FL_HEALING_DEFAULT) and `persistent.glider` (GD_FRAME_STARTER_BASE). MysticFox's
// working rows hold instance ids; the VPS account's starter rows held catalog ids and it had no flask (no heals, no revives)
// in a realm hunt on 14 Oct. Same repair shape as bannerInstanceMigration.ts: change a field only when it holds a catalog id
// of the expected kind and the inventory owns exactly one instance of it; leave valid references and every ambiguous shape.

export type StarterReferenceStatus =
    | "migrate"
    | "already-valid"
    | "absent"
    | "invalid-inventory"
    | "invalid-loadouts"
    | "invalid-persistent"
    | "missing-owned-instance"
    | "duplicate-owned-instances"
    | "unrecognized-reference";

export interface StarterReferenceChange {
    /** "slot N flask" or "persistent glider". */
    field: string;
    from: string;
    to: string;
}

export interface FlaskInstanceMigrationPlan {
    status: StarterReferenceStatus;
    /** The repaired slot array; present only for "migrate". */
    loadouts?: unknown[];
    changes?: StarterReferenceChange[];
    detail?: string;
}

export interface GliderInstanceMigrationPlan {
    status: StarterReferenceStatus;
    /** The repaired persistent object; present only for "migrate". */
    persistent?: Record<string, unknown>;
    change?: StarterReferenceChange;
    detail?: string;
}

interface InstancedInventoryItem {
    catalogId: string;
    instanceId: string;
}

type Resolution =
    | { status: "already-valid" | "absent" }
    | { status: "migrate"; to: string }
    | { status: Exclude<StarterReferenceStatus, "migrate" | "already-valid" | "absent">; detail: string };

function IsRecord(Value: unknown): Value is Record<string, unknown> {
    return Value != null && typeof Value === "object" && !Array.isArray(Value);
}

function IsInventory(Value: unknown): Value is InstancedInventoryItem[] {
    return Array.isArray(Value) && Value.every((Item) => IsRecord(Item)
        && typeof Item.catalogId === "string" && Item.catalogId.length > 0
        && typeof Item.instanceId === "string" && Item.instanceId.length > 0);
}

/** How one stored reference to an owned item of the `Prefix` kind (FL_, GD_) resolves against the inventory. */
function ResolveReference(Items: InstancedInventoryItem[], Value: unknown, Prefix: string, Field: string): Resolution {
    if (Value == null || Value === "") return { status: "absent" };
    if (typeof Value !== "string") return { status: "unrecognized-reference", detail: `${Field} is not a string` };
    const Referenced = Items.find((Item) => Item.instanceId === Value);
    if (Referenced != null) {
        return Referenced.catalogId.startsWith(Prefix)
            ? { status: "already-valid" }
            : { status: "unrecognized-reference", detail: `${Field} points to ${Referenced.catalogId}, not a ${Prefix}* item` };
    }
    if (!Value.startsWith(Prefix)) {
        return { status: "unrecognized-reference", detail: `${Field} is neither an owned instance id nor a ${Prefix}* catalog id` };
    }
    const Matches = Items.filter((Item) => Item.catalogId === Value);
    if (Matches.length === 0) return { status: "missing-owned-instance", detail: `inventory has no owned instance for ${Value}` };
    if (Matches.length > 1) return { status: "duplicate-owned-instances", detail: `inventory has ${Matches.length} instances for ${Value}` };
    return { status: "migrate", to: Matches[0].instanceId };
}

/**
 * Plans the flask repair of every loadout slot without mutating the inputs. One slot needing manual review blocks the row.
 */
export function PlanFlaskInstanceMigration(InstancedItemsValue: unknown, LoadoutsValue: unknown): FlaskInstanceMigrationPlan {
    if (!IsInventory(InstancedItemsValue)) {
        return { status: "invalid-inventory", detail: "instancedItems is not an array of catalogId/instanceId records" };
    }
    if (!Array.isArray(LoadoutsValue)) return { status: "invalid-loadouts", detail: "loadouts is not an array" };

    const Changes: StarterReferenceChange[] = [];
    const Repaired: unknown[] = [];
    let SawFlask = false;
    for (const [Position, Slot] of LoadoutsValue.entries()) {
        if (!IsRecord(Slot)) { Repaired.push(Slot); continue; }
        const SlotIndex = typeof Slot.slot_index === "number" ? Slot.slot_index : Position;
        const Field = `slot ${SlotIndex} flask`;
        const Result = ResolveReference(InstancedItemsValue, Slot.flask, "FL_", Field);
        if (Result.status === "absent") { Repaired.push(Slot); continue; }
        SawFlask = true;
        if (Result.status === "already-valid") { Repaired.push(Slot); continue; }
        if (Result.status !== "migrate") return { status: Result.status, detail: "detail" in Result ? Result.detail : undefined };
        Changes.push({ field: Field, from: Slot.flask as string, to: Result.to });
        Repaired.push({ ...Slot, flask: Result.to });
    }

    if (Changes.length > 0) return { status: "migrate", loadouts: Repaired, changes: Changes };
    return { status: SawFlask ? "already-valid" : "absent" };
}

/** Plans the persistent.glider repair without mutating the inputs. */
export function PlanGliderInstanceMigration(InstancedItemsValue: unknown, PersistentValue: unknown): GliderInstanceMigrationPlan {
    if (!IsInventory(InstancedItemsValue)) {
        return { status: "invalid-inventory", detail: "instancedItems is not an array of catalogId/instanceId records" };
    }
    if (!IsRecord(PersistentValue)) return { status: "invalid-persistent", detail: "persistent is not an object" };
    const Result = ResolveReference(InstancedItemsValue, PersistentValue.glider, "GD_", "persistent glider");
    if (Result.status === "migrate") {
        return {
            status: "migrate",
            persistent: { ...PersistentValue, glider: Result.to },
            change: { field: "persistent glider", from: PersistentValue.glider as string, to: Result.to }
        };
    }
    return "detail" in Result ? { status: Result.status, detail: Result.detail } : { status: Result.status };
}
