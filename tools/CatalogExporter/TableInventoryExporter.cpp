/*
 * TableInventoryExporter - read-only census of every loaded UDataTable in the 1.12 client.
 *
 * WHY THIS EXISTS
 * ---------------
 * The other exporters target a DataTable by its RowStruct name, which requires knowing that name
 * up front. That works when the struct is findable in the SDK dump (FPlayerHuntTableData,
 * FMatchmakerHuntTableData) and fails when it isn't. Concretely: `matchmaker_hunts_table` rows
 * reference `map_metadata_table` through an FDataTableRowHandle, but no plausibly-named row struct
 * for it appears in Archon_structs.hpp, and "trials" could plausibly be backed by
 * FChallengeTableData, FGameActivityTableData, or neither. Guessing wastes an inject cycle per
 * guess.
 *
 * This pass inverts the problem: instead of asking "which table has RowStruct X", it walks GObjects
 * once and reports EVERY loaded UDataTable with its object name, full path, RowStruct name and row
 * count. That is the map you need to decide what to export next — one inject answers it for the
 * whole hunt/mission/trial/escalation graph at once.
 *
 * It deliberately does NOT serialize row contents. Row serialization needs per-struct field
 * knowledge; reading a row as the wrong type is exactly how you fault a live process. This pass
 * touches only UObject/UDataTable header fields that are type-safe regardless of RowStruct.
 *
 * Read-only: no ProcessEvent, no hooks, no writes into game memory.
 *
 * COVERAGE CAVEAT: this sees LOADED tables only. A table the client hasn't streamed in yet is
 * invisible. Reach Ramsgate and open the Hunt/Map, Trials and Escalation UIs at least once before
 * injecting, or the census will under-report.
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

// Same SEH discipline as HuntExporter: a census must skip a malformed/mid-load object rather than
// take down the game process. Every name read from live memory goes through this.
// NOTE: this generated SDK exposes GetName() but NOT GetFullName(), and does not surface an Outer
// accessor we can rely on. Rather than guess at a package-path API that may not exist, duplicate
// table names are disambiguated by their GObjects index, which is always available and type-safe.
__declspec(noinline) static void RawName(UObject* obj, std::string* out) { *out = obj->GetName(); }
__declspec(noinline) static void RawRowCount(UDataTable* dt, int* out) { *out = dt->RowMap.Num(); }

static bool SehName(UObject* obj, std::string* out) {
    __try { RawName(obj, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
static bool SehRowCount(UDataTable* dt, int* out) {
    __try { RawRowCount(dt, out); return true; } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

// See ExportPaths.hpp: <root>\Items_Analysis when ExportPaths.local.h names a root, else .\Items_Analysis.
static std::wstring ResolveOutDir() { return ExportOutDir(); }

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

} // namespace TableInv

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

        // A RowMap count outside this range means we are not looking at a sane table.
        if (rec.rowCount < 0 || rec.rowCount > 200000) {
            Status("implausible RowMap.Num()=" + std::to_string(rec.rowCount) + " on " + rec.name + "; skipping");
            ++skipped;
            continue;
        }

        // RowStruct is the field that makes this census actionable: it is the exact string another
        // exporter passes to FindDataTablesByRowStruct.
        if (dt->RowStruct) SehName(dt->RowStruct, &rec.rowStruct);

        records.push_back(rec);
    }

    std::sort(records.begin(), records.end(), [](const TableRecord& a, const TableRecord& b) {
        return a.name < b.name;
    });

    std::ofstream f(outDir + L"\\table_inventory_1_14_7.jsonl", std::ios::trunc);
    if (!f) {
        Status("cannot open table_inventory_1_14_7.jsonl");
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

    // A flat name->rowStruct index, sorted and greppable, so you can eyeball the whole landscape
    // without a JSON tool. This is the file to read first.
    std::ofstream idx(outDir + L"\\table_inventory_1_14_7.txt", std::ios::trunc);
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
