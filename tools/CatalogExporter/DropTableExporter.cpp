

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <algorithm>
#include <cstdint>

#include "SDK.hpp"

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

} 

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

    std::ofstream f(outDir + L"\\drop_tables_1_12.jsonl", std::ios::trunc);
    if (!f) {
        Status("cannot open drop_tables_1_12.jsonl");
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