/*
 * SkinsExporter — extends CatalogExporter with a weapon-skins-only mode (EXPORT_SKINS flag).
 *
 * Filters UArchonCatalog::GetAllItems() (the same source DumpGeneralCatalog in dllmain.cpp
 * already reads) down to weapon transmog/skin items across all 7 weapon types, instead of
 * emitting the full ~7000-row general catalog. Useful when you only want to audit skins (e.g.
 * cross-referencing against the wiki) without re-parsing catalog_1_12.jsonl every time.
 *
 * Family tag -> weapon mapping, confirmed against real 1.12 displayNames (2026-07-18 session):
 *   gaxe    -> Axe        (WeaponType_GAXE)     e.g. "Archonite Axe"
 *   eblade  -> Sword       (WeaponType_EBLADE)   e.g. "Archonite Sword"
 *   ihammer -> Hammer      (WeaponType_IHAMMER)  e.g. "Archonite Hammer"
 *   cblades -> ChainBlades (WeaponType_CBLADES)
 *   dp      -> Repeaters   (WeaponType_DP)       e.g. "Archonite Repeaters"
 *   mspear  -> Spear       (WeaponType_MSPEAR)   e.g. "Archonite Spear"/"...Pike"
 *   ac      -> Strikers    (WeaponType_AC)       e.g. "Archonite Strikers"
 * A catalog item is a weapon skin iff its tags include "transmog" AND at least one of the
 * seven family tags above (this is exactly how the general catalog's own tags identify them —
 * no separate skin-specific struct/table exists; skins are FArchonCatalogItem rows like
 * everything else, just tagged this way).
 *
 * ---- EXPORT_SKINS_RESOLVE_STRINGTABLE (opt-in, CLIENT-ONLY — see warning below) -----------
 *
 * ~40% of skins (2026-07-18 session count: 178/444) have DisplayNameInvariant/DisplayName both
 * blank/"<MISSING STRING TABLE ENTRY>" — confirmed via Ghidra that the real strings live in a
 * separate UStringTable asset (e.g. "weapon_gaxe_cosmetic_catalog"), keyed by a Namespace+Key
 * pair embedded in the item's own CustomData JSON (DisplayNameLocKey/DescriptionLocKey). The
 * only way to resolve these is UKismetStringTableLibrary::GetTableEntrySourceString(TableId,
 * Key) — a real, live engine call, confirmed present in the game binary via Ghidra
 * (UKismetStringTableLibrary::execGetTableEntrySourceString).
 *
 * *** WARNING: this call goes through UObject::ProcessEvent (see the SDK's own
 * Engine_functions.cpp implementation of GetTableEntrySourceString/Conv_StringToName), which is
 * NOT thread-safe to call from an arbitrary OS thread — it assumes the game thread. This
 * exporter's worker thread (CreateThread in dllmain.cpp) is deliberately NOT the game thread, so
 * every OTHER export mode in this DLL is a pure GObjects/FString read with zero engine-dispatch
 * risk, safe to run against a live production server. EXPORT_SKINS_RESOLVE_STRINGTABLE breaks
 * that guarantee. ONLY inject a build with this flag enabled into your own local/offline client,
 * NEVER the shared dedicated server process. Default OFF; ExportFlags.md documents this same
 * warning for anyone editing export_flags.txt directly. ***
 */

#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <unordered_map>

#include "SDK.hpp"
#include "ExportPaths.hpp"

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

// Forward decl — Status() itself is defined further down (needs ResolveOutDir first), but the
// stringtable resolver needs to log per-attempt diagnostics from higher up in the file.
static void Status(const std::string& s);

// FArchonCatalogItem carries TWO independent string sources per field (see
// Archon_structs.hpp FArchonCatalogItem, offsets 0x48/0x58 vs 0x68/0x80):
//   - DisplayNameInvariant/DescriptionInvariant (FString, Transient) — populated on-demand by
//     game code that resolves through the live FTextLocalizationManager; comes back
//     "<MISSING STRING TABLE ENTRY>" if that resolution never ran for this item (e.g. it was
//     never displayed in any UI during the captured session — exactly what happened for the
//     Saint's Bond/Frostfall/Dark Harvest "_01"/"_02" variants).
//   - DisplayName/Description (FText) — the SDK's FText::ToString() reads TextData->TextSource
//     directly, the string baked into the text asset at cook time, independent of whether the
//     runtime localization manager ever resolved it for display. A different, more direct path
//     that can succeed where the Invariant field didn't.
// ResolveString tries Invariant first (cheap, already a plain FString), falls back to the FText
// source, and reports which path won (or that neither did) via `source` for transparency.
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
            // TextData present but source unreadable (e.g. torn-down asset) — fall through to
            // "none" rather than propagate/crash the exporter thread over one row.
        }
    }
    sourceOut = "none";
    return invariant; // whatever we had (empty or the missing-marker), unchanged
}

// Pulls Namespace/Key out of one LocKey JSON blob embedded (double-encoded) inside CustomData,
// e.g. customData contains: "DisplayNameLocKey":"{\r\n\t\"HasValue\": true,\r\n\t\"Namespace\":
// \"weapon_gaxe_cosmetic_catalog\",\r\n\t\"Key\": \"WP_GA_ROMANTIC_01|Display Name\"\r\n}" — the
// inner JSON got string-escaped into the outer JSON's string value, so a full JSON parser isn't
// worth it here; targeted substring search on the known escaped-quote pattern is simpler and
// matches every sample observed this session (Axe/Sword/Hammer/etc. LocKey blocks alike).
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

// *** CLIENT-ONLY — see the file header warning. Calls through ProcessEvent (game-thread-only
// engine dispatch) via the SDK's standard UKismetStringLibrary/UKismetStringTableLibrary
// wrappers. Never call this from a build injected into the dedicated server. ***
//
// SDK::FString (UnrealContainers.hpp UC::FString) only has a wchar_t* constructor, and that
// constructor does NOT copy — it just points Data at the caller's buffer (a view, not an owning
// string). So the backing std::wstring must stay alive for the whole call; wNs/wKey are locals
// held through both engine calls below, which is exactly long enough since both dispatch
// synchronously (native BlueprintCallable, not a deferred Blueprint graph).
//
// `logTag` (e.g. "WP_GA_ROMANTIC_01/displayName") is logged with every attempt — diagnostic
// visibility added 2026-07-18 after a first run came back viaStringTable=0 across all 178 rows
// with no crash, which is consistent with several different failure points (extraction, CDO
// lookup, function lookup, or the table genuinely not resident) that a silent empty return can't
// distinguish between.
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

        std::wstring wNs(ns.begin(), ns.end());   // catalog namespaces/keys are plain ASCII identifiers
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

// See ExportPaths.hpp: <root>\Items_Analysis when ExportPaths.local.h names a root, else .\Items_Analysis.
static std::wstring ResolveOutDir() { return ExportOutDir(); }

static void Status(const std::string& s) {
    OutputDebugStringA(("[SkinsExporter] " + s + "\n").c_str());
    std::wofstream f(ResolveOutDir() + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << std::wstring(s.begin(), s.end()) << L"\n";
}

// Family tag -> canonical weapon name (see file header for the confirmed mapping).
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

// Returns the weapon name for the item's tags if it's a weapon skin, else empty string.
// An item can only belong to one weapon family in practice, but if tags somehow carried more
// than one family tag, the first match wins (order = kFamilyToWeapon's declaration order,
// i.e. Axe/Sword/Hammer/ChainBlades/Repeaters/Spear/Strikers) rather than emitting the row once
// per matching family.
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

// One-shot characterization of the string-table subsystem, so we stop guessing why
// GetTableEntrySourceString returns empty for the 178 unresolved skins. Ghidra decompilation of
// the native GetTableEntrySourceString (FUN_143cc1d20) shows the flow is:
//   FStringTableRegistry::FindStringTable(TableId)  -> the table (registered, we confirmed)
//   FStringTable::GetSourceString(Key, Out)         -> hash-map lookup of Key in KeysToEntries
// and the lookup returns empty when Key's index == -1 (key simply not in the table's entry map).
// This pass answers the only remaining question: does the table actually CONTAIN any keys (data
// cooked/loaded), and if so, in what exact key format?
static void RunStringTableDiagnostic() {
    Status("=== STRINGTABLE DIAGNOSTIC START ===");

    // (1) Pure GObjects read (SAFE): which UStringTable ASSETS are actually loaded in memory.
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

    // (2) ProcessEvent (CLIENT-ONLY): every registered table ID. Log ones mentioning cosmetic.
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

    // (3) ProcessEvent (CLIENT-ONLY): for the axe cosmetic table, dump the ACTUAL keys it holds.
    // This is the decisive test: if this returns keys in "WP_GA_..|Display Name" form, our format
    // is right and something else is wrong; if it returns keys in a DIFFERENT form, we adapt; if
    // it returns 0 keys, the table is registered but its data was never loaded/cooked in this
    // build (the strings genuinely aren't extractable — matching the in-game "<MISSING STRING
    // TABLE ENTRY>" the client itself shows).
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

} // namespace SkinsExp

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
    std::ofstream f(outDir + L"\\weapon_skins_1_14_7.jsonl", std::ios::trunc);
    if (!f) { Status("cannot open weapon_skins_1_14_7.jsonl"); return -1; }

    // Per-weapon counts, plus how each row's name got resolved, for the status line.
    std::unordered_map<std::string, int> perWeapon;
    int viaInvariant = 0, viaText = 0, viaStringTable = 0, unresolved = 0;

    int written = 0;
    for (int i = 0; i < n; ++i) {
        FArchonCatalogItem& it = items[i];
        std::string weapon = WeaponForTags(it.Tags);
        if (weapon.empty()) continue; // not a weapon skin (transmog tag missing, or no family tag)

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
        // Virtual-currency prices, same shape as the general catalog dump — this is how a
        // skin's Store price (Platinum amount) surfaces, when it has one.
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
    Status("wrote " + std::to_string(written) + " weapon skins -> weapon_skins_1_14_7.jsonl (" + breakdown + ") | "
           "names: invariant=" + std::to_string(viaInvariant) + " viaFText=" + std::to_string(viaText) +
           " viaStringTable=" + std::to_string(viaStringTable) + " stillUnresolved=" + std::to_string(unresolved));
    return written;
}
