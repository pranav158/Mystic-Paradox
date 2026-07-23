

#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <unordered_map>

#include "SDK.hpp"

using namespace SDK;

namespace SkinsExp {

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

static std::string FStr(const FString& s) {
    if (s.Num() <= 0 || !s.IsValid()) return std::string();
    return s.ToString();
}

static bool IsMissingOrEmpty(const std::string& s) {
    return s.empty() || s == "<MISSING STRING TABLE ENTRY>";
}



static void Status(const std::string& s);














static std::string ResolveString(const std::string& invariant, FText& text, std::string& sourceOut) {
    if (!IsMissingOrEmpty(invariant)) {
        sourceOut = "invariant";
        return invariant;
    }
    if (text.TextData != nullptr) {
        try {
            std::string fromText = text.ToString();
            if (!IsMissingOrEmpty(fromText)) {
                sourceOut = "text";
                return fromText;
            }
        } catch (...) {
            
            
        }
    }
    sourceOut = "none";
    return invariant; 
}







static bool ExtractLocKey(const std::string& customData, const std::string& blockKey,
                           std::string& outNamespace, std::string& outKey) {
    std::string blockMarker = "\"" + blockKey + "\":\"";
    size_t blockPos = customData.find(blockMarker);
    if (blockPos == std::string::npos) return false;
    size_t blockStart = blockPos + blockMarker.size();
    size_t windowEnd = (std::min)(customData.size(), blockStart + 600);
    std::string window = customData.substr(blockStart, windowEnd - blockStart);

    auto extractField = [&window](const std::string& fieldName) -> std::string {
        std::string marker = "\\\"" + fieldName + "\\\": \\\"";
        size_t fp = window.find(marker);
        if (fp == std::string::npos) return std::string();
        size_t vStart = fp + marker.size();
        size_t vEnd = window.find("\\\"", vStart);
        if (vEnd == std::string::npos) return std::string();
        return window.substr(vStart, vEnd - vStart);
    };

    outNamespace = extractField("Namespace");
    outKey = extractField("Key");
    return !outNamespace.empty() && !outKey.empty();
}
















static std::string ResolveViaStringTable(const std::string& ns, const std::string& key, const std::string& logTag) {
    try {
        UClass* strLibCls = UKismetStringLibrary::StaticClass();
        UClass* tblLibCls = UKismetStringTableLibrary::StaticClass();
        UObject* strLibCdo = strLibCls ? UKismetStringLibrary::GetDefaultObj() : nullptr;
        UObject* tblLibCdo = tblLibCls ? UKismetStringTableLibrary::GetDefaultObj() : nullptr;
        if (!strLibCls || !tblLibCls || !strLibCdo || !tblLibCdo) {
            Status("  [stringtable] " + logTag + " FAILED: CDO/class lookup null (strLibCls=" +
                   std::to_string(reinterpret_cast<uintptr_t>(strLibCls)) + " tblLibCls=" +
                   std::to_string(reinterpret_cast<uintptr_t>(tblLibCls)) + " strLibCdo=" +
                   std::to_string(reinterpret_cast<uintptr_t>(strLibCdo)) + " tblLibCdo=" +
                   std::to_string(reinterpret_cast<uintptr_t>(tblLibCdo)) + ")");
            return std::string();
        }

        std::wstring wNs(ns.begin(), ns.end());   
        std::wstring wKey(key.begin(), key.end());

        FName tableId = UKismetStringLibrary::Conv_StringToName(FString(wNs.c_str()));
        bool isRegistered = UKismetStringTableLibrary::IsRegisteredTableId(tableId);
        FString result = UKismetStringTableLibrary::GetTableEntrySourceString(tableId, FString(wKey.c_str()));
        std::string s = FStr(result);

        Status("  [stringtable] " + logTag + " ns=\"" + ns + "\" key=\"" + key + "\" "
               "tableIdIsNone=" + std::string(tableId.IsNone() ? "1" : "0") +
               " isRegisteredTableId=" + std::string(isRegistered ? "1" : "0") +
               " result=\"" + s + "\"");

        if (IsMissingOrEmpty(s)) return std::string();
        return s;
    } catch (const std::exception& e) {
        Status("  [stringtable] " + logTag + " EXCEPTION: " + e.what());
        return std::string();
    } catch (...) {
        Status("  [stringtable] " + logTag + " EXCEPTION: unknown (non-std)");
        return std::string();
    }
}

static std::string StrArray(const TArray<FString>& arr) {
    std::string o = "[";
    for (int i = 0; i < arr.Num(); ++i) {
        if (i) o += ",";
        o += Q(FStr(arr[i]));
    }
    o += "]";
    return o;
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
    OutputDebugStringA(("[SkinsExporter] " + s + "\n").c_str());
    std::wofstream f(ResolveOutDir() + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << std::wstring(s.begin(), s.end()) << L"\n";
}


static const std::unordered_map<std::string, std::string> kFamilyToWeapon = {
    { "gaxe",    "Axe"         },
    { "eblade",  "Sword"       },
    { "ihammer", "Hammer"      },
    { "cblades", "ChainBlades" },
    { "dp",      "Repeaters"   },
    { "mspear",  "Spear"       },
    { "ac",      "Strikers"    },
};

static UArchonCatalog* FindArchonCatalog() {
    if (!UObject::GObjects) return nullptr;
    const int count = UObject::GObjects->Num();
    UClass* cls = UArchonCatalog::StaticClass();
    if (!cls) return nullptr;
    for (int i = 0; i < count; ++i) {
        UObject* obj = UObject::GObjects->GetByIndex(i);
        if (!obj) continue;
        if (obj->IsDefaultObject()) continue;
        if (obj->IsA(cls)) return static_cast<UArchonCatalog*>(obj);
    }
    return nullptr;
}






static std::string WeaponForTags(const TArray<FString>& tags) {
    bool isTransmog = false;
    for (int i = 0; i < tags.Num(); ++i) {
        if (FStr(tags[i]) == "transmog") { isTransmog = true; break; }
    }
    if (!isTransmog) return std::string();

    for (int i = 0; i < tags.Num(); ++i) {
        auto it = kFamilyToWeapon.find(FStr(tags[i]));
        if (it != kFamilyToWeapon.end()) return it->second;
    }
    return std::string();
}









static void RunStringTableDiagnostic() {
    Status("=== STRINGTABLE DIAGNOSTIC START ===");

    
    if (UObject::GObjects) {
        UClass* stCls = UStringTable::StaticClass();
        int stCount = 0, cosmeticCount = 0;
        const int count = UObject::GObjects->Num();
        for (int i = 0; i < count && stCls; ++i) {
            UObject* obj = UObject::GObjects->GetByIndex(i);
            if (!obj || obj->IsDefaultObject() || !obj->IsA(stCls)) continue;
            ++stCount;
            std::string full = obj->GetFullName();
            if (full.find("cosmetic") != std::string::npos || full.find("weapon_") != std::string::npos) {
                Status("  [ST-obj] loaded UStringTable: " + full);
                ++cosmeticCount;
            }
        }
        Status("  [ST-obj] total loaded UStringTable objects=" + std::to_string(stCount) +
               " (cosmetic/weapon-related=" + std::to_string(cosmeticCount) + ")");
    }

    
    try {
        TArray<FName> registered = UKismetStringTableLibrary::GetRegisteredStringTables();
        Status("  [ST-reg] GetRegisteredStringTables count=" + std::to_string(registered.Num()));
        int shown = 0;
        for (int i = 0; i < registered.Num(); ++i) {
            std::string idStr = registered[i].ToString();
            if (idStr.find("cosmetic") != std::string::npos || idStr.find("weapon_") != std::string::npos) {
                Status("  [ST-reg] registered cosmetic table: \"" + idStr + "\"");
                if (++shown >= 20) { Status("  [ST-reg] (truncated at 20 cosmetic matches)"); break; }
            }
        }
    } catch (...) {
        Status("  [ST-reg] GetRegisteredStringTables threw");
    }

    
    
    
    
    
    
    try {
        FName axeTable = UKismetStringLibrary::Conv_StringToName(FString(L"weapon_gaxe_cosmetic_catalog"));
        TArray<FString> keys = UKismetStringTableLibrary::GetKeysFromStringTable(axeTable);
        Status("  [ST-keys] weapon_gaxe_cosmetic_catalog key count=" + std::to_string(keys.Num()));
        for (int i = 0; i < keys.Num() && i < 25; ++i) {
            std::string k = FStr(keys[i]);
            std::string src = FStr(UKismetStringTableLibrary::GetTableEntrySourceString(axeTable, keys[i]));
            Status("  [ST-keys]   key[" + std::to_string(i) + "]=\"" + k + "\" source=\"" + src + "\"");
        }
    } catch (...) {
        Status("  [ST-keys] GetKeysFromStringTable threw");
    }

    Status("=== STRINGTABLE DIAGNOSTIC END ===");
}

} 

int RunSkinsExport(bool resolveViaStringTable) {
    using namespace SkinsExp;

    UArchonCatalog* cat = FindArchonCatalog();
    if (!cat) { Status("UArchonCatalog instance NOT found yet"); return 0; }

    TArray<FArchonCatalogItem> items;
    cat->GetAllItems(&items);
    const int n = items.Num();
    Status("scanning " + std::to_string(n) + " catalog items for weapon skins");
    if (n <= 0) return 0;

    if (resolveViaStringTable) {
        Status("*** EXPORT_SKINS_RESOLVE_STRINGTABLE=1: calling ProcessEvent off the worker "
               "thread to resolve missing names. CLIENT-ONLY — this must never run against the "
               "dedicated server. If this is the server process, kill it now. ***");
        RunStringTableDiagnostic();
    }

    std::wstring outDir = ResolveOutDir();
    std::ofstream f(outDir + L"\\weapon_skins_1_12.jsonl", std::ios::trunc);
    if (!f) { Status("cannot open weapon_skins_1_12.jsonl"); return -1; }

    
    std::unordered_map<std::string, int> perWeapon;
    int viaInvariant = 0, viaText = 0, viaStringTable = 0, unresolved = 0;

    int written = 0;
    for (int i = 0; i < n; ++i) {
        FArchonCatalogItem& it = items[i];
        std::string weapon = WeaponForTags(it.Tags);
        if (weapon.empty()) continue; 

        std::string id = FStr(it.ItemId);
        if (id.empty()) continue;

        std::string nameSource, descSource;
        std::string displayName = ResolveString(FStr(it.DisplayNameInvariant), it.DisplayName, nameSource);
        std::string description = ResolveString(FStr(it.DescriptionInvariant), it.Description, descSource);
        std::string customData = FStr(it.CustomData);

        if (resolveViaStringTable) {
            if (nameSource == "none") {
                std::string ns, key;
                if (ExtractLocKey(customData, "DisplayNameLocKey", ns, key)) {
                    std::string resolved = ResolveViaStringTable(ns, key, id + "/displayName");
                    if (!resolved.empty()) { displayName = resolved; nameSource = "stringtable"; }
                } else {
                    Status("  [stringtable] " + id + "/displayName EXTRACTION FAILED (no LocKey block found in customData)");
                }
            }
            if (descSource == "none") {
                std::string ns, key;
                if (ExtractLocKey(customData, "DescriptionLocKey", ns, key)) {
                    std::string resolved = ResolveViaStringTable(ns, key, id + "/description");
                    if (!resolved.empty()) { description = resolved; descSource = "stringtable"; }
                } else {
                    Status("  [stringtable] " + id + "/description EXTRACTION FAILED (no LocKey block found in customData)");
                }
            }
        }

        std::string line = "{";
        line += "\"itemId\":" + Q(id);
        line += ",\"weapon\":" + Q(weapon);
        line += ",\"itemClass\":" + Q(it.ItemClass.AssetPathName.ToString());
        line += ",\"displayName\":" + Q(displayName);
        line += ",\"displayNameSource\":" + Q(nameSource);
        line += ",\"description\":" + Q(description);
        line += ",\"descriptionSource\":" + Q(descSource);
        line += ",\"tags\":" + StrArray(it.Tags);
        line += ",\"customData\":" + Q(customData);
        
        
        line += ",\"virtualCurrencyPrices\":[";
        for (int p = 0; p < it.VirtualCurrencyPrices.Num(); ++p) {
            if (p) line += ",";
            FPlayFabCatalogCurrency& c = it.VirtualCurrencyPrices[p];
            line += "{\"currency\":" + std::to_string(static_cast<int>(c.CurrencyType)) + ",\"amount\":" + std::to_string(c.Amount) + "}";
        }
        line += "]";
        line += "}";

        f << line << "\n";
        ++written;
        perWeapon[weapon]++;
        if (nameSource == "invariant") ++viaInvariant;
        else if (nameSource == "text") ++viaText;
        else if (nameSource == "stringtable") ++viaStringTable;
        else ++unresolved;
    }
    f.close();

    std::string breakdown;
    for (const auto& [weapon, wcount] : perWeapon) {
        if (!breakdown.empty()) breakdown += ", ";
        breakdown += weapon + "=" + std::to_string(wcount);
    }
    Status("wrote " + std::to_string(written) + " weapon skins -> weapon_skins_1_12.jsonl (" + breakdown + ") | "
           "names: invariant=" + std::to_string(viaInvariant) + " viaFText=" + std::to_string(viaText) +
           " viaStringTable=" + std::to_string(viaStringTable) + " stillUnresolved=" + std::to_string(unresolved));
    return written;
}