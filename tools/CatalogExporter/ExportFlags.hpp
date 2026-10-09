/*
 * CatalogExporter export-flags — read from a sidecar text file since an
 * injected DLL has no argv. See ExportFlags.md for the full explanation.
 *
 * File format (export_flags.txt, one KEY=VALUE per line, VALUE is 0 or 1):
 *   EXPORT_CATALOG=1
 *   EXPORT_PROGRESSION=1
 *   EXPORT_COMBAT=0
 *   EXPORT_SKINS=0
 *   EXPORT_SKINS_RESOLVE_STRINGTABLE=0
 *   EXPORT_WEAPON_SLOTS=0
 *   EXPORT_CELLS=0
 *
 * *** EXPORT_SKINS_RESOLVE_STRINGTABLE WARNING: CLIENT-ONLY. This mode calls a live engine
 * function (UKismetStringTableLibrary::GetTableEntrySourceString) via ProcessEvent from the
 * exporter's background worker thread, NOT the game thread — every other flag in this file is a
 * pure GObjects/FString read with no engine-dispatch risk, safe against a live production
 * server; this one is not. Only enable it in a build you inject into your own local/offline
 * client. NEVER enable it for a build injected into the shared dedicated server process. See
 * SkinsExporter.cpp's file header for the full explanation. ***
 *
 * Search order for the flags file (first match wins; see ExportPaths.hpp):
 *   <root>\tools\CatalogExporter\export_flags.txt   (when ExportPaths.local.h names a root)
 *   .\export_flags.txt   (relative to the injected process CWD)
 *
 * If the file is missing entirely, defaults to EXPORT_CATALOG=1 and
 * everything else =0 — this preserves the exact pre-existing behavior of
 * the original CatalogExporter for anyone who already has an injection
 * workflow that doesn't know about flags.
 */

#pragma once

#include <windows.h>
#include <string>
#include <unordered_map>
#include <fstream>
#include <sstream>

#include "ExportPaths.hpp"

struct ExportFlags {
    bool ExportCatalog = true;
    bool ExportProgression = false;
    bool ExportCombat = false;
    bool ExportSkins = false;
    bool ExportSkinsResolveStringTable = false;
    bool ExportSlayersPath = false;
    bool ExportWeaponSlots = false;
    bool ExportHunts = false;
    bool ExportTableInventory = false;
    // [2026-07-21] Omnicell investigation. Dumps GetCellSlots()/GetPermanentCells()/
    // GetAllPermanentCellEffects() for every live UArchonInventoryItem_Weapon in GObjects — pure
    // direct calls into already-declared SDK member functions, no ProcessEvent, same safety class
    // as EXPORT_WEAPON_SLOTS. Client-only in the sense that it only finds anything on a client with
    // a real inventory loaded (harmless no-op on the dedicated server, but pointless there).
    bool ExportCells = false;
    // [2026-07-24] Lady Luck's Store / Core Breaker investigation. Reads every loaded
    // PlayFabDropTableTableData row (weighted loot tables — real item-id/weight/amount triples), via
    // RowStruct search like EXPORT_HUNTS's supporting tables. Pure GObjects/RowMap read, same safety
    // class as every other flag here except EXPORT_SKINS_RESOLVE_STRINGTABLE. LOAD REQUIREMENT: open
    // the Core Breaker and preview a core of each tier before injecting, or DT_Cell_Cores (and
    // anything else sharing this RowStruct) will not have streamed in yet.
    bool ExportDropTables = false;
    // [2026-07-26] Reward Cache Store investigation (Progress/30_REWARD_CACHE_STORE.md). Resolves
    // real display names for every "currency"-tagged catalog item (the 9 Reward Cache currencies —
    // CURRENCY_REWARDCACHE + CURRENCY_S13_COIN..CURRENCY_S20_COIN — plus any other currency with an
    // unresolved name) via the same UKismetStringTableLibrary::GetTableEntrySourceString ProcessEvent
    // call already proven for EXPORT_SKINS_RESOLVE_STRINGTABLE.
    //
    // *** CLIENT-ONLY, same as EXPORT_SKINS_RESOLVE_STRINGTABLE — see CurrencyExporter.cpp's file
    // header. Calls ProcessEvent off the worker thread. NEVER enable for a build injected into the
    // shared dedicated server process; only your own local/offline client. ***
    bool ExportCurrencyNames = false;
    // [2026-07-28] Reward Cache repro capture. Walks loaded UStoreViewModel and
    // UStoreItemViewModel objects plus StoreItemTable image rows after the Reward Cache UI is open.
    // Pure SDK-layout/GObjects reads: no hooks, no ProcessEvent and no game-memory writes.
    bool ExportStoreRuntime = false;
};

inline std::wstring FindFlagsFile() {
    for (const std::wstring& c : ExportFlagsFileCandidates()) {
        DWORD attr = GetFileAttributesW(c.c_str());
        if (attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY)) return c;
    }
    return std::wstring();
}

inline ExportFlags LoadExportFlags() {
    ExportFlags flags; // defaults: catalog-only, matching pre-flag behavior.

    std::wstring path = FindFlagsFile();
    if (path.empty()) {
        return flags;
    }

    std::ifstream f(path);
    if (!f) {
        return flags;
    }

    std::unordered_map<std::string, bool> parsed;
    std::string line;
    while (std::getline(f, line)) {
        // Strip whitespace/CR.
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) line.pop_back();
        size_t start = 0;
        while (start < line.size() && (line[start] == ' ' || line[start] == '\t')) ++start;
        line = line.substr(start);

        if (line.empty() || line[0] == '#') continue;

        size_t eq = line.find('=');
        if (eq == std::string::npos) continue;

        std::string key = line.substr(0, eq);
        std::string val = line.substr(eq + 1);
        parsed[key] = (val == "1" || val == "true" || val == "TRUE");
    }

    // Once a valid flags file exists, it is authoritative for ALL three keys
    // (a key simply absent from the file is treated as 0/false) — this avoids
    // surprising "half defaulted" states once someone opts in to the file.
    flags.ExportCatalog = parsed.count("EXPORT_CATALOG") ? parsed["EXPORT_CATALOG"] : false;
    flags.ExportProgression = parsed.count("EXPORT_PROGRESSION") ? parsed["EXPORT_PROGRESSION"] : false;
    flags.ExportCombat = parsed.count("EXPORT_COMBAT") ? parsed["EXPORT_COMBAT"] : false;
    flags.ExportSkins = parsed.count("EXPORT_SKINS") ? parsed["EXPORT_SKINS"] : false;
    flags.ExportSkinsResolveStringTable = parsed.count("EXPORT_SKINS_RESOLVE_STRINGTABLE") ? parsed["EXPORT_SKINS_RESOLVE_STRINGTABLE"] : false;
    flags.ExportSlayersPath = parsed.count("EXPORT_SLAYERS_PATH") ? parsed["EXPORT_SLAYERS_PATH"] : false;
    flags.ExportWeaponSlots = parsed.count("EXPORT_WEAPON_SLOTS") ? parsed["EXPORT_WEAPON_SLOTS"] : false;
    flags.ExportHunts = parsed.count("EXPORT_HUNTS") ? parsed["EXPORT_HUNTS"] : false;
    flags.ExportTableInventory = parsed.count("EXPORT_TABLE_INVENTORY") ? parsed["EXPORT_TABLE_INVENTORY"] : false;
    flags.ExportCells = parsed.count("EXPORT_CELLS") ? parsed["EXPORT_CELLS"] : false;
    flags.ExportDropTables = parsed.count("EXPORT_DROP_TABLES") ? parsed["EXPORT_DROP_TABLES"] : false;
    flags.ExportCurrencyNames = parsed.count("EXPORT_CURRENCY_NAMES") ? parsed["EXPORT_CURRENCY_NAMES"] : false;
    flags.ExportStoreRuntime = parsed.count("EXPORT_STORE_RUNTIME") ? parsed["EXPORT_STORE_RUNTIME"] : false;

    return flags;
}
