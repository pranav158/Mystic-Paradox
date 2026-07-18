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

import crypto from "crypto";
import { GetRepositories, GetUnitOfWork } from "../persistence";
import { GetUsernameForUserId } from "./login";
import { logger } from "../logger";
import { SeedNewAccountAtomically } from "./starterManifest";

const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;

const DEFAULT_APPEARANCE_DATA = JSON.stringify({
    
    
    
    
    CreationState: "EArchonCharacterCreationState::FaceComplete",
    Data: [{ SkeletalMeshComponentName: "Head Slot", MorphData: [] }],
    AssetReferences: [],
    StringData: [
        { Key: "BodyType", Data: "Feminine" },
        { Key: "Hair", Data: "Hair12" },
        { Key: "SkinName", Data: "Tan" },
        { Key: "SkinValue", Data: "(R=0.610496,G=0.417885,B=0.254152,A=1.000000)" },
        { Key: "Hair_Color", Data: "(R=0.196843,G=0.042531,B=0.019093,A=1.000000)" },
        { Key: "Beard", Data: "NoBeard" },
        { Key: "Facepaint", Data: "NoFacepaint" },
        { Key: "Makeup", Data: "NoMakeup" }
    ]
});

const DEFAULT_CHARACTER_FLAGS = JSON.stringify({
    Flags: []
});

function EmptyQuestSeries(Id: string){
    return JSON.stringify({ ID: Id });
}

function NormalizeCharacterData(CharacterDataToNormalize: string){
    const CharacterData = JSON.parse(CharacterDataToNormalize || "{}");
    const Now = new Date();
    const LoginTime = [
        Now.getUTCFullYear(),
        Pad(Now.getUTCMonth() + 1),
        Pad(Now.getUTCDate())
    ].join(".") + "-" + [
        Pad(Now.getUTCHours()),
        Pad(Now.getUTCMinutes()),
        Pad(Now.getUTCSeconds())
    ].join(".");

    CharacterData.RecentPlayers ??= JSON.stringify({ RecentPlayers: [], Version: 0 });
    CharacterData.AppearanceData ??= DEFAULT_APPEARANCE_DATA;
    CharacterData.PlayerAccountProgressStep ??= "New";
    CharacterData.CharacterFlagData ??= DEFAULT_CHARACTER_FLAGS;
    CharacterData.PlayerDataRepair ??= JSON.stringify({ Data: [] });
    CharacterData.SERIE_cr20_pjm_quests ??= EmptyQuestSeries("CR20_PJM_Quests");
    CharacterData.SERIE_d24_a_main_quests ??= EmptyQuestSeries("D24_A_MAIN_QUESTS");
    CharacterData.SERIE_d24_b_side_quests ??= EmptyQuestSeries("D24_B_SIDE_QUESTS");
    CharacterData.SERIE_d24_d_tutorials ??= EmptyQuestSeries("D24_D_TUTORIALS");
    CharacterData.LoginTime ??= LoginTime;
    CharacterData.LastLoginTime ??= LoginTime;
    CharacterData.LastChangelist = TARGET_CHANGELIST ?? CharacterData.LastChangelist ?? "";

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    ForceReturningPlayerState(CharacterData);

    
    
    
    
    NormalizeProgressionInvariants(CharacterData);

    return JSON.stringify(CharacterData);
}



function DefaultAppearanceData(): any {
    return {
        CreationState: "EArchonCharacterCreationState::FaceComplete",
        Data: [
            { SkeletalMeshComponentName: "Head Slot", MorphData: [] }
        ],
        AssetReferences: [],
        StringData: [
            { Key: "BodyType", Data: "Feminine" },
            { Key: "Hair", Data: "Hair12" },
            { Key: "SkinName", Data: "Tan" },
            { Key: "SkinValue", Data: "(R=0.610496,G=0.417885,B=0.254152,A=1.000000)" },
            { Key: "Hair_Color", Data: "(R=0.196843,G=0.042531,B=0.019093,A=1.000000)" },
            { Key: "Beard", Data: "NoBeard" },
            { Key: "Facepaint", Data: "NoFacepaint" },
            { Key: "Makeup", Data: "NoMakeup" }
        ]
    };
}





const TUTORIAL_SLATE_FLAGS = [
    "TutorialSlate_LanternAbility", "TutorialSlate_QuickAttack", "TutorialSlate_HeavyAttack",
    "TutorialSlate_Dodge",          "TutorialSlate_LockOn",       "TutorialSlate_Sprint",
    "TutorialSlate_Consumables",    "TutorialSlate_Interact",     "TutorialSlate_Chat",
    "TutorialSlate_Emote",          "TutorialSlate_Menu",         "TutorialSlate_Inventory",
    "TutorialSlate_Loadout",        "TutorialSlate_Store",        "TutorialSlate_HuntPass",
    "TutorialSlate_Map",            "TutorialSlate_Party"
];

function TryParseObj(s: any): any {
    if (s === null || s === undefined) return null;
    if (typeof s === "object") return s;
    if (typeof s !== "string") return null;
    try { return JSON.parse(s); } catch { return null; }
}

function ForceReturningPlayerState(CharacterData: any): void {
    
    const currentStep = String(CharacterData.PlayerAccountProgressStep ?? "New");
    const currentOrd = PROGRESS_ORDER[currentStep] ?? 0;
    const rgOrd = PROGRESS_ORDER["EnteredRamsgate"];
    if (currentOrd < rgOrd) {
        CharacterData.PlayerAccountProgressStep = "EnteredRamsgate";
    }

    
    
    
    
    const existing = TryParseObj(CharacterData.AppearanceData);
    const appearance = existing ?? DefaultAppearanceData();
    appearance.CreationState = "EArchonCharacterCreationState::FaceComplete";
    if (!Array.isArray(appearance.Data) || appearance.Data.length === 0) {
        appearance.Data = DefaultAppearanceData().Data;
    }
    
    
    
    
    const stringDataLegacy = Array.isArray(appearance.StringData) &&
        appearance.StringData.some((e: any) => e && (("CustomizationName" in e) || ("ValueName" in e) || !("Key" in e)));
    if (!Array.isArray(appearance.StringData) || appearance.StringData.length === 0 || stringDataLegacy) {
        appearance.StringData = DefaultAppearanceData().StringData;
    }
    if (!Array.isArray(appearance.AssetReferences)) {
        appearance.AssetReferences = [];
    }
    CharacterData.AppearanceData = JSON.stringify(appearance);

    
    const flagsObj = TryParseObj(CharacterData.CharacterFlagData) ?? { Flags: [] };
    if (!Array.isArray(flagsObj.Flags)) flagsObj.Flags = [];
    const haveKeys = new Set<string>((flagsObj.Flags as any[]).map(f => f?.FlagKey));
    for (const key of TUTORIAL_SLATE_FLAGS) {
        if (!haveKeys.has(key)) {
            flagsObj.Flags.push({ FlagKey: key, FlagValue: "True" });
        }
    }
    if (!haveKeys.has("CharacterFlag_CityGatherableTutorialShown")) {
        flagsObj.Flags.push({ FlagKey: "CharacterFlag_CityGatherableTutorialShown", FlagValue: "True" });
    }
    CharacterData.CharacterFlagData = JSON.stringify(flagsObj);

    
    
    
    
    const loginFlags = TryParseObj(CharacterData.LoginFlagData) ?? { Flags: [] };
    if (!Array.isArray(loginFlags.Flags)) loginFlags.Flags = [];
    const haveLoginKeys = new Set<string>((loginFlags.Flags as any[]).map(f => f?.FlagKey));
    if (!haveLoginKeys.has("WatchedNewRamsgateCinematic")) {
        loginFlags.Flags.push({ FlagKey: "WatchedNewRamsgateCinematic", FlagValue: "true" });
    }
    CharacterData.LoginFlagData = JSON.stringify(loginFlags);
}


const PROGRESS_ORDER: Record<string, number> = {
    "New": 0,
    "DefeatedGnasher": 1,
    "SavedCharacter": 2,
    "EnteredRamsgate": 3,
    "FinishedFirstHunt": 4,
    "FinishedSecondHunt": 5,
    "Final": 5,
};

const PROGRESS_FROM_ORDINAL: Record<number, string> = {
    0: "New",
    1: "DefeatedGnasher",
    2: "SavedCharacter",
    3: "EnteredRamsgate",
    4: "FinishedFirstHunt",
    5: "FinishedSecondHunt",
};

function GetProgressOrdinal(step: string | undefined): number {
    if (!step) return 0;
    return PROGRESS_ORDER[step] ?? 0;
}

function IsCreationStateComplete(appearance: string | undefined): boolean {
    if (!appearance) return false;
    try {
        const parsed = typeof appearance === "string" ? JSON.parse(appearance) : appearance;
        
        
        return parsed?.CreationState === "EArchonCharacterCreationState::FaceComplete";
    } catch {
        return false;
    }
}


function NormalizeProgressionInvariants(CharacterData: any): void {
    const creationComplete = IsCreationStateComplete(CharacterData.AppearanceData);
    const currentProgress = String(CharacterData.PlayerAccountProgressStep ?? "New");
    const currentOrdinal = GetProgressOrdinal(currentProgress);

    if (!creationComplete && currentOrdinal >= PROGRESS_ORDER["SavedCharacter"]) {
        
        
        const clamped = "DefeatedGnasher";
        logger.warn(`[progression-invariant] Clamped progress ${currentProgress} → ${clamped} because CreationState is not FaceComplete`);
        CharacterData.PlayerAccountProgressStep = clamped;
    }

    if (!creationComplete) {
        
        
        
        
        
        
        if (CharacterData.WatchedNewRamsgateCinematic !== undefined) {
            logger.warn(`[progression-invariant] Cleared top-level WatchedNewRamsgateCinematic`);
            delete CharacterData.WatchedNewRamsgateCinematic;
        }
        if (typeof CharacterData.LoginFlagData === "string") {
            try {
                const flags = JSON.parse(CharacterData.LoginFlagData);
                if (Array.isArray(flags?.Flags)) {
                    const before = flags.Flags.length;
                    flags.Flags = flags.Flags.filter((f: any) => f?.FlagKey !== "WatchedNewRamsgateCinematic");
                    if (flags.Flags.length !== before) {
                        logger.warn(`[progression-invariant] Stripped WatchedNewRamsgateCinematic from LoginFlagData.Flags (${before} → ${flags.Flags.length})`);
                        CharacterData.LoginFlagData = JSON.stringify(flags);
                    }
                }
            } catch { /* leave alone */ }
        }
    }
}


export async function IsFreshOnboarding(userId: string): Promise<boolean> {
    const chars = await GetRepositories().characters.findManyByUserId(userId);
    if (chars.length === 0) return true;

    for (const c of chars) {
        try {
            const d = JSON.parse(c.data || "{}");
            const step = String(d.PlayerAccountProgressStep ?? "New");
            const ordinal = GetProgressOrdinal(step);
            const creationDone = IsCreationStateComplete(d.AppearanceData);
            if (creationDone && ordinal >= PROGRESS_ORDER["SavedCharacter"]) {
                return false;
            }
        } catch { /* treat as fresh on parse errors */ }
    }
    return true;
}

function TransformDbCharacterToWireCharacter(DbCharacter: any){
    return {
        accountId: DbCharacter.userId,
        catalogDaoId: null,
        createdDate: DbCharacter.createdDate,
        data: NormalizeCharacterData(DbCharacter.data),
        id: DbCharacter.characterId,
        lastModifiedDate: DbCharacter.lastModifiedDate,
        name: DbCharacter.name,
        updateVersion: DbCharacter.updateVersion
    };
}

export async function GetCharactersForUid(userId: string){
    let CharactersFromDb = await GetRepositories().characters.findManyByUserId(userId);

    if(CharactersFromDb.length === 0){
        const Username = await GetUsernameForUserId(userId);

        await CreateCharacterForUid(userId, Username);

        CharactersFromDb = await GetRepositories().characters.findManyByUserId(userId);
    }

    return CharactersFromDb.map((DbCharacter) => TransformDbCharacterToWireCharacter(DbCharacter));
}

function Pad(Target: number){
    return String(Target).padStart(2, "0");
}

function ProcessTriggers(CharacterDataToUpdateWith: string){
    const CharacterData = JSON.parse(NormalizeCharacterData(CharacterDataToUpdateWith));

    if(CharacterData.SERIE_cr19_series_1_ftue != undefined){
        const FTUESerieData = JSON.parse(CharacterData.SERIE_cr19_series_1_ftue);

        if(FTUESerieData["929A333B40E413C41E47B0A425EC3349"].Status === 3 && CharacterData["SERIE_dojo"] == undefined){
            logger.info(`Injecting SERIE_dojo!`);

            CharacterData["SERIE_dojo"] = "{\"ID\":\"Dojo\",\"Status\":0,\"62B91BD94558409B4F7352B5B96F3ED7\":{\"Status\":0,\"6CA2C43B46334BC06F73DEB5F2BFFEC1\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0},\"3A7241AA43743647D3C1E39E8976E4F3\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0}},\"816CBFD94D16EDA252BD1D8461209568\":{\"Status\":1},\"B152371947599B3C2D55BE9B91439C37\":{\"Status\":0,\"D3F19E2248AECEF5C5C3C8B9E2AC2C67\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0},\"0407C2134FE0BEFE3EC791999632D2BC\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0}},\"DFE54F884C6FC60688B6C494D79ADD29\":{\"Status\":0,\"9D1B0D754DBC896034F942AD625F9D93\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0}}}";
        }
    }

    return JSON.stringify(CharacterData);
}

export async function CreateCharacterForUid(userId: string, characterName: string){
    let CharacterUUID = crypto.randomUUID();

    let CurrentDate = new Date();

    let FormattedCurrentDate = CurrentDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });

    
    
    
    
    
    
    let NewCharacter = await GetUnitOfWork().withTransaction(async (Repos, Session) => {
        const Character = await Repos.characters.create({
            characterId: CharacterUUID,
            userId: userId,
            name: characterName,
            createdDate: FormattedCurrentDate,
            lastModifiedDate: FormattedCurrentDate,
            updateVersion: 0,
            data: NormalizeCharacterData("{}")
        }, Session);

        await SeedNewAccountAtomically(userId, CharacterUUID, Session);

        return Character;
    });

    return TransformDbCharacterToWireCharacter(NewCharacter);
}

export async function UpdateCharacterForUid(CharacterId: string, UserId: string, CharacterDataToUpdateWith: string, UpdateVersion: number, IsGameserver: boolean = false){
    const CurrentData = await GetCharacterWithUid(CharacterId, UserId);

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    let EffectiveVersion = UpdateVersion;
    if(CurrentData!.updateVersion >= UpdateVersion){
        if(!IsGameserver){
            return false;
        }
        EffectiveVersion = CurrentData!.updateVersion + 1;
        logger.info(`[gameserver-force] Stale gameserver write for characterId ${CharacterId} — was updateVersion ${UpdateVersion}, forcing to ${EffectiveVersion} (server is authoritative for progress/PJM)`);
    }

    
    
    
    
    
    
    try {
        const incomingRaw = JSON.parse(CharacterDataToUpdateWith || "{}");
        const existingRaw = JSON.parse(CurrentData!.data || "{}");

        const incomingOrdinal = GetProgressOrdinal(incomingRaw.PlayerAccountProgressStep);
        const existingOrdinal = GetProgressOrdinal(existingRaw.PlayerAccountProgressStep);

        
        if (incomingOrdinal < existingOrdinal) {
            logger.warn(`[progression-guard] Rejecting backward progression ${existingRaw.PlayerAccountProgressStep} → ${incomingRaw.PlayerAccountProgressStep}; keeping existing`);
            incomingRaw.PlayerAccountProgressStep = existingRaw.PlayerAccountProgressStep;
        }
        // Rule 2: no skipping steps (allow same or +1 at a time)
        else if (incomingOrdinal > existingOrdinal + 1) {
            const clampedOrdinal = existingOrdinal + 1;
            const clampedStr = PROGRESS_FROM_ORDINAL[clampedOrdinal];
            logger.warn(`[progression-guard] Rejecting skip ${existingRaw.PlayerAccountProgressStep} → ${incomingRaw.PlayerAccountProgressStep}; clamped to ${clampedStr}`);
            incomingRaw.PlayerAccountProgressStep = clampedStr;
        }

        CharacterDataToUpdateWith = JSON.stringify(incomingRaw);
    } catch (err) {
        logger.warn(`[progression-guard] Non-JSON incoming data or parse error — skipping guard: ${String(err)}`);
    }

    CharacterDataToUpdateWith = NormalizeCharacterData(ProcessTriggers(CharacterDataToUpdateWith));

    await GetRepositories().characters.updateDataConditional(CharacterId, UserId, CharacterDataToUpdateWith, EffectiveVersion);

    return true;
}

export async function GetCharacterWithUid(CharacterId: string, UserId: string){
    const Character = await GetRepositories().characters.findByCharacterIdAndUserId(CharacterId, UserId);

    if(Character == undefined){
        return undefined;
    }

    return TransformDbCharacterToWireCharacter(Character);
}
