/*
 * HuntExporter - read-only 1.12.0 hunt/matchmaking table export.
 *
 * Emits the live PlayerHuntTableData and MatchmakerHuntTableData rows rather than
 * carrying forward the 1.4.4-era JSON snapshot. This is deliberately an evidence
 * export: it does not overwrite Metagame vendor tables or invent aliases.
 *
 * The tag-routing payload is preserved as tag dictionaries plus raw token streams.
 * A later importer/resolver can implement the same query semantics without needing
 * another capture. No ProcessEvent, hooks, or gameplay mutation are used.
 */

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <algorithm>
#include <cstdint>

#include "SDK.hpp"
#include "ExportPaths.hpp"

using namespace SDK;

namespace HuntExp {

static std::string JsonEsc(const std::string& s) {
    std::string o; o.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char b[8]; sprintf_s(b, "\\u%04x", c & 0xFF); o += b;
                } else {
                    o += c;
                }
        }
    }
    return o;
}
static std::string Q(const std::string& s) { return "\"" + JsonEsc(s) + "\""; }

// Every string/name conversion from raw table memory is SEH guarded. A diagnostic
// exporter must skip a malformed/mid-load row rather than crash the game process.
__declspec(noinline) static void RawFStr(const FString& s, std::string* out) {
    if (s.Num() > 0 && s.IsValid()) *out = s.ToString();
}
__declspec(noinline) static void RawFNm(const FName& n, std::string* out) {
    *out = n.ToString();
}
static bool SehStr(const FString& s, std::string* out) {
    __try { RawFStr(s, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static bool SehNm(const FName& n, std::string* out) {
    __try { RawFNm(n, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static std::string FStr(const FString& s) { std::string o; SehStr(s, &o); return o; }
static std::string FNm(const FName& n) { std::string o; SehNm(n, &o); return o; }

// See ExportPaths.hpp: <root>\Items_Analysis when ExportPaths.local.h names a root, else .\Items_Analysis.
static std::wstring ResolveOutDir() { return ExportOutDir(); }

static void Status(const std::string& s) {
    OutputDebugStringA(("[HuntExporter] " + s + "\n").c_str());
    std::ofstream f(ResolveOutDir() + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << "[Hunts] " << s << "\n";
}

static bool RowCountIsSane(UDataTable* dt, int& outCount) {
    outCount = dt->RowMap.Num();
    return outCount >= 0 && outCount < 200000;
}

static std::vector<UDataTable*> FindDataTablesByRowStruct(const std::string& expectedRowStructName) {
    std::vector<UDataTable*> out;
    if (!UObject::GObjects) return out;
    UClass* dtClass = UDataTable::StaticClass();
    if (!dtClass) return out;

    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || !obj->Class || !obj->IsA(dtClass)) continue;
        UDataTable* dt = static_cast<UDataTable*>(obj);
        if (dt->RowStruct && dt->RowStruct->GetName() == expectedRowStructName) out.push_back(dt);
    }
    return out;
}

static std::string SerializeTagArray(const TArray<FGameplayTag>& tags) {
    std::string o = "[";
    const int n = tags.Num();
    for (int i = 0; i < n; ++i) {
        if (i) o += ",";
        o += Q(FNm(tags[i].TagName));
    }
    return o + "]";
}

static std::string SerializeTags(const FGameplayTagContainer& tags) {
    // GameplayTags is the authored set; ParentTags is transient derived state and
    // intentionally excluded so exports are stable across load order.
    return SerializeTagArray(tags.GameplayTags);
}

static std::string SerializeTagQuery(const FGameplayTagQuery& query) {
    std::string o = "{";
    o += "\"tokenStreamVersion\":" + std::to_string(query.TokenStreamVersion);
    o += ",\"tagDictionary\":" + SerializeTagArray(query.TagDictionary);
    o += ",\"tokenStream\":[";
    const int n = query.QueryTokenStream.Num();
    for (int i = 0; i < n; ++i) {
        if (i) o += ",";
        o += std::to_string(static_cast<unsigned int>(query.QueryTokenStream[i]));
    }
    o += "]";
    o += ",\"userDescription\":" + Q(FStr(query.UserDescription));
    o += ",\"autoDescription\":" + Q(FStr(query.AutoDescription));
    return o + "}";
}

static std::string SerializeHandle(const FDataTableRowHandle& h) {
    return "{\"table\":" + Q(h.DataTable ? h.DataTable->GetName() : std::string()) +
           ",\"rowName\":" + Q(FNm(h.RowName)) + "}";
}

/*
 * Reads the /Game/... path out of a soft pointer WITHOUT loading the asset.
 *
 * WHY NOT .Get(): a TSoftObjectPtr/TSoftClassPtr resolves to nullptr whenever the target asset is
 * not currently loaded, and hunt maps/behemoths are exactly that — streamed on demand, absent in
 * Ramsgate. The first pass used .Get() and produced an EMPTY mapAssetName for 869 of 869 map
 * entries, which made the export useless for import: MapAssetName is the field DeployServer hands
 * to the gameserver to launch a map. The path is always present in the pointer's FSoftObjectPath
 * regardless of load state, so read that instead.
 *
 * WHY A HARDCODED OFFSET: Dumper-7 emits TPersistentObjectPtr::ObjectID with size 0x0000 (it
 * cannot size the template parameter), so the generated member offset of 0x0C is not trustworthy.
 * The real layout is FWeakObjectPtr(0x08) + int32 TagAtLastTest(0x04) + 4 bytes alignment padding,
 * putting FSoftObjectPath at 0x10. This is corroborated by the SDK's own field sizes: both
 * FHunt_MapInfo::MapAsset and FHunt_BehemothInfo::BehemothAsset are 0x28, and
 * 0x28 - sizeof(FSoftObjectPath){FName 0x08 + FString 0x10 = 0x18} = 0x10.
 *
 * SEH-guarded like every other live read here; a bad path yields "" rather than a fault.
 */
static constexpr size_t kSoftObjectPathOffset = 0x10;

__declspec(noinline) static void RawSoftPath(const void* softPtr, std::string* out) {
    const uint8_t* base = reinterpret_cast<const uint8_t*>(softPtr);
    const FName* assetPathName = reinterpret_cast<const FName*>(base + kSoftObjectPathOffset);

    // GetRawString(), NOT ToString(). This SDK's FName::ToString() ends with:
    //     size_t pos = OutputString.rfind('/');
    //     return OutputString.substr(pos + 1);
    // i.e. it strips everything before the last slash to yield a short display name. That is
    // exactly wrong here: the whole point of this read is the full package path. Using ToString()
    // produced "adventure_moss_cave.adventure_moss_cave" where the vendored table correctly holds
    // "/Game/Maps/islands/adventure/Moss_Cave/adventure_moss_cave.adventure_moss_cave", and
    // DeployServer hands this string to the gameserver to launch the map.
    *out = assetPathName->GetRawString();
}

// Split exactly like RawFStr/SehStr above: __try cannot live in a function that owns an object
// requiring unwinding (C2712), so the std::string local stays out of the guarded frame.
static bool SehSoftPath(const void* softPtr, std::string* out) {
    __try { RawSoftPath(softPtr, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static std::string SoftPath(const void* softPtr) {
    std::string o;
    if (!SehSoftPath(softPtr, &o)) o.clear();
    // An unset soft pointer reads back as the literal FName "None"; normalize to empty so
    // consumers do not have to special-case it.
    if (o == "None") o.clear();
    return o;
}

static std::string SerializeBehemoth(const FHunt_BehemothInfo& b) {
    std::string o = "{";
    o += "\"behemothName\":" + Q(FStr(b.BehemothName));
    o += ",\"behemothAssetPath\":" + Q(SoftPath(&b.BehemothAsset));
    o += ",\"behemothAssetResolvedName\":" + Q(b.BehemothAsset.Get() ? b.BehemothAsset.Get()->GetName() : std::string());
    o += ",\"powerOverride\":" + std::to_string(b.PowerOverride);
    o += ",\"weighting\":" + std::to_string(b.Weighting);
    return o + "}";
}

static std::string SerializeMap(const FHunt_MapInfo& m) {
    std::string o = "{";
    o += "\"mapName\":" + Q(FStr(m.MapName));
    // MapAssetName is an authored FString that 1.12 leaves empty; the soft-pointer path below is
    // the authoritative source. Both are emitted so an importer can prefer whichever is populated.
    o += ",\"mapAssetName\":" + Q(FStr(m.MapAssetName));
    o += ",\"mapAssetPath\":" + Q(SoftPath(&m.MapAsset));
    o += ",\"mapAssetResolvedName\":" + Q(m.MapAsset.Get() ? m.MapAsset.Get()->GetName() : std::string());
    o += ",\"biome\":" + std::to_string(static_cast<int>(m.Biome));
    o += ",\"weighting\":" + std::to_string(m.Weighting);
    return o + "}";
}

static std::string SerializeMatchmakerList(const FMatchmakerHuntList& list) {
    std::string o = "{";
    o += "\"matchmakerTable\":" + Q(list.MatchmakerTable ? list.MatchmakerTable->GetName() : std::string());
    o += ",\"queries\":[";
    const int n = list.HuntTags.Num();
    for (int i = 0; i < n; ++i) {
        if (i) o += ",";
        o += SerializeTagQuery(list.HuntTags[i]);
    }
    return o + "]}";
}

static std::string SerializePlayerHuntRow(const std::string& sourceTable, const std::string& rowName,
                                          const FPlayerHuntTableData& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);
    o += ",\"playerHuntId\":" + Q(FNm(row.PlayerHuntId));
    o += ",\"region\":" + SerializeHandle(row.Region);
    o += ",\"matchmakingType\":" + std::to_string(static_cast<int>(row.MatchmakingType));
    o += ",\"matchmakingGameType\":" + std::to_string(static_cast<int>(row.MatchmakingGameType));
    o += ",\"huntTags\":" + SerializeTags(row.HuntTags);
    o += ",\"matchmakerHuntIDs\":[";
    for (int i = 0; i < row.MatchmakerHuntIDs.Num(); ++i) {
        if (i) o += ",";
        o += SerializeHandle(row.MatchmakerHuntIDs[i]);
    }
    o += "]";
    o += ",\"matchmakerHuntsByTag\":[";
    for (int i = 0; i < row.MatchmakerHuntsByTag.Num(); ++i) {
        if (i) o += ",";
        o += SerializeMatchmakerList(row.MatchmakerHuntsByTag[i]);
    }
    o += "]";
    o += ",\"escalationModeSpecification\":" + SerializeHandle(row.EscalationModeSpecification);
    o += ",\"escalationPatrolInitialChallengeLevel\":" + std::to_string(row.EscalationPatrolInitialChallengeLevel);
    o += ",\"escalationPatrolMaxChallengeLevel\":" + std::to_string(row.EscalationPatrolMaxChallengeLevel);
    o += ",\"recommendedEscalationLevel\":" + std::to_string(row.RecommendedEscalationLevel);
    o += ",\"hasPortals\":" + std::string(row.bHasPortals ? "true" : "false");
    o += ",\"hasGlitterEvent\":" + std::string(row.bHasGlitterEvent ? "true" : "false");
    o += ",\"hasPhaelanxEvent\":" + std::string(row.bHasPhaelanxEvent ? "true" : "false");
    o += ",\"huntSuccessReward\":" + Q(FNm(row.HuntSuccessReward));
    o += ",\"firstCompletionSuccessReward\":" + Q(FNm(row.FirstCompletionSuccessReward));
    o += ",\"targetedHuntSuccessReward\":" + Q(FNm(row.TargetedHuntSuccessReward));
    o += ",\"huntFailureReward\":" + Q(FNm(row.HuntFailureReward));
    o += ",\"targetedHuntFailureReward\":" + Q(FNm(row.TargetedHuntFailureReward));
    o += ",\"minWeaponSkillLevel\":" + std::to_string(row.MinWeaponSkillLevel);
    o += ",\"recommendedWeaponSkillLevel\":" + std::to_string(row.RecomendedWeaponSkillLevel);
    o += ",\"visibleWhileLocked\":" + std::string(row.IsVisibleWhileLocked ? "true" : "false");
    return o + "}";
}

static std::string SerializeMatchmakerHuntRow(const std::string& sourceTable, const std::string& rowName,
                                               const FMatchmakerHuntTableData& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);
    o += ",\"region\":" + SerializeHandle(row.Region);
    o += ",\"huntTags\":" + SerializeTags(row.HuntTags);
    o += ",\"huntThreatLevel\":" + std::to_string(row.HuntThreatLevel);
    o += ",\"gameModeOverride\":" + Q(FStr(row.GameModeOverride));
    o += ",\"dangerPerSecOverride\":" + std::to_string(row.DangerPerSecOverride);
    o += ",\"specificBehemoth\":" + SerializeBehemoth(row.SpecificBehemoth);
    o += ",\"additionalSpecificBehemoths\":[";
    for (int i = 0; i < row.AdditionalSpecificBehemoths.Num(); ++i) {
        if (i) o += ",";
        o += SerializeBehemoth(row.AdditionalSpecificBehemoths[i]);
    }
    o += "]";
    o += ",\"mapMetaData\":" + SerializeHandle(row.MapMetaData);
    o += ",\"mapList\":[";
    for (int i = 0; i < row.MapList.Num(); ++i) {
        if (i) o += ",";
        o += SerializeMap(row.MapList[i]);
    }
    o += "]";
    o += ",\"specificModifier\":" + Q(row.SpecificModifier ? row.SpecificModifier->GetName() : std::string());
    o += ",\"modifiers\":[";
    for (int i = 0; i < row.Modifiers.Num(); ++i) {
        if (i) o += ",";
        o += Q(FNm(row.Modifiers[i]));
    }
    o += "]";
    o += ",\"gatherableTier\":" + std::to_string(static_cast<int>(row.GatherableTier));
    o += ",\"maxPlayers\":" + std::to_string(row.MaxPlayers);
    o += ",\"isGeneratedEncounter\":" + std::string(row.bIsGeneratedEncounter ? "true" : "false");
    o += ",\"gameModeSpecificData\":" + SerializeHandle(row.GameModeSpecificData);
    return o + "}";
}

template <typename RowT, typename Fn>
__declspec(noinline) static void RawSerializeRow(Fn fn, const std::string& tableName,
                                                  const std::string& rowName, const RowT& row,
                                                  std::string* out) {
    *out = fn(tableName, rowName, row);
}
template <typename RowT, typename Fn>
static bool SafeSerializeRow(Fn fn, const std::string& tableName, const std::string& rowName,
                             const RowT& row, std::string* out) {
    __try { RawSerializeRow<RowT>(fn, tableName, rowName, row, out); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

template <typename RowT, typename Fn>
static int ExportTablesByStruct(const std::string& rowStructName, const std::wstring& fileName, Fn serializer) {
    const std::vector<UDataTable*> tables = FindDataTablesByRowStruct(rowStructName);
    if (tables.empty()) {
        Status("no loaded table with RowStruct=" + rowStructName + "; open the hunt/map UI and re-inject");
        return 0;
    }

    std::ofstream f(fileName, std::ios::trunc);
    if (!f) {
        Status("cannot open hunt export output file");
        return -1;
    }

    int written = 0;
    for (UDataTable* table : tables) {
        int rowCount = 0;
        if (!RowCountIsSane(table, rowCount)) {
            Status("RowMap.Num() unreasonable on " + table->GetName() + "; skipping");
            continue;
        }

        std::vector<std::string> rowNames;
        rowNames.reserve(rowCount);
        for (auto& pair : table->RowMap) rowNames.push_back(FNm(pair.Key()));
        std::sort(rowNames.begin(), rowNames.end());

        int tableWritten = 0;
        for (const std::string& rowName : rowNames) {
            uint8_t* rowPtr = nullptr;
            for (auto& pair : table->RowMap) {
                if (FNm(pair.Key()) == rowName) { rowPtr = pair.Value(); break; }
            }
            if (!rowPtr) continue;

            const RowT& row = *reinterpret_cast<const RowT*>(rowPtr);
            std::string line;
            if (!SafeSerializeRow<RowT>(serializer, table->GetName(), rowName, row, &line)) {
                Status("row '" + rowName + "' faulted in " + table->GetName() + "; skipped");
                continue;
            }
            f << line << "\n";
            ++written;
            ++tableWritten;
        }
        Status("wrote " + std::to_string(tableWritten) + "/" + std::to_string(rowCount) +
               " rows from " + table->GetName() + " (RowStruct=" + rowStructName + ")");
    }
    return written;
}

/*
 * ---------------------------------------------------------------------------------------------
 * Supporting hunt-graph tables, identified by the EXPORT_TABLE_INVENTORY census.
 *
 * player_hunts/matchmaker_hunts reference these by FDataTableRowHandle, so an importer that only
 * has the two main tables still cannot resolve a hunt end to end. Row struct names below are the
 * exact strings the census reported, not guesses:
 *
 *   hunt_regions        -> Hunt_Region                 (43 rows)   <- Region handle target
 *   escalation_mode_specs -> EscalationModeSpecification (19 rows) <- EscalationModeSpecification
 *   hunt_modifiers      -> HuntModifierTableRow        (164 rows)  <- Modifiers[]
 *   game_activity_table -> GameActivityTableData       (10 rows)   <- activity -> hunt routing
 *
 * NOT exported: map_metadata_table. Its row struct is `map_metadata`, a Blueprint-defined
 * UserDefinedStruct absent from Archon_structs.hpp, so there is no verified layout to read and
 * casting a row to a guessed struct is how you fault the process. The map path we actually need
 * comes from FMatchmakerHuntTableData::MapList instead.
 *
 * *** FText IS DELIBERATELY OMITTED FROM EVERY SERIALIZER BELOW. ***
 * FText is a shared-ref to FTextData, NOT an FString. Calling ToString() on one is what produced
 * the EXCEPTION_ACCESS_VIOLATION that killed an earlier SlayersPathExporter injection. These rows
 * are full of display text (Hunt_Region::Name/Description, HuntModifierTableRow::ModifierName and
 * friends) and every one of those fields is skipped on purpose. Only FName, POD, row handles,
 * tag containers and soft-pointer paths are read. Do not "improve" this by adding display names.
 * ---------------------------------------------------------------------------------------------
 */

static std::string SerializeHuntRegionRow(const std::string& sourceTable, const std::string& rowName,
                                          const FHunt_Region& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);
    // FText Name / Description / TargetedHuntDescription intentionally skipped — see header above.
    o += ",\"matchmakingId\":" + Q(FNm(row.MatchmakingId));
    o += ",\"tokenId\":" + Q(FNm(row.TokenId));
    o += ",\"numTokensRequired\":" + std::to_string(row.NumTokensRequired);
    o += ",\"numHuntPassBehemothRewards\":" + std::to_string(row.NumHuntPassBehemothRewards);
    o += ",\"targetedBehemothList\":" + Q(row.TargetedBehemothList ? row.TargetedBehemothList->GetName() : std::string());
    o += ",\"behemothPresets\":[";
    for (int i = 0; i < row.BehemothPresets.Num(); ++i) {
        if (i) o += ",";
        o += Q(SoftPath(&row.BehemothPresets[i]));
    }
    o += "]";
    return o + "}";
}

static std::string SerializeEscalationModeSpecRow(const std::string& sourceTable, const std::string& rowName,
                                                  const FEscalationModeSpecification& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);
    // FText EscalationSpecificationName / Description intentionally skipped.
    o += ",\"initialChallengeLevel\":" + std::to_string(row.InitialChallengeLevel);
    o += ",\"maxChallengeLevel\":" + std::to_string(row.MaxChallengeLevel);
    o += ",\"roundStructureCount\":" + std::to_string(row.RoundStructures.Num());
    o += ",\"lootTable\":" + SerializeHandle(row.LootTable);
    o += ",\"optionalPowerOverride\":" + std::to_string(row.OptionalPowerOverride);
    o += ",\"escalationModeTags\":" + SerializeTags(row.EscalationModeTags);
    o += ",\"backupEncountersTable\":" + Q(row.BackupEncountersTable ? row.BackupEncountersTable->GetName() : std::string());
    o += ",\"completionRewards\":[";
    for (int i = 0; i < row.CompletionRewards.Num(); ++i) {
        if (i) o += ",";
        o += Q(FStr(row.CompletionRewards[i]));
    }
    o += "]";
    o += ",\"escalationAmountPerScoreValue\":[";
    for (int i = 0; i < row.EscalationAmountPerScoreValue.Num(); ++i) {
        if (i) o += ",";
        o += std::to_string(row.EscalationAmountPerScoreValue[i]);
    }
    o += "]";
    // RoundStructures / EncounterCreationParams / StateTimings are deep nested structs; only their
    // shape is reported here. Add typed serializers for them only if an importer actually needs them.
    return o + "}";
}

static std::string SerializeHuntModifierRow(const std::string& sourceTable, const std::string& rowName,
                                            const FHuntModifierTableRow& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);
    // FText ModifierName / ModifierDescription / ModifierHUDDescription intentionally skipped.
    o += ",\"modifierAssetPath\":" + Q(SoftPath(&row.ModifierAsset));
    o += ",\"huntComplexityModifier\":" + std::to_string(row.HuntComplexityModifier);
    o += ",\"threatLevel\":" + std::to_string(row.ThreatLevel);
    o += ",\"modifierApplicationType\":" + std::to_string(static_cast<int>(row.ModifierApplicationType));
    o += ",\"modifierMetaTags\":" + SerializeTags(row.ModifierMetaTags);
    o += ",\"behemothElementCondition\":" + std::to_string(static_cast<int>(row.BehemothElementCondition));
    return o + "}";
}

static std::string SerializeGameActivityRow(const std::string& sourceTable, const std::string& rowName,
                                            const FGameActivityTableData& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);
    o += ",\"enabled\":" + std::string(row.bEnabled ? "true" : "false");
    // The routing fields: how an activity (Trials, Escalation, etc.) maps onto concrete hunts.
    o += ",\"playerHunt\":" + Q(FNm(row.PlayerHunt));
    o += ",\"matchmakerHunts\":[";
    for (int i = 0; i < row.MatchmakerHunts.Num(); ++i) {
        if (i) o += ",";
        o += Q(FNm(row.MatchmakerHunts[i]));
    }
    o += "]";
    o += ",\"unlockRequirement\":" + std::to_string(static_cast<int>(row.UnlockRequirement));
    o += ",\"unlockCriteria\":[";
    for (int i = 0; i < row.UnlockCriteria.Num(); ++i) {
        if (i) o += ",";
        o += SerializeHandle(row.UnlockCriteria[i]);
    }
    o += "]";
    return o + "}";
}

/*
 * ---------------------------------------------------------------------------------------------
 * game_activity_unlock_criteria — WHY a hunt-menu entry stays greyed out.
 *
 * THE QUESTION THIS ANSWERS: the Slayer's Path node for "Trials Mode Normal difficulty" unlocks and
 * persists (survives relog, the Slayer's Path UI shows it unlocked), yet the Trial entry in the hunt
 * menu is still greyed out with "Unlock Normal Trials at Milestone XI in the Slayer's Path". A stale
 * client was ruled out — a fresh login still shows it locked — so the gate is failing on a signal we
 * are not satisfying.
 *
 * FProgressionUnlockCriteria can require FIVE independent things, each with its own operation enum:
 *     FeatureFlags           TArray<TSubclassOf<UFeatureFlag>>   <- our backend serves NONE of these
 *     ItemIds                TArray<FString>
 *     ProgressionTrackRanks  TArray<FProgressTrackRank>          { FName Track; int32 Rank; }
 *     QuestRequirements      TArray<FQuestRequirement>           { FName QuestName; EQuestStatus; }
 *     PlayerJourneyNodes     TArray<FDataTableRowHandle>         <- it CAN check the node directly
 * The node is unlocked and it still fails, so one of the other four is the blocker. Each implies a
 * completely different fix, which is why this is exported before anything is changed.
 *
 * FeatureFlags is the leading suspect: a grep of ParadoxBackend found no feature-flag support at all,
 * so any criterion requiring one can never be satisfied — which matches "fails permanently, survives
 * relog, unaffected by progression".
 *
 * SAFETY: FName + FString + POD + row handles only. FeatureFlags are TSubclassOf, read via SoftPath()
 * (the same unresolved-soft-pointer read that fixed the empty map paths) so an unloaded class still
 * yields its path. No FText anywhere — see the file header.
 * ---------------------------------------------------------------------------------------------
 */
static std::string SerializeUnlockCriteriaRow(const std::string& sourceTable, const std::string& rowName,
                                              const FProgressionUnlockCriteria& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);

    // Operation enums decide AND/OR/NONE semantics per group; exported raw so the importer can map them.
    o += ",\"featureFlagsOperation\":" + std::to_string(static_cast<int>(row.FeatureFlagsOperation));
    o += ",\"featureFlags\":[";
    for (int i = 0; i < row.FeatureFlags.Num(); ++i) {
        if (i) o += ",";
        o += Q(SoftPath(&row.FeatureFlags[i]));
    }
    o += "]";

    o += ",\"itemIdsOperation\":" + std::to_string(static_cast<int>(row.ItemIdsOperation));
    o += ",\"itemIds\":[";
    for (int i = 0; i < row.ItemIds.Num(); ++i) {
        if (i) o += ",";
        o += Q(FStr(row.ItemIds[i]));
    }
    o += "]";

    o += ",\"progressionTrackRanksOperation\":" + std::to_string(static_cast<int>(row.ProgressionTrackRanksOperation));
    o += ",\"progressionTrackRanks\":[";
    for (int i = 0; i < row.ProgressionTrackRanks.Num(); ++i) {
        if (i) o += ",";
        o += "{\"track\":" + Q(FNm(row.ProgressionTrackRanks[i].Track))
           + ",\"rank\":" + std::to_string(row.ProgressionTrackRanks[i].Rank) + "}";
    }
    o += "]";

    o += ",\"questRequirementsOperation\":" + std::to_string(static_cast<int>(row.QuestRequirementsOperation));
    o += ",\"questRequirementsCondition\":" + std::to_string(static_cast<int>(row.QuestRequirementsCondition));
    o += ",\"questRequirements\":[";
    for (int i = 0; i < row.QuestRequirements.Num(); ++i) {
        if (i) o += ",";
        o += "{\"questName\":" + Q(FNm(row.QuestRequirements[i].QuestName))
           + ",\"statusRequired\":" + std::to_string(static_cast<int>(row.QuestRequirements[i].QuestStatusRequired)) + "}";
    }
    o += "]";

    o += ",\"playerJourneyNodesOperation\":" + std::to_string(static_cast<int>(row.PlayerJourneyNodesOperation));
    o += ",\"playerJourneyNodes\":[";
    for (int i = 0; i < row.PlayerJourneyNodes.Num(); ++i) {
        if (i) o += ",";
        o += SerializeHandle(row.PlayerJourneyNodes[i]);
    }
    o += "]";

    return o + "}";
}

/*
 * ScheduleData — the schedule tables the USchedulerComponent loads (ScheduleTables @ +0xD0). This is
 * WHY the Trials hunt-menu entry stays greyed: UHuntCatalog::IsHuntUnlocked runs a scheduler gate
 * (FUN_14197e8c0) BEFORE the Slayer's Path criteria — a scheduled hunt is only "unlocked" if its
 * scheduled-item ID is currently ACTIVE (server-pushed via ClientReceiveCurrentSchedule ->
 * AvailableScheduledItems). Our /game_tuning/seasonal_event_schedule is stubbed empty, so no Trials
 * rotation is ever active. Dumping these rows gives the exact ScheduledItems[].ID (e.g. "Scheduled_Arena")
 * to serve always-active in that endpoint. FText Name is deliberately omitted (reading FText faults).
 */
static std::string SerializeScheduleDataRow(const std::string& sourceTable, const std::string& rowName,
                                            const FScheduleData& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);
    o += ",\"startTimeTicks\":" + std::to_string(*reinterpret_cast<const int64_t*>(&row.StartTime));
    o += ",\"endTimeTicks\":" + std::to_string(*reinterpret_cast<const int64_t*>(&row.EndTime));
    o += ",\"isRepeatable\":" + std::string(row.IsRepeatable ? "true" : "false");
    o += ",\"eachDay\":" + std::string(row.RepeatableDetails.EachDay ? "true" : "false");
    o += ",\"eachWeek\":" + std::string(row.RepeatableDetails.EachWeek ? "true" : "false");
    o += ",\"shouldQueue\":" + std::string(row.bShouldQueueTheSheduleItems ? "true" : "false");
    o += ",\"scheduledItems\":[";
    for (int i = 0; i < row.ScheduledItems.Num(); ++i) {
        if (i) o += ",";
        o += "{\"id\":" + Q(FNm(row.ScheduledItems[i].ID)) +
             ",\"maxCompletionPerInterval\":" + std::to_string(row.ScheduledItems[i].MaxCompletionPerInterval) + "}";
    }
    o += "]";
    o += ",\"itemsLeftOut\":[";
    for (int i = 0; i < row.ItemsToBeLeftOutOfTheRotation.Num(); ++i) {
        if (i) o += ",";
        o += std::to_string(row.ItemsToBeLeftOutOfTheRotation[i]);
    }
    o += "]";
    return o + "}";
}

} // namespace HuntExp

int RunHuntExport() {
    using namespace HuntExp;

    const std::wstring root = ResolveOutDir();
    const std::wstring outDir = root + L"\\hunts_1_14_7";
    CreateDirectoryW(outDir.c_str(), nullptr);

    Status("starting read-only 1.12 hunt export");
    const int playerRows = ExportTablesByStruct<FPlayerHuntTableData>(
        "PlayerHuntTableData", outDir + L"\\player_hunts.jsonl", SerializePlayerHuntRow);
    const int matchmakerRows = ExportTablesByStruct<FMatchmakerHuntTableData>(
        "MatchmakerHuntTableData", outDir + L"\\matchmaker_hunts.jsonl", SerializeMatchmakerHuntRow);

    // Supporting tables the two above reference by row handle. Counted separately so a fault in a
    // supporting table is obvious in the manifest rather than silently folded into the main totals.
    const int regionRows = ExportTablesByStruct<FHunt_Region>(
        "Hunt_Region", outDir + L"\\hunt_regions.jsonl", SerializeHuntRegionRow);
    const int escalationRows = ExportTablesByStruct<FEscalationModeSpecification>(
        "EscalationModeSpecification", outDir + L"\\escalation_mode_specs.jsonl", SerializeEscalationModeSpecRow);
    const int modifierRows = ExportTablesByStruct<FHuntModifierTableRow>(
        "HuntModifierTableRow", outDir + L"\\hunt_modifiers.jsonl", SerializeHuntModifierRow);
    const int activityRows = ExportTablesByStruct<FGameActivityTableData>(
        "GameActivityTableData", outDir + L"\\game_activities.jsonl", SerializeGameActivityRow);
    // The gate itself: what each activity actually requires before the hunt menu will enable it.
    const int unlockCriteriaRows = ExportTablesByStruct<FProgressionUnlockCriteria>(
        "ProgressionUnlockCriteria", outDir + L"\\activity_unlock_criteria.jsonl", SerializeUnlockCriteriaRow);
    // Schedule tables (USchedulerComponent.ScheduleTables). The scheduled-item IDs here are the missing
    // piece for Trials: seasonal_event_schedule must mark one of these active for the Trials button to
    // enable + a trial to launch. See SerializeScheduleDataRow header.
    const int scheduleRows = ExportTablesByStruct<FScheduleData>(
        "ScheduleData", outDir + L"\\schedule_data.jsonl", SerializeScheduleDataRow);

    std::ofstream manifest(outDir + L"\\hunt_export_manifest.json", std::ios::trunc);
    if (manifest) {
        manifest << "{\n"
                 << "  \"gameVersion\": \"1.14.7\",\n"
                 << "  \"changelist\": 647472,\n"
                 << "  \"format\": \"jsonl\",\n"
                 << "  \"playerHuntRows\": " << playerRows << ",\n"
                 << "  \"matchmakerHuntRows\": " << matchmakerRows << ",\n"
                 << "  \"huntRegionRows\": " << regionRows << ",\n"
                 << "  \"escalationModeSpecRows\": " << escalationRows << ",\n"
                 << "  \"huntModifierRows\": " << modifierRows << ",\n"
                 << "  \"gameActivityRows\": " << activityRows << ",\n"
                 << "  \"unlockCriteriaRows\": " << unlockCriteriaRows << ",\n"
                 << "  \"scheduleRows\": " << scheduleRows << ",\n"
                 << "  \"notes\": \"Read-only live table export. Tag-routed query dictionaries and raw token streams are preserved. FText display fields are deliberately omitted (FText is a shared-ref to FTextData, not an FString; reading it faults). map_metadata_table is omitted: Blueprint-defined row struct with no verified layout. Do not replace backend tables until importer validation is complete.\"\n"
                 << "}\n";
    }

    Status("DONE playerRows=" + std::to_string(playerRows) +
           " matchmakerRows=" + std::to_string(matchmakerRows) +
           " regions=" + std::to_string(regionRows) +
           " escalationSpecs=" + std::to_string(escalationRows) +
           " modifiers=" + std::to_string(modifierRows) +
           " activities=" + std::to_string(activityRows) +
           " unlockCriteria=" + std::to_string(unlockCriteriaRows) +
           " schedule=" + std::to_string(scheduleRows));

    if (playerRows < 0 || matchmakerRows < 0) return -1;
    // Supporting tables are additive: a missing one is reported above but must not mask a
    // successful main export, so negatives are floored rather than propagated.
    return playerRows + matchmakerRows +
           (regionRows > 0 ? regionRows : 0) +
           (escalationRows > 0 ? escalationRows : 0) +
           (modifierRows > 0 ? modifierRows : 0) +
           (activityRows > 0 ? activityRows : 0) +
           (unlockCriteriaRows > 0 ? unlockCriteriaRows : 0) +
           (scheduleRows > 0 ? scheduleRows : 0);
}
