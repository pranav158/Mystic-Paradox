/*
 * Copyright (C) 2026 Mystic Paradox (pranav158/MysticParadox)
 * Licensed under the GNU Affero General Public License v3.0.
 */

/*
 * Where the exporters write and read their flags.
 *
 * An optional, git-ignored ExportPaths.local.h next to this file may define MYSTICPARADOX_EXPORT_ROOT,
 * a wide-string folder (normally your repository root), for example:
 *
 *     #define MYSTICPARADOX_EXPORT_ROOT L"D:\\MysticParadox"
 *
 * Exports then land in <root>\Items_Analysis and the flags file is read from
 * <root>\tools\CatalogExporter\export_flags.txt, whatever the injected game's working directory is.
 * Without it, both are relative to that working directory (.\Items_Analysis, .\export_flags.txt).
 */

#pragma once

#include <windows.h>
#include <string>
#include <vector>

#if __has_include("ExportPaths.local.h")
#include "ExportPaths.local.h"
#endif

// The first existing folder of <root>\Items_Analysis and .\Items_Analysis; otherwise the first is created.
inline std::wstring ExportOutDir() {
    std::vector<std::wstring> candidates;
#ifdef MYSTICPARADOX_EXPORT_ROOT
    candidates.push_back(std::wstring(MYSTICPARADOX_EXPORT_ROOT) + L"\\Items_Analysis");
#endif
    candidates.push_back(L".\\Items_Analysis");
    for (const std::wstring& candidate : candidates) {
        const DWORD attributes = GetFileAttributesW(candidate.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY)) return candidate;
    }
    CreateDirectoryW(candidates[0].c_str(), nullptr);
    return candidates[0];
}

// Flags file candidates in search order (see ExportFlags.hpp).
inline std::vector<std::wstring> ExportFlagsFileCandidates() {
    std::vector<std::wstring> candidates;
#ifdef MYSTICPARADOX_EXPORT_ROOT
    candidates.push_back(std::wstring(MYSTICPARADOX_EXPORT_ROOT) + L"\\tools\\CatalogExporter\\export_flags.txt");
#endif
    candidates.push_back(L".\\export_flags.txt");
    return candidates;
}
