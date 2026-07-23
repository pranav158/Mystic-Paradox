

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <algorithm>

#include "SDK.hpp"

using namespace SDK;

namespace SlayersPathExp {

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
static std::string FNm(const FName& n) { try { return n.ToString(); } catch (...) { return std::string(); } }













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
    OutputDebugStringA(("[SlayersPathExporter] " + s + "\n").c_str());
    std::wstring dir = ResolveOutDir();
    std::ofstream f(dir + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << "[SlayersPath] " << s << "\n";
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





static std::string SerializeCurrencyCosts(const TArray<struct FArchonCurrencyCost>& costs) {
    std::string o = "[";
    for (int i = 0; i < costs.Num(); ++i) {
        const FArchonCurrencyCost& c = costs[i];
        if (i) o += ",";
        o += "{\"currency\":" + Q(FNm(c.Currency.RowName));
        o += ",\"amount\":" + std::to_string(c.Amount) + "}";
    }
    o += "]";
    return o;
}


static std::string SerializeExperienceCosts(const TArray<struct FExperienceCost>& costs) {
    std::string o = "[";
    for (int i = 0; i < costs.Num(); ++i) {
        const FExperienceCost& c = costs[i];
        if (i) o += ",";
        o += "{\"experienceType\":" + std::to_string(static_cast<int>(c.ExperienceType));
        o += ",\"amount\":" + std::to_string(c.Amount) + "}";
    }
    o += "]";
    return o;
}


static std::string SerializeRewards(const TArray<struct FGameplayReward>& rewards) {
    std::string o = "[";
    for (int i = 0; i < rewards.Num(); ++i) {
        const FGameplayReward& r = rewards[i];
        if (i) o += ",";
        o += "{\"itemId\":" + Q(FNm(r.ItemId));
        o += ",\"amount\":" + std::to_string(r.Amount);
        o += ",\"entitlementId\":" + Q(FNm(r.EntitlementId));
        o += ",\"duration\":" + std::to_string(r.Duration);
        o += ",\"passPrefix\":" + Q(FNm(r.PassPrefix));
        o += ",\"experienceType\":" + std::to_string(static_cast<int>(r.ExperienceType));
        o += ",\"autoEquip\":" + std::string(r.bAutoEquip ? "true" : "false");
        o += "}";
    }
    o += "]";
    return o;
}



static std::string SerializeChildNodes(const TArray<struct FDataTableRowHandle>& children) {
    std::string o = "[";
    for (int i = 0; i < children.Num(); ++i) {
        if (i) o += ",";
        o += Q(FNm(children[i].RowName));
    }
    o += "]";
    return o;
}

static std::string SerializeNameArray(const TArray<FName>& names) {
    std::string o = "[";
    for (int i = 0; i < names.Num(); ++i) {
        if (i) o += ",";
        o += Q(FNm(names[i]));
    }
    o += "]";
    return o;
}

static std::string SerializeNodeRow(const std::string& tableName, const std::string& rowName,
                                    const FPlayerJourneyNodeData& row) {
    std::string o = "{";
    o += "\"nodeId\":" + Q(rowName);                 
    o += ",\"table\":" + Q(tableName);

    
    o += ",\"nodeType\":" + std::to_string(static_cast<int>(row.NodeType));
    o += ",\"nodeLevel\":" + std::to_string(row.NodeLevel);

    
    o += ",\"childNodes\":" + SerializeChildNodes(row.ChildNodes);
    o += ",\"autoUnlockIfParentUnlocked\":" + std::string(row.bAutoUnlockIfParentUnlocked ? "true" : "false");

    
    o += ",\"currencyCosts\":" + SerializeCurrencyCosts(row.CurrencyCosts);
    o += ",\"experienceCosts\":" + SerializeExperienceCosts(row.ExperienceCosts);

    
    o += ",\"rewards\":" + SerializeRewards(row.Rewards);
    o += ",\"systemRewardCount\":" + std::to_string(row.SystemRewards.Num());

    
    o += ",\"activationEventId\":" + Q(FNm(row.ActivationEventId));
    o += ",\"questIds\":" + SerializeNameArray(row.QuestIds);
    o += ",\"questIdToNotifyOnUnlock\":" + Q(FNm(row.QuestIdToNotifyOnUnlock));
    o += ",\"tutorialToShowWhenUnlocked\":" + Q(FNm(row.TutorialToShowWhenUnlocked));
    o += ",\"objectiveCount\":" + std::to_string(row.Objectives.Num());

    
    o += ",\"gameplayAttributeValues\":{";
    {
        bool first = true;
        for (auto& Pair : row.GameplayAttributeValues) {
            if (!first) o += ",";
            first = false;
            o += Q(FNm(Pair.Key())) + ":" + std::to_string(Pair.Value());
        }
    }
    o += "}";

    o += "}";
    return o;
}



template <typename RowStructT, typename SerializeFn>
static int ExportByRowStruct(const std::string& expectedRowStructName, const std::wstring& outFile, SerializeFn serialize) {
    std::vector<UDataTable*> tables = FindDataTablesByRowStruct(expectedRowStructName);
    if (tables.empty()) {
        Status("no tables found with RowStruct=" + expectedRowStructName +
               " (is the Slayer's Path screen loaded? open it once, then re-run)");
        return 0;
    }

    std::ofstream f(outFile, std::ios::trunc);
    if (!f) { Status("cannot open output file for RowStruct=" + expectedRowStructName); return -1; }

    int total = 0;
    for (UDataTable* dt : tables) {
        int rowCount = 0;
        if (!RowCountIsSane(dt, rowCount)) {
            Status("RowMap.Num() unreasonable (" + std::to_string(rowCount) + ") on " + dt->GetName() + " - skipping");
            continue;
        }

        std::string tableName = dt->GetName();

        std::vector<std::string> rowNames;
        rowNames.reserve(rowCount);
        for (auto& Pair : dt->RowMap) rowNames.push_back(FNm(Pair.Key()));
        std::sort(rowNames.begin(), rowNames.end());

        int written = 0;
        for (const std::string& rowName : rowNames) {
            uint8_t* rowPtr = nullptr;
            for (auto& Pair : dt->RowMap) {
                if (FNm(Pair.Key()) == rowName) { rowPtr = Pair.Value(); break; }
            }
            if (!rowPtr) continue;

            const RowStructT& row = *reinterpret_cast<const RowStructT*>(rowPtr);
            f << serialize(tableName, rowName, row) << "\n";
            ++written;
        }
        Status("wrote " + std::to_string(written) + "/" + std::to_string(rowCount) + " nodes from " + tableName);
        total += written;
    }
    f.close();
    Status("ExportByRowStruct(" + expectedRowStructName + ") DONE total_nodes=" + std::to_string(total) +
           " across " + std::to_string(tables.size()) + " table(s)");
    return total;
}

} 

int RunSlayersPathExport() {
    using namespace SlayersPathExp;

    std::wstring outDir = ResolveOutDir();
    CreateDirectoryW((outDir + L"\\slayers_path_1_12").c_str(), nullptr);
    std::wstring sDir = outDir + L"\\slayers_path_1_12";

    int total = std::max(0, ExportByRowStruct<FPlayerJourneyNodeData>(
        "PlayerJourneyNodeData",
        sDir + L"\\player_journey_nodes.jsonl",
        SerializeNodeRow));

    Status("RunSlayersPathExport COMPLETE nodes=" + std::to_string(total));
    return total;
}