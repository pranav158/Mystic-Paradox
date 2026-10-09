/*
 * Slayer's Path (Player Journey Map) node definitions + unlock reward granting.
 *
 * WHY THIS EXISTS
 * ---------------
 * `POST /pjm/:userId` used to only persist the client's node map. It never processed a node's
 * unlock EFFECT. So you could buy e.g. Grim Onslaught (`WeaponTypeGA_Spc_00`), the node saved
 * fine, and the weapon special still wasn't selectable — because the item it grants
 * (`PART_GA_SPECIAL_SKILLSHOT`) was never added to the character's inventory. Reported as
 * "I unlock it, the hold completes, nothing happens."
 *
 * The served graph (`game-data/slayers_path.json`) is node ids only — no costs, no rewards, no edges —
 * so the backend had no way to know what a node grants. `game-data/slayers_path_definitions.json` is
 * the missing half, exported from the game's own `Archon.PlayerJourneyNodeData` DataTable by
 * CatalogExporter (`EXPORT_SLAYERS_PATH=1`).
 *
 * SCOPE — REWARD GRANTING ONLY, DELIBERATELY
 * ------------------------------------------
 * This grants rewards. It does NOT deduct `currencyCosts`, even though the definitions carry
 * them, because the CLIENT already sends the spend as a normal inventory transaction
 * (verified in capture: `removeStacked=[CURRENCY_NOTES x760]` -> wallet debit -> journey SAVED).
 * Deducting here as well would DOUBLE-CHARGE the player. Costs are kept in the definitions file
 * for the future server-authoritative unlock transaction (validate prereq -> deduct -> persist ->
 * grant), which is a separate piece of work.
 *
 * SELF-HEALING IDEMPOTENCY
 * ------------------------
 * Every journey save reconciles every unlocked, item-granting node against inventory. This is
 * intentional: the journey row and inventory transaction cannot currently share one Mongo
 * transaction, so a grant may fail after the node save succeeds. Reconciliation retries that
 * missing reward on the next save. Existing catalog ids are skipped, and each item uses stable
 * transaction + instance ids so even an ambiguous retry cannot create a duplicate.
 */

import crypto from "node:crypto";

import { logger } from "../logger";
import { loadGameData } from "../gameData/loader";
import { GetCharactersForUid } from "./character";
import { GetInventoryForUserIdAndCharacterId, RunInventoryTransaction } from "./inventory";

export type SlayersPathNodeDefinition = {
    rewards?: string[];
    currencyCosts?: Array<{ currency: string; amount: number }>;
    childNodes?: string[];
    autoUnlockIfParentUnlocked?: boolean;
};

function LoadDefinitions(): Record<string, SlayersPathNodeDefinition> {
    try {
        const Parsed = loadGameData<Record<string, SlayersPathNodeDefinition>>("slayers_path_definitions.json");
        const Grantable = Object.values(Parsed).filter((Def) => (Def?.rewards?.length ?? 0) > 0).length;

        logger.info(`[slayers-path] loaded ${Object.keys(Parsed).length} node definitions (${Grantable} grant an item)`);
        return Parsed;
    } catch (err) {
        // Non-fatal: the journey map still persists, unlocks just won't grant their item.
        logger.error(`[slayers-path] FAILED to load slayers_path_definitions.json — node rewards will NOT be granted: ${String(err)}`);
        return {};
    }
}

const DEFINITIONS: Record<string, SlayersPathNodeDefinition> = LoadDefinitions();

export function GetNodeDefinition(nodeId: string): SlayersPathNodeDefinition | undefined {
    return DEFINITIONS[nodeId];
}

// Grantable catalog ids for a node. The export writes a literal "None" for nodes whose reward slot
// is empty (Slayer_00, Past_/Future_Slayer_*) — those must never be granted.
export function GetNodeRewardItemIds(nodeId: string): string[] {
    const Def = DEFINITIONS[nodeId];
    if (Def == undefined || !Array.isArray(Def.rewards)) return [];
    return Def.rewards.filter((Id) => typeof Id === "string" && Id.length > 0 && Id !== "None");
}

// Archon.EPlayerJourneyNodeStatus in the 1.12 SDK is:
//   Locked=0, LockedButClaimable=1, Unlocked=2.
// A purchased item-reward node can remain at LockedButClaimable while its reward delivery is
// pending/failed. Reconciliation therefore accepts the two real claim states (1 and 2), but not
// Locked or the enum sentinels. Callers that cause grants are restricted to game-server auth.
export function IsNodeUnlocked(node: any): boolean {
    const Status = node?.node_status;
    return Status === 1 || Status === 2;
}

export function GetUnlockedNodeIds(nodes: any): string[] {
    const SafeNodes = nodes && typeof nodes === "object" ? nodes : {};
    return Object.entries(SafeNodes)
        .filter(([, Node]) => IsNodeUnlocked(Node))
        .map(([NodeId, Node]: [string, any]) =>
            typeof Node?.node_id === "string" && Node.node_id.length > 0 ? Node.node_id : NodeId
        );
}
export function ComputeNewlyUnlockedNodeIds(storedNodes: any, nextNodes: any): string[] {
    const Stored = storedNodes && typeof storedNodes === "object" ? storedNodes : {};
    const Next = nextNodes && typeof nextNodes === "object" ? nextNodes : {};

    const Out: string[] = [];
    for (const [NodeId, Node] of Object.entries(Next)) {
        if (!IsNodeUnlocked(Node)) continue;              // not unlocked in the incoming map
        if (IsNodeUnlocked((Stored as any)[NodeId])) continue; // already unlocked before -> not new
        Out.push(NodeId);
    }
    return Out;
}

/**
 * Reconciles reward items for the supplied unlocked nodes. Returns catalog ids whose idempotent
 * transaction completed during this call (empty when there was nothing to do). Never throws: a
 * failed reward is retried on the next journey save.
 */
export async function GrantSlayersPathRewards(userId: string, nodeIds: string[]): Promise<string[]> {
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) return [];

    const WantedItemIds = new Set<string>();
    for (const NodeId of nodeIds) {
        for (const ItemId of GetNodeRewardItemIds(NodeId)) WantedItemIds.add(ItemId);
    }
    if (WantedItemIds.size === 0) {
        logger.info(`[slayers-path] ${userId}: ${nodeIds.length} reward-eligible node(s), but none map to an item reward`);
        return [];
    }

    try {
        const Characters = await GetCharactersForUid(userId);
        const Character: any = Array.isArray(Characters) ? Characters[0] : undefined;
        const CharacterId: string | undefined = Character?.id ?? Character?.characterId;

        if (CharacterId == undefined) {
            logger.warn(`[slayers-path] cannot grant rewards for ${userId}: no character found`);
            return [];
        }

        // Layer 2: skip anything the character already owns.
        const Inventory = await GetInventoryForUserIdAndCharacterId(userId, CharacterId);
        let InstancedItems: any[] = [];
        try {
            const Raw = (Inventory as any)?.instancedItems;
            InstancedItems = typeof Raw === "string" ? JSON.parse(Raw) : Array.isArray(Raw) ? Raw : [];
        } catch { InstancedItems = []; }

        const Owned = new Set<string>();
        const LegacyWeaponParts = new Map<string, any[]>();
        for (const Item of InstancedItems) {
            if (!Item || typeof Item.catalogId !== "string") continue;

            // Some rewards written by older builds used the catalog id as the instance id
            // (for example PART_GA_SPECIAL_SKILLSHOT/PART_GA_SPECIAL_SKILLSHOT). The 1.12
            // client can deserialize that item, but it is not a real player-owned instance
            // identity and can fail the customization ownership/filtering path.
            // Only migrate Slayer's Path weapon-part rewards; catalog-shaped ids may be valid
            // virtual/default identities for other item families.
            if (Item.catalogId.startsWith("PART_") && Item.instanceId === Item.catalogId) {
                const Existing = LegacyWeaponParts.get(Item.catalogId) ?? [];
                Existing.push(Item);
                LegacyWeaponParts.set(Item.catalogId, Existing);
                continue;
            }

            Owned.add(Item.catalogId);
        }

        const ToGrant = [...WantedItemIds].filter((Id) => !Owned.has(Id)).sort();
        const ToRepair = ToGrant.filter((Id) => LegacyWeaponParts.has(Id));
        logger.info(`[slayers-path] ${userId}: mapped rewards=[${[...WantedItemIds].sort().join(", ")}], missing=[${ToGrant.join(", ")}], malformedInstances=[${ToRepair.join(", ")}]`);
        if (ToGrant.length === 0) return [];

        const Granted: string[] = [];
        for (const CatalogId of ToGrant) {
            // One transaction per item means one bad reward cannot prevent every other reward.
            // Both ids are deterministic so the request body is byte-for-byte stable on retry;
            // this is required by RunInventoryTransaction's transaction-id/request-hash guard.
            const StableKey = `${userId}:${CharacterId}:${CatalogId}`;
            const InstanceId = crypto
                .createHash("sha256")
                .update(`pjm-instance:${StableKey}`)
                .digest("hex")
                .slice(0, 26)
                .toUpperCase();
            const LegacyItems = LegacyWeaponParts.get(CatalogId) ?? [];
            const IsRepair = LegacyItems.length > 0;
            const TransactionId = crypto
                .createHash("sha256")
                // A repair has a different request body from the original grant. It therefore
                // needs a distinct idempotency key or the ledger correctly rejects it as a
                // transaction-id replay with different content.
                .update(`${IsRepair ? "pjm-repair-instance" : "pjm-grant"}:${StableKey}`)
                .digest("hex")
                .slice(0, 32)
                .toUpperCase();

            const Preserved = LegacyItems[0];
            const Replacement = {
                catalogId: CatalogId,
                instanceId: InstanceId,
                itemData: Preserved?.itemData ?? null,
                updateVersion: typeof Preserved?.updateVersion === "number" ? Preserved.updateVersion : 0,
            };

            try {
                const Succeeded = await RunInventoryTransaction(
                    userId,
                    CharacterId,
                    TransactionId,
                    [Replacement],
                    [],
                    LegacyItems.map((Item) => ({ catalogId: CatalogId, instanceId: Item.instanceId })),
                    [], []
                );

                if (!Succeeded) {
                    logger.warn(`[slayers-path] ${userId}: inventory transaction did not apply for ${CatalogId}; will retry on next journey save`);
                    continue;
                }

                Granted.push(CatalogId);
                Owned.add(CatalogId);
                if (IsRepair) {
                    logger.info(`[slayers-path] ${userId}: repaired malformed instanceId for ${CatalogId}: ${LegacyItems[0].instanceId} -> ${InstanceId}`);
                } else {
                    logger.info(`[slayers-path] ${userId}: granted ${CatalogId}`);
                }
            } catch (err) {
                logger.error(`[slayers-path] ${userId}: grant failed for ${CatalogId}; will retry on next journey save: ${String(err)}`);
            }
        }

        return Granted;
    } catch (err) {
        logger.error(`[slayers-path] reward reconciliation failed for ${userId}; will retry on next journey save: ${String(err)}`);
        return [];
    }
}
