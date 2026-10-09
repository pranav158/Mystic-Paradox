/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include <windows.h>
#include <cstdint>
#include <string>

// Helpers and globals defined in dllmain.cpp that the runtime's other source files may use.

namespace Globals {
    extern bool AmServer;
    extern uintptr_t BaseAddress;
    extern int Port;
    // DeployServer roster: "accountId:..., accountId:..." (null outside a DeployServer launch).
    extern const wchar_t* ExpectedPlayerString;
}

// Flushed per-port diagnostic log next to the game executable (mysticparadox_dll_port<N>.log).
void MpLog(const std::string& Msg);
std::string MpPtr(const void* Ptr);
// Reads an environment variable of at most Maximum characters without control characters.
bool MpReadEnvironment(const char* Name, std::string& Value, size_t Maximum);
// True iff <game-exe-dir>\<FileName> exists.
bool MpExeRelativeFlagPresent(const wchar_t* FileName);
// MYSTICPARADOX_RUNTIME_PROFILE=development, injected only by the launcher.
bool DevelopmentRuntimeProfile();

bool IsReadablePointer(const void* Ptr, size_t Size = sizeof(void*));
// True while Ptr is a live UObject (its GObjects slot still points at it).
bool IsRegisteredLiveObject(const void* Ptr);
std::string SafeObjectNameForDiagnostic(void* Object);
// Narrow copy of a UE FString (ASCII content), guarded and bounded.
std::string CoreCapFString(void* fstr);

// Game thread: UKismetSystemLibrary::QuitGame on the current world.
void MpQuitGame();
