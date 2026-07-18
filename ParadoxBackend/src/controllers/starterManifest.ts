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

import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import { GetRepositories, GetUnitOfWork, RepositoryProvider } from "../persistence";
import { logger } from "../logger";
import { STARTER_WALLET } from "./wallet";
















const INSTANCE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const INSTANCE_ID_LENGTH = 26;

export function GenerateStarterInstanceId(): string {
    const Bytes = crypto.randomBytes(INSTANCE_ID_LENGTH);
    let Id = "";
    for (let i = 0; i < INSTANCE_ID_LENGTH; i++) {
        Id += INSTANCE_ID_ALPHABET[Bytes[i] % INSTANCE_ID_ALPHABET.length];
    }
    return Id;
}




export const STARTER_DEFAULT_WEAPON_PART_CATALOG_IDS = [
    "PART_EB_SPECIAL_DEFAULT",
    "PART_IH_SPECIAL_DEFAULT",
    "PART_GA_SPECIAL_DEFAULT",
    "PART_CB_SPECIAL_DEFAULT",
    "PART_MS_SPECIAL_PROJECTILE",
    "PART_DP_RECEIVER_DEFAULT",
    "PART_DP_GRIP_DEFAULT",
    "PART_AC_SPECIAL_DEFAULT",
] as const;



export const STARTER_INSTANCED_CATALOG_IDS = [
    "WP_EB_BEGINNER",
    "WP_GA_BEGINNER",
    "WP_IH_BEGINNER",
    "WP_CB_BEGINNER",
    "WP_MS_BEGINNER",
    "WP_DP_BEGINNER",
    "WP_AC_BEGINNER",
    ...STARTER_DEFAULT_WEAPON_PART_CATALOG_IDS,
    "AR_UNEQUIPPED_HELM",
    "AR_BEGINNER_CHEST",
    "AR_BEGINNER_ARMS",
    "AR_BEGINNER_LEGS",
    "LT_BASIC",
    "FL_HEALING_DEFAULT",
    "GD_FRAME_STARTER_BASE",
    "BN_BEGINNER_00",
] as const;

const STARTER_WEAPON_CATALOG_ID = "WP_EB_BEGINNER";
const STARTER_WEAPON_PART_CATALOG_ID = "PART_EB_SPECIAL_DEFAULT";






export const STARTER_STACKED_CATALOG_IDS = [
    "QI_BASIC_FLARE_DURABLE",
    "EM_INTRO_BEGINNER_01",
    "EM_END_BEGINNER_01",
    "EM_PLAYER_BEGINNER_01",
    "EM_PLAYER_BEGINNER_02",
    "EM_PLAYER_BEGINNER_03",
    "EM_PLAYER_BEGINNER_04",
    "BNC_MESH_BEGINNER_00",
    "BNC_FABRIC_BEGINNER_00",
    "BNC_SIGIL_BEGINNER_00",
    "BNC_ANIMATION_BEGINNER_00",
    "BNC_VFX_BEGINNER_00",
    "DYE_GREEN04_DURABLE",
    "DYE_BROWN07_DURABLE",
] as const;




function BuildInstanceData(): string {
    return JSON.stringify({
        SheenType: 73,
        IsPrimarySheenActive: true,
        PrimaryDyeId: "None",
        IsSecondarySheenActive: true,
        SecondaryDyeId: "None",
        IsTertiarySheenActive: false,
        TertiaryDyeId: "None",
        TransmogCatalogId: "None",
        TransmogEnabled: false,
        EquippedCells: [],
        EquippedCellsv2: [],
        SubTypeMetadataArray: {
            ItemSubType: "subtype_eblade",
            EquippedItemParts: [
                {
                    WeaponPartId: STARTER_WEAPON_PART_CATALOG_ID,
                    SlotIndex: 0,
                }
            ]
        }
    });
}

export const BOOTSTRAP_VERSION = "starter-1.12-v2";

export interface StarterManifest {
    instanceIdsByCatalogId: Record<string, string>;
    instancedItems: Array<{ catalogId: string; instanceId: string; itemData: string | null; updateVersion: number }>;
    stackedItems: Array<{ catalogId: string; quantity: number }>;
    loadoutSlot: any;
    persistent: any;
}

type StarterInstancedItem = { catalogId: string; instanceId: string; itemData: string | null; updateVersion: number };

const LOADOUT_EQUIPMENT: Array<[string, string]> = [
    ["weapon", STARTER_WEAPON_CATALOG_ID],
    ["helmet", "AR_UNEQUIPPED_HELM"],
    ["chest", "AR_BEGINNER_CHEST"],
    ["arms", "AR_BEGINNER_ARMS"],
    ["legs", "AR_BEGINNER_LEGS"],
    ["lantern", "LT_BASIC"],
];

function BuildStarterPersistent(): any {
    return {
        manual_emotes: ["", "", "", "", "", ""],
        intro_emote: "EM_INTRO_BEGINNER_01",
        banner: "BN_BEGINNER_00",
        bannerCustomization: JSON.stringify({
            BannerMeshItemID: "BNC_MESH_BEGINNER_00", FabricMaterialItemID: "BNC_FABRIC_BEGINNER_00",
            SigilTextureItemID: "BNC_SIGIL_BEGINNER_00", PlantVFXItemID: "", PersistantStandardVFXItemID: "",
            AnimationItemID: "BNC_ANIMATION_BEGINNER_00", BackgroundColourItemID: "DYE_GREEN04_DURABLE",
            BorderColourItemID: "DYE_BROWN07_DURABLE", SigilColourItemID: "DYE_BROWN07_DURABLE",
            BackgroundSheenType: 0, BorderSheenType: 0, SigilSheenType: 0
        }),
        flare: "QI_BASIC_FLARE_DURABLE", title: "", head_accessory: "", back_accessory: "", pet: "",
        glider: "GD_FRAME_STARTER_BASE", update_version: 0,
        quick_chats: ["", "", "", "", "", "", "", "", ""],
        emojis: ["", "", "", "", "", "", "", "", ""],
        quick_curiosities_items: Array.from({ length: 8 }, (_, item_index) => ({ item_index, item_id: "", instance_id: "" })),
        quickwheel: [],
    };
}



export function BuildStarterLoadoutSlot(instanceIdsByCatalogId: Record<string, string>, persistent = BuildStarterPersistent()): any {
    const InstanceData = BuildInstanceData();
    const Slot: Record<string, any> = {};
    for (const [Key, CatalogId] of LOADOUT_EQUIPMENT) {
        const InstanceId = instanceIdsByCatalogId[CatalogId];
        if (!InstanceId) throw new Error(`Missing inventory instance ID for starter loadout item ${CatalogId}`);
        Slot[Key] = { item_id: CatalogId, instance_id: InstanceId, instance_data: CatalogId === STARTER_WEAPON_CATALOG_ID ? InstanceData : null };
    }
    return {
        ...Slot,
        player_role: null,
        subweapon: null,
        appearance: "{\"CreationState\":\"EArchonCharacterCreationState::FaceComplete\",\"Data\":[{\"SkeletalMeshComponentName\":\"Head Slot\",\"MorphData\":[]}],\"AssetReferences\":[],\"StringData\":[{\"Key\":\"BodyType\",\"Data\":\"Feminine\"},{\"Key\":\"Hair\",\"Data\":\"Hair12\"},{\"Key\":\"SkinName\",\"Data\":\"Tan\"},{\"Key\":\"SkinValue\",\"Data\":\"(R=0.610496,G=0.417885,B=0.254152,A=1.000000)\"},{\"Key\":\"Hair_Color\",\"Data\":\"(R=0.196843,G=0.042531,B=0.019093,A=1.000000)\"},{\"Key\":\"Beard\",\"Data\":\"NoBeard\"},{\"Key\":\"Facepaint\",\"Data\":\"NoFacepaint\"},{\"Key\":\"Makeup\",\"Data\":\"NoMakeup\"}]}",
        flask: "FL_HEALING_DEFAULT", quick_items: [], slot_index: 0, update_version: 0, custom_name: "", persistent,
    };
}



export function BuildStarterManifest(): StarterManifest {
    const InstanceIdsByCatalogId: Record<string, string> = {};
    for (const CatalogId of STARTER_INSTANCED_CATALOG_IDS) InstanceIdsByCatalogId[CatalogId] = GenerateStarterInstanceId();
    const Persistent = BuildStarterPersistent();
    const InstancedItems: StarterInstancedItem[] = STARTER_INSTANCED_CATALOG_IDS.map((CatalogId) => ({
        catalogId: CatalogId, instanceId: InstanceIdsByCatalogId[CatalogId], itemData: null, updateVersion: 0
    }));
    return {
        instanceIdsByCatalogId: InstanceIdsByCatalogId,
        instancedItems: InstancedItems,
        stackedItems: STARTER_STACKED_CATALOG_IDS.map((catalogId) => ({ catalogId, quantity: 1 })),
        loadoutSlot: BuildStarterLoadoutSlot(InstanceIdsByCatalogId, Persistent),
        persistent: Persistent,
    };
}

function ParseArray(raw: string): any[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function FreshInstanceId(usedInstanceIds: Set<string>): string {
    let instanceId: string;
    do instanceId = GenerateStarterInstanceId(); while (usedInstanceIds.has(instanceId));
    usedInstanceIds.add(instanceId);
    return instanceId;
}





function ReconcileMissingDefaultWeaponParts(existingItems: any[]): {
    instancedItems: any[];
    addedCatalogIds: string[];
} {
    const InstancedItems = existingItems.map((Item) =>
        Item && typeof Item === "object" ? { ...Item } : Item
    );
    const OwnedCatalogIds = new Set<string>();
    const UsedInstanceIds = new Set<string>();

    for (const Item of InstancedItems) {
        if (!Item || typeof Item !== "object") continue;
        if (typeof Item.catalogId === "string" && Item.catalogId.length > 0) {
            OwnedCatalogIds.add(Item.catalogId);
        }
        if (typeof Item.instanceId === "string" && Item.instanceId.length > 0) {
            UsedInstanceIds.add(Item.instanceId);
        }
    }

    const AddedCatalogIds: string[] = [];
    for (const CatalogId of STARTER_DEFAULT_WEAPON_PART_CATALOG_IDS) {
        if (OwnedCatalogIds.has(CatalogId)) continue;
        InstancedItems.push({
            catalogId: CatalogId,
            instanceId: FreshInstanceId(UsedInstanceIds),
            itemData: null,
            updateVersion: 0,
        });
        OwnedCatalogIds.add(CatalogId);
        AddedCatalogIds.push(CatalogId);
    }

    return { instancedItems: InstancedItems, addedCatalogIds: AddedCatalogIds };
}



function RepairStarterInstancedItems(existingItems: any[], sourceLoadout?: any): { instancedItems: any[]; instanceIdsByCatalogId: Record<string, string>; changed: boolean } {
    const instancedItems = existingItems.map((item) => item && typeof item === "object" ? { ...item } : item).filter((item) => item && typeof item === "object");
    const usedInstanceIds = new Set<string>();
    const instanceIdsByCatalogId: Record<string, string> = {};
    let changed = instancedItems.length !== existingItems.length;

    for (const item of instancedItems) {
        if (typeof item.instanceId === "string" && item.instanceId.length > 0 && !usedInstanceIds.has(item.instanceId)) {
            usedInstanceIds.add(item.instanceId);
            if (typeof item.catalogId === "string" && !instanceIdsByCatalogId[item.catalogId]) instanceIdsByCatalogId[item.catalogId] = item.instanceId;
        }
    }

    
    
    const loadoutIds: Record<string, string> = {};
    for (const [Key, CatalogId] of LOADOUT_EQUIPMENT) {
        const equipment = sourceLoadout?.[Key];
        if (equipment?.item_id === CatalogId && typeof equipment.instance_id === "string" && /^[A-Z0-9]{26}$/.test(equipment.instance_id)) {
            loadoutIds[CatalogId] = equipment.instance_id;
        }
    }

    for (const CatalogId of STARTER_INSTANCED_CATALOG_IDS) {
        if (instanceIdsByCatalogId[CatalogId]) continue;
        const Existing = instancedItems.find((item) => item.catalogId === CatalogId);
        const Candidate = loadoutIds[CatalogId];
        const InstanceId = Candidate && !usedInstanceIds.has(Candidate) ? (usedInstanceIds.add(Candidate), Candidate) : FreshInstanceId(usedInstanceIds);
        if (Existing) {
            Existing.instanceId = InstanceId;
            Existing.itemData = Existing.itemData ?? null;
            Existing.updateVersion = typeof Existing.updateVersion === "number" ? Existing.updateVersion : 0;
        } else {
            instancedItems.push({ catalogId: CatalogId, instanceId: InstanceId, itemData: null, updateVersion: 0 });
        }
        instanceIdsByCatalogId[CatalogId] = InstanceId;
        changed = true;
    }
    return { instancedItems, instanceIdsByCatalogId, changed };
}






export class CharacterOwnershipError extends Error {
    constructor(public readonly characterId: string, public readonly userId: string) {
        super(`Character ${characterId} does not belong to user ${userId}`);
        this.name = "CharacterOwnershipError";
    }
}




export async function EnsureStarterBootstrapRecordsInTransaction(repos: RepositoryProvider, userId: string, characterId: string, session: ClientSession) {
    
    
    
    
    const OwnedCharacter = await repos.characters.findByCharacterIdAndUserId(characterId, userId, session);
    if (OwnedCharacter == undefined) {
        throw new CharacterOwnershipError(characterId, userId);
    }

    let inventory = await repos.inventories.findByCharacterId(characterId, session);
    let loadout = await repos.loadouts.findByCharacterIdAndUserId(characterId, userId, session);
    if (inventory && loadout) {
        const Reconciled = ReconcileMissingDefaultWeaponParts(ParseArray(inventory.instancedItems));
        if (Reconciled.addedCatalogIds.length > 0) {
            const Updated = await repos.inventories.updateBothIfRevisionMatches(
                characterId,
                JSON.stringify(Reconciled.instancedItems),
                inventory.stackedItems,
                inventory.revision ?? 0,
                session
            );
            if (!Updated) throw new Error("Default weapon-part reconciliation conflict for inventory " + characterId);
            inventory = Updated;
            logger.info(
                "[inventory] reconciled missing default weapon parts [" +
                Reconciled.addedCatalogIds.join(", ") + "] for characterId " +
                characterId + " (userId " + userId + ")"
            );
        }
        return { inventory, loadout };
    }

    if (!inventory && !loadout) {
        const manifest = BuildStarterManifest();
        inventory = { characterId, userId, instancedItems: JSON.stringify(manifest.instancedItems), stackedItems: JSON.stringify(manifest.stackedItems), revision: 0, bootstrapVersion: BOOTSTRAP_VERSION };
        loadout = { characterId, userId, loadouts: JSON.stringify([manifest.loadoutSlot]), persistent: JSON.stringify(manifest.persistent), revision: 0, bootstrapVersion: BOOTSTRAP_VERSION };
        await repos.inventories.create(inventory, session);
        await repos.loadouts.create(loadout, session);
        return { inventory, loadout };
    }

    if (!inventory) {
        const repaired = RepairStarterInstancedItems([], ParseArray(loadout!.loadouts)[0]);
        inventory = {
            characterId, userId, instancedItems: JSON.stringify(repaired.instancedItems),
            stackedItems: JSON.stringify(STARTER_STACKED_CATALOG_IDS.map((catalogId) => ({ catalogId, quantity: 1 }))),
            revision: 0, bootstrapVersion: BOOTSTRAP_VERSION
        };
        await repos.inventories.create(inventory, session);
        return { inventory, loadout: loadout! };
    }

    const repaired = RepairStarterInstancedItems(ParseArray(inventory.instancedItems));
    if (repaired.changed) {
        const updated = await repos.inventories.updateBothIfRevisionMatches(characterId, JSON.stringify(repaired.instancedItems), inventory.stackedItems, inventory.revision ?? 0, session);
        if (!updated) throw new Error(`Starter recovery conflict for inventory ${characterId}`);
        inventory = updated;
    }
    const persistent = BuildStarterPersistent();
    loadout = { characterId, userId, loadouts: JSON.stringify([BuildStarterLoadoutSlot(repaired.instanceIdsByCatalogId, persistent)]), persistent: JSON.stringify(persistent), revision: 0, bootstrapVersion: BOOTSTRAP_VERSION };
    await repos.loadouts.create(loadout, session);
    return { inventory, loadout };
}

export async function EnsureStarterBootstrapRecords(userId: string, characterId: string) {
    return GetUnitOfWork().withTransaction((repos, session) => EnsureStarterBootstrapRecordsInTransaction(repos, userId, characterId, session));
}






export async function SeedNewAccountAtomically(userId: string, characterId: string, session: ClientSession): Promise<StarterManifest> {
    const Manifest = BuildStarterManifest();

    await GetRepositories().inventories.create(
        {
            characterId,
            userId,
            instancedItems: JSON.stringify(Manifest.instancedItems),
            stackedItems: JSON.stringify(Manifest.stackedItems),
            revision: 0,
            bootstrapVersion: BOOTSTRAP_VERSION
        },
        session
    );

    await GetRepositories().loadouts.create(
        {
            characterId,
            userId,
            loadouts: JSON.stringify([Manifest.loadoutSlot]),
            persistent: JSON.stringify(Manifest.persistent),
            revision: 0,
            bootstrapVersion: BOOTSTRAP_VERSION
        },
        session
    );

    
    
    await GetRepositories().wallets.createIfMissing(
        { userId, balances: { ...STARTER_WALLET }, bootstrapVersion: BOOTSTRAP_VERSION },
        session
    );

    return Manifest;
}
