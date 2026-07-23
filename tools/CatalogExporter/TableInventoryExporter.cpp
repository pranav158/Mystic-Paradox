

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <algorithm>
#include <cstdint>

#include "SDK.hpp"

using namespace SDK;

namespace TableInv {

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






__declspec(noinline) static void RawName(UObject* obj, std::string* out) { *out = obj->GetName(); }
__declspec(noinline) static void RawRowCount(UDataTable* dt, int* out) { *out = dt->RowMap.Num(); }

static bool SehName(UObject* obj, std::string* out) {
    __try { RawName(obj, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static bool SehRowCount(UDataTable* dt, int* out) {
    __try { RawRowCount(dt, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

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
    OutputDebugStringA(("[TableInventory] " + s + "\n").c_str());
    std::ofstream f(ResolveOutDir() + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << "[TableInventory] " << s << "\n";
}

struct TableRecord {
    std::string name;
    std::string rowStruct;
    int rowCount = 0;
    int objectIndex = 0;
};

} 

int RunTableInventoryExport() {
    using namespace TableInv;

    const std::wstring outDir = ResolveOutDir();
    Status("starting read-only DataTable census");

    if (!UObject::GObjects) {
        Status("GObjects unavailable; aborting");
        return -1;
    }

    UClass* dtClass = UDataTable::StaticClass();
    if (!dtClass) {
        Status("UDataTable::StaticClass() unavailable; aborting");
        return -1;
    }

    std::vector<TableRecord> records;
    int skipped = 0;

    const int count = UObject::GObjects->Num();
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj || !obj->Class || !obj->IsA(dtClass)) continue;

        UDataTable* dt = static_cast<UDataTable*>(obj);

        TableRecord rec;
        rec.objectIndex = i;
        if (!SehName(obj, &rec.name)) { ++skipped; continue; }
        if (!SehRowCount(dt, &rec.rowCount)) { ++skipped; continue; }

        
        if (rec.rowCount < 0 || rec.rowCount > 200000) {
            Status("implausible RowMap.Num()=" + std::to_string(rec.rowCount) + " on " + rec.name + "; skipping");
            ++skipped;
            continue;
        }

        
        
        if (dt->RowStruct) SehName(dt->RowStruct, &rec.rowStruct);

        records.push_back(rec);
    }

    std::sort(records.begin(), records.end(), [](const TableRecord& a, const TableRecord& b) {
        return a.name < b.name;
    });

    std::ofstream f(outDir + L"\\table_inventory_1_12.jsonl", std::ios::trunc);
    if (!f) {
        Status("cannot open table_inventory_1_12.jsonl");
        return -1;
    }

    for (const TableRecord& rec : records) {
        f << "{"
          << "\"name\":" << Q(rec.name)
          << ",\"rowStruct\":" << Q(rec.rowStruct)
          << ",\"rowCount\":" << rec.rowCount
          << ",\"objectIndex\":" << rec.objectIndex
          << "}\n";
    }
    f.close();

    
    
    std::ofstream idx(outDir + L"\\table_inventory_1_12.txt", std::ios::trunc);
    if (idx) {
        idx << "# Loaded UDataTables in the 1.12 client (read-only census)\n";
        idx << "# name | rowStruct | rowCount\n";
        for (const TableRecord& rec : records) {
            idx << rec.name << " | " << (rec.rowStruct.empty() ? "<null>" : rec.rowStruct)
                << " | " << rec.rowCount << "\n";
        }
    }

    Status("DONE tables=" + std::to_string(records.size()) + " skipped=" + std::to_string(skipped));
    return static_cast<int>(records.size());
}