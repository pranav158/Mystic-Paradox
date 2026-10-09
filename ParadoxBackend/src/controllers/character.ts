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
    // [Analysis.md Section 13.F] Default to FaceComplete to match the character
    // endpoint (which force-normalizes to FaceComplete in ForceReturningPlayerState
    // below). Prevents momentary NewCharacter default from creating contradictory
    // onboarding state on first-read paths that bypass NormalizeCharacterData.
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

// 1.12 still consults the legacy Dojo quest-series blob when deciding whether the Training Grounds
// destination is selectable, even though the Slayer's Path UI uses the newer Player Journey Map.
// Keep the exact retail-shaped bootstrap previously emitted by ProcessTriggers, but make it reusable
// for migrated accounts whose PJM already has Dojo unlocked and never received the old CR19 FTUE row.
const DOJO_SERIES_DATA = JSON.stringify({
    ID: "Dojo",
    Status: 0,
    "62B91BD94558409B4F7352B5B96F3ED7": {
        Status: 0,
        "6CA2C43B46334BC06F73DEB5F2BFFEC1": { Status: 0, CurrentAmount: 0, LastUpdateAmount: 0 },
        "3A7241AA43743647D3C1E39E8976E4F3": { Status: 0, CurrentAmount: 0, LastUpdateAmount: 0 }
    },
    "816CBFD94D16EDA252BD1D8461209568": { Status: 1 },
    "B152371947599B3C2D55BE9B91439C37": {
        Status: 0,
        "D3F19E2248AECEF5C5C3C8B9E2AC2C67": { Status: 0, CurrentAmount: 0, LastUpdateAmount: 0 },
        "0407C2134FE0BEFE3EC791999632D2BC": { Status: 0, CurrentAmount: 0, LastUpdateAmount: 0 }
    },
    "DFE54F884C6FC60688B6C494D79ADD29": {
        Status: 0,
        "9D1B0D754DBC896034F942AD625F9D93": { Status: 0, CurrentAmount: 0, LastUpdateAmount: 0 }
    }
});

function IsJourneyNodeUnlocked(Node: any): boolean {
    return Node?.node_status === 1 || Node?.node_status === 2;
}

async function IsDojoUnlockedForUser(UserId: string): Promise<boolean> {
    try {
        const Journey = await GetRepositories().playerJourney.findByUserId(UserId);
        if(Journey == undefined) return false;

        const Nodes = JSON.parse(Journey.nodes || "{}");
        if(IsJourneyNodeUnlocked(Nodes?.Dojo)) return true;

        // Preserve compatibility with captures where the map key differs but node_id is authoritative.
        return Object.values(Nodes ?? {}).some((Node: any) =>
            Node?.node_id === "Dojo" && IsJourneyNodeUnlocked(Node)
        );
    }
    catch(err){
        logger.warn(`[dojo-reconcile] Unable to read Player Journey for userId ${UserId}: ${String(err)}`);
        return false;
    }
}

function EnsureLegacyDojoSeries(CharacterDataToNormalize: string, DojoUnlocked: boolean){
    const CharacterData = JSON.parse(NormalizeCharacterData(CharacterDataToNormalize));
    const Added = DojoUnlocked && CharacterData.SERIE_dojo == undefined;
    if(Added) CharacterData.SERIE_dojo = DOJO_SERIES_DATA;

    return { data: JSON.stringify(CharacterData), added: Added };
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

    // [DEV — FTUE bypass 2026-07-10] Force every account to read as "onboarding complete,
    // in Ramsgate" so LoginScreen_bps_C routes CITY / ShatteredIsles_ReturnToRamsgate
    // directly to the hub, skipping BOTH the tutorial and the character creator.
    //
    // Why forced not conditional:
    //   - The FTUE tutorial hunt starves on missing beginner-loadout data
    //     (WP_EB_BEGINNER, AR_BEGINNER_CHEST, BN_BEGINNER_00, GD_FRAME_STARTER_BASE...
    //     all absent from vendor catalogs).
    //   - The FTUE intro cinematic triggers a client-RPC-loops-locally recursion
    //     (Archon.ArchonCharacter.ClientRequestClientAuthoritativeCustomMovementChange)
    //     that eats the server's stack — the DLL depth-guard blocks the crash but
    //     the cinematic can't complete cleanly.
    //   - The client's normal onboarding chain New → tutorial → DefeatedGnasher →
    //     creator → SavedCharacter → Ramsgate → EnteredRamsgate cannot advance past
    //     the tutorial because of the above.
    //
    // "Returning player" state is the code's own documented supported path (see
    // matchmaking.ts). Both fields MUST be set together — NormalizeProgressionInvariants
    // below clamps progress>=SavedCharacter back down to DefeatedGnasher unless
    // CreationState is FaceComplete.
    ForceReturningPlayerState(CharacterData);

    // [1.12 progression invariant — 2026-07-10]
    // Kept as safety-net: with the forced state above CreationState is always
    // FaceComplete so this becomes a no-op. Leaves the invariant available if the
    // forced-set path is ever gated behind a dev flag.
    NormalizeProgressionInvariants(CharacterData);

    return JSON.stringify(CharacterData);
}

// Minimal-but-valid default appearance for the forced "returning player" state.
// The player can re-open the creator later (Ramsgate inn mirror) to customize.
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

// The 17 TutorialSlate_* flags + the CityGatherable flag. When true, the client
// suppresses the corresponding tutorial popup in Ramsgate — otherwise the hub
// spawns them one after another and the input state flip-flops between UI and
// game mode.
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
    // 1. Progress → EnteredRamsgate (or higher if already set higher).
    const currentStep = String(CharacterData.PlayerAccountProgressStep ?? "New");
    const currentOrd = PROGRESS_ORDER[currentStep] ?? 0;
    const rgOrd = PROGRESS_ORDER["EnteredRamsgate"];
    if (currentOrd < rgOrd) {
        CharacterData.PlayerAccountProgressStep = "EnteredRamsgate";
    }

    // 2. AppearanceData → FaceComplete with populated defaults if the existing
    //    Data/StringData is missing or empty. If the client already sent good
    //    appearance data (from an earlier creator session), preserve it — only
    //    force CreationState=FaceComplete so the invariant + gating logic pass.
    const existing = TryParseObj(CharacterData.AppearanceData);
    const appearance = existing ?? DefaultAppearanceData();
    appearance.CreationState = "EArchonCharacterCreationState::FaceComplete";
    if (!Array.isArray(appearance.Data) || appearance.Data.length === 0) {
        appearance.Data = DefaultAppearanceData().Data;
    }
    // Also rewrite a NON-empty StringData still in the legacy shape ({CustomizationName,ValueName}).
    // 1.12 FAppearanceStringData is {Key,Data} (Archon_structs.hpp:7695); a legacy entry never
    // deserializes/applies, so PlayerAppearanceReady never fires. Real {Key,Data} data (has Key,
    // no CustomizationName) is preserved — this only heals the broken legacy shape.
    const stringDataLegacy = Array.isArray(appearance.StringData) &&
        appearance.StringData.some((e: any) => e && (("CustomizationName" in e) || ("ValueName" in e) || !("Key" in e)));
    if (!Array.isArray(appearance.StringData) || appearance.StringData.length === 0 || stringDataLegacy) {
        appearance.StringData = DefaultAppearanceData().StringData;
    }
    if (!Array.isArray(appearance.AssetReferences)) {
        appearance.AssetReferences = [];
    }
    CharacterData.AppearanceData = JSON.stringify(appearance);

    // 3. CharacterFlagData → all tutorial slates true so no popups fire in Ramsgate.
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

    // 4. LoginFlagData → mark the "watched new Ramsgate cinematic" flag so the
    //    login flow doesn't try to play the returning-cinematic (which fails on
    //    fresh install too because the cinematic asset chain is heavy). Do this
    //    inside LoginFlagData.Flags — that's where the client persists it.
    const loginFlags = TryParseObj(CharacterData.LoginFlagData) ?? { Flags: [] };
    if (!Array.isArray(loginFlags.Flags)) loginFlags.Flags = [];
    const haveLoginKeys = new Set<string>((loginFlags.Flags as any[]).map(f => f?.FlagKey));
    if (!haveLoginKeys.has("WatchedNewRamsgateCinematic")) {
        loginFlags.Flags.push({ FlagKey: "WatchedNewRamsgateCinematic", FlagValue: "true" });
    }
    CharacterData.LoginFlagData = JSON.stringify(loginFlags);
}

// EPlayerAccountProgressState string→ordinal mapping (verified against Archon_structs.hpp)
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
        // FaceComplete means the character creator has been submitted at least once.
        // Anything before that (NewCharacter or missing) is "creator not complete".
        return parsed?.CreationState === "EArchonCharacterCreationState::FaceComplete";
    } catch {
        return false;
    }
}

/**
 * Enforce the 1.12 progression invariant:
 *   - If character creation is NOT complete (CreationState=NewCharacter or missing),
 *     progress must be at most DefeatedGnasher.
 *   - EnteredRamsgate and beyond require creation to be complete (CreationState=FaceComplete)
 *     and requires progress to already have reached SavedCharacter.
 *
 * If the incoming state violates the invariant, we clamp DOWN to a valid state
 * rather than silently letting the client into an impossible mixed state. This
 * keeps the client's onboarding path routed correctly (New → tutorial → creator
 * → Ramsgate) rather than jumping straight to returning-player CITY matchmaking.
 */
function NormalizeProgressionInvariants(CharacterData: any): void {
    const creationComplete = IsCreationStateComplete(CharacterData.AppearanceData);
    const currentProgress = String(CharacterData.PlayerAccountProgressStep ?? "New");
    const currentOrdinal = GetProgressOrdinal(currentProgress);

    if (!creationComplete && currentOrdinal >= PROGRESS_ORDER["SavedCharacter"]) {
        // CreationState=NewCharacter cannot coexist with SavedCharacter+ progress.
        // Clamp down to DefeatedGnasher (post-tutorial-but-pre-creator).
        const clamped = "DefeatedGnasher";
        logger.warn(`[progression-invariant] Clamped progress ${currentProgress} → ${clamped} because CreationState is not FaceComplete`);
        CharacterData.PlayerAccountProgressStep = clamped;
    }

    if (!creationComplete) {
        // The client stashes WatchedNewRamsgateCinematic inside LoginFlagData.Flags array
        // (verified via _inspect_char.cjs on the 2026-07-10 16:10 test: DB had
        // `LoginFlagData = {"Flags":[{"FlagKey":"WatchedNewRamsgateCinematic","FlagValue":"true"}]}`).
        // Strip that key from both the top-level field AND from the LoginFlagData.Flags
        // array. The client uses this flag to skip the "arriving in Ramsgate" cinematic;
        // for a fresh account we must NOT let it skip.
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

/**
 * Convenience for the matchmaking route: returns whether the character's persisted
 * onboarding is "fresh" — either the creator has not been completed, or progress is
 * strictly less than SavedCharacter. In that state, requesting GameMode=CITY on the
 * client is a stale-state bug; the matchmaking route routes fresh accounts into the
 * FTUE tutorial hunt instead.
 */
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

function TransformDbCharacterToWireCharacter(DbCharacter: any, DojoUnlocked: boolean = false){
    const Reconciled = EnsureLegacyDojoSeries(DbCharacter.data, DojoUnlocked);
    return {
        accountId: DbCharacter.userId,
        catalogDaoId: null,
        createdDate: DbCharacter.createdDate,
        data: Reconciled.data,
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

    const DojoUnlocked = await IsDojoUnlockedForUser(userId);
    return CharactersFromDb.map((DbCharacter) =>
        TransformDbCharacterToWireCharacter(DbCharacter, DojoUnlocked)
    );
}

function Pad(Target: number){
    return String(Target).padStart(2, "0");
}

function ProcessTriggers(CharacterDataToUpdateWith: string){
    const CharacterData = JSON.parse(NormalizeCharacterData(CharacterDataToUpdateWith));

    if(CharacterData.SERIE_cr19_series_1_ftue != undefined){
        const FTUESerieData = JSON.parse(CharacterData.SERIE_cr19_series_1_ftue);

        if(FTUESerieData?.["929A333B40E413C41E47B0A425EC3349"]?.Status === 3 && CharacterData["SERIE_dojo"] == undefined){
            logger.info(`Injecting SERIE_dojo!`);
            CharacterData["SERIE_dojo"] = DOJO_SERIES_DATA;
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

    // [hardening 2026-07-14] Character row + the full starter manifest (23 instanced items, 14
    // stacked items, one loadout slot, and the starter wallet grant) are now seeded together in
    // ONE atomic Mongo transaction, tagged with starterManifest.ts's BOOTSTRAP_VERSION. Previously
    // inventory/loadout/wallet were each lazily created independently on first GET/access - never
    // atomically, never guaranteed to happen together, and (for inventory/loadout) using SHARED
    // MYSTICPARADOX_STARTER_* instance IDs reused across every account instead of unique per-player IDs.
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

    // [1.14.7 FIX 2026-10-04] The lines below dereferenced CurrentData with non-null assertions
    // (CurrentData!.updateVersion / .data). When no character record exists for this (characterId, userId)
    // pair that threw "TypeError: Cannot read properties of undefined (reading 'updateVersion')" out of the
    // route, so Express answered with an HTML 500 - exactly what appeared in the hub log as
    //   <pre>TypeError: Cannot read properties of undefined (reading 'updateVersion')<br> at UpdateCharacterForUid
    // and on the client as "Failed to update player account progress flag: UnknownError".
    // A missing record is an anomaly (the character is created on first login), so it is logged loudly and
    // treated as a rejected write, which keeps the route answering JSON and leaves stored state untouched.
    if (!CurrentData) {
        logger.warn(`UpdateCharacterForUid: no character record for characterId ${CharacterId} userId ${UserId} (isGameserver=${IsGameserver}) - treating as a rejected write instead of throwing`);
        return false;
    }

    // [move4 / Opus root cause B — 2026-07-10]
    // Optimistic-concurrency-control on updateVersion.
    //
    // The client and the gameserver both persist the same character concurrently and both
    // stamp their PUTs with monotonically-increasing updateVersion. The CLIENT bumps
    // version frequently (58→59→60→…→64 within seconds — see metagame.log for a real
    // sequence), so a GAMESERVER write almost always arrives "stale" and gets rejected.
    //
    // But the gameserver is AUTHORITATIVE for server-driven fields:
    //   - PlayerAccountProgressStep advance (gates interaction, journey/PJM progress)
    //   - PJM Slayer_00 unlock (finalizes equipped-armor state → clothes render on client)
    //
    // If the gameserver's write is rejected:
    //   - Fix A (route conflict handler) returns 200 with current authoritative state,
    //     which keeps the gameserver's HTTP queue alive.
    //   - But the gameserver reads the response back, sees its progress flag did NOT
    //     advance (because the write was rejected), and logs
    //         "Failed to update player account progress flag: UnknownError"
    //     Both symptoms follow: no interaction (progress flag never advances) and
    //     no clothes on client (server armor state never replicates).
    //
    // Fix B: for gameserver writes on version conflict, DO NOT reject. Instead force the
    // write through by using EffectiveVersion = current+1. The monotonic progression-guard
    // below already prevents backward or skipping progression jumps, so this is safe.
    //
    // Client writes retain the original optimistic-concurrency semantics (return false →
    // route returns 200 with current state, client reconciles).
    let EffectiveVersion = UpdateVersion;
    if(CurrentData!.updateVersion >= UpdateVersion){
        if(!IsGameserver){
            return false;
        }
        EffectiveVersion = CurrentData!.updateVersion + 1;
        logger.info(`[gameserver-force] Stale gameserver write for characterId ${CharacterId} — was updateVersion ${UpdateVersion}, forcing to ${EffectiveVersion} (server is authoritative for progress/PJM)`);
    }

    // [1.12 monotonic progression guard — 2026-07-10]
    // Enforce that PlayerAccountProgressStep can only advance forward (New → DefeatedGnasher →
    // SavedCharacter → EnteredRamsgate → FinishedFirstHunt → FinishedSecondHunt). Reject
    // decreases and clamp jump-aheads. This prevents a corrupted or maliciously edited
    // client save from setting an inconsistent progress state that skips the tutorial or
    // the character creator.
    try {
        const incomingRaw = JSON.parse(CharacterDataToUpdateWith || "{}");
        const existingRaw = JSON.parse(CurrentData!.data || "{}");

        const incomingOrdinal = GetProgressOrdinal(incomingRaw.PlayerAccountProgressStep);
        const existingOrdinal = GetProgressOrdinal(existingRaw.PlayerAccountProgressStep);

        // Rule 1: no going backward
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

    // GetCharacterWithUid overlays SERIE_dojo whenever the persisted Player Journey says Dojo is
    // unlocked. Preserve that authoritative unlock on every subsequent character write so a stale
    // client blob cannot remove the legacy gate again.
    let DojoUnlocked = false;
    try {
        DojoUnlocked = JSON.parse(CurrentData!.data || "{}").SERIE_dojo != undefined;
    }
    catch { /* malformed existing data is handled by the normal update path */ }

    const DojoReconciled = EnsureLegacyDojoSeries(CharacterDataToUpdateWith, DojoUnlocked);
    CharacterDataToUpdateWith = DojoReconciled.data;
    if(DojoReconciled.added){
        logger.info(`[dojo-reconcile] Persisting SERIE_dojo for userId ${UserId} characterId ${CharacterId} from unlocked Player Journey state`);
    }

    await GetRepositories().characters.updateDataConditional(CharacterId, UserId, CharacterDataToUpdateWith, EffectiveVersion);

    return true;
}

export async function GetCharacterWithUid(CharacterId: string, UserId: string){
    const Character = await GetRepositories().characters.findByCharacterIdAndUserId(CharacterId, UserId);

    if(Character == undefined){
        return undefined;
    }

    const DojoUnlocked = await IsDojoUnlockedForUser(UserId);
    return TransformDbCharacterToWireCharacter(Character, DojoUnlocked);
}
