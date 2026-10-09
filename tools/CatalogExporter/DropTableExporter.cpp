/*
 * DropTableExporter - reads every loaded PlayFabDropTableTableData row (weighted loot tables).
 *
 * WHY THIS EXISTS
 * ---------------
 * catalog_1_12.jsonl's containerResultTableContents field (added for the Lady Luck's Store
 * investigation) showed CONTAINER_CORE_{BRONZE,SILVER,GOLD}_CELLCORE reference named result tables
 * (DT_CELL_CORE_00, DT_CELL_CORE_REWARDS_00, DT_BONUS_RAMS_00, DT_MERIT_CHANCE_00), repeated per name
 * to represent pick weight among the pool. None of those names are their own top-level UDataTable —
 * the EXPORT_TABLE_INVENTORY census (after opening the Core Breaker and previewing a core of each
 * tier so the relevant tables actually stream in) found `DT_Cell_Cores` instead, RowStruct
 * `PlayFabDropTableTableData`, 5 rows — the four names above are almost certainly ROW NAMES inside
 * this one table, each row itself being a further weighted roll (FPlayFabDropTableTableData.Items /
 * DropTables, each entry an FPlayFabDropTableItem{ResultItem, Weight, Amount}).
 *
 * This searches by RowStruct name, not table name, so it also picks up any OTHER loaded table that
 * shares this row struct — the Core Breaker table is the immediate need, but the schema is
 * game-generic (PlayFab-style weighted drop tables), so this is worth having as a standing export
 * rather than a one-off.
 *
 * Read-only: no ProcessEvent, no hooks, no writes into game memory. Same SEH discipline as every
 * other exporter here — a malformed/mid-load row is skipped, never allowed to fault the process.
 *
 * COVERAGE CAVEAT: LOADED tables only. If a table using this RowStruct hasn't streamed in, it is
 * invisible here — open whatever UI references it (Core Breaker, for DT_Cell_Cores) before injecting.
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

namespace DropTable {

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

__declspec(noinline) static void RawStr(const FString& s, std::string* out) { *out = s.ToString(); }
__declspec(noinline) static void RawNm(const FName& n, std::string* out) { *out = n.ToString(); }
__declspec(noinline) static void RawRowCount(UDataTable* dt, int* out) { *out = dt->RowMap.Num(); }

static bool SehStr(const FString& s, std::string* out) {
    __try { RawStr(s, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static bool SehNm(const FName& n, std::string* out) {
    __try { RawNm(n, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static bool SehRowCount(UDataTable* dt, int* out) {
    __try { RawRowCount(dt, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static std::string FStr(const FString& s) { std::string o; SehStr(s, &o); return o; }
static std::string FNm(const FName& n) { std::string o; SehNm(n, &o); return o; }

// See ExportPaths.hpp: <root>\Items_Analysis when ExportPaths.local.h names a root, else .\Items_Analysis.
static std::wstring ResolveOutDir() { return ExportOutDir(); }

static void Status(const std::string& s) {
    OutputDebugStringA(("[DropTables] " + s + "\n").c_str());
    std::ofstream f(ResolveOutDir() + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << "[DropTables] " << s << "\n";
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

static std::string SerializeDropItems(const TArray<FPlayFabDropTableItem>& items) {
    std::string o = "[";
    for (int i = 0; i < items.Num(); ++i) {
        if (i) o += ",";
        const FPlayFabDropTableItem& it = items[i];
        o += "{\"resultItem\":" + Q(FStr(it.ResultItem))
           + ",\"weight\":" + std::to_string(it.Weight)
           + ",\"amount\":" + std::to_string(it.Amount) + "}";
    }
    return o + "]";
}

// A malformed/mid-load row must not fault the process — every field read goes through this frame.
__declspec(noinline) static void RawSerializeRow(const std::string& tableName, const std::string& rowName,
                                                  const FPlayFabDropTableTableData& row, std::string* out) {
    std::string line = "{";
    line += "\"table\":" + Q(tableName);
    line += ",\"rowName\":" + Q(rowName);
    line += ",\"ignoreOwnedItems\":" + std::string(row.IgnoreOwnedItems ? "true" : "false");
    line += ",\"items\":" + SerializeDropItems(row.Items);
    line += ",\"dropTables\":" + SerializeDropItems(row.DropTables);
    line += "}";
    *out = line;
}

static bool SafeSerializeRow(const std::string& tableName, const std::string& rowName,
                              const FPlayFabDropTableTableData& row, std::string* out) {
    __try { RawSerializeRow(tableName, rowName, row, out); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

} // namespace DropTable

int RunDropTableExport() {
    using namespace DropTable;

    const std::wstring outDir = ResolveOutDir();
    Status("starting PlayFabDropTableTableData export");

    const std::vector<UDataTable*> tables = FindDataTablesByRowStruct("PlayFabDropTableTableData");
    if (tables.empty()) {
        Status("no loaded table with RowStruct=PlayFabDropTableTableData; open the Core Breaker and "
               "preview a core of each tier, then re-inject");
        return 0;
    }

    std::ofstream f(outDir + L"\\drop_tables_1_14_7.jsonl", std::ios::trunc);
    if (!f) {
        Status("cannot open drop_tables_1_14_7.jsonl");
        return -1;
    }

    int written = 0;
    for (UDataTable* table : tables) {
        int rowCount = 0;
        if (!SehRowCount(table, &rowCount) || rowCount < 0 || rowCount > 200000) {
            Status("RowMap.Num() unreasonable on a table; skipping");
            continue;
        }

        std::string tableName = table->GetName();

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

            const FPlayFabDropTableTableData& row = *reinterpret_cast<const FPlayFabDropTableTableData*>(rowPtr);
            std::string line;
            if (!SafeSerializeRow(tableName, rowName, row, &line)) {
                Status("row '" + rowName + "' faulted in " + tableName + "; skipped");
                continue;
            }
            f << line << "\n";
            ++written;
            ++tableWritten;
        }
        Status("wrote " + std::to_string(tableWritten) + "/" + std::to_string(rowCount) +
               " rows from " + tableName);
    }
    f.close();

    Status("DONE tables=" + std::to_string(tables.size()) + " rows=" + std::to_string(written));
    return written;
}
