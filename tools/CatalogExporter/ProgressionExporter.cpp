

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <cstdint>
#include <set>
#include <algorithm>

#include "SDK.hpp"

using namespace SDK;



namespace ProgExp {

static std::string JsonEsc(const std::string& s) {
    std::string o; o.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c & 0xFF); o += b; }
                else o += c;
        }
    }
    return o;
}

static std::string Q(const std::string& s) { return "\"" + JsonEsc(s) + "\""; }











__declspec(noinline) static void RawFStr(const FString& s, std::string* out) { if (s.Num() > 0 && s.IsValid()) *out = s.ToString(); }
__declspec(noinline) static void RawFTxt(const FText&  t, std::string* out) { *out = t.ToString(); }
__declspec(noinline) static void RawFNm (const FName&  n, std::string* out) { *out = n.ToString(); }

static bool SehStr(const FString& s, std::string* out) { __try { RawFStr(s, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; } }
static bool SehTxt(const FText&  t, std::string* out) { __try { RawFTxt(t, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; } }
static bool SehNm (const FName&  n, std::string* out) { __try { RawFNm (n, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; } }

static std::string FStr(const FString& s) { std::string o; if (!SehStr(s, &o)) return std::string(); return o; }
static std::string FTxt(const FText& t)   { std::string o; if (!SehTxt(t, &o)) return std::string(); return o; }
static std::string FNm (const FName& n)   { std::string o; if (!SehNm (n, &o)) return std::string(); return o; }

static void Status(const std::string& s);  
                                            

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
    OutputDebugStringA(("[ProgressionExporter] " + s + "\n").c_str());
    std::wstring dir = ResolveOutDir();
    std::ofstream f(dir + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << "[Progression] " << s << "\n";
}





static UDataTable* FindDataTableByName(const std::string& exactName) {
    if (!UObject::GObjects) return nullptr;
    UClass* dtClass = UDataTable::StaticClass();
    if (!dtClass) return nullptr;

    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || !obj->Class) continue;
        if (!obj->IsA(dtClass)) continue;
        if (obj->GetName() == exactName) return static_cast<UDataTable*>(obj);
    }
    return nullptr;
}




static std::vector<UDataTable*> FindDataTablesByRowStruct(const std::string& expectedRowStructName) {
    std::vector<UDataTable*> out;
    if (!UObject::GObjects) return out;
    UClass* dtClass = UDataTable::StaticClass();
    if (!dtClass) return out;

    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || !obj->Class) continue;
        if (!obj->IsA(dtClass)) continue;

        UDataTable* dt = static_cast<UDataTable*>(obj);
        if (!dt->RowStruct) continue;
        if (dt->RowStruct->GetName() != expectedRowStructName) continue;

        out.push_back(dt);
    }
    return out;
}




static bool RowCountIsSane(UDataTable* dt, int& outCount) {
    outCount = dt->RowMap.Num();
    return outCount >= 0 && outCount < 200000;
}



static std::string SerializeGameplayTagContainer(const FGameplayTagContainer& tags) {
    
    
    
    
    
    (void)tags;
    return "[]";
}

static std::string SerializeOnlineProgressionTrackReward(const FOnlineProgressionTrackReward& r) {
    std::string o = "{";
    o += "\"rankId\":" + std::to_string(r.RankId);
    o += ",\"customRewardString\":" + Q(FTxt(r.CustomRewardString));

    
    
    o += ",\"stackedItems\":[";
    for (int i = 0; i < r.StackedItems.Num(); ++i) {
        if (i) o += ",";
        const FOnlineProgressionTrackStackedItemReward& s = r.StackedItems[i];
        o += "{\"catalogId\":" + Q(FStr(s.CatalogId)) +
             ",\"quantity\":" + std::to_string(s.Quantity) +
             ",\"priority\":" + std::to_string(s.Priority) + "}";
    }
    o += "]";

    
    o += ",\"instancedItems\":[";
    for (int i = 0; i < r.InstancedItems.Num(); ++i) {
        if (i) o += ",";
        o += Q(FStr(r.InstancedItems[i]));
    }
    o += "]";

    
    
    o += ",\"orderedInstancedItems\":[";
    for (int i = 0; i < r.OrderedInstancedItems.Num(); ++i) {
        if (i) o += ",";
        const FOnlineProgressionTrackOrderedInstancedItemReward& oi = r.OrderedInstancedItems[i];
        o += "{\"catalogId\":" + Q(FStr(oi.CatalogId)) +
             ",\"priority\":" + std::to_string(oi.Priority) + "}";
    }
    o += "]";

    
    
    o += ",\"entitlements\":[";
    for (int i = 0; i < r.Entitlements.Num(); ++i) {
        if (i) o += ",";
        const FOnlineProgressionTrackEntitlementReward& e = r.Entitlements[i];
        o += "{\"entitlementId\":" + Q(FStr(e.EntitlementId)) +
             ",\"duration\":" + std::to_string(e.Duration) + "}";
    }
    o += "]";

    
    
    
    o += ",\"buffCount\":" + std::to_string(r.Buffs.Num());
    o += "}";
    return o;
}

static std::string SerializeRewardArray(const TArray<FOnlineProgressionTrackReward>& arr) {
    std::string o = "[";
    for (int i = 0; i < arr.Num(); ++i) {
        if (i) o += ",";
        o += SerializeOnlineProgressionTrackReward(arr[i]);
    }
    o += "]";
    return o;
}




static std::string WriteOnlineProgressionTrackBaseFields(const FOnlineProgressionTrackTableData& row) {
    std::string o = "{";
    o += "\"progressionTrack\":" + Q(FStr(row.ProgressionTrack));
    o += ",\"premiumGatingEntitlement\":" + Q(FStr(row.PremiumGatingEntitlement));
    o += ",\"resetWithCharacter\":" + std::string(row.ResetWithCharacter ? "true" : "false");
    o += ",\"progressionMultiplier\":" + std::to_string(row.ProgressionMultiplier);
    o += ",\"requirementCount\":" + std::to_string(row.Requirements.Num());
    
    
    
    
    
    o += ",\"requirements\":[";
    for (int i = 0; i < row.Requirements.Num(); ++i) {
        if (i) o += ",";
        o += "{\"rankId\":" + std::to_string(row.Requirements[i].RankId) +
             ",\"requiredXP\":" + std::to_string(row.Requirements[i].RequiredXP) + "}";
    }
    o += "]";
    o += ",\"freeRewards\":" + SerializeRewardArray(row.FreeRewards);
    o += ",\"premiumRewards\":" + SerializeRewardArray(row.PremiumRewards);
    o += "}";
    return o;
}


static std::string SerializeExperienceTrackRow(const std::string& rowName, const FExperienceTrackTableData& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"base\":" + WriteOnlineProgressionTrackBaseFields(row);
    o += ",\"prestigeTrack\":" + Q(FNm(row.PrestigeTrack.RowName));
    o += ",\"expDisplayShortName\":" + Q(FTxt(row.ExperienceTypeDisplayData.ShortDisplayName));
    o += ",\"expDisplayName\":" + Q(FTxt(row.ExperienceTypeDisplayData.DisplayName));
    o += ",\"expDisplayDescription\":" + Q(FTxt(row.ExperienceTypeDisplayData.Description));
    o += ",\"experienceBankingLevelCount\":" + std::to_string(row.ExperienceBankingDataPerLevel.Num());
    o += "}";
    return o;
}


static std::string SerializeExperienceAwardRow(const std::string& rowName, const FExperienceTableData& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"experienceType\":" + std::to_string(static_cast<int>(row.ExperienceType));
    o += ",\"amount\":" + std::to_string(row.Amount);
    o += ",\"objectiveCount\":" + std::to_string(row.Objectives.Num());
    o += "}";
    return o;
}


static std::string SerializeProgressionTrackRow(const std::string& rowName, const FProgressionTrackTableData& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"displayName\":" + Q(FTxt(row.DisplayName));
    o += ",\"currentVersion\":" + std::to_string(row.CurrentVersion);
    o += ",\"repeats\":" + std::string(row.Repeats ? "true" : "false");
    o += ",\"isPrestigeTrack\":" + std::string(row.IsPrestigeTrack ? "true" : "false");
    o += ",\"isCoreTrack\":" + std::string(row.IsCoreTrack ? "true" : "false");
    o += ",\"visibleInUI\":" + std::string(row.VisibleInUI ? "true" : "false");
    o += ",\"prestigeTrack\":" + Q(FNm(row.PrestigeTrack));
    o += ",\"rankTable\":" + Q(row.RankTable ? row.RankTable->GetName() : std::string());
    o += ",\"unlockConditionCount\":" + std::to_string(row.UnlockConditions.Num());
    o += ",\"challengeSlotCount\":" + std::to_string(row.ChallengeSlots.Num());
    o += ",\"craftItemRewardAmount\":" + std::to_string(row.CraftItemRewardAmount);
    o += ",\"upgradeItemRewardAmount\":" + std::to_string(row.UpgradeItemRewardAmount);
    o += "}";
    return o;
}


static std::string SerializeMasteryTrackRow(const std::string& rowName, const FMasteryTrackTableData& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"base\":" + WriteOnlineProgressionTrackBaseFields(row);
    o += ",\"displayName\":" + Q(FTxt(row.DisplayName));
    o += ",\"shortDisplayName\":" + Q(FTxt(row.ShortDisplayName));
    o += ",\"isUIEnabled\":" + std::string(row.bIsUIEnabled ? "true" : "false");
    o += ",\"category\":" + std::to_string(static_cast<int>(row.Categtory));
    o += "}";
    return o;
}






static std::string SerializeOnlineProgressionTrackInfoRow(const std::string& rowName, const FOnlineProgressionTrackInfo& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"displayName\":" + Q(FTxt(row.DisplayName));
    o += ",\"progressDisplaySingular\":" + Q(FTxt(row.ProgressDisplaySingular));
    o += ",\"progressDisplayPlural\":" + Q(FTxt(row.ProgressDisplayPlural));
    o += ",\"progressDescription\":" + Q(FTxt(row.ProgressDescription));
    o += "}";
    return o;
}








static std::string SerializeHuntPassSeasonRow(const std::string& rowName, const FHuntPassSeasonDataTable& row) {
    std::string o = "{";
    o += "\"rowName\":" + Q(rowName);
    o += ",\"base\":" + WriteOnlineProgressionTrackBaseFields(row);
    o += ",\"mustClaimRewards\":" + std::string(row.bMustClaimRewards ? "true" : "false");
    o += ",\"seasonTitle\":" + Q(FTxt(row.SeasonTitle));
    o += ",\"seasonDescription\":" + Q(FTxt(row.SeasonDescription));
    o += ",\"seasonDate\":" + Q(FTxt(row.SeasonDate));
    o += ",\"huntRewardItemId\":" + Q(FStr(row.HuntRewardItemId));
    o += ",\"huntRewardItemAmount\":" + std::to_string(row.HuntRewardItemAmount);
    o += ",\"nextProgressionTrack\":" + Q(FStr(row.NextProgressionTrack));
    o += ",\"previewsProgressionTrack\":" + Q(FStr(row.PreviewsProgressionTrack));
    o += ",\"buyLevelsUsingRank\":" + std::string(row.bBuyLevelsUsingRank ? "true" : "false");
    o += ",\"giveSeasonalCurrencies\":" + std::string(row.bGiveSeasonalCurrencies ? "true" : "false");
    o += ",\"overallSeasonName\":" + Q(FTxt(row.OverallSeasonName));
    o += "}";
    return o;
}






template <typename RowT, typename Fn>
__declspec(noinline) static void RawSerializeRow(Fn fn, const std::string& rowName, const RowT& row, std::string* out) { *out = fn(rowName, row); }

template <typename RowT, typename Fn>
static bool SafeSerializeRow(Fn fn, const std::string& rowName, const RowT& row, std::string* out) {
    __try { RawSerializeRow<RowT>(fn, rowName, row, out); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}




template <typename RowStructT, typename SerializeFn>
static int ExportTable(UDataTable* dt, const std::string& expectedRowStructName,
                        const std::wstring& outFile, SerializeFn serialize) {
    if (!dt) { Status("table not found, skipping"); return -1; }
    if (!dt->RowStruct) { Status("RowStruct is null, skipping " + dt->GetName()); return -1; }

    std::string actualStructName = dt->RowStruct->GetName();
    if (actualStructName != expectedRowStructName) {
        Status("RowStruct mismatch on " + dt->GetName() + ": expected " + expectedRowStructName +
                " got " + actualStructName + " - skipping (never guessing a wrong cast)");
        return -1;
    }

    int rowCount = 0;
    if (!RowCountIsSane(dt, rowCount)) {
        Status("RowMap.Num() unreasonable (" + std::to_string(rowCount) + ") on " + dt->GetName() + " - skipping");
        return -1;
    }

    std::ofstream f(outFile, std::ios::trunc);
    if (!f) { Status("cannot open output file for " + dt->GetName()); return -1; }

    
    std::vector<std::string> rowNames;
    rowNames.reserve(rowCount);
    for (auto& Pair : dt->RowMap) {
        rowNames.push_back(FNm(Pair.Key()));
    }
    std::sort(rowNames.begin(), rowNames.end());

    int written = 0;
    for (const std::string& rowName : rowNames) {
        uint8_t* rowPtr = nullptr;
        for (auto& Pair : dt->RowMap) {
            if (FNm(Pair.Key()) == rowName) { rowPtr = Pair.Value(); break; }
        }
        if (!rowPtr) continue;

        const RowStructT& row = *reinterpret_cast<const RowStructT*>(rowPtr);
        std::string line;
        if (!SafeSerializeRow<RowStructT>(serialize, rowName, row, &line)) {
            Status("row '" + rowName + "' faulted during serialize on " + dt->GetName() + " - skipped (SEH-guarded)");
            continue;
        }
        f << line << "\n";
        ++written;
    }
    f.close();
    Status("wrote " + std::to_string(written) + "/" + std::to_string(rowCount) + " rows from " +
            dt->GetName() + " (RowStruct=" + actualStructName + ")");
    return written;
}








static int ExportAwardTables(const std::wstring& outFile) {
    std::vector<UDataTable*> tables = FindDataTablesByRowStruct("ExperienceTableData");

    if (tables.empty() && UObject::GObjects) {
        UClass* pecClass = UPlayerExperienceComponent::StaticClass();
        if (pecClass) {
            const int count = UObject::GObjects->Num();
            for (int i = 0; i < count; ++i) {
                UObject* obj = UObject::GObjects->GetByIndex(i);
                if (!obj || !obj->Class) continue;
                if (!obj->IsA(pecClass)) continue;
                UPlayerExperienceComponent* pec = static_cast<UPlayerExperienceComponent*>(obj);
                
                
                
                UDataTable* et = reinterpret_cast<UDataTable*>(pec->ExperienceTable);
                if (et && et->RowStruct && et->RowStruct->GetName() == "ExperienceTableData") {
                    tables.push_back(et);
                    Status("experience awards: using UPlayerExperienceComponent::ExperienceTable composite fallback (" + et->GetName() + ")");
                    break;
                }
            }
        }
    }

    if (tables.empty()) {
        Status("experience awards: no ExperienceTableData tables found (struct walk + component fallback) - skipping");
        return 0;
    }

    std::ofstream f(outFile, std::ios::trunc);
    if (!f) { Status("experience awards: cannot open output file"); return 0; }

    int written = 0;
    for (UDataTable* dt : tables) {
        int rowCount = 0;
        if (!RowCountIsSane(dt, rowCount)) {
            Status("experience awards: RowMap.Num() unreasonable (" + std::to_string(rowCount) + ") on " + dt->GetName() + " - skipping this table");
            continue;
        }
        const std::string tableName = dt->GetName();

        std::vector<std::string> rowNames;
        rowNames.reserve(rowCount);
        for (auto& Pair : dt->RowMap) rowNames.push_back(FNm(Pair.Key()));
        std::sort(rowNames.begin(), rowNames.end());

        for (const std::string& rn : rowNames) {
            uint8_t* rowPtr = nullptr;
            for (auto& Pair : dt->RowMap) {
                if (FNm(Pair.Key()) == rn) { rowPtr = Pair.Value(); break; }
            }
            if (!rowPtr) continue;

            const FExperienceTableData& row = *reinterpret_cast<const FExperienceTableData*>(rowPtr);
            std::string line;
            if (!SafeSerializeRow<FExperienceTableData>(SerializeExperienceAwardRow, rn, row, &line)) {
                Status("experience awards: row '" + rn + "' faulted during serialize on " + tableName + " - skipped (SEH-guarded)");
                continue;
            }
            
            if (!line.empty() && line.back() == '}') {
                line.pop_back();
                line += ",\"table\":" + Q(tableName) + "}";
            }
            f << line << "\n";
            ++written;
        }
    }
    f.close();
    Status("experience awards: wrote " + std::to_string(written) + " rows from " + std::to_string(tables.size()) + " table(s) by row struct");
    return written;
}




int RunProgressionExport() {
    std::wstring outDir = ResolveOutDir();
    CreateDirectoryW((outDir + L"\\progression_1_12").c_str(), nullptr);
    std::wstring pDir = outDir + L"\\progression_1_12";

    int total = 0;

    
    total += std::max(0, ExportTable<FExperienceTrackTableData>(
        FindDataTableByName("player_experience_track_table"),
        "ExperienceTrackTableData",
        pDir + L"\\player-experience-tracks.jsonl",
        SerializeExperienceTrackRow));

    
    total += std::max(0, ExportTable<FExperienceTrackTableData>(
        FindDataTableByName("weapon_experience_track_table"),
        "ExperienceTrackTableData",
        pDir + L"\\weapon-experience-tracks.jsonl",
        SerializeExperienceTrackRow));

    
    
    
    total += std::max(0, ExportTable<FExperienceTrackTableData>(
        FindDataTableByName("experience_track_table"),
        "ExperienceTrackTableData",
        pDir + L"\\experience-tracks.jsonl",
        SerializeExperienceTrackRow));

    
    
    
    total += std::max(0, ExportTable<FHuntPassSeasonDataTable>(
        FindDataTableByName("hunt_pass_season_table"),
        "HuntPassSeasonDataTable",
        pDir + L"\\huntpass-season-table.jsonl",
        SerializeHuntPassSeasonRow));

    
    
    
    total += std::max(0, ExportAwardTables(pDir + L"\\experience-awards.jsonl"));

    
    total += std::max(0, ExportTable<FProgressionTrackTableData>(
        FindDataTableByName("progression_track_table"),
        "ProgressionTrackTableData",
        pDir + L"\\progression-tracks.jsonl",
        SerializeProgressionTrackRow));

    
    
    
    total += std::max(0, ExportTable<FOnlineProgressionTrackInfo>(
        FindDataTableByName("online_progression_track_info_table"),
        "OnlineProgressionTrackInfo",
        pDir + L"\\online-track-info.jsonl",
        SerializeOnlineProgressionTrackInfoRow));

    
    total += std::max(0, ExportTable<FMasteryTrackTableData>(
        FindDataTableByName("mastery_track_table"),
        "MasteryTrackTableData",
        pDir + L"\\mastery-tracks.jsonl",
        SerializeMasteryTrackRow));

    Status("RunProgressionExport DONE total_rows=" + std::to_string(total));
    return total;
}

} 

int RunProgressionExport() { return ProgExp::RunProgressionExport(); }