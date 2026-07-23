

#pragma once

#include <windows.h>
#include <string>
#include <unordered_map>
#include <fstream>
#include <sstream>

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
    
    
    
    
    
    bool ExportCells = false;
    
    
    
    
    
    
    bool ExportDropTables = false;
};

inline std::wstring FindFlagsFile() {
    static const wchar_t* kCandidates[] = {
        L".\\export_flags.txt",
    };
    for (const wchar_t* c : kCandidates) {
        DWORD attr = GetFileAttributesW(c);
        if (attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY)) return c;
    }
    return std::wstring();
}

inline ExportFlags LoadExportFlags() {
    ExportFlags flags; 

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

    return flags;
}