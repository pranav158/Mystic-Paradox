

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { logger } from "../logger";
import { gameDataPath } from "../gameData/loader";
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
        const Raw = fs
            .readFileSync(gameDataPath("slayers_path_definitions.json"), "utf8")
            .replace(/^﻿/, "");

        const Parsed = JSON.parse(Raw) as Record<string, SlayersPathNodeDefinition>;
        const Grantable = Object.values(Parsed).filter((Def) => (Def?.rewards?.length ?? 0) > 0).length;

        logger.info(`[slayers-path] loaded ${Object.keys(Parsed).length} node definitions (${Grantable} grant an item)`);
        return Parsed;
    } catch (err) {
        
        logger.error(`[slayers-path] FAILED to load slayers_path_definitions.json — node rewards will NOT be granted: ${String(err)}`);
        return {};
    }
}

const DEFINITIONS: Record<string, SlayersPathNodeDefinition> = LoadDefinitions();

export function GetNodeDefinition(nodeId: string): SlayersPathNodeDefinition | undefined {
    return DEFINITIONS[nodeId];
}



export function GetNodeRewardItemIds(nodeId: string): string[] {
    const Def = DEFINITIONS[nodeId];
    if (Def == undefined || !Array.isArray(Def.rewards)) return [];
    return Def.rewards.filter((Id) => typeof Id === "string" && Id.length > 0 && Id !== "None");
}






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
        if (!IsNodeUnlocked(Node)) continue;              
        if (IsNodeUnlocked((Stored as any)[NodeId])) continue; 
        Out.push(NodeId);
    }
    return Out;
}


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
