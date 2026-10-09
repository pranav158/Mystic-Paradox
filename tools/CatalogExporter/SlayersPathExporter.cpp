/*
 * SlayersPathExporter — dumps the full Slayer's Path (Player Journey Map) node definition table
 * for Dauntless 1.12.0 (CL 392819, UE 4.26.2).
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend serves `src/data/slayers_path.json`, which is a FLAT graph:
 *     { node_id, node_status: 0, objectives: [] }   x317
 * It carries NO costs, NO rewards, NO prerequisites. That is why the metagame cannot implement an
 * atomic unlock (validate -> deduct -> persist -> grant): it has no idea that a node costs
 * 100 CURRENCY_PJM_WEAPON + 7500 CURRENCY_NOTES, or that it grants PART_GA_SPECIAL_SKILLSHOT.
 * The client has all of it locally (it renders exact costs and effect text), so we export it.
 *
 * WHAT IT EXPORTS
 * ---------------
 * Everything lives in ONE reflected DataTable row struct — Archon.PlayerJourneyNodeData:
 *     ChildNodes                  0x00B0  TArray<FDataTableRowHandle>   -> graph edges (parent -> children)
 *     CurrencyCosts               0x0130  TArray<FArchonCurrencyCost>   -> THE CONSUME (merit / Rams)
 *     Objectives                  0x0140  TArray<FTrackedObjectiveData>
 *     ExperienceCosts             0x0150  TArray<FExperienceCost>
 *     Rewards                     0x0200  TArray<FGameplayReward>       -> THE GRANTS (ItemId + Amount)
 *     SystemRewards               0x0210
 *     QuestIds                    0x0220
 *     bAutoUnlockIfParentUnlocked 0x0238
 * The DataTable ROW NAME is the node_id, and it matches the node_ids already in slayers_path.json
 * (e.g. "Aetherdrive_Tonic"), so the export joins to the existing graph on row name.
 *
 * Found by ROW STRUCT match across every loaded DataTable (not by table name) — same approach as
 * CombatExporter, so it still finds the table regardless of its asset name.
 *
 * OUTPUT
 * ------
 *   <OutDir>\slayers_path_1_12\player_journey_nodes.jsonl   (one JSON object per node)
 *
 * FLAG
 * ----
 *   EXPORT_SLAYERS_PATH=1   in export_flags.txt  (see ExportFlags.md)
 */

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <algorithm>

#include "SDK.hpp"
#include "ExportPaths.hpp"

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

// NOTE — no FText/FString accessors here, deliberately.
//
// v1 of this exporter emitted DisplayName/Description/UnlockDescription/RewardName by calling
// FText::ToString(). That CRASHED the game with EXCEPTION_ACCESS_VIOLATION inside
// UC::FString::ToString(): FText is NOT an FString — it's a shared-ref to FTextData, so treating
// it as a string dereferences garbage. A try/catch does not save you either: an access violation
// is an SEH exception and plain `catch (...)` never sees it (that needs /EHa).
//
// Those fields were documentation-only. Everything load-bearing (node ids, currency ids, item ids)
// is FName, and every numeric/bool is POD — both are safe to read directly. Human-readable names
// for granted items are already available from EXPORT_CATALOG's general dump, joined on itemId.

// See ExportPaths.hpp: <root>\Items_Analysis when ExportPaths.local.h names a root, else .\Items_Analysis.
static std::wstring ResolveOutDir() { return ExportOutDir(); }

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

// --- serializers -----------------------------------------------------------------------------

// FArchonCurrencyCost { FDataTableRowHandle Currency; int32 Amount; }
// Currency.RowName is the currency catalog id (CURRENCY_PJM_WEAPON, CURRENCY_NOTES, ...).
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

// FExperienceCost { EExperienceType ExperienceType; int32 Amount; }
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

// FGameplayReward — ItemId is the granted catalog item (e.g. PART_GA_SPECIAL_SKILLSHOT).
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

// ChildNodes are FDataTableRowHandle — RowName is the child node_id. The graph is stored
// parent -> children; the backend can invert this to get each node's prerequisite.
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
    o += "\"nodeId\":" + Q(rowName);                 // row name == node_id in slayers_path.json
    o += ",\"table\":" + Q(tableName);

    // (DisplayName/Description/UnlockDescription intentionally omitted — see the FText note above.)
    o += ",\"nodeType\":" + std::to_string(static_cast<int>(row.NodeType));
    o += ",\"nodeLevel\":" + std::to_string(row.NodeLevel);

    // graph
    o += ",\"childNodes\":" + SerializeChildNodes(row.ChildNodes);
    o += ",\"autoUnlockIfParentUnlocked\":" + std::string(row.bAutoUnlockIfParentUnlocked ? "true" : "false");

    // CONSUME
    o += ",\"currencyCosts\":" + SerializeCurrencyCosts(row.CurrencyCosts);
    o += ",\"experienceCosts\":" + SerializeExperienceCosts(row.ExperienceCosts);

    // GRANTS
    o += ",\"rewards\":" + SerializeRewards(row.Rewards);
    o += ",\"systemRewardCount\":" + std::to_string(row.SystemRewards.Num());

    // side effects / linkage
    o += ",\"activationEventId\":" + Q(FNm(row.ActivationEventId));
    o += ",\"questIds\":" + SerializeNameArray(row.QuestIds);
    o += ",\"questIdToNotifyOnUnlock\":" + Q(FNm(row.QuestIdToNotifyOnUnlock));
    o += ",\"tutorialToShowWhenUnlocked\":" + Q(FNm(row.TutorialToShowWhenUnlocked));
    o += ",\"objectiveCount\":" + std::to_string(row.Objectives.Num());

    // gameplay attribute deltas granted by the node (TMap<FName,float>)
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

// --- export driver ---------------------------------------------------------------------------

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

} // namespace SlayersPathExp

int RunSlayersPathExport() {
    using namespace SlayersPathExp;

    std::wstring outDir = ResolveOutDir();
    CreateDirectoryW((outDir + L"\\slayers_path_1_14_7").c_str(), nullptr);
    std::wstring sDir = outDir + L"\\slayers_path_1_14_7";

    int total = std::max(0, ExportByRowStruct<FPlayerJourneyNodeData>(
        "PlayerJourneyNodeData",
        sDir + L"\\player_journey_nodes.jsonl",
        SerializeNodeRow));

    Status("RunSlayersPathExport COMPLETE nodes=" + std::to_string(total));
    return total;
}
