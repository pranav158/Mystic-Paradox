/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include <string>

// Hook points for the optional player-hosted (P2P) server mode.
//
// The runtime is complete without it: P2PHooksStub.cpp gives every hook its dedicated-only behaviour
// (the mode is never claimed, so a server runs as a DeployServer gameserver). When the p2p\ sources
// are present, MysticParadox.vcxproj compiles them instead of the stub. dllmain.cpp and Networking.cpp
// call only these functions; they never include anything from p2p\.
namespace P2PHooks {
    // --- Init, under the loader lock: no logging, no file I/O ---

    // True when the module serves this MYSTICPARADOX_AUTH_MODE value; the server then runs in the
    // module's mode (Globals::ServerAuthMode::HuntCapability). The stub claims nothing, so any value
    // other than GLOBAL_GAMESERVER stays invalid and the server exits before listen.
    bool ClaimAuthMode(const std::string& Value);
    // Module mode with the DeployServer-style argument list: read and validate the module's own
    // launch environment. The core clears the gameserver API key for this mode.
    void ReadLaunch(int NumArgs, wchar_t** Args);

    // --- Server start ---

    // From InitServerHooks, after MH_Initialize, on every server.
    void InstallServerHooks();
    // Extra ` key=value` fields for the [InitRole] log line.
    std::string DescribeRole();
    // MainThread, module mode only, before listen. False when the process cannot run (the module has
    // already ended it).
    bool StartServer();

    // --- Networking (server) ---

    // False refuses the listen. Host is set when the module pins the listen address.
    bool PrepareListen(std::wstring& Host);
    // True when the module reports readiness itself instead of the DeployServer stdout marker.
    bool ReportsReadiness();
    bool ReportReady(int Port);

    // --- Game thread (server) ---

    // Every engine tick in module mode: true while the module is ending the process (skip the tick).
    bool TickShutdown();
    // The listen failed in module mode.
    void OnListenFailed();
    // An extra header for backend HTTP requests in module mode; Name stays empty when there is none.
    void RequestHeader(std::wstring& Name, std::wstring& Value);
    // Every server ProcessEvent (after the shared handling).
    void ObserveServerEvent(const std::string& FunctionName, void* Parms);
}
