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
 * [2026-10-13 realms S3] WHO PAYS THE PRICE, AND WHAT A PLAYER-HOSTED SERVER MAY SAVE
 * -----------------------------------------------------------------------------------
 * The game pays a node's price itself, in its own POST /inventory before the journey is saved: a dedicated
 * server relays `removeStackedItems=[CURRENCY_PJM_WEAPON x25, CURRENCY_NOTES x1875]` (exactly the node's
 * `currencyCosts`, merits and Notes in one transaction) and posts the journey map to POST /pjm/:userId up to
 * minutes later - on arrival or a later save - not in the same request (captures: 18 Jul 2026 VPS logs,
 * `[INV-CAP] ... gsKey=Y removeStacked=[CURRENCY_PJM_WEAPON x25]`, wallet debit, then `Player journey map SAVED`
 * 14 s on). So the backend must NOT charge again (double charge), and it cannot tell at /pjm time which spend belonged
 * to which node: the inventory ledger stores request hashes only, Notes are also spent on crafting, and merit prices
 * changed between game versions, so reconciling balances against unlocked nodes would reject real players. A host's
 * spend goes through POST /inventory like a dedicated server's (p2pInventoryAuthorization.ts refuses only Platinum
 * and entitlements; the inventory monitor tags it), so the price is covered there, not here.
 *
 * What the backend CAN check at /pjm time, and does for a player-hosted server (PlanHostPlayerJourney, applied inside
 * SavePlayerJourney's compare-and-swap loop): a node newly unlocked must be a node the game has, and either a root of
 * the graph (no node lists it in `childNodes`) or have at least one parent already unlocked, in the stored map or
 * accepted earlier in the same request. A newly unlocked node that fails keeps its stored status (and so grants no
 * reward). A host also cannot lock an unlocked node again or point one node's reward at another node's id.
 * Dedicated servers keep the old trust: their map is stored as sent.
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
import { loadGameData, tryLoadGameData } from "../gameData/loader";
import { GauntletMatchmakingEnabled } from "../matchmakingHuntPolicy";
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

// [2026-10-13 realms S3] The shape of the graph as the definitions give it, for checking a player-hosted server's
// unlocks (PlanHostPlayerJourney). `parents` maps a node to every node that lists it in `childNodes`; a node with no
// entry is a root. `known` is every node id the game has: the definitions, their children and the served graph
// (50 of the 509 nodes carry no cost, reward or child and so have no definition row, but are children or served nodes).
export interface SlayersPathGraph {
    parents: ReadonlyMap<string, readonly string[]>;
    known: ReadonlySet<string>;
    /** False when no definitions loaded: nothing can be verified, so a host's unlocks are all refused. */
    usable: boolean;
}

export function BuildSlayersPathGraph(
    definitions: Record<string, SlayersPathNodeDefinition>,
    servedNodeIds: Iterable<string> = []
): SlayersPathGraph {
    const Parents = new Map<string, string[]>();
    const Known = new Set<string>();
    for (const [NodeId, Def] of Object.entries(definitions ?? {})) {
        Known.add(NodeId);
        for (const Child of Array.isArray(Def?.childNodes) ? Def.childNodes : []) {
            if (typeof Child !== "string" || Child.length === 0 || Child === "None") continue;
            Known.add(Child);
            const Existing = Parents.get(Child);
            if (Existing === undefined) Parents.set(Child, [NodeId]);
            else if (!Existing.includes(NodeId)) Existing.push(NodeId);
        }
    }
    for (const NodeId of servedNodeIds) {
        if (typeof NodeId === "string" && NodeId.length > 0) Known.add(NodeId);
    }
    return { parents: Parents, known: Known, usable: Object.keys(definitions ?? {}).length > 0 };
}

let DefaultGraphCache: SlayersPathGraph | undefined;

function DefaultSlayersPathGraph(): SlayersPathGraph {
    if (DefaultGraphCache === undefined) {
        let Served: string[] = [];
        try {
            Served = Object.keys(tryLoadGameData<any>("slayers_path.json")?.payload?.nodes ?? {});
        } catch {
            Served = [];   // the definitions alone still give every parent edge
        }
        DefaultGraphCache = BuildSlayersPathGraph(DEFINITIONS, Served);
    }
    return DefaultGraphCache;
}

export type HostJourneyStripReason = "unknown-node" | "prerequisite" | "node-id-mismatch" | "definitions-unavailable";

export interface HostJourneyPlan {
    /** The node map to store. */
    nodes: Record<string, any>;
    /** Newly unlocked nodes accepted (the backend checked their prerequisite). */
    unlocked: string[];
    /** Newly unlocked nodes refused; the stored status is kept (a node the map did not have stays locked). */
    stripped: { nodeId: string; reason: HostJourneyStripReason }[];
    /** Nodes the host tried to lock again; the stored entry is kept. */
    relocked: string[];
}

/**
 * [2026-10-13 realms S3] Pure. Checks the journey map a player-hosted server sends for one of its players (POST /pjm),
 * after SavePlayerJourney merged it with the stored map (`mergedNodes`; `storedNodes` is what was there), and returns the map
 * to store. The game pays a node's price itself (see the header), so only what the backend can know is checked:
 *   - a newly unlocked node (status 1 or 2 where the stored one was not) must exist in the game and either be a root or
 *     have a parent that is unlocked in the stored map or accepted earlier in this request (a purchase and its
 *     auto-unlocked children arrive together, in any key order, so this runs to a fixed point);
 *   - an unlocked node cannot be locked again;
 *   - an unlocked entry's own `node_id` must be its key: rewards are granted from `node_id`
 *     (GetUnlockedNodeIds), so a free root's key must not carry another node's id.
 * Every refusal keeps the stored entry, or a locked copy of the sent one when there was none.
 */
export function PlanHostPlayerJourney(storedNodes: any, mergedNodes: any, graph: SlayersPathGraph = DefaultSlayersPathGraph()): HostJourneyPlan {
    const AsRecord = (Value: any): Record<string, any> =>
        Value && typeof Value === "object" && !Array.isArray(Value) ? Value : {};
    const Stored = AsRecord(storedNodes);
    const StoredEntry = (NodeId: string): any => Object.hasOwn(Stored, NodeId) ? Stored[NodeId] : undefined;
    // A Map keeps a "__proto__" key an ordinary entry; the result is built with Object.fromEntries for the same reason.
    const Merged = new Map<string, any>(Object.entries(AsRecord(mergedNodes)));

    const Stripped: HostJourneyPlan["stripped"] = [];
    const Relocked: string[] = [];

    for (const [NodeId, Node] of [...Merged]) {
        if (!IsNodeUnlocked(Node) || typeof Node?.node_id !== "string" || Node.node_id === NodeId) continue;
        const Before = StoredEntry(NodeId);
        if (Before !== undefined && JSON.stringify(Before) === JSON.stringify(Node)) continue;   // data from before, not this write
        Stripped.push({ nodeId: NodeId, reason: "node-id-mismatch" });
        if (Before !== undefined) Merged.set(NodeId, Before);
        else Merged.delete(NodeId);
    }

    for (const NodeId of Object.keys(Stored)) {
        if (IsNodeUnlocked(Stored[NodeId]) && !IsNodeUnlocked(Merged.get(NodeId))) {
            Merged.set(NodeId, Stored[NodeId]);
            Relocked.push(NodeId);
        }
    }

    const Pending: string[] = [];
    const Unlocked = new Set<string>();
    for (const [NodeId, Node] of Merged) {
        if (!IsNodeUnlocked(Node)) continue;
        if (IsNodeUnlocked(StoredEntry(NodeId))) Unlocked.add(NodeId);
        else Pending.push(NodeId);
    }

    const Refuse: { nodeId: string; reason: HostJourneyStripReason }[] = [];
    let Remaining: string[] = [];
    for (const NodeId of Pending) {
        if (!graph.usable) Refuse.push({ nodeId: NodeId, reason: "definitions-unavailable" });
        else if (!graph.known.has(NodeId)) Refuse.push({ nodeId: NodeId, reason: "unknown-node" });
        else Remaining.push(NodeId);
    }

    const Accepted: string[] = [];
    for (let Progress = true; Progress && Remaining.length > 0;) {
        Progress = false;
        const Next: string[] = [];
        for (const NodeId of Remaining) {
            const Parents = graph.parents.get(NodeId);
            if (Parents === undefined || Parents.some((Parent) => Unlocked.has(Parent))) {
                Unlocked.add(NodeId);
                Accepted.push(NodeId);
                Progress = true;
            } else {
                Next.push(NodeId);
            }
        }
        Remaining = Next;
    }
    for (const NodeId of Remaining) Refuse.push({ nodeId: NodeId, reason: "prerequisite" });

    for (const { nodeId } of Refuse) {
        const Before = StoredEntry(nodeId);
        Merged.set(nodeId, Before !== undefined ? Before : { ...Merged.get(nodeId), node_status: 0 });
    }

    return {
        nodes: Object.fromEntries(Merged),
        unlocked: Pending.filter((NodeId) => Accepted.includes(NodeId)),
        stripped: [...Stripped, ...Refuse],
        relocked: Relocked
    };
}

// [2026-10-16] Gauntlet stays shown but disabled until MYSTICPARADOX_GAUNTLET=on (owner's decision: mark it disabled, do not remove it).
// The game's hunt map enables Gauntlet from the Slayer's Path node Gauntlet_Unlock (a Blueprint check on the journey data, not in the
// executable): on 16 Oct the owner's account held it at 2 and a hunt's map offered Gauntlet. So while Gauntlet is off the backend serves
// that node as Locked (0) on every journey answer and never changes what is stored: a save that brings the masked status back keeps the
// stored entry, so a player's real unlock is there when Gauntlet is turned on. Matchmaking refuses Gauntlet hunts anyway
// (matchmakingHuntPolicy.ts).
export const GAUNTLET_UNLOCK_NODE = "Gauntlet_Unlock";

/** The journey nodes served as Locked: Gauntlet_Unlock while MYSTICPARADOX_GAUNTLET is not on, else none. */
export function JourneyNodesShownLocked(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
    return GauntletMatchmakingEnabled(environment) ? [] : [GAUNTLET_UNLOCK_NODE];
}

/** A copy of the map for a journey answer, with every shown-locked node that is present set to Locked (0). The input is not changed. */
export function MaskJourneyNodesForPlayer(nodes: any, shownLocked: readonly string[] = JourneyNodesShownLocked()): Record<string, any> {
    const Safe: Record<string, any> = nodes && typeof nodes === "object" && !Array.isArray(nodes) ? nodes : {};
    if (shownLocked.length === 0) return Safe;
    const Out: Record<string, any> = { ...Safe };
    for (const NodeId of shownLocked) {
        if (Object.hasOwn(Out, NodeId) && Out[NodeId] && typeof Out[NodeId] === "object") Out[NodeId] = { ...Out[NodeId], node_status: 0 };
    }
    return Out;
}

/**
 * For a save (runs on the merged map, before the host check): a shown-locked node that is unlocked in the stored map keeps its stored
 * entry, whatever the game sent back (it saw the masked Locked status). A node the stored map does not have unlocked is left as sent,
 * so a real unlock while Gauntlet is off is still checked and stored.
 */
export function RestoreJourneyNodesShownLocked(storedNodes: any, mergedNodes: any,
    shownLocked: readonly string[] = JourneyNodesShownLocked()): Record<string, any> {
    const Merged: Record<string, any> = mergedNodes && typeof mergedNodes === "object" && !Array.isArray(mergedNodes) ? { ...mergedNodes } : {};
    const Stored: Record<string, any> = storedNodes && typeof storedNodes === "object" && !Array.isArray(storedNodes) ? storedNodes : {};
    for (const NodeId of shownLocked) {
        if (Object.hasOwn(Stored, NodeId) && IsNodeUnlocked(Stored[NodeId])) Merged[NodeId] = Stored[NodeId];
    }
    return Merged;
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
