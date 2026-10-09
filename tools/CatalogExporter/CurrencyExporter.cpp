/*
 * CurrencyExporter — extends CatalogExporter with a currency-only mode (EXPORT_CURRENCY_NAMES flag).
 *
 * [2026-07-26] Reward Cache Store investigation (Progress/30_REWARD_CACHE_STORE.md). Filters
 * UArchonCatalog::GetAllItems() (the same source DumpGeneralCatalog in dllmain.cpp already reads)
 * down to every item tagged "currency" — this naturally includes all 9 Reward Cache currencies
 * (CURRENCY_REWARDCACHE + CURRENCY_S13_COIN..CURRENCY_S20_COIN, tagged
 * ["currency","seasonal_currency"]) plus every other currency in the catalog, since resolving one
 * costs nothing extra once the mechanism exists.
 *
 * Confirmed via catalog_1_12.jsonl: 8 of the 9 Reward Cache currencies carry a real, well-formed
 * DisplayNameLocKey (e.g. CURRENCY_S19_COIN -> {Namespace: "currency_tokens_catalog", Key:
 * "CURRENCY_S19_COIN|Display Name"}) but resolve to "<MISSING STRING TABLE ENTRY>" in the plain
 * DisplayNameInvariant/DisplayName fields DumpGeneralCatalog already reads. This is the IDENTICAL
 * shape SkinsExporter.cpp already solved for weapon skins (178/444 unresolved there) — same
 * ResolveViaStringTable/ExtractLocKey mechanism, just pointed at "currency"-tagged rows instead of
 * "transmog"-tagged ones. Reused verbatim (own copy, per this project's "one self-contained
 * translation unit per exporter" convention) rather than shared via a header.
 *
 * Purpose here specifically: confirm or refute "Elemental Coin" as CURRENCY_S19_COIN's real
 * in-game name, straight from the client's own string table, instead of inferring it from the
 * icon asset name ("ui_event_molten_coin_currency_icon" — a reasonable but unconfirmed reading).
 *
 * *** CLIENT-ONLY — see the identical warning in SkinsExporter.cpp / ExportFlags.hpp. This mode
 * calls UKismetStringTableLibrary::GetTableEntrySourceString via ProcessEvent from the exporter's
 * background worker thread (NOT the game thread). Every other export mode in this DLL is a pure
 * GObjects/FString read with zero engine-dispatch risk, safe against a live production server.
 * EXPORT_CURRENCY_NAMES breaks that guarantee exactly like EXPORT_SKINS_RESOLVE_STRINGTABLE does.
 * ONLY inject a build with this flag enabled into your own local/offline client, NEVER the shared
 * dedicated server process. ***
 */

#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <unordered_map>

#include "SDK.hpp"
#include "ExportPaths.hpp"

using namespace SDK;

namespace CurrencyExp {

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

// Same two-source resolution as SkinsExporter.cpp's ResolveString — see that file's comment on
// FArchonCatalogItem's Invariant-vs-FText split for the full rationale.
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

// Identical targeted-substring extraction as SkinsExporter.cpp's ExtractLocKey — the LocKey JSON
// blob is double-encoded inside CustomData the same way for currencies as it is for skins.
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

// Also pulls the Icon path out of the ItemData sub-block (not a LocKey — plain string field), so
// the export includes the icon-name evidence ("molten_coin" etc.) alongside whatever the real
// resolved display name turns out to be, without needing a second pass over catalog_1_12.jsonl.
static std::string ExtractIcon(const std::string& customData) {
    std::string marker = "\\\"Icon\\\":\\\"";
    size_t p = customData.find(marker);
    if (p == std::string::npos) return std::string();
    size_t vStart = p + marker.size();
    size_t vEnd = customData.find("\\\"", vStart);
    if (vEnd == std::string::npos) return std::string();
    return customData.substr(vStart, vEnd - vStart);
}

// *** CLIENT-ONLY — see file header warning. Identical to SkinsExporter.cpp's ResolveViaStringTable. ***
static std::string ResolveViaStringTable(const std::string& ns, const std::string& key, const std::string& logTag) {
    try {
        UClass* strLibCls = UKismetStringLibrary::StaticClass();
        UClass* tblLibCls = UKismetStringTableLibrary::StaticClass();
        UObject* strLibCdo = strLibCls ? UKismetStringLibrary::GetDefaultObj() : nullptr;
        UObject* tblLibCdo = tblLibCls ? UKismetStringTableLibrary::GetDefaultObj() : nullptr;
        if (!strLibCls || !tblLibCls || !strLibCdo || !tblLibCdo) {
            Status("  [stringtable] " + logTag + " FAILED: CDO/class lookup null");
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

static bool HasTag(const TArray<FString>& tags, const std::string& want) {
    for (int i = 0; i < tags.Num(); ++i) {
        if (FStr(tags[i]) == want) return true;
    }
    return false;
}

// See ExportPaths.hpp: <root>\Items_Analysis when ExportPaths.local.h names a root, else .\Items_Analysis.
static std::wstring ResolveOutDir() { return ExportOutDir(); }

static void Status(const std::string& s) {
    OutputDebugStringA(("[CurrencyExporter] " + s + "\n").c_str());
    std::wofstream f(ResolveOutDir() + L"\\catalog_export_status.txt", std::ios::app);
    if (f) f << std::wstring(s.begin(), s.end()) << L"\n";
}

// [2026-07-26, round 2] The first run resolved 0/23 missing currency names via string table -
// every query came back isRegisteredTableId=1 (table IS loaded) but result="" (empty), for EVERY
// key tried, across three distinct namespaces (currency_tokens_catalog, UI, UI_PlayerJourney).
// Per SkinsExporter.cpp's own established diagnosis for the identical failure mode on weapon
// skins: GetTableEntrySourceString returns empty when the key's index is -1 in the table's
// KeysToEntries map - i.e. "registered" only means the UStringTable ASSET is loaded, not that this
// particular key's row is populated in it. SkinsExporter.cpp answered this decisively by dumping
// the table's ACTUAL keys (GetKeysFromStringTable) rather than guessing further. This mirrors that
// exact diagnostic, scoped to the three namespaces this run's unresolved currencies actually use.
static void DumpStringTableKeys(const std::string& ns, int maxShown) {
    try {
        std::wstring wNs(ns.begin(), ns.end());
        FName tableId = UKismetStringLibrary::Conv_StringToName(FString(wNs.c_str()));
        bool isRegistered = UKismetStringTableLibrary::IsRegisteredTableId(tableId);
        TArray<FString> keys = UKismetStringTableLibrary::GetKeysFromStringTable(tableId);
        Status("  [ST-keys] \"" + ns + "\" isRegisteredTableId=" + std::string(isRegistered ? "1" : "0") +
               " key count=" + std::to_string(keys.Num()));
        for (int i = 0; i < keys.Num() && i < maxShown; ++i) {
            std::string k = FStr(keys[i]);
            std::string src = FStr(UKismetStringTableLibrary::GetTableEntrySourceString(tableId, keys[i]));
            Status("  [ST-keys]   \"" + ns + "\" key[" + std::to_string(i) + "]=\"" + k + "\" source=\"" + src + "\"");
        }
    } catch (...) {
        Status("  [ST-keys] \"" + ns + "\" GetKeysFromStringTable threw");
    }
}

static void RunStringTableKeyDiagnostic() {
    Status("=== CURRENCY STRINGTABLE KEY DIAGNOSTIC START ===");
    // The three namespaces round 1's per-row log actually queried for the 23 unresolved rows -
    // currency_tokens_catalog (all 9 Reward Cache coins + several event currencies),
    // UI_PlayerJourney (the 5 PJM merit currencies), UI (CURRENCY_CELLDUST).
    DumpStringTableKeys("currency_tokens_catalog", 30);
    DumpStringTableKeys("UI_PlayerJourney", 30);
    DumpStringTableKeys("UI", 10); // large shared table - just prove it has ANY keys, don't dump it all
    Status("=== CURRENCY STRINGTABLE KEY DIAGNOSTIC END ===");
}

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

} // namespace CurrencyExp

int RunCurrencyExport() {
    using namespace CurrencyExp;

    UArchonCatalog* cat = FindArchonCatalog();
    if (!cat) { Status("UArchonCatalog instance NOT found yet"); return 0; }

    TArray<FArchonCatalogItem> items;
    cat->GetAllItems(&items);
    const int n = items.Num();
    Status("scanning " + std::to_string(n) + " catalog items for currency-tagged rows");
    if (n <= 0) return 0;

    Status("*** EXPORT_CURRENCY_NAMES=1: calling ProcessEvent off the worker thread to resolve "
           "missing currency display names. CLIENT-ONLY — this must never run against the "
           "dedicated server. If this is the server process, kill it now. ***");

    RunStringTableKeyDiagnostic();

    std::wstring outDir = ResolveOutDir();
    std::ofstream f(outDir + L"\\currency_names_1_14_7.jsonl", std::ios::trunc);
    if (!f) { Status("cannot open currency_names_1_14_7.jsonl"); return -1; }

    int viaInvariant = 0, viaText = 0, viaStringTable = 0, unresolved = 0;
    int written = 0;

    for (int i = 0; i < n; ++i) {
        FArchonCatalogItem& it = items[i];
        if (!HasTag(it.Tags, "currency")) continue;

        std::string id = FStr(it.ItemId);
        if (id.empty()) continue;

        std::string nameSource;
        std::string displayName = ResolveString(FStr(it.DisplayNameInvariant), it.DisplayName, nameSource);
        std::string customData = FStr(it.CustomData);
        std::string icon = ExtractIcon(customData);

        bool hadLocKey = false;
        std::string ns, key;
        if (nameSource == "none") {
            if (ExtractLocKey(customData, "DisplayNameLocKey", ns, key)) {
                hadLocKey = true;
                std::string resolved = ResolveViaStringTable(ns, key, id + "/displayName");
                if (!resolved.empty()) { displayName = resolved; nameSource = "stringtable"; }
            } else {
                Status("  [stringtable] " + id + "/displayName EXTRACTION FAILED (no LocKey block found in customData)");
            }
        }

        std::string line = "{";
        line += "\"itemId\":" + Q(id);
        line += ",\"displayName\":" + Q(displayName);
        line += ",\"displayNameSource\":" + Q(nameSource);
        line += ",\"hadLocKey\":" + std::string(hadLocKey ? "true" : "false");
        line += ",\"locNamespace\":" + Q(ns);
        line += ",\"locKey\":" + Q(key);
        line += ",\"icon\":" + Q(icon);
        line += ",\"tags\":" + StrArray(it.Tags);
        line += "}";

        f << line << "\n";
        ++written;
        if (nameSource == "invariant") ++viaInvariant;
        else if (nameSource == "text") ++viaText;
        else if (nameSource == "stringtable") ++viaStringTable;
        else ++unresolved;
    }
    f.close();

    Status("wrote " + std::to_string(written) + " currencies -> currency_names_1_14_7.jsonl | "
           "names: invariant=" + std::to_string(viaInvariant) + " viaFText=" + std::to_string(viaText) +
           " viaStringTable=" + std::to_string(viaStringTable) + " stillUnresolved=" + std::to_string(unresolved));
    return written;
}
