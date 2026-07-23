

#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <algorithm>

#include "SDK.hpp"

using namespace SDK;

namespace CombatExp {

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
    OutputDebugStringA(("[CombatExporter] " + s + "\n").c_str());
    std::wstring dir = ResolveOutDir();
    std::ofstream f(dir + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << "[Combat] " << s << "\n";
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

static std::string SerializeDamageRow(const std::string& tableName, const std::string& rowName, const FDamageTableData& row) {
    std::string o = "{";
    o += "\"table\":" + Q(tableName);
    o += ",\"rowName\":" + Q(rowName);
    o += ",\"baseDamage\":" + std::to_string(row.BaseDamage);
    o += ",\"physicalTypeOverride\":" + std::to_string(static_cast<int>(row.PhysicalTypeOverride));
    o += ",\"explicitPartBreak\":" + std::to_string(row.ExplicitPartBreak);
    o += ",\"explicitStagger\":" + std::to_string(row.ExplicitStagger);
    o += ",\"explicitExpose\":" + std::to_string(row.ExplicitExpose);
    o += ",\"damageTrue\":" + std::to_string(row.DamageTrue);
    o += ",\"physicalDamage\":" + std::to_string(row.PhysicalDamage);
    o += ",\"flameDamage\":" + std::to_string(row.FlameDamage);
    o += ",\"frostDamage\":" + std::to_string(row.FrostDamage);
    o += ",\"shockDamage\":" + std::to_string(row.ShockDamage);
    o += ",\"radiantDamage\":" + std::to_string(row.RadiantDamage);
    o += ",\"umbralDamage\":" + std::to_string(row.UmbralDamage);
    o += ",\"terraDamage\":" + std::to_string(row.TerraDamage);
    o += ",\"rawElementalDamage\":" + std::to_string(row.RawElementalDamage);
    o += ",\"elementalHealthDamageMod\":" + std::to_string(row.ElementalHealthDamageMod);
    o += ",\"meter\":" + std::to_string(row.Meter);
    o += ",\"assetTagCount\":" + std::to_string(row.AssetTags.Num());
    o += "}";
    return o;
}

static std::string SerializeWeaponPowerRow(const std::string& tableName, const std::string& rowName, const FWeaponPowerTableData& row) {
    std::string o = "{";
    o += "\"table\":" + Q(tableName);
    o += ",\"rowName\":" + Q(rowName);
    o += ",\"globalPower\":" + std::to_string(row.GlobalPower);
    o += ",\"globalPowerPerLevel\":" + std::to_string(row.GlobalPowerPerLevel);
    o += ",\"physicalType\":" + std::to_string(static_cast<int>(row.PhysicalType));
    o += ",\"elementalType\":" + std::to_string(static_cast<int>(row.ElementalType));
    o += ",\"elementalPower\":" + std::to_string(row.ElementalPower);
    o += ",\"elementalPowerPerLevel\":" + std::to_string(row.ElementalPowerPerLevel);
    o += ",\"flamePower\":" + std::to_string(row.FlamePower);
    o += ",\"frostPower\":" + std::to_string(row.FrostPower);
    o += ",\"shockPower\":" + std::to_string(row.ShockPower);
    o += ",\"radiantPower\":" + std::to_string(row.RadiantPower);
    o += ",\"umbralPower\":" + std::to_string(row.UmbralPower);
    o += ",\"terraPower\":" + std::to_string(row.TerraPower);
    o += ",\"rawElementalPower\":" + std::to_string(row.RawElementalPower);
    o += ",\"staminaCostScale\":" + std::to_string(row.StaminaCostScale);
    o += ",\"staminaRegenScale\":" + std::to_string(row.StaminaRegenScale);
    o += ",\"freezeAmountPerHit\":" + std::to_string(row.FreezeAmountPerHit);
    o += ",\"tagCount\":" + std::to_string(row.Tags.Num());
    o += ",\"refAbilityCount\":" + std::to_string(row.RefAbilities.Num());
    o += "}";
    return o;
}





template <typename RowStructT, typename SerializeFn>
static int ExportByRowStruct(const std::string& expectedRowStructName, const std::wstring& outFile, SerializeFn serialize) {
    std::vector<UDataTable*> tables = FindDataTablesByRowStruct(expectedRowStructName);
    if (tables.empty()) {
        Status("no tables found with RowStruct=" + expectedRowStructName);
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
        Status("wrote " + std::to_string(written) + "/" + std::to_string(rowCount) + " rows from " + tableName);
        total += written;
    }
    f.close();
    Status("ExportByRowStruct(" + expectedRowStructName + ") DONE total_rows=" + std::to_string(total) +
            " across " + std::to_string(tables.size()) + " table(s)");
    return total;
}

int RunCombatExport() {
    std::wstring outDir = ResolveOutDir();
    CreateDirectoryW((outDir + L"\\combat_1_12").c_str(), nullptr);
    std::wstring cDir = outDir + L"\\combat_1_12";

    int total = 0;
    total += std::max(0, ExportByRowStruct<FDamageTableData>(
        "DamageTableData", cDir + L"\\damage-tables.jsonl", SerializeDamageRow));

    total += std::max(0, ExportByRowStruct<FWeaponPowerTableData>(
        "WeaponPowerTableData", cDir + L"\\weapon-power-tables.jsonl", SerializeWeaponPowerRow));

    Status("RunCombatExport DONE total_rows=" + std::to_string(total));
    return total;
}

} 

int RunCombatExport() { return CombatExp::RunCombatExport(); }