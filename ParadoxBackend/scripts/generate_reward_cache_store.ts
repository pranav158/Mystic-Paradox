/*
 * Generates the reconstructed Reward Cache rotation (first built for 1.12 Season 19; 1.14.7 since 2026-10-08).
 *
 * Source of truth:
 *   - Items_Analysis/catalog_1_14_7.jsonl (MYSTICPARADOX_CATALOG_PATH overrides) for item existence, display text,
 *     rarity and storage shape.
 *   - Progress/30_REWARD_CACHE_STORE.md for the runtime-captured category tags.
 *
 * The original Phoenix Labs rotation and prices were remote service data and are not claimed here.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ScriptDir = path.dirname(fileURLToPath(import.meta.url));
const MetagameRoot = path.resolve(ScriptDir, "..");
const ProjectRoot = path.resolve(MetagameRoot, "..");
const CatalogOverride = process.env.MYSTICPARADOX_CATALOG_PATH ?? process.env.MYSTICPARADOX_CATALOG_1_12_PATH;
const CatalogPath = CatalogOverride
    ? path.resolve(CatalogOverride)
    : path.join(ProjectRoot, "Items_Analysis", "catalog_1_14_7.jsonl");
const OutputPath = path.join(MetagameRoot, "game-data", "reward_cache_store.json");

// [1.14.7 2026-10-08] The Reward Cache is priced in the 1.14.7 seasonal coin (CURRENCY_SEASONAL_COIN, the blue-star
// "Cache Coins" of the HUD; icon ui_icon_huntpass_elite_complete_currency). The live 1.14.7 hunt passes
// (season21..27 in DauntlessEndpointDocumentation/Progression/Config.json) pay it as prestige, 5 free / 20 premium.
// The 1.12 build used the Season 19 coin ("Elemental Coins"). CURRENCY_REWARDCACHE ("Cache Coin") is an older
// event coin with the ancient-coin icon - not this one. SKU ids keep their season19_rewardcache_ prefix:
// purchase history is keyed on them.
const CURRENCY_ID = "id_currency_seasonal_coin";
const PRICE_TIERS = new Set([700, 800, 1000, 2000, 2500, 3000]);

const CATEGORY_TAGS = {
    armour: "tab_season_armour",
    weapon: "tab_season_weapon",
    style: "tab_season_style",
    event: "season_store_event",
    limited: "tab_season_limited",
    general: "season_store_general",
} as const;

type Category = keyof typeof CATEGORY_TAGS;

type CatalogRow = {
    itemId: string;
    displayName?: string;
    description?: string;
    tags?: string[];
    customData?: string;
    isStackable?: boolean;
    maxQuantity?: number;
};

type Selection = {
    catalogId: string;
    category: Category;
    price: number;
    featured?: boolean;
    // Explicitly permits a small number of named rarity-3 premium cosmetics. This is never inferred
    // from the item prefix, preventing starter or unresolved low-rarity rows from entering the store.
    allowRarity3?: boolean;
    // Overrides are allowed only when the cooked 1.12 catalog row exists but its localized string table
    // is unavailable. The catalog ID, class, rarity and artwork remain client-authored and validated.
    displayNameOverride?: string;
    descriptionOverride?: string;
};

type ParsedItemData = {
    rarity: number;
    icon: string;
    largeIcon: string;
    customIcon: string;
};

// Curated from the verified 1.12 catalog. The set deliberately favors Hunt Pass ultra armour,
// premium weapon transmogs, high-rarity dyes/emotes and distinctive event cosmetics. Founder,
// translator, mastery, Trials-store, WIP and unresolved entries are intentionally excluded.
const SELECTIONS: Selection[] = [
    // Four marquee offers also populate the FEATURED tab.
    { catalogId: "AR_HP08A_HEROES_HELM_00_ULTRA", category: "armour", price: 3000, featured: true },
    { catalogId: "WP_EB_HP08A_HEROES_01", category: "weapon", price: 3000, featured: true },
    { catalogId: "EM_INTRO_HP10A_CELESTIAL_00", category: "style", price: 3000, featured: true },
    { catalogId: "AC_HEAD_UNSEEN_00", category: "limited", price: 3000, featured: true },

    // Armour (26 total including the featured helm).
    { catalogId: "AR_HP08A_HEROES_CHEST_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP08A_HEROES_LEGS_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP07B_WITCH_HELM_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP07A_MONK_HELM_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP11A_ALCHEMIST_HELM_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP10A_CELESTIAL_HELM_02", category: "armour", price: 2500 },
    { catalogId: "AR_HP09A_ASSASSINS_CHEST_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP08B_PUNK_CHEST_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_ARMSTRONG_HELM_ULTRA", category: "armour", price: 2000 },
    { catalogId: "AR_HP10A_CELESTIAL_ARMS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP10B_RAIDERS_ARMS_01", category: "armour", price: 2500 },
    { catalogId: "AR_HP11A_ALCHEMIST_ARMS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP07A_MONK_ARMS_ULTRA", category: "armour", price: 2500 },

    // Complete premium armour-set pieces.
    { catalogId: "AR_HP11A_ALCHEMIST_CHEST_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP11A_ALCHEMIST_LEGS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP10A_CELESTIAL_HELM_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP10A_CELESTIAL_CHEST_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP10A_CELESTIAL_LEGS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP07B_WITCH_ARMS_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP07B_WITCH_CHEST_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP07B_WITCH_LEGS_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP12A_FROSTWARDEN_HELM_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP12A_FROSTWARDEN_ARMS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP12A_FROSTWARDEN_CHEST_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP12A_FROSTWARDEN_LEGS_00_ULTRA", category: "armour", price: 2500 },

    // Additional premium complete-set pieces.
    { catalogId: "AR_HP08A_HEROES_ARMS_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP09A_ASSASSINS_HELM_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP09A_ASSASSINS_ARMS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP09A_ASSASSINS_LEGS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP08B_PUNK_HELM_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP08B_PUNK_ARMS_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP08B_PUNK_LEGS_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP10B_RAIDERS_HELM_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP10B_RAIDERS_ARMS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP10B_RAIDERS_CHEST_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP10B_RAIDERS_LEGS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP09B_COMMANDO_HELM_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP09B_COMMANDO_ARMS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP09B_COMMANDO_CHEST_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_HP09B_COMMANDO_LEGS_00_ULTRA", category: "armour", price: 2500 },
    { catalogId: "AR_ARMSTRONG_ARMS_ULTRA", category: "armour", price: 2000 },
    { catalogId: "AR_ARMSTRONG_CHEST_ULTRA", category: "armour", price: 2000 },
    { catalogId: "AR_ARMSTRONG_LEGS_ULTRA", category: "armour", price: 2000 },

    // Rogue Elements standard tactical set. Patch 1.12.0 explicitly advertised two complete tactical
    // armour sets; the ultra SM-* set was already present, so include its complete standard counterpart.
    { catalogId: "AR_HP09B_COMMANDO_HELM_00", category: "armour", price: 2000 },
    { catalogId: "AR_HP09B_COMMANDO_CHEST_00", category: "armour", price: 2000 },
    { catalogId: "AR_HP09B_COMMANDO_ARMS_00", category: "armour", price: 2000 },
    { catalogId: "AR_HP09B_COMMANDO_LEGS_00", category: "armour", price: 2000 },

    // Weapons (35 total including Salvator Rex).
    { catalogId: "WP_IH_HP10B_RAIDERS_01", category: "weapon", price: 2500 },
    { catalogId: "WP_EB_HP12A_FROSTWARDEN_01", category: "weapon", price: 2500 },
    { catalogId: "WP_AC_HP10A_CELESTIAL_01", category: "weapon", price: 2500 },
    { catalogId: "WP_DP_HP10A_CELESTIAL_01", category: "weapon", price: 2500 },
    { catalogId: "WP_MS_HP11A_ALCHEMIST_01", category: "weapon", price: 2500 },
    { catalogId: "WP_EB_HP10A_CELESTIAL_00", category: "weapon", price: 2000 },
    { catalogId: "WP_IH_HP08B_PUNK_00", category: "weapon", price: 2000 },
    { catalogId: "WP_AC_HP10A_CELESTIAL_00", category: "weapon", price: 2000 },
    { catalogId: "WP_AC_HP11A_ALCHEMIST_00", category: "weapon", price: 2000 },
    { catalogId: "WP_AC_HP07A_MONK_00", category: "weapon", price: 2000 },
    { catalogId: "WP_AC_HP08B_PUNK_00", category: "weapon", price: 2000 },

    // Axe transmogs (the 1.12 catalog uses WP_GA_* / WeaponType_GAXE).
    { catalogId: "WP_GA_HP11A_ALCHEMIST_00", category: "weapon", price: 2000 },
    { catalogId: "WP_GA_ARCSLAYER_00", category: "weapon", price: 2000 },
    { catalogId: "WP_GA_HP12A_FROSTWARDEN_00", category: "weapon", price: 2000 },
    { catalogId: "WP_GA_HP08A_HEROES_00", category: "weapon", price: 2000 },
    { catalogId: "WP_GA_HP09A_ASSASSINS_00", category: "weapon", price: 2000 },
    { catalogId: "WP_GA_HP10A_CELESTIAL_00", category: "weapon", price: 2000 },
    { catalogId: "WP_GA_HEADSMAN", category: "weapon", price: 2000 },
    { catalogId: "WP_GA_HP07B_WITCH_00", category: "weapon", price: 2000 },

    // Remaining resolved premium axe transmogs. The four rarity-3 Hunt Pass axes are explicit
    // exceptions; unresolved later-season and functional legendary axe rows remain excluded.
    { catalogId: "WP_GA_HP10B_RAIDERS_00", category: "weapon", price: 2500 },
    { catalogId: "WP_GA_HP06_PIRATE_00", category: "weapon", price: 2500 },
    { catalogId: "WP_GA_HP07A_MONK_00", category: "weapon", price: 2500 },
    { catalogId: "WP_GA_HP08B_PUNK_00", category: "weapon", price: 2500 },
    { catalogId: "WP_GA_HP09B_COMMANDO_00", category: "weapon", price: 2500 },
    { catalogId: "WP_GA_ROMANTIC", category: "weapon", price: 2500 },
    { catalogId: "WP_GA_HP06B_ACADEMY_00", category: "weapon", price: 2500 },
    { catalogId: "WP_GA_HP04_ARID", category: "weapon", price: 2000, allowRarity3: true },
    { catalogId: "WP_GA_HP03_MOSSY", category: "weapon", price: 2000, allowRarity3: true },
    { catalogId: "WP_GA_HP05_NINJA_00", category: "weapon", price: 2000, allowRarity3: true },
    { catalogId: "WP_GA_HP05_NINJA_02", category: "weapon", price: 2000, allowRarity3: true },

    // Legendary premium axes. Their 1.12 catalog classes, rarity and artwork are present, but the
    // localized name table is missing from this client dump, so use verified external names explicitly.
    { catalogId: "WP_GA_ELVEN_00", category: "weapon", price: 3000, featured: true,
      displayNameOverride: "Lightsworn Benediction",
      descriptionOverride: "A radiant Lightsworn axe transmog forged for a Slayer of Andar." },
    { catalogId: "WP_GA_HP16A_MARAUDERS_01", category: "weapon", price: 3000, featured: true,
      displayNameOverride: "Hellion's Foil",
      descriptionOverride: "A legendary blaze axe transmog inspired by Hellion." },
    { catalogId: "WP_GA_METAL_00", category: "weapon", price: 3000, featured: true,
      displayNameOverride: "The Debt Collector",
      descriptionOverride: "A heavy legendary metal axe transmog built to collect what is owed." },

    // Style (23 total including Portal Beam).
    { catalogId: "DYE_RED01_DURABLE", category: "style", price: 1000 },
    { catalogId: "DYE_GRAY05_DURABLE", category: "style", price: 1000 },
    { catalogId: "DYE_GREEN14_DURABLE", category: "style", price: 1000 },
    { catalogId: "DYE_BLUE13_DURABLE", category: "style", price: 1000 },
    { catalogId: "EM_PLAYER_HP07A_FIREBALL_00", category: "style", price: 2000 },
    { catalogId: "EM_PLAYER_HP10A_CELESTIAL_04", category: "style", price: 2000 },
    { catalogId: "EM_INTRO_HP08A_HEROIC_00", category: "style", price: 2500 },

    // Premium player and arrival emotes.
    { catalogId: "EM_INTRO_HP12A_FROSTWARDEN_00", category: "style", price: 2500 },
    { catalogId: "EM_INTRO_HP09A_ASSASSINS_00", category: "style", price: 2500 },
    { catalogId: "EM_INTRO_HP03_VINE_00", category: "style", price: 2500 },
    { catalogId: "EM_INTRO_HP08B_SKATEBOARD_00", category: "style", price: 2500 },
    { catalogId: "EM_PLAYER_HP11A_ALCHEMIST_00", category: "style", price: 2500 },
    { catalogId: "EM_INTRO_HP10B_RAIDERS_01", category: "style", price: 2500 },
    { catalogId: "EM_INTRO_HP07B_COFFINDROP_BAT_00", category: "style", price: 2500 },
    { catalogId: "EM_INTRO_HP07B_COFFINDROP_DANCE_00", category: "style", price: 2500 },
    { catalogId: "EM_INTRO_HP09B_COMMANDO_00", category: "style", price: 2500 },
    { catalogId: "EM_INTRO_HP10B_RAIDERS_00", category: "style", price: 2500 },
    { catalogId: "EM_INTRO_HP08A_WARCRY_00", category: "style", price: 2500 },

    // Flares.
    { catalogId: "QI_FLARE_FUNGUY", category: "style", price: 1000 },
    { catalogId: "QI_FLARE_HP11A_ALCHEMIST_00", category: "style", price: 1000 },
    { catalogId: "QI_FLARE_HP08B_03", category: "style", price: 1000 },
    { catalogId: "QI_FLARE_SAINTS19_06", category: "style", price: 1000 },

    // Event (9).
    { catalogId: "WP_DP_EVENT_SPRING_00", category: "event", price: 2500 },
    { catalogId: "EM_PLAYER_EVENT_FROST17_002", category: "event", price: 2000 },
    { catalogId: "BNC_ANIMATION_EVENT_FROST17_00", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_EVENT_FROST17_00", category: "event", price: 800 },

    // Banner standards / flagstaff skins.
    { catalogId: "BNC_STANDARD_HP10A_CELESTIAL_00", category: "event", price: 1000 },
    { catalogId: "BNC_STANDARD_HP09A_ASSASSINS_00", category: "event", price: 1000 },
    { catalogId: "BNC_STANDARD_HP10B_RAIDERS_00", category: "event", price: 1000 },
    { catalogId: "BNC_STANDARD_HP07A_MONK_01", category: "event", price: 1000 },
    { catalogId: "BNC_STANDARD_HP08B_PUNK_00", category: "event", price: 1000 },

    // Premium banner-plant animations.
    { catalogId: "BNC_ANIMATION_HP05_FLAMES_00", category: "event", price: 2000 },
    { catalogId: "BNC_ANIMATION_HP05_PETALS_00", category: "event", price: 2000 },
    { catalogId: "BNC_ANIMATION_HP05_NINJASTARS_00", category: "event", price: 2000 },
    { catalogId: "BNC_ANIMATION_HP09A_ASSASSINS_00", category: "event", price: 2000 },
    { catalogId: "BNC_ANIMATION_HP11A_ALCHEMIST_00", category: "event", price: 2000 },
    { catalogId: "BNC_ANIMATION_HP12A_FROSTWARDEN_00", category: "event", price: 2000 },
    { catalogId: "BNC_ANIMATION_AUTUMN_FOX_00", category: "event", price: 2000 },
    { catalogId: "BNC_ANIMATION_SAINTS_BOND_00", category: "event", price: 2000 },

    // Additional premium flagstaff skins.
    { catalogId: "BNC_MESH_EVENT_FROST17_00", category: "event", price: 2500 },
    { catalogId: "BNC_STANDARD_OSTIA_00", category: "event", price: 2500 },
    { catalogId: "BNC_STANDARD_OSTIA_01", category: "event", price: 2500 },
    { catalogId: "BNC_STANDARD_FUNGUY_00", category: "event", price: 2000 },

    // Additional premium banner standards.
    { catalogId: "BNC_STANDARD_HP09B_COMMANDO_00", category: "event", price: 2000 },
    { catalogId: "BNC_STANDARD_HP05_NINJA_00", category: "event", price: 2000 },
    { catalogId: "BNC_STANDARD_HP05_NINJA_01", category: "event", price: 2000 },
    { catalogId: "BNC_STANDARD_HP05_NINJA_02", category: "event", price: 2000 },
    { catalogId: "BNC_STANDARD_1P_ARCSLAYER", category: "event", price: 2000 },
    { catalogId: "BNC_STANDARD_1P_UNSEEN", category: "event", price: 2000 },
    { catalogId: "BNC_STANDARD_HP03_MOSSY_00", category: "event", price: 2000 },

    // Banner fabrics / shields: the cloth silhouette beneath the sigil.
    { catalogId: "BNC_FABRIC_EVENT_HP09A_ASSASSINS_01", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_HP09B_COMMANDO_00", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_HP10A_CELESTIAL_00", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_HP10B_RAIDERS_00", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_HP08B_00", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_HP08B_01", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_HP08B_02", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_HP11A_ALCHEMIST_00", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_HP12A_FROSTWARDEN_00", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_AUTUMN_FOX", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_FUNGUY", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_ARMSTRONG", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_DARK17_000", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_FROST18_01", category: "event", price: 1000 },
    { catalogId: "BNC_FABRIC_EVENT_FROST18_02", category: "event", price: 1000 },

    // Banner sigils / logos.
    { catalogId: "BNC_SIGIL_EVENT_HP09A_ASSASSINS_00", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_HP09B_COMMANDO_00", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_HP10B_RAIDERS_00", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_EVENT_HP08B_01", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_EVENT_HP08B_02", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_EVENT_HP08B_03", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_FUNGUY", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_EVENT_FROST17_01", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_EVENT_DARK17_000", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_RANDALL", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_EVENT_HP08A_00", category: "event", price: 1000 },
    { catalogId: "BNC_SIGIL_036", category: "event", price: 2000 },

    // Limited (10 total including the Unseen Crown).
    { catalogId: "AC_BACK_HP06-1_01", category: "limited", price: 2500 },
    { catalogId: "AC_BACK_HP06-1_00", category: "limited", price: 2500 },
    { catalogId: "GD_FRAME_A_REDSTRIPE", category: "limited", price: 2500 },

    // Named glider frames with resolved 1.12 display data.
    { catalogId: "GD_FRAME_A_BASE", category: "limited", price: 2500 },
    { catalogId: "GD_FRAME_B_BLUEWING", category: "limited", price: 2000 },
    { catalogId: "GD_FRAME_B_FLUTTERHEART", category: "limited", price: 2000 },
    { catalogId: "GD_FRAME_B_SPRINGTIDE", category: "limited", price: 2000 },
    { catalogId: "GD_FRAME_B_BASE", category: "limited", price: 2000 },
    { catalogId: "GD_FRAME_C_BASE", category: "limited", price: 2000 },

    // General (8).
    { catalogId: "TITLE_HP10A_CELESTIAL_01", category: "general", price: 700 },
    { catalogId: "BNC_STANDARD_HP08A_HEROES_00", category: "general", price: 800 },

    // Titles.
    { catalogId: "TITLE_HP08B_01", category: "general", price: 800 },
    { catalogId: "TITLE_HP09A_ASSASSINS_01", category: "general", price: 800 },
    { catalogId: "TITLE_HP07B_00", category: "general", price: 800 },
    { catalogId: "TITLE_HP08A_01", category: "general", price: 800 },
    { catalogId: "TITLE_HP09B_COMMANDO_01", category: "general", price: 800 },
    { catalogId: "TITLE_HP10B_RAIDERS_01", category: "general", price: 800 },
];

const EXPECTED_CATEGORY_COUNTS: Record<Category, number> = {
    armour: 48,
    weapon: 34,
    style: 23,
    event: 55,
    limited: 10,
    general: 8,
};

const FORBIDDEN_TAGS = new Set([
    "deprecated",
    "hidden",
    "initial",
    "masteryreward",
    "trialstore",
    "wip",
]);
const FORBIDDEN_ID_PATTERNS = [/FOUNDER/i, /TRANSLATOR/i, /TRIALS/i, /MASTERY/i];
const FORBIDDEN_QUEST_ONLY_CATALOG_IDS = new Set([
    // Shadow Scythe is granted by its six-part Rumour chain, not by Reward Cache/store purchase.
    "WP_GA_SPOOKY_01",
]);

function ParseItemData(Row: CatalogRow): ParsedItemData {
    try {
        const CustomData = JSON.parse(Row.customData ?? "{}") as { ItemData?: string };
        const ItemData = JSON.parse(CustomData.ItemData ?? "{}") as {
            RarityLevel?: number;
            Icon?: string;
            LargeIcon?: string;
            CustomIcon?: string;
        };
        return {
            rarity: Number(ItemData.RarityLevel ?? 0),
            icon: typeof ItemData.Icon === "string" ? ItemData.Icon : "",
            largeIcon: typeof ItemData.LargeIcon === "string" ? ItemData.LargeIcon : "",
            customIcon: typeof ItemData.CustomIcon === "string" ? ItemData.CustomIcon : "",
        };
    } catch {
        return { rarity: 0, icon: "", largeIcon: "", customIcon: "" };
    }
}

function TextureReference(AssetPath: string): string {
    Assert(/^\/Game\/[A-Za-z0-9_./-]+$/.test(AssetPath), `Invalid cooked texture path: ${AssetPath}`);
    return `Engine.Texture2D'${AssetPath}'`;
}

function Slug(Value: string): string {
    return Value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function Assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

Assert(fs.existsSync(CatalogPath), `Catalog dump not found: ${CatalogPath}`);
Assert(SELECTIONS.length === 178, `Expected 178 selections, found ${SELECTIONS.length}`);

const Catalog = new Map<string, CatalogRow>();
for (const Line of fs.readFileSync(CatalogPath, "utf8").split(/\r?\n/)) {
    if (!Line.trim()) continue;
    const Row = JSON.parse(Line) as CatalogRow;
    if (typeof Row.itemId === "string" && Row.itemId.length > 0) Catalog.set(Row.itemId, Row);
}

const OriginalSelectionOrder = new Map(SELECTIONS.map((Selection, Index) => [Selection.catalogId, Index]));
const CategoryOrder: Record<Category, number> = {
    armour: 0,
    weapon: 1,
    style: 2,
    event: 3,
    limited: 4,
    general: 5,
};
const ArmourFamilyOrder = [
    "AR_HP08A_HEROES",
    "AR_HP09A_ASSASSINS",
    "AR_HP08B_PUNK",
    "AR_HP10B_RAIDERS",
    "AR_HP09B_COMMANDO",
    "AR_HP11A_ALCHEMIST",
    "AR_HP10A_CELESTIAL",
    "AR_HP07B_WITCH",
    "AR_HP12A_FROSTWARDEN",
    "AR_ARMSTRONG",
    "AR_HP07A_MONK",
];
const BannerFamilyOrder = [
    "HP09A_ASSASSINS",
    "HP09B_COMMANDO",
    "HP10B_RAIDERS",
    "HP08B",
    "HP11A_ALCHEMIST",
    "HP12A_FROSTWARDEN",
    "HP10A_CELESTIAL",
    "HP08A",
    "HP05_NINJA",
    "FROST17",
    "FROST18",
    "DARK17",
    "AUTUMN_FOX",
    "FUNGUY",
    "ARMSTRONG",
    "ARCSLAYER",
    "UNSEEN",
    "MOSSY",
    "RANDALL",
];

function PrefixRank(Value: string, Prefixes: readonly string[]): number {
    const Index = Prefixes.findIndex((Prefix) => Value.includes(Prefix));
    return Index >= 0 ? Index : Prefixes.length;
}

function ArmourSlotRank(Row: CatalogRow | undefined): number {
    const Tags = new Set(Row?.tags ?? []);
    if (Tags.has("Helm")) return 0;
    if (Tags.has("Chest")) return 1;
    if (Tags.has("Arms")) return 2;
    if (Tags.has("Legs")) return 3;
    return 4;
}

function BannerComponentRank(CatalogId: string): number {
    if (CatalogId.startsWith("BNC_STANDARD_") || CatalogId.startsWith("BNC_MESH_")) return 0;
    if (CatalogId.startsWith("BNC_FABRIC_")) return 1;
    if (CatalogId.startsWith("BNC_SIGIL_")) return 2;
    if (CatalogId.startsWith("BNC_ANIMATION_")) return 3;
    return 4;
}

function CompareSelections(Left: Selection, Right: Selection): number {
    if (Boolean(Left.featured) !== Boolean(Right.featured)) return Left.featured ? -1 : 1;

    const CategoryDifference = CategoryOrder[Left.category] - CategoryOrder[Right.category];
    if (CategoryDifference !== 0) return CategoryDifference;

    if (Left.category === "armour") {
        const FamilyDifference = PrefixRank(Left.catalogId, ArmourFamilyOrder) - PrefixRank(Right.catalogId, ArmourFamilyOrder);
        if (FamilyDifference !== 0) return FamilyDifference;
        const VariantDifference = (Left.catalogId.endsWith("_ULTRA") ? 0 : 1) - (Right.catalogId.endsWith("_ULTRA") ? 0 : 1);
        if (VariantDifference !== 0) return VariantDifference;
        const SlotDifference = ArmourSlotRank(Catalog.get(Left.catalogId)) - ArmourSlotRank(Catalog.get(Right.catalogId));
        if (SlotDifference !== 0) return SlotDifference;
    }

    if (Left.category === "weapon") {
        const AxeDifference = (Left.catalogId.startsWith("WP_GA_") ? 0 : 1) - (Right.catalogId.startsWith("WP_GA_") ? 0 : 1);
        if (AxeDifference !== 0) return AxeDifference;
        if (Left.catalogId.startsWith("WP_GA_") && Right.catalogId.startsWith("WP_GA_")) {
            const RarityDifference = ParseItemData(Catalog.get(Right.catalogId) ?? {}).rarity - ParseItemData(Catalog.get(Left.catalogId) ?? {}).rarity;
            if (RarityDifference !== 0) return RarityDifference;
        }
    }

    if (Left.category === "event") {
        const LeftIsBanner = Left.catalogId.startsWith("BNC_");
        const RightIsBanner = Right.catalogId.startsWith("BNC_");
        if (LeftIsBanner !== RightIsBanner) return LeftIsBanner ? -1 : 1;
        if (LeftIsBanner && RightIsBanner) {
            const FamilyDifference = PrefixRank(Left.catalogId, BannerFamilyOrder) - PrefixRank(Right.catalogId, BannerFamilyOrder);
            if (FamilyDifference !== 0) return FamilyDifference;
            const ComponentDifference = BannerComponentRank(Left.catalogId) - BannerComponentRank(Right.catalogId);
            if (ComponentDifference !== 0) return ComponentDifference;
        }
    }

    return (OriginalSelectionOrder.get(Left.catalogId) ?? Number.MAX_SAFE_INTEGER)
        - (OriginalSelectionOrder.get(Right.catalogId) ?? Number.MAX_SAFE_INTEGER);
}

const OrderedSelections = [...SELECTIONS].sort(CompareSelections);

const SeenCatalogIds = new Set<string>();
const SeenSkuIds = new Set<string>();
const CategoryCounts = Object.fromEntries(Object.keys(CATEGORY_TAGS).map((Category) => [Category, 0])) as Record<Category, number>;
let FeaturedCount = 0;

const Store = OrderedSelections.map((Selection, Index) => {
    Assert(!SeenCatalogIds.has(Selection.catalogId), `Duplicate catalog selection: ${Selection.catalogId}`);
    SeenCatalogIds.add(Selection.catalogId);

    Assert(PRICE_TIERS.has(Selection.price), `Unsupported price ${Selection.price} for ${Selection.catalogId}`);
    for (const Pattern of FORBIDDEN_ID_PATTERNS) {
        Assert(!Pattern.test(Selection.catalogId), `Exclusive/progression catalog id is not eligible: ${Selection.catalogId}`);
    }
    Assert(
        !FORBIDDEN_QUEST_ONLY_CATALOG_IDS.has(Selection.catalogId),
        `Quest/Rumour-only catalog item is not eligible: ${Selection.catalogId}`
    );
    const Row = Catalog.get(Selection.catalogId);
    Assert(Row, `Catalog item not found: ${Selection.catalogId}`);

    const CatalogName = Row.displayName?.trim() ?? "";
    const Name = Selection.displayNameOverride?.trim() || CatalogName;
    Assert(Name.length > 0, `Missing display name: ${Selection.catalogId}`);
    Assert(
        Selection.displayNameOverride || !/^~DNT~|^<MISSING|^TBD$|^Empty slot$/i.test(Name),
        `Unresolved display name for ${Selection.catalogId}: ${Name}`
    );

    const Tags = (Row.tags ?? []).filter((Tag): Tag is string => typeof Tag === "string");
    const LowerTags = new Set(Tags.map((Tag) => Tag.toLowerCase()));
    for (const ForbiddenTag of FORBIDDEN_TAGS) {
        Assert(!LowerTags.has(ForbiddenTag), `Forbidden catalog tag '${ForbiddenTag}' on ${Selection.catalogId}`);
    }

    const ItemData = ParseItemData(Row);
    const Rarity = ItemData.rarity;
    const IsResolvedGlider = LowerTags.has("glider") && Rarity >= 3;
    const IsExplicitRarity3Premium = Selection.allowRarity3 === true && Rarity === 3;
    Assert(
        Rarity >= 4 || IsResolvedGlider || IsExplicitRarity3Premium,
        `Selected item must be rarity 4+, a resolved rarity-3 glider, or an explicit rarity-3 premium selection: ${Selection.catalogId} has rarity ${Rarity}`
    );

    // Official captured SKU payloads use images.standard for server-authored tile art. Reconstructed
    // SKU ids do not have baked StoreItemsTable rows, so provide a cooked catalog texture reference
    // directly. Prefer full custom/large art, then fall back to the ordinary inventory icon.
    const StandardImagePath = ItemData.customIcon || ItemData.largeIcon || ItemData.icon;
    Assert(StandardImagePath.length > 0, `Missing catalog image path: ${Selection.catalogId}`);

    CategoryCounts[Selection.category] += 1;
    if (Selection.featured) FeaturedCount += 1;

    const SkuId = `season19_rewardcache_${Selection.category}_${Slug(Selection.catalogId)}`;
    Assert(!SeenSkuIds.has(SkuId), `Duplicate generated SKU id: ${SkuId}`);
    SeenSkuIds.add(SkuId);

    const StoreTags = [
        "season_store",
        CATEGORY_TAGS[Selection.category],
        ...(Selection.featured ? ["season_store_feature"] : []),
        "season19",
        "reward_cache_reconstructed",
        `reward_cache_rarity_${Rarity}`,
    ];

    return {
        id: SkuId,
        displayName: Name,
        displayDescription: Selection.descriptionOverride?.trim() || Row.description?.trim() || `A premium Reward Cache cosmetic: ${Name}.`,
        displayPriority: Index + 1,
        prices: [{ currencyId: CURRENCY_ID, price: Selection.price }],
        maxAllowed: 1,
        images: { standard: TextureReference(StandardImagePath) },
        tags: StoreTags,
        items: [{ catalogId: Selection.catalogId, quantity: 1, instanced: Row.isStackable !== true }],
        duplicateInstancedItems: [Selection.catalogId],
    };
});

for (const [Category, ExpectedCount] of Object.entries(EXPECTED_CATEGORY_COUNTS) as [Category, number][]) {
    Assert(CategoryCounts[Category] === ExpectedCount, `${Category} count ${CategoryCounts[Category]} != expected ${ExpectedCount}`);
}
Assert(FeaturedCount === 7, `Featured count ${FeaturedCount} != expected 7`);

const Json = JSON.stringify(Store, null, 2) + "\n";
fs.writeFileSync(OutputPath, Json, "utf8");

const PriceCounts = new Map<number, number>();
for (const Entry of Store) {
    const Price = Entry.prices[0].price;
    PriceCounts.set(Price, (PriceCounts.get(Price) ?? 0) + 1);
}

console.log(`Wrote ${OutputPath}`);
console.log(`SKUs: ${Store.length}; featured: ${FeaturedCount}`);
console.log(`Categories: ${Object.entries(CategoryCounts).map(([Key, Value]) => `${Key}=${Value}`).join(", ")}`);
console.log(`Prices: ${[...PriceCounts.entries()].sort(([A], [B]) => A - B).map(([Price, Count]) => `${Price}=${Count}`).join(", ")}`);