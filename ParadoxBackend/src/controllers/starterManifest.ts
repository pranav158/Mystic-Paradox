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

// [hardening 2026-07-14] The authoritative new-player bootstrap manifest. Replaces the previous
// design (shared MYSTICPARADOX_STARTER_* instance IDs reused across every account, defined in
// inventory.ts's STARTER_INSTANCE_IDS/StarterInstancedItems) - those were fine for a single dev
// account but are wrong for real multiplayer accounts, which must never share instance IDs.
//
// Every catalog ID below is proven by the captured 1.12 dev_inventory.json, the captured
// loadoutEquip contract, or Items_Analysis/weapon_slots_1_12.jsonl's live FWeaponPartSlot defaults.
// src/controllers/loadout.ts's DEFAULT_PERSISTENT/DEFAULT_INSTANCE_DATA came from the same capture.
// Nothing here is invented. Notably WP_EB_FROSTFALL_L1 (the OLDER Items_Analysis/
// recommended_baseline_items.csv capture) is NOT used - that capture is a returning-player
// baseline, not the clean Recruit starter set new accounts should get.

// 26 uppercase alphanumeric characters, matching every captured/observed instance ID's shape
// (e.g. "RHLDQHG6UNBG3KROD7MWHKZSKU"). Generated per-player, per-item - never shared, never
// reused, so two accounts (or the same account created twice) never collide on an instance ID.
const INSTANCE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const INSTANCE_ID_LENGTH = 26;

export function GenerateStarterInstanceId(): string {
    // randomInt draws each character uniformly (a byte modulo 36 favours the first 4 letters).
    let Id = "";
    for (let i = 0; i < INSTANCE_ID_LENGTH; i++) {
        Id += INSTANCE_ID_ALPHABET[crypto.randomInt(INSTANCE_ID_ALPHABET.length)];
    }
    return Id;
}

// Each owned starter weapon must also own every non-empty default part referenced by its
// FWeaponPartSlot data. The client does not render a modification row until the currently
// equipped/default part resolves to a live inventory object.
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

// The 23 instanced-item catalog IDs every new account owns. WP_EB_BEGINNER (Recruit's Sword)
// is the equipped weapon; the other six Recruit weapons are owned-but-unequipped choices.
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
export const STARTER_BANNER_CATALOG_ID = "BN_BEGINNER_00";

// The 14 stacked ownership entries every new account owns, quantity 1 each - the flare, the 6
// captured emotes (intro + end-of-hunt + 4 player emotes), and the 7 banner-customization/dye
// pieces. Currency (CURRENCY_*) starter grants live in the WALLET (STARTER_WALLET in wallet.ts)
// and are projected into inventory responses by MergeWalletIntoStacked - they are deliberately
// NOT duplicated here, matching the user's explicit instruction.
export const STARTER_STACKED_CATALOG_IDS = [
    // [1.14.7 ROOT-CAUSE FIX 2026-10-05] The daily-bounty draft token.
    //
    // Measured: the hub's REMOTE player never completes bounty_daily_bpc - it is the only loader left at
    // loaded=0 loading=1 while all ten others reach loaded=1 - and the game says exactly why:
    //   [LogArchonBounty][Error][bounty_daily_bpc] UBountyComponent::OnSelectDraftChoiceComplete()
    //       - failed to find enough bounty tokens inventory item.
    // The daily payload sets automatic_draft: true (matching the captured contract) with
    // num_tokens_hp_start: 1, so the component auto-drafts a bounty and needs TOKEN_DAILY_CHALLENGE_DRAFT
    // in the player's inventory. Nothing seeded it, so the draft failed, FinishSetup never ran, the loader
    // never reached Done, and the 60s PlayerData timeout disconnected the player.
    // quantity 1 matches num_tokens_hp_start: 1 in the daily payload.
    // This is an inventory grant the captured contract requires - NOT a payload change made to force a
    // pointer non-null.
    "TOKEN_DAILY_CHALLENGE_DRAFT",
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

// Same shape as loadout.ts's DEFAULT_INSTANCE_DATA (the proven captured per-item cosmetic/cell
// state) - duplicated here rather than imported to avoid a circular import between
// starterManifest.ts and loadout.ts; both must stay in sync if the captured contract changes.
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

// v4 adds TOKEN_DAILY_CHALLENGE_DRAFT to the stacked items. The bump is what makes existing accounts pick
// it up: EnsureStarterBootstrapRecords re-runs on inventory GET and compares this version, so a player
// seeded under v3 is repaired rather than left without the token.
export const BOOTSTRAP_VERSION = "starter-1.12-v4";

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

function BuildStarterPersistent(instanceIdsByCatalogId: Record<string, string>): any {
    // `persistent.banner` is an inventory-instance reference, unlike the stacked personality
    // fields (flare/emotes) whose catalog IDs double as their stable ownership references.
    // AArchonLoadout stores this as FItemInstanceIdRepl and AArchonBanner resolves it through
    // AArchonInventory::GetItemFromInstanceId. Supplying BN_BEGINNER_00 here therefore leaves
    // CachedBanner null even though the player owns the item, so animation/audio play without
    // any mesh, fabric, or sigil.
    const BannerInstanceId = instanceIdsByCatalogId[STARTER_BANNER_CATALOG_ID];
    if (!BannerInstanceId) {
        throw new Error(`Missing inventory instance ID for starter banner ${STARTER_BANNER_CATALOG_ID}`);
    }

    return {
        manual_emotes: ["", "", "", "", "", ""],
        intro_emote: "EM_INTRO_BEGINNER_01",
        banner: BannerInstanceId,
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

// Builds a slot from the actual inventory IDs supplied by the caller. This is deliberately
// separate from BuildStarterManifest so recovery never needs a shared/global starter ID.
export function BuildStarterLoadoutSlot(
    instanceIdsByCatalogId: Record<string, string>,
    persistent = BuildStarterPersistent(instanceIdsByCatalogId)
): any {
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

// Builds one complete, internally-consistent manifest with fresh IDs. Inventory itemData stays
// null; weapon appearance and part metadata are stored exclusively in loadout instance_data.
export function BuildStarterManifest(): StarterManifest {
    const InstanceIdsByCatalogId: Record<string, string> = {};
    for (const CatalogId of STARTER_INSTANCED_CATALOG_IDS) InstanceIdsByCatalogId[CatalogId] = GenerateStarterInstanceId();
    const Persistent = BuildStarterPersistent(InstanceIdsByCatalogId);
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

// Existing accounts created from v1 own all seven starter weapons but only the Sword's default
// special. Preserve every existing entry verbatim and append only absent default parts. This is
// deliberately narrower than full starter repair: a normal inventory GET must never restore
// removed gear, rewrite item data, or alter the player's loadout.
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

// [1.14.7 ROOT-CAUSE FIX 2026-10-05] The stacked-item sibling of the weapon-part reconcile above.
//
// Measured failure: the daily-bounty draft token was never seeded, so the daily component's auto-draft
// could not find one -
//   [LogArchonBounty][Error][bounty_daily_bpc] UBountyComponent::OnSelectDraftChoiceComplete()
//       - failed to find enough bounty tokens inventory item.
// - FinishSetup therefore never ran, bounty_daily_bpc stayed at loaded=0 loading=1 while all ten other
// loaders reached loaded=1, and the 60s PlayerData timeout disconnected the player.
//
// Adding the token to STARTER_STACKED_CATALOG_IDS fixes NEW accounts, but existing accounts are seeded
// only at creation time (SeedNewAccountAtomically), so an account already in the database is never
// repaired by that change alone - measured: the served inventory body still lacked
// TOKEN_DAILY_CHALLENGE_DRAFT after the manifest edit and a BOOTSTRAP_VERSION bump.
//
// Same discipline as the weapon-part reconcile: preserve every existing entry verbatim and append only
// absent starter entries. A normal inventory GET must never remove a player's items or rewrite quantities.
function ReconcileMissingStarterStackedItems(existingStacked: any[]): {
    stackedItems: any[];
    addedCatalogIds: string[];
} {
    const StackedItems = existingStacked.map((Item) =>
        Item && typeof Item === "object" ? { ...Item } : Item
    );
    const OwnedCatalogIds = new Set<string>();
    for (const Item of StackedItems) {
        if (!Item || typeof Item !== "object") continue;
        if (typeof Item.catalogId === "string" && Item.catalogId.length > 0) {
            OwnedCatalogIds.add(Item.catalogId);
        }
    }

    const AddedCatalogIds: string[] = [];
    for (const CatalogId of STARTER_STACKED_CATALOG_IDS) {
        if (OwnedCatalogIds.has(CatalogId)) continue;
        StackedItems.push({ catalogId: CatalogId, quantity: 1 });
        OwnedCatalogIds.add(CatalogId);
        AddedCatalogIds.push(CatalogId);
    }

    return { stackedItems: StackedItems, addedCatalogIds: AddedCatalogIds };
}

// Retains every valid existing item verbatim. Only records needed to reconstitute a missing
// inventory/loadout are repaired, and every created/repaired instance receives a fresh unique ID.
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

    // A surviving loadout is only an ID source when its equipment item has the observed
    // 26-character ID format. Shared MYSTICPARADOX_STARTER_* placeholders are never propagated.
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

// Thrown when a recovery/GET path is asked to bootstrap records for a (characterId, userId) pair
// that does not correspond to a real character owned by that user. Recovery can CREATE inventory
// and loadout documents, so without this guard a bearer-authenticated player could materialize
// orphan records for arbitrary character UUIDs (or another user's character whose loadout row is
// missing). Callers/routes should surface this as a 4xx, never a silent create.
export class CharacterOwnershipError extends Error {
    constructor(public readonly characterId: string, public readonly userId: string) {
        super(`Character ${characterId} does not belong to user ${userId}`);
        this.name = "CharacterOwnershipError";
    }
}

// Transactional bootstrap repair creates an absent inventory/loadout document. For complete v1
// accounts it performs one narrowly-scoped, idempotent migration: append missing default weapon
// parts so every starter weapon's currently equipped/default part resolves in the client UI.
export async function EnsureStarterBootstrapRecordsInTransaction(repos: RepositoryProvider, userId: string, characterId: string, session: ClientSession) {
    // Ownership gate FIRST, before any read or write: recovery is capable of creating inventory
    // and loadout documents, so it must never run for a character the user does not own. Reads
    // the character row inside this same transaction/session so the check and any subsequent
    // writes are one atomic unit.
    const OwnedCharacter = await repos.characters.findByCharacterIdAndUserId(characterId, userId, session);
    if (OwnedCharacter == undefined) {
        throw new CharacterOwnershipError(characterId, userId);
    }

    let inventory = await repos.inventories.findByCharacterId(characterId, session);
    let loadout = await repos.loadouts.findByCharacterIdAndUserId(characterId, userId, session);
    if (inventory && loadout) {
        const Reconciled = ReconcileMissingDefaultWeaponParts(ParseArray(inventory.instancedItems));
        // [1.14.7 FIX 2026-10-05] Also reconcile STACKED items. This branch previously passed
        // inventory.stackedItems through untouched, so a stacked grant added to the manifest later
        // (such as the daily-bounty draft token) could never reach an existing account.
        const ReconciledStacked = ReconcileMissingStarterStackedItems(ParseArray(inventory.stackedItems));
        if (Reconciled.addedCatalogIds.length > 0 || ReconciledStacked.addedCatalogIds.length > 0) {
            const Updated = await repos.inventories.updateBothIfRevisionMatches(
                characterId,
                JSON.stringify(Reconciled.instancedItems),
                JSON.stringify(ReconciledStacked.stackedItems),
                inventory.revision ?? 0,
                session
            );
            if (!Updated) throw new Error("Default weapon-part reconciliation conflict for inventory " + characterId);
            inventory = Updated;
            if (Reconciled.addedCatalogIds.length > 0) {
                logger.info(
                    "[inventory] reconciled missing default weapon parts [" +
                    Reconciled.addedCatalogIds.join(", ") + "] for characterId " +
                    characterId + " (userId " + userId + ")"
                );
            }
            if (ReconciledStacked.addedCatalogIds.length > 0) {
                logger.info(
                    "[inventory] reconciled missing starter stacked items [" +
                    ReconciledStacked.addedCatalogIds.join(", ") + "] for characterId " +
                    characterId + " (userId " + userId + ")"
                );
            }
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
    const persistent = BuildStarterPersistent(repaired.instanceIdsByCatalogId);
    loadout = { characterId, userId, loadouts: JSON.stringify([BuildStarterLoadoutSlot(repaired.instanceIdsByCatalogId, persistent)]), persistent: JSON.stringify(persistent), revision: 0, bootstrapVersion: BOOTSTRAP_VERSION };
    await repos.loadouts.create(loadout, session);
    return { inventory, loadout };
}

export async function EnsureStarterBootstrapRecords(userId: string, characterId: string) {
    return GetUnitOfWork().withTransaction((repos, session) => EnsureStarterBootstrapRecordsInTransaction(repos, userId, characterId, session));
}

// Atomically seeds inventory, loadout, and wallet for a brand-new account, tagged with
// BOOTSTRAP_VERSION so future migrations can tell which accounts already have the current
// manifest shape. Must be called inside a Mongo transaction (session required, not optional) -
// this is account-creation-time seeding, not a lazy per-GET fallback, so partial application
// (e.g. inventory created but loadout creation fails) must never be possible.
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

    // A prior wallet/balance request may have created this row before character creation. The
    // atomic upsert preserves its balances exactly; only a truly absent wallet receives starter funds.
    await GetRepositories().wallets.createIfMissing(
        { userId, balances: { ...STARTER_WALLET }, bootstrapVersion: BOOTSTRAP_VERSION },
        session
    );

    return Manifest;
}
