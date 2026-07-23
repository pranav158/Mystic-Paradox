

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <algorithm>
#include <cstdint>

#include "SDK.hpp"

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

static std::wstring ResolveOutDir() {
    static const wchar_t* kCandidates[] = {
        L".\\Items_Analysis",
    };
    for (const wchar_t* c : kCandidates) {
        DWORD a = GetFileAttributesW(c);
        if (a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY)) return c;
    }
    CreateDirectoryW(kCandidates[0], nullptr);
    return kCandidates[0];
}

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


static constexpr size_t kSoftObjectPathOffset = 0x10;

__declspec(noinline) static void RawSoftPath(const void* softPtr, std::string* out) {
    const uint8_t* base = reinterpret_cast<const uint8_t*>(softPtr);
    const FName* assetPathName = reinterpret_cast<const FName*>(base + kSoftObjectPathOffset);

    
    
    
    
    
    
    
    
    *out = assetPathName->GetRawString();
}



static bool SehSoftPath(const void* softPtr, std::string* out) {
    __try { RawSoftPath(softPtr, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static std::string SoftPath(const void* softPtr) {
    std::string o;
    if (!SehSoftPath(softPtr, &o)) o.clear();
    
    
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



static std::string SerializeHuntRegionRow(const std::string& sourceTable, const std::string& rowName,
                                          const FHunt_Region& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);
    
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
    
    
    return o + "}";
}

static std::string SerializeHuntModifierRow(const std::string& sourceTable, const std::string& rowName,
                                            const FHuntModifierTableRow& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);
    
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


static std::string SerializeUnlockCriteriaRow(const std::string& sourceTable, const std::string& rowName,
                                              const FProgressionUnlockCriteria& row) {
    std::string o = "{";
    o += "\"sourceTable\":" + Q(sourceTable);
    o += ",\"rowName\":" + Q(rowName);

    
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

} 

int RunHuntExport() {
    using namespace HuntExp;

    const std::wstring root = ResolveOutDir();
    const std::wstring outDir = root + L"\\hunts_1_12";
    CreateDirectoryW(outDir.c_str(), nullptr);

    Status("starting read-only 1.12 hunt export");
    const int playerRows = ExportTablesByStruct<FPlayerHuntTableData>(
        "PlayerHuntTableData", outDir + L"\\player_hunts.jsonl", SerializePlayerHuntRow);
    const int matchmakerRows = ExportTablesByStruct<FMatchmakerHuntTableData>(
        "MatchmakerHuntTableData", outDir + L"\\matchmaker_hunts.jsonl", SerializeMatchmakerHuntRow);

    
    
    const int regionRows = ExportTablesByStruct<FHunt_Region>(
        "Hunt_Region", outDir + L"\\hunt_regions.jsonl", SerializeHuntRegionRow);
    const int escalationRows = ExportTablesByStruct<FEscalationModeSpecification>(
        "EscalationModeSpecification", outDir + L"\\escalation_mode_specs.jsonl", SerializeEscalationModeSpecRow);
    const int modifierRows = ExportTablesByStruct<FHuntModifierTableRow>(
        "HuntModifierTableRow", outDir + L"\\hunt_modifiers.jsonl", SerializeHuntModifierRow);
    const int activityRows = ExportTablesByStruct<FGameActivityTableData>(
        "GameActivityTableData", outDir + L"\\game_activities.jsonl", SerializeGameActivityRow);
    
    const int unlockCriteriaRows = ExportTablesByStruct<FProgressionUnlockCriteria>(
        "ProgressionUnlockCriteria", outDir + L"\\activity_unlock_criteria.jsonl", SerializeUnlockCriteriaRow);
    
    
    
    const int scheduleRows = ExportTablesByStruct<FScheduleData>(
        "ScheduleData", outDir + L"\\schedule_data.jsonl", SerializeScheduleDataRow);

    std::ofstream manifest(outDir + L"\\hunt_export_manifest.json", std::ios::trunc);
    if (manifest) {
        manifest << "{\n"
                 << "  \"gameVersion\": \"1.12.0\",\n"
                 << "  \"changelist\": 392819,\n"
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
    
    
    return playerRows + matchmakerRows +
           (regionRows > 0 ? regionRows : 0) +
           (escalationRows > 0 ? escalationRows : 0) +
           (modifierRows > 0 ? modifierRows : 0) +
           (activityRows > 0 ? activityRows : 0) +
           (unlockCriteriaRows > 0 ? unlockCriteriaRows : 0) +
           (scheduleRows > 0 ? scheduleRows : 0);
}